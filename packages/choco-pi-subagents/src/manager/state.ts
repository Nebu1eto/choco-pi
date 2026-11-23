import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isString } from "../value-guards.ts";
import {
  admissionRequiredMessage,
  consumeReviewTicket,
  roundClassOf,
  type ReviewTicket,
} from "../review-rounds.ts";
import { resumeAgent, runAgent, type MainSessionFork, type ToolActivity } from "../agent-runner.ts";
import { scratchDirForSession } from "@choco-pi/shared/scratch-path";
import { OPENAI_SIGN_IN_USAGE_LIMIT_CODE } from "../openai-sign-in.ts";
import { normalizeMaxConcurrent } from "../limits.ts";
import type { ModelEntry } from "../model-resolver.ts";
import type { BlockingUsageLimitClosure } from "../provider-health.ts";
import { markResultGenerationConsumed, publishTerminalResult } from "../result-read.ts";
import {
  RunBudgetController,
  estimateBootstrapTokens,
  type ForcedTerminalStatus,
  type RunBudgetLimits,
} from "../run-budgets.ts";
import type {
  JournalAgentSnapshot,
  JournalRunOptions,
  SubagentJournalData,
} from "../revival-journal.ts";
import { claimSessionFile, releaseSessionFile } from "../session-file-ownership.ts";
import type {
  AgentInvocation,
  AgentRecord,
  AgentTombstone,
  IsolationMode,
  ModelProvenance,
  SubagentUsageLimit,
  SubagentType,
  ThinkingLevel,
} from "../types.ts";
import {
  describeUsageLimit,
  latestCodexUsageLimitEntry,
  scopeKey,
  type Corroboration,
  type UsageLimitClassification,
} from "../usage-limit-seam.ts";
import type { WorktreeInfo } from "../worktree.ts";
import type { NestedAgentManager } from "../nested-tools.ts";
import { scheduleJournal } from "./revival-journal.ts";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

export interface AgentManagerRunner {
  runAgent: typeof runAgent;
  resumeAgent: typeof resumeAgent;
  setSessionModel?: (session: AgentSession, model: Model<Api>) => Promise<void>;
}

export const DEFAULT_AGENT_MANAGER_RUNNER: AgentManagerRunner = { runAgent, resumeAgent };

export const USAGE_LIMIT_RESET_MARGIN_MS = 30_000;
export const USAGE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60_000;
export const USAGE_LIMIT_POLL_MS = 5 * 60_000;
export const USAGE_LIMIT_MAX_POLL_MS = 6 * 60 * 60_000;
export const USAGE_LIMIT_DEFAULT_CLOSE_MS = 30 * 60_000;
export const REARM_RESET_GRACE_MS = 3_000;
export const REARM_POLICY_RETRY_MS = 30_000;
export const REARM_POLICY_POLL_MS = 2_000;
export const SUSPEND_SETTLE_TIMEOUT_MS = 10_000;
export const SESSION_FILE_RELEASE_TIMEOUT_MS = 15_000;

export const SUSPEND_REASON = "Suspended by the host (quit, reload, or session switch).";

export const USAGE_LIMIT_RESUME_PROMPT =
  "The provider usage window has reset. Continue the previous task from where it stopped; do not repeat tool calls that already completed.";

export interface UsageModelRegistry {
  getAll(): ModelEntry[];
  getAvailable?(): ModelEntry[];
  find(provider: string, modelId: string): Model<Api> | undefined;
  isUsingOAuth?(model: Model<Api>): boolean;
}

export type ModelRef = { provider: string; id: string };

export interface UsageLimitScope {
  owner?: string;
  cwd: string;
  modelRegistry?: UsageModelRegistry;
  scoped: string[];
}

export interface UsageLimitDecision {
  usageLimit: SubagentUsageLimit;
  classification: UsageLimitClassification;
  accountIds: string[];
  park: boolean;
}

