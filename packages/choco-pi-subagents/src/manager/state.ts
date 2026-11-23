/**
 * state.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

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

/** Narrow execution seam for deterministic manager lifecycle tests. */
export interface AgentManagerRunner {
  runAgent: typeof runAgent;
  resumeAgent: typeof resumeAgent;
  /**
   * Apply a caller-selected model to an idle child session. Defaults to
   * `session.setModel(model)`; tests inject delayed or failing authentication.
   */
  setSessionModel?: (session: AgentSession, model: Model<Api>) => Promise<void>;
}

export const DEFAULT_AGENT_MANAGER_RUNNER: AgentManagerRunner = { runAgent, resumeAgent };

/** Margin after a reported reset before the wake-up re-checks readiness. */
export const USAGE_LIMIT_RESET_MARGIN_MS = 30_000;
/** Longest single wait; a later reset re-arms after re-checking readiness. */
export const USAGE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60_000;
/** Poll cadence and bound when the provider gives no reset estimate. */
export const USAGE_LIMIT_POLL_MS = 5 * 60_000;
export const USAGE_LIMIT_MAX_POLL_MS = 6 * 60 * 60_000;
/** Closure applied when the provider gives no reset estimate. */
export const USAGE_LIMIT_DEFAULT_CLOSE_MS = 30 * 60_000;
/** Delay before a re-armed wait whose reset already passed re-checks readiness. */
export const REARM_RESET_GRACE_MS = 3_000;
/** How long a re-armed wake keeps retrying while the usage-limit policy is unregistered. */
export const REARM_POLICY_RETRY_MS = 30_000;
/** Retry cadence while waiting for the usage-limit policy to register. */
export const REARM_POLICY_POLL_MS = 2_000;
/** Bound on how long `suspendAll` waits for suspended runs to settle. */
export const SUSPEND_SETTLE_TIMEOUT_MS = 10_000;
/** Bound on how long a revival waits for another owner to release a session file. */
export const SESSION_FILE_RELEASE_TIMEOUT_MS = 15_000;

export const SUSPEND_REASON = "Suspended by the host (quit, reload, or session switch).";

/** Continuation prompt for a child resumed after its usage window reset. */
export const USAGE_LIMIT_RESUME_PROMPT =
  "The provider usage window has reset. Continue the previous task from where it stopped; do not repeat tool calls that already completed.";

/** Registry surface read by the usage-limit suggestion and resume-model paths. */
export interface UsageModelRegistry {
  getAll(): ModelEntry[];
  getAvailable?(): ModelEntry[];
  find(provider: string, modelId: string): Model<Api> | undefined;
  /** Pi's auth-type query; read only to detect openai subscription sign-in. */
  isUsingOAuth?(model: Model<Api>): boolean;
}

export type ModelRef = { provider: string; id: string };

/** Values snapshotted at spawn so settle-time decisions never touch a stale ctx. */
export interface UsageLimitScope {
  /** Root session id whose usage-limit policy governs this record. */
  owner?: string;
  cwd: string;
  modelRegistry?: UsageModelRegistry;
  /** The parent's scoped models as `provider/id`; empty means unrestricted. */
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
  /** Every account the limit closed; all of them reopen on a confirmed reset. */
  accountIds: string[];
  classification: UsageLimitClassification;
  resumeOptions: ResumeOptions;
  /**
   * Steering accepted while parked, carried into the post-reset prompt. Kept
   * here across re-parks and cleared only when a continuation actually starts,
   * so each message is delivered exactly once.
   */
  continuation: string[];
  /** Set once the wait falls back to polling (no usable reset estimate). */
  pollUntil?: number;
  /** Re-armed from the journal at startup: the policy may register late. */
  revived?: boolean;
  /** Deadline for the late-policy retry, set on the first wake without a policy. */
  policyRetryUntil?: number;
  timer?: ReturnType<typeof setTimeout>;
  parkedPromise: Promise<string>;
  release(value: string | PromiseLike<string>): void;
}

/** Raised by `resume(..., { model })` before any run state changes. */

export type UsageLimitListener = (record: AgentRecord) => void;

/**
 * Durable-revival writer. The root activation installs one per root session;
 * child-session activations never do, so their managers journal nothing.
 */
export interface SubagentJournalSink {
  /** Root session id stamped on every entry (fork/clone guard). */
  rootSessionId: string;
  /** Append one `subagent-journal` entry to the ROOT session file. */
  append(data: SubagentJournalData): void;
  /** Optional diagnostic, called at most once per record when journaling fails. */
  reportError?(agentId: string, error: Error): void;
}

/** Background callbacks a revived run streams into (mirrors a background spawn's). */
export interface RevivalRunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