export interface UsageWait {
  generation: number;
  owner: string;
  providerKey: string;
  accountIds: string[];
  classification: UsageLimitClassification;
  resumeOptions: ResumeOptions;
  continuation: string[];
  pollUntil?: number;
  revived?: boolean;
  policyRetryUntil?: number;
  timer?: ReturnType<typeof setTimeout>;
  parkedPromise: Promise<string>;
  release(value: string | PromiseLike<string>): void;
}

export type UsageLimitListener = (record: AgentRecord) => void;

export interface SubagentJournalSink {
  rootSessionId: string;
  append(data: SubagentJournalData): void;
  reportError?(agentId: string, error: Error): void;
}

export interface RevivalRunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

export type RevivalReportKind = "revived" | "rearmed" | "capped" | "failed" | "skipped";

export interface RevivalReport {
  kind: RevivalReportKind;
  agentId: string;
  handle?: string;
  description: string;
  parentAgentId?: string;
  message: string;
}

export type RevivalTypeResolution = { ok: true; type: string } | { ok: false; message: string };

export interface RevivalContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  resolveType?: (type: string) => RevivalTypeResolution | Promise<RevivalTypeResolution>;
  callbacksFor?: (snapshot: JournalAgentSnapshot) => RevivalRunCallbacks;
  onRevived?: (record: AgentRecord) => void;
  onRevivalReport?: (report: RevivalReport) => void;
}

export type RevivalSnapshot = Pick<SubagentJournalData, "suspended" | "agent">;

export interface SuspendSummary {
  suspended: string[];
  unsettled: string[];
  aborted: number;
}

export type SubagentJournalLookup = (id: string) => JournalAgentSnapshot | undefined;

export interface SubagentJournalHealth {
  failures: number;
  lastError?: string;
}

export const MAX_DORMANT = 500;

export function isUnsettledStatus(status: AgentRecord["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_reset" ||
    status === "interrupted"
  );
}

export function sessionHasAssistantMessage(session: AgentSession | undefined): boolean {
  if (session === undefined) return false;
  try {
    return session.messages.some((message) => message.role === "assistant");
  } catch {
    return false;
  }
}

export function modelRefOf(model: ModelRef | undefined): ModelRef | undefined {
  return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

export function scopedModelKeys(ctx: ExtensionContext): string[] {
  try {
    const scoped: ExtensionContext["scopedModels"] | undefined = ctx.scopedModels;
    if (scoped === undefined) return [];
    return scoped.map((entry) => `${entry.model.provider}/${entry.model.id}`);
  } catch {
    return [];
  }
}

export function withUsageLimitNote(failure: string, usageLimit: SubagentUsageLimit): string {
  return `${failure}\n\nUsage limit: ${describeUsageLimit(usageLimit)}.`;
}

export function canParkForReset(record: AgentRecord): boolean {
  return record.workflowId === undefined && !record.sideConversation;
}

export type UsageLimitVerdict = "confirmed" | "unconfirmed" | "transient";

export function corroborationVerdict(
  initial: UsageLimitClassification,
  corroboration: Corroboration | undefined,
): UsageLimitVerdict {
  if (initial.kind === "billing") return "unconfirmed";
  const classification = corroboration?.classification ?? initial;
  if (classification.kind === "billing") return "unconfirmed";
  if (classification.kind === "transient") return "transient";
  const evidence = corroboration?.evidence;
  if (evidence === "confirmed") return "confirmed";
  if (evidence === "capacity") return "transient";
  if (evidence === undefined && corroboration?.ready === true) return "transient";
  if (classification.confidence === "inferred") return "transient";
  if (evidence === undefined && corroboration !== undefined) return "confirmed";
  return "unconfirmed";
}

export function accountKey(owner: string, providerKey: string): string {
  return `${owner}\u0000${providerKey}`;
}

export function withCodexUsageEntry(
  classification: UsageLimitClassification,
  model: ModelRef,
  session: AgentSession | undefined,
  failedAt: number,
  failure: string,
): UsageLimitClassification {
  if (session === undefined) return classification;
  const provider = model.provider.toLowerCase();
  const eligible =
    provider === "openai-codex" ||
    (provider === "openai" && failure.includes(OPENAI_SIGN_IN_USAGE_LIMIT_CODE));
  if (!eligible) return classification;
  let entry: ReturnType<typeof latestCodexUsageLimitEntry>;
  try {
    entry = latestCodexUsageLimitEntry(session.sessionManager.getBranch(), failedAt);
  } catch {
    return classification;
  }
  if (entry === undefined) return classification;
  const upgraded: UsageLimitClassification = { ...classification, confidence: "structured" };
  if (entry.resetAt !== undefined) upgraded.resetAt = entry.resetAt;
  if (entry.accountId !== undefined) upgraded.accountId = entry.accountId;
  return upgraded;
}

export function sessionRootOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

export function lastSuccessfulRequestStart(session: AgentSession | undefined): number | undefined {
  const messages = session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
    return message.timestamp;
  }
  return undefined;
}

export function childSessionId(record: AgentRecord, session: AgentSession | undefined): string {
  let sessionId: string | undefined;
  try {
    sessionId = session?.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  return sessionId !== undefined && sessionId !== "" ? sessionId : `subagent:${record.id}`;
}

export function withSessionId(
  classification: UsageLimitClassification,
  sessionId: string | undefined,
): UsageLimitClassification {
  return sessionId === undefined ? classification : { ...classification, sessionId };
}

export type QueuedFinalizer = (notify: boolean) => void;

export interface QueueEntry {
  id: string;
  providerKey: string;
  modelId?: string;
  start: () => void;
  finalize?: QueuedFinalizer;
  repark?: () => void;
  wait?: UsageWait;
}

export interface SuspendPlan {
  record: AgentRecord;
  status: "interrupted" | "waiting_for_reset";
  wait?: UsageWait;
  queueEntry?: QueueEntry;
}

export interface SuspendPlanResult {
  suspended: AgentRecord[];
  running: AgentRecord[];
}

export function retainedWorktreeNotice(
  worktree: WorktreeInfo,
  cause: CancellationCause | undefined,
): string {
  return `\n\n---\nWork retained in worktree \`${worktree.path}\` (branch base \`${worktree.baseSha}\`) because the run was cancelled (${cause ?? "cancelled"}). Nothing was committed; inspect it before merging or run \`git worktree remove --force ${worktree.path}\` to discard.`;
}

export async function removeHookWorktree(pi: ExtensionAPI, path: string): Promise<void> {
  let claimed = false;
  let finish: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  pi.events.emit("subagents:worktree-remove", {
    path,
    claim: () => {
      claimed = true;
    },
    done: finish,
  });
  await Promise.resolve();
  if (claimed) await completion;
}

export const DEFAULT_MAX_CONCURRENT = 4;

export const MAX_TOMBSTONES = 100;

export type SpawnCwdInput =
  | string
  | number
  | boolean
  | null
  | SpawnCwdInput[]
  | { [key: string]: SpawnCwdInput }
  | undefined;

export function assertAbsoluteSpawnCwd(
  cwd: SpawnCwdInput,
): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (!isString(cwd) || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
}

export async function assertSpawnCwdDirectory(cwd: string): Promise<void> {
  let isDirectory = false;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

export async function validateSpawnCwd(cwd: SpawnCwdInput): Promise<void> {
  assertAbsoluteSpawnCwd(cwd);
  if (cwd != null) await assertSpawnCwdDirectory(cwd);
}

export function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId">,
): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}

export function isBudgetedToolActivity(activity: ToolActivity): boolean {
  return activity.type === "start" || !activity.toolName.includes("-error:");
}

export function bootstrapEstimateOf(session: AgentSession): number {
  const view: Partial<Pick<AgentSession, "getAllTools" | "getActiveToolNames" | "systemPrompt">> =
    session;
  const all = view.getAllTools?.() ?? [];
  const activeNames = view.getActiveToolNames?.();
  const active = activeNames === undefined ? undefined : new Set(activeNames);
  return estimateBootstrapTokens({
    systemPrompt: view.systemPrompt,
    tools: active === undefined ? all : all.filter((tool) => active.has(tool.name)),
  });
}