export type RevivalReportKind = "revived" | "rearmed" | "capped" | "failed" | "skipped";

/** One revival outcome, for the main-session notification U5 renders. */
export interface RevivalReport {
  kind: RevivalReportKind;
  agentId: string;
  handle?: string;
  description: string;
  parentAgentId?: string;
  message: string;
}

/** Outcome of resolving a saved agent type under spawn's dispatch rules. */
export type RevivalTypeResolution = { ok: true; type: string } | { ok: false; message: string };

/** What a revival needs from the activation that owns the root session. */
export interface RevivalContext {
  pi: ExtensionAPI;
  /** The current root session's context (cwd, model registry, session id). */
  ctx: ExtensionContext;
  /**
   * Agent-type resolution with spawn's dispatch rules (index.ts:
   * `reloadCustomAgents()` + `resolveSpawnType`). Omitted accepts the type.
   * May be async: the reload reads agent files without blocking.
   */
  resolveType?: (type: string) => RevivalTypeResolution | Promise<RevivalTypeResolution>;
  /** Per-agent background callbacks (activity tracker, transcript streaming). */
  callbacksFor?: (snapshot: JournalAgentSnapshot) => RevivalRunCallbacks;
  /** Called synchronously once a revived record is live (join mode, output file). */
  onRevived?: (record: AgentRecord) => void;
  /** Every revival outcome, in order. */
  onRevivalReport?: (report: RevivalReport) => void;
}

/** A reduced journal snapshot (`reduceJournal` values satisfy it). */
export type RevivalSnapshot = Pick<SubagentJournalData, "suspended" | "agent">;

/** Outcome of `suspendAll`. */
export interface SuspendSummary {
  /** Journaled records suspended for revival. */
  suspended: string[];
  /** Suspended runs that did not settle within `SUSPEND_SETTLE_TIMEOUT_MS`. */
  unsettled: string[];
  /** Records outside the journal stopped with today's shutdown semantics. */
  aborted: number;
}

/** Lookup for journaled snapshots the in-memory dormant map no longer holds. */
export type SubagentJournalLookup = (id: string) => JournalAgentSnapshot | undefined;

/** Journal failure counters, for diagnostics and tests. */
export interface SubagentJournalHealth {
  failures: number;
  lastError?: string;
}

/**
 * Bound on dormant snapshots kept in memory (oldest inserted dropped first).
 * Each is at most two 64 KiB texts plus small fields; the session file stays
 * the source of truth and `setJournalLookup` covers anything dropped.
 */
export const MAX_DORMANT = 500;

/** Statuses whose generation has no final outcome yet. */
export function isUnsettledStatus(status: AgentRecord["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_reset" ||
    status === "interrupted"
  );
}

/** The child session already holds an assistant message, so its file exists. */
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
    // Older hosts and test fixtures omit scopedModels; widen before reading.
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

/** Parking is limited to records whose resume path preserves every invariant. */
export function canParkForReset(record: AgentRecord): boolean {
  // Workflow steps and /btw answers have single-shot aggregate delivery, so
  // both are reported instead. Worktree runs park; their worktree is kept until
  // the final settle (see `deferredWorktrees`).
  return record.workflowId === undefined && !record.sideConversation;
}

/**
 * `confirmed`: exhaustion confirmed, parking allowed. `unconfirmed`: an explicit
 * provider limit that corroboration could not confirm; reported and closed, never
 * parked. `transient`: not a usage limit (capacity reported, or an inferred limit
 * without confirmation); handled as an ordinary transient failure. A billing
 * failure is always reported, whatever the evidence: it never resets on its own
 * and the host already refuses to retry it.
 */
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
  // Policies without the evidence field: `ready` means capacity is available.
  if (evidence === undefined && corroboration?.ready === true) return "transient";
  // A bare 429 is only a usage limit when exhaustion is confirmed.
  if (classification.confidence === "inferred") return "transient";
  // Explicit provider limit text, answered "not ready" by a policy that predates
  // the evidence field: the only confirmation such a policy can give.
  if (evidence === undefined && corroboration !== undefined) return "confirmed";
  return "unconfirmed";
}

export function accountKey(owner: string, providerKey: string): string {
  return `${owner}\u0000${providerKey}`;
}

/**
 * Apply the Codex provider's structured limit entry from the failing child's
 * own branch. The entry is appended on that session's errored `message_end`,
 * so the root branch never carries it for a child failure. Provider `openai`
 * (ChatGPT sign-in on api.openai.com) gets the same entry, without a reset
 * time, only for the subscription usage-limit code in this failure's text.
 */
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

/**
 * The failing child's own session id, so the owner's policy never enriches a
 * child classification from the root branch. A child without a readable
 * session id gets a record-scoped marker that can never equal a root session.
 */