export function ownsUnsettledGeneration(record: AgentRecord): boolean {
  return (
    record.status === "running" ||
    record.status === "queued" ||
    (record.resultGeneration !== undefined &&
      record.terminalResultGeneration !== record.resultGeneration)
  );
}

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export function providerKeyFor(options: SpawnOptions, ctx: ExtensionContext): string {
  return (options.model?.provider ?? ctx.model?.provider ?? "unknown").toLowerCase();
}

export function modelIdFor(options: SpawnOptions, ctx: ExtensionContext): string | undefined {
  return options.model !== undefined ? options.model.id : ctx.model?.id;
}

export function closuresRewritten(
  before: readonly BlockingUsageLimitClosure[],
  after: readonly BlockingUsageLimitClosure[],
): boolean {
  const changed = after.some(({ key, closure }) => {
    const previous = before.find((entry) => scopeKey(entry.key.scope) === scopeKey(key.scope));
    return closure.closedAt !== previous?.closure.closedAt;
  });
  return (
    changed ||
    before.some(
      ({ key }) => !after.some((entry) => scopeKey(entry.key.scope) === scopeKey(key.scope)),
    )
  );
}

export interface RunBudgetState {
  controller?: RunBudgetController;
  forcedStatus?: ForcedTerminalStatus;
  forcedReason?: string;
}

export type CancellationCause = NonNullable<AgentRecord["cancellation"]>["cause"];

export function cancellationForGeneration(
  record: AgentRecord,
  generation: number,
): AgentRecord["cancellation"] {
  const cancellation: AgentRecord["cancellation"] = record.cancellation;
  return cancellation?.generation === generation ? cancellation : undefined;
}

export function requireReviewAdmission(
  type: string,
  ticket: ReviewTicket | undefined,
): AgentRecord["verdictTask"] {
  const roundClass = roundClassOf(type);
  if (roundClass === undefined) return undefined;
  if (ticket?.roundClass !== undefined && ticket.roundClass !== roundClass) {
    throw new Error(admissionRequiredMessage(type));
  }
  if (!consumeReviewTicket(ticket)) throw new Error(admissionRequiredMessage(type));
  if (ticket === undefined || ticket.exemptReason !== undefined || ticket.workTask === "") {
    return undefined;
  }
  return { workTask: ticket.workTask, rootSessionId: ticket.rootSessionId };
}

export interface SpawnOptions {
  reviewTicket?: ReviewTicket;
  description: string;
  name?: string;
  resumeSessionFile?: string;
  reclaim?: { handle: string; alias?: string };
  model?: Model<Api>;
  maxTurns?: number;
  budgets?: RunBudgetLimits;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  mainSessionFork?: MainSessionFork;
  isBackground?: boolean;
  sideConversation?: boolean;
  workflowId?: string;
  workflowStepId?: string;
  readOnly?: boolean;
  bypassQueue?: boolean;
  isolation?: IsolationMode;
  hookWorktreePath?: string;
  cwd?: string;
  invocation?: AgentInvocation;
  modelProvenance?: ModelProvenance;
  onStartFailed?: (info: { id: string; alias?: string; reason: string }) => void;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
  depth?: number;
  parentAgentId?: string;
  maxSubagentDepth?: number;
  configCwd?: string;
  fastModeRequested?: boolean;
  daybreakRequested?: boolean | "auto";
  rootSessionId?: string;
  adoptWorktree?: AdoptedWorktree;
}

export interface AdoptedWorktree {
  path: string;
  branch: string;
  baseSha: string;
  repo: string;
  workPath?: string;
  hookManaged?: boolean;
}

export interface RevivalIdentity {
  id: string;
  handle?: string;
  alias?: string;
  revivals: number;
  steers?: string[];
  scoped?: string[];
  outputFile?: string;
  claim?: SessionClaim;
  rearm?: { snapshot: JournalAgentSnapshot; sessionFile: string };
}