/** The root session id a host context belongs to; undefined for stubs without one. */
export function sessionRootOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/**
 * Start time of the session's last request when it succeeded, or undefined
 * when the last assistant message failed, was aborted, or does not exist.
 */
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

/** Terminal handling for a queued entry that never started (stop, shutdown, drop). */
export type QueuedFinalizer = (notify: boolean) => void;

/** A background start waiting for a concurrency slot. */
export interface QueueEntry {
  id: string;
  providerKey: string;
  /** Model the start runs on, so a model-scoped closure gates only the models it covers. */
  modelId?: string;
  start: () => void;
  /**
   * Post-reset continuation only: owns the parked task's promise and final
   * notification while queued, so every queued terminal path must call it.
   */
  finalize?: QueuedFinalizer;
  /**
   * Post-reset continuation only: return the task to `waiting_for_reset`
   * when its provider account was closed again by a usage limit while queued.
   */
  repark?: () => void;
  /** Post-reset continuation only: the wait it continues (for a suspend write). */
  wait?: UsageWait;
}

/** One record a graceful suspend journals and cancels. */
export interface SuspendPlan {
  record: AgentRecord;
  status: "interrupted" | "waiting_for_reset";
  wait?: UsageWait;
  queueEntry?: QueueEntry;
}

export interface SuspendPlanResult {
  suspended: AgentRecord[];
  /** Suspended records whose run must still settle. */
  running: AgentRecord[];
}

/** Notice appended to a result whose worktree was kept after a cancellation. */
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

/** Default max concurrent background agents. */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
export const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
export type SpawnCwdInput =
  | string
  | number
  | boolean
  | null
  | SpawnCwdInput[]
  | { [key: string]: SpawnCwdInput }
  | undefined;

/**
 * Synchronous half of the check: unset, or an absolute path string. The
 * directory check is asynchronous ({@link assertSpawnCwdDirectory}); a run
 * performs it before it starts, and async entry points (RPC) can run
 * {@link validateSpawnCwd} before spawning to fail at the call.
 */
export function assertAbsoluteSpawnCwd(
  cwd: SpawnCwdInput,
): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (!isString(cwd) || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
}

/** Reject unless `cwd` names an existing directory, with the curated errors. */
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

/** Full validation of a caller-supplied SpawnOptions.cwd, for async callers that spawn next. */
export async function validateSpawnCwd(cwd: SpawnCwdInput): Promise<void> {
  assertAbsoluteSpawnCwd(cwd);
  if (cwd != null) await assertSpawnCwdDirectory(cwd);
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
export function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId">,
): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}

export function isBudgetedToolActivity(activity: ToolActivity): boolean {
  return activity.type === "start" || !activity.toolName.includes("-error:");
}

/**
 * Estimated first-request size of a freshly created child session: its system
 * prompt plus the schemas of the tools it will declare. Read through a partial
 * view because test doubles and older hosts may omit these members.
 */
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

/** Model id a spawn runs on (the same source as `providerKeyFor`), if known. */
export function modelIdFor(options: SpawnOptions, ctx: ExtensionContext): string | undefined {
  return options.model !== undefined ? options.model.id : ctx.model?.id;
}

/**
 * Whether the closures changed while a re-check was in flight: one in
 * `after` is new or was rewritten, or one in `before` was removed (a success
 * reopened it). Either is newer evidence than the re-check's reading.
 */
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

/**
 * Fail-closed round gate: a review-role or verification-role launch must carry
 * a one-shot ticket issued by `ReviewRoundStore.admit` for that role's class
 * (or `issueExemptTicket`). Throws before any record, queue or run state
 * changes. Resolves the work task the run is verdict-recorded under (none for
 * ungated roles and exempt tickets).
 */
export function requireReviewAdmission(
  type: string,
  ticket: ReviewTicket | undefined,
): AgentRecord["verdictTask"] {
  const roundClass = roundClassOf(type);
  if (roundClass === undefined) return undefined;
  // A round admitted for the other class cannot start this role.
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
  /** One-shot review-round admission ticket; required for review-role types. */
  reviewTicket?: ReviewTicket;
  description: string;
  /**
   * Optional goal-derived name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  model?: Model<Api>;
  maxTurns?: number;
  budgets?: RunBudgetLimits;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Internal /btw capability: cloned main-agent state and identity. */
  mainSessionFork?: MainSessionFork;
  isBackground?: boolean;
  /** Orchestrator-owned BTW side conversation marker. */
  sideConversation?: boolean;
  /** Aggregate workflow identity; issued only by the root workflow scheduler. */
  workflowId?: string;
  workflowStepId?: string;
  /** Restrict the child session to read/grep/find/ls and no extensions. */
  readOnly?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Internal path returned by a Claude-compatible WorktreeCreate hook. */
  hookWorktreePath?: string;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Model/thinking/definition provenance resolved by the spawning tool. */
  modelProvenance?: ModelProvenance;
  /**
   * Called when a created record is torn down because its start threw
   * synchronously, before the error propagates — the only moment its id and
   * alias still exist for the caller to journal.
   */
  onStartFailed?: (info: { id: string; alias?: string; reason: string }) => void;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Explicit request; omitted snapshots the immediate parent's current request. */
  fastModeRequested?: boolean;
  daybreakRequested?: boolean | "auto";
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
  /**
   * Internal revival capability: run in this existing worktree instead of
   * creating one. Its final settle cleans it up like a created worktree.
   */
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

/** Identity a revival reuses instead of allocating a new one. */
export interface RevivalIdentity {
  id: string;
  handle?: string;
  alias?: string;
  revivals: number;
  /** Steering carried into the new session (fresh restarts). */
  steers?: string[];
  /** Parent scoped models (`provider/id`) captured at the original spawn. */
  scoped?: string[];
  outputFile?: string;
  /** Session-file claim already taken for this id. */
  claim?: SessionClaim;
  /** Re-arm a usage wait instead of starting a run. */
  rearm?: { snapshot: JournalAgentSnapshot; sessionFile: string };
}

export interface SessionClaim {
  file: string;
  token: string;
}

/** Validated inputs for one revival, with its session-file claim held. */
export interface PreparedRevival {
  snapshot: JournalAgentSnapshot;
  mode: "revive" | "rearm" | "resume";
  clean: boolean | undefined;
  revivals: number;
  type: SubagentType;
  model?: Model<Api>;
  adopt?: AdoptedWorktree;
  claim?: SessionClaim;
  /** Original prompt for a fresh restart (no session file). */
  freshPrompt?: string;
  steers: string[];
}

export type PrepareOutcome =
  | { kind: "ok"; prepared: PreparedRevival }
  /** `journal`: a permanent failure recorded as an error; otherwise left dormant. */
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

/**
 * Serializable subset of the options a spawn ran with, for the journal.
 * `readOnly` is carried so a revival can never widen a restricted child.
 */
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
    // RPC callers may send null for "unset".
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
  /** One-shot review-round admission ticket; required to resume a review-role agent. */
  reviewTicket?: ReviewTicket;
  maxTurns?: number;
  /** Rebind the accepted record's alias for this resumed run. */
  name?: string;
  /**
   * Continue on another model (`provider/id`), e.g. after a usage limit.
   * Validated against the registry, scope, and provider closures, then applied
   * with `session.setModel`; failures throw `ResumeModelError` before any run
   * state changes.
   */
  model?: string;
  fastModeRequested?: boolean;
  daybreakRequested?: boolean;
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  budgets?: RunBudgetLimits;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Longest a user stop waits for a stopped run to publish its terminal generation. */
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

/** The only status writer: every transition is journaled. */
export function transition(
  mgr: ManagerState,
  record: AgentRecord,
  status: AgentRecord["status"],
): void {
  record.status = status;
  scheduleJournal(mgr, record);
}

/**
 * Publish a terminal generation and journal it: a settle after an explicit
 * stop fills result/error without another status write.
 */
export function publishTerminal(mgr: ManagerState, record: AgentRecord): void {
  publishTerminalResult(record);
  scheduleJournal(mgr, record);
  releaseTerminalWaiters(mgr, record);
}

/** Publish an inline-consumed terminal generation and journal it. */
export function markTerminalConsumed(mgr: ManagerState, record: AgentRecord): void {
  markResultGenerationConsumed(record);
  scheduleJournal(mgr, record);
  releaseTerminalWaiters(mgr, record);
}

/** Resolve every user-stop waiter whose generation has now been published. */
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

/**
 * Resolves when `record` publishes the terminal generation it holds now. Bounded, so a
 * run that never settles cannot hold a /stop report open forever.
 */
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

/** Terminal state for a queued record that will never start. */
/** Root session a record belongs to for stop-control purposes. */
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

// ---- Durable revival: session-file ownership ----

export function ownerToken(mgr: ManagerState, id: string, generation: number): string {
  return `${mgr.instanceToken}:${id}:${generation}`;
}

/**
 * Claim the record's child session file once its path is known. An existing
 * claim on the same file (a revival's pre-claim) is kept. Returns false when
 * another owner holds the file.
 */
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

// ---- Durable revival: graceful suspend ----

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

/**
 * Whether a run that awaited its preparation (cwd check, worktree creation)
 * still owns the record: same generation, not suspended, not cancelled, and
 * the manager is not disposed.
 */
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