export interface SessionClaim {
  file: string;
  token: string;
}

export interface PreparedRevival {
  snapshot: JournalAgentSnapshot;
  mode: "revive" | "rearm" | "resume";
  clean: boolean | undefined;
  revivals: number;
  type: SubagentType;
  model?: Model<Api>;
  adopt?: AdoptedWorktree;
  claim?: SessionClaim;
  freshPrompt?: string;
  steers: string[];
}

export type PrepareOutcome =
  | { kind: "ok"; prepared: PreparedRevival }
  | { kind: "failed"; reason: string; journal: boolean }
  | { kind: "stale" };

export function terminalStatusFor(run: {
  aborted?: boolean;
  failure?: string;
  steered?: boolean;
}): AgentRecord["status"] {
  if (run.aborted) return "aborted";
  if (run.failure) return "error";
  if (run.steered) return "steered";
  return "completed";
}

export function journalRunOptionsOf(
  options: SpawnOptions,
  scopedModels: string[],
): JournalRunOptions {
  const budgets = options.budgets;
  return {
    maxTurns: options.maxTurns,
    budgets:
      budgets === undefined
        ? undefined
        : {
            timeoutMs: budgets.timeoutMs,
            maxToolCalls: budgets.maxToolCalls,
            maxTokens: budgets.maxTokens,
            idleTimeoutMs: budgets.idleTimeoutMs,
          },
    thinkingLevel: options.thinkingLevel,
    isolated: options.isolated,
    inheritContext: options.inheritContext,
    isolation: options.isolation,
    cwd: options.cwd ?? undefined,
    configCwd: options.configCwd,
    isBackground: options.isBackground,
    readOnly: options.readOnly,
    sideConversation: options.sideConversation,
    workflowId: options.workflowId,
    workflowStepId: options.workflowStepId,
    maxSubagentDepth: options.maxSubagentDepth,
    fastModeRequested: options.fastModeRequested,
    daybreakRequested: options.daybreakRequested,
    scopedModels: scopedModels.length > 0 ? [...scopedModels] : undefined,
    invocation: options.invocation === undefined ? undefined : { ...options.invocation },
  };
}

export interface ResumeOptions {
  reviewTicket?: ReviewTicket;
  maxTurns?: number;
  name?: string;
  model?: string;
  fastModeRequested?: boolean;
  daybreakRequested?: boolean;
  isBackground?: boolean;
  budgets?: RunBudgetLimits;
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
  onStarted?: () => void;
}

export const USER_STOP_SETTLE_TIMEOUT_MS = 30_000;

export interface TerminalWaiter {
  generation: number;
  release: () => void;
}

export interface ManagerState {
  readonly manager: NestedAgentManager;
  agents: Map<string, AgentRecord>;
  cleanupInterval: ReturnType<typeof setInterval>;
  onComplete?: OnAgentComplete;
  onStart?: OnAgentStart;
  onCompact?: OnAgentCompact;
  onSpawned?: (id: string) => void;
  maxConcurrent: number;
  readonly runner: AgentManagerRunner;
  readonly invokeSpawn: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ) => string;
  readonly invokeStartAgent: (id: string, record: AgentRecord, args: SpawnArgs) => void;
  readonly invokeApplyResumeModel: (
    record: AgentRecord,
    session: AgentSession,
    input: string,
  ) => Promise<void>;
  disposed: boolean;
  activeRunBudgets: Set<RunBudgetController>;
  worktreeRepos: Set<string>;
  tombstones: Map<string, AgentTombstone>;
  queue: QueueEntry[];
  runningBackground: number;
  usageScopes: Map<string, UsageLimitScope>;
  usageWaits: Map<string, UsageWait>;
  wakeRuns: Map<string, number>;
  classifiedAccounts: Map<string, string>;
  resumeReservations: Set<string>;
  deferredWorktrees: Map<string, () => Promise<void>>;
  usageLimitListener?: UsageLimitListener;
  verdictScratchDir: (rootSessionId: string) => string;
  journalSink?: SubagentJournalSink;
  journalLookup?: SubagentJournalLookup;
  journalRoot?: string;
  dormant: Map<string, JournalAgentSnapshot>;
  unjournaled: Set<string>;
  sessionFileConfirmed: Set<string>;
  pendingJournal: Map<string, AgentRecord>;
  journalFlushQueued: boolean;
  lastJournaled: Map<string, string>;
  journalFailureReported: Set<string>;
  journalFailures: number;
  lastJournalError?: string;
  readonly instanceToken: string;
  sessionClaims: Map<string, SessionClaim>;
  revivalArgs: Map<string, SpawnArgs>;
  revivalReservations: Set<string>;
  terminalWaiters: Map<string, TerminalWaiter[]>;
  revivalEpoch: number;
  closureRechecks: Map<string, Promise<void>>;
}

export function createManagerState(
  manager: NestedAgentManager,
  onComplete: OnAgentComplete | undefined,
  maxConcurrent: number,
  onStart: OnAgentStart | undefined,
  onCompact: OnAgentCompact | undefined,
  getRunner: () => AgentManagerRunner,
  getRunningBackground: () => number,
  setRunningBackground: (value: number) => void,
  invokeSpawn: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ) => string,
  invokeStartAgent: (id: string, record: AgentRecord, args: SpawnArgs) => void,
  invokeApplyResumeModel: (
    record: AgentRecord,
    session: AgentSession,
    input: string,
  ) => Promise<void>,
  onCleanupTick: () => void,
): ManagerState {
  const cleanupInterval = setInterval(onCleanupTick, 60_000);
  cleanupInterval.unref();
  return {
    manager,
    agents: new Map(),
    cleanupInterval,
    onComplete,
    onStart,
    onCompact,
    maxConcurrent: normalizeMaxConcurrent(maxConcurrent),
    get runner() {
      return getRunner();
    },
    invokeSpawn,
    invokeStartAgent,
    invokeApplyResumeModel,
    disposed: false,
    activeRunBudgets: new Set(),
    worktreeRepos: new Set(),
    tombstones: new Map(),
    queue: [],
    get runningBackground() {
      return getRunningBackground();
    },
    set runningBackground(value: number) {
      setRunningBackground(value);
    },
    usageScopes: new Map(),
    usageWaits: new Map(),
    wakeRuns: new Map(),
    classifiedAccounts: new Map(),
    resumeReservations: new Set(),
    deferredWorktrees: new Map(),
    verdictScratchDir: (rootSessionId) => scratchDirForSession(rootSessionId),
    dormant: new Map(),
    unjournaled: new Set(),
    sessionFileConfirmed: new Set(),
    pendingJournal: new Map(),
    journalFlushQueued: false,
    lastJournaled: new Map(),
    journalFailureReported: new Set(),
    journalFailures: 0,
    instanceToken: randomUUID(),
    sessionClaims: new Map(),
    revivalArgs: new Map(),
    revivalReservations: new Set(),
    terminalWaiters: new Map(),
    revivalEpoch: 0,
    closureRechecks: new Map(),
  };
}

export function transition(
  mgr: ManagerState,
  record: AgentRecord,
  status: AgentRecord["status"],
): void {
  record.status = status;
  scheduleJournal(mgr, record);
}

export function publishTerminal(mgr: ManagerState, record: AgentRecord): void {
  publishTerminalResult(record);
  scheduleJournal(mgr, record);
  releaseTerminalWaiters(mgr, record);
}

export function markTerminalConsumed(mgr: ManagerState, record: AgentRecord): void {
  markResultGenerationConsumed(record);
  scheduleJournal(mgr, record);
  releaseTerminalWaiters(mgr, record);
}

export function releaseTerminalWaiters(
  mgr: ManagerState,
  record: AgentRecord,
  force = false,
): void {
  const waiters = mgr.terminalWaiters.get(record.id);
  if (waiters === undefined) return;
  const published = record.terminalResultGeneration;
  const remaining: TerminalWaiter[] = [];
  for (const waiter of waiters) {
    if (force || (published !== undefined && published >= waiter.generation)) waiter.release();
    else remaining.push(waiter);
  }
  if (remaining.length === 0) mgr.terminalWaiters.delete(record.id);
  else mgr.terminalWaiters.set(record.id, remaining);
}

export function awaitTerminal(mgr: ManagerState, record: AgentRecord): Promise<void> {
  const generation = record.resultGeneration ?? 1;
  if (
    (record.terminalResultGeneration !== undefined &&
      record.terminalResultGeneration >= generation) ||
    mgr.disposed ||
    mgr.agents.get(record.id) !== record
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(() => waiter.release(), USER_STOP_SETTLE_TIMEOUT_MS);
    timer.unref();
    const waiter: TerminalWaiter = {
      generation,
      release: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      },
    };
    mgr.terminalWaiters.set(record.id, [...(mgr.terminalWaiters.get(record.id) ?? []), waiter]);
  });
}

export function recordRoot(mgr: ManagerState, record: AgentRecord): string | undefined {
  return (
    record.admissionRoot ?? mgr.usageScopes.get(record.id)?.owner ?? mgr.journalSink?.rootSessionId
  );
}

export function requestCancellation(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  cause: CancellationCause,
  reason: string,
  abortController = record.abortController,
): boolean {
  if ((record.resultGeneration ?? 1) !== generation) return false;
  if (record.cancellation?.generation !== generation) {
    record.cancellation = { generation, cause, reason, requestedAt: Date.now() };
  }
  record.pendingSteers = undefined;
  abortController?.abort();
  return true;
}

export function armRunBudgets(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  limits: RunBudgetLimits | undefined,
  abortController: AbortController,
): RunBudgetState {
  const state: RunBudgetState = {};
  if (
    limits === undefined ||
    (limits.timeoutMs === undefined &&
      limits.maxToolCalls === undefined &&
      limits.maxTokens === undefined &&
      limits.idleTimeoutMs === undefined)
  ) {
    return state;
  }

  const controller = new RunBudgetController(limits, {
    isActive: () =>
      !mgr.disposed && record.resultGeneration === generation && record.status === "running",
    steerConclusion: (
      message = "The idle watchdog detected no tool activity. Conclude now with your current findings in the required output format.",
    ) => {
      const session = record.session;
      if (session) {
        void session.steer(message).catch(() => undefined);
      } else {
        (record.pendingSteers ??= []).push(message);
      }
    },
    stop: (status, reason) => {
      if (state.forcedStatus !== undefined) return;
      state.forcedStatus = status;
      state.forcedReason = reason;
      requestCancellation(
        mgr,
        record,
        generation,
        status === "watchdog_stopped" ? "watchdog" : "budget",
        reason,
        abortController,
      );
    },
    onDispose: (disposedController) => {
      mgr.activeRunBudgets.delete(disposedController);
    },
  });
  state.controller = controller;
  mgr.activeRunBudgets.add(controller);
  return state;
}

export function ownerToken(mgr: ManagerState, id: string, generation: number): string {
  return `${mgr.instanceToken}:${id}:${generation}`;
}

export function claimRecordSessionFile(
  mgr: ManagerState,
  record: AgentRecord,
  file: string,
  generation: number,
): boolean {
  const existing = mgr.sessionClaims.get(record.id);
  if (existing?.file === file) return true;
  const token = ownerToken(mgr, record.id, generation);
  if (!claimSessionFile(file, token)) return false;
  if (existing !== undefined) releaseSessionFile(existing.file, existing.token);
  mgr.sessionClaims.set(record.id, { file, token });
  return true;
}

export function isSuspendedGeneration(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
): boolean {
  return (
    record.resultGeneration === generation &&
    cancellationForGeneration(record, generation)?.cause === "suspend"
  );
}

export function ownsPreparedRun(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
): boolean {
  return (
    !mgr.disposed &&
    (record.resultGeneration ?? 1) === generation &&
    !isSuspendedGeneration(mgr, record, generation) &&
    record.abortController?.signal.aborted !== true
  );
}
