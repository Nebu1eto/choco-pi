/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway), and so do
 * nested children — see `occupiesPoolSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  resolveAgentMaxTurns,
  resumeAgent,
  runAgent,
  type MainSessionFork,
  type ToolActivity,
} from "./agent-runner.ts";
import { unregisterChildSessionId } from "./child-context.ts";
import { cleanupChildSessionOwner, emitChildSessionShutdown } from "./child-session-cleanup.ts";
import { setSessionFastMode, snapshotFastMode } from "./fast-mode-bridge.ts";
import { setSessionDaybreak, snapshotDaybreak } from "./daybreak-bridge.ts";
import { normalizeMaxConcurrent, schedulingMaxConcurrent } from "./limits.ts";
import { assignHandle, handleBase } from "./mention.ts";
import type { ModelEntry } from "./model-resolver.ts";
import { checkModelScope } from "./model-scope.ts";
import { ResumeModelError } from "./resume-model-error.ts";
import {
  classifyTerminalFailure,
  clearUsageLimitClosure,
  closeUntil,
  isAvailable,
  ProviderUnavailableError,
  providerUnavailableMessage,
  recordFailure,
  recordSuccess,
  retryAfterMsFromFailure,
  usageLimitClosure,
  type UsageLimitClosure,
} from "./provider-health.ts";
import {
  beginResultGeneration,
  markResultGenerationConsumed,
  publishTerminalResult,
} from "./result-read.ts";
import {
  RunBudgetController,
  type ForcedTerminalStatus,
  type RunBudgetLimits,
} from "./run-budgets.ts";
import {
  buildInterruptionPrompt,
  buildJournalData,
  CAPPED_REVIVAL_ERROR,
  journalClassificationOf,
  JournalAgentSnapshotSchema,
  startupDisposition,
  usageClassificationOf,
  type InterruptedChildRun,
  type JournalAgentSnapshot,
  type JournalRunOptions,
  type SubagentJournalData,
} from "./revival-journal.ts";
import {
  claimSessionFile,
  releaseSessionFile,
  waitForSessionFileRelease,
} from "./session-file-ownership.ts";
import { probeWorktree } from "./worktree-probe.ts";
import { getSessionCostBaseline } from "./usage.ts";
import type {
  AgentInvocation,
  AgentRecord,
  AgentTombstone,
  IsolationMode,
  MentionResolution,
  SubagentUsageLimit,
  SubagentType,
  ThinkingLevel,
} from "./types.ts";
import {
  accountIdWithPolicy,
  classifyWithPolicy,
  closeProviderWithPolicy,
  corroborateWithPolicy,
  describeUsageLimit,
  isClosedWithPolicy,
  latestCodexUsageLimitEntry,
  pickFallbackWithPolicy,
  preferenceFromPolicy,
  readUsageLimitPolicy,
  type Corroboration,
  type UsageLimitClassification,
  type UsageLimitPolicy,
} from "./usage-limit-seam.ts";
import { addUsage } from "./usage.ts";
import {
  adoptHookWorktree,
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
} from "./worktree.ts";

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

const DEFAULT_AGENT_MANAGER_RUNNER: AgentManagerRunner = { runAgent, resumeAgent };

/** Margin after a reported reset before the wake-up re-checks readiness. */
const USAGE_LIMIT_RESET_MARGIN_MS = 30_000;
/** Longest single wait; a later reset re-arms after re-checking readiness. */
const USAGE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60_000;
/** Poll cadence and bound when the provider gives no reset estimate. */
const USAGE_LIMIT_POLL_MS = 5 * 60_000;
const USAGE_LIMIT_MAX_POLL_MS = 6 * 60 * 60_000;
/** Closure applied when the provider gives no reset estimate. */
const USAGE_LIMIT_DEFAULT_CLOSE_MS = 30 * 60_000;
/** Delay before a re-armed wait whose reset already passed re-checks readiness. */
export const REARM_RESET_GRACE_MS = 3_000;
/** How long a re-armed wake keeps retrying while the usage-limit policy is unregistered. */
export const REARM_POLICY_RETRY_MS = 30_000;
/** Retry cadence while waiting for the usage-limit policy to register. */
const REARM_POLICY_POLL_MS = 2_000;
/** Bound on how long `suspendAll` waits for suspended runs to settle. */
export const SUSPEND_SETTLE_TIMEOUT_MS = 10_000;
/** Bound on how long a revival waits for another owner to release a session file. */
export const SESSION_FILE_RELEASE_TIMEOUT_MS = 15_000;

const SUSPEND_REASON = "Suspended by the host (quit, reload, or session switch).";

/** Continuation prompt for a child resumed after its usage window reset. */
export const USAGE_LIMIT_RESUME_PROMPT =
  "The provider usage window has reset. Continue the previous task from where it stopped; do not repeat tool calls that already completed.";

/** Registry surface read by the usage-limit suggestion and resume-model paths. */
interface UsageModelRegistry {
  getAll(): ModelEntry[];
  getAvailable?(): ModelEntry[];
  find(provider: string, modelId: string): Model<Api> | undefined;
}

type ModelRef = { provider: string; id: string };

/** Values snapshotted at spawn so settle-time decisions never touch a stale ctx. */
interface UsageLimitScope {
  /** Root session id whose usage-limit policy governs this record. */
  owner?: string;
  cwd: string;
  modelRegistry?: UsageModelRegistry;
  /** The parent's scoped models as `provider/id`; empty means unrestricted. */
  scoped: string[];
}

interface UsageLimitDecision {
  usageLimit: SubagentUsageLimit;
  classification: UsageLimitClassification;
  accountIds: string[];
  park: boolean;
}

interface UsageWait {
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
export { ResumeModelError };

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

/** What a revival needs from the activation that owns the root session. */
export interface RevivalContext {
  pi: ExtensionAPI;
  /** The current root session's context (cwd, model registry, session id). */
  ctx: ExtensionContext;
  /**
   * Agent-type resolution with spawn's dispatch rules (index.ts:
   * `reloadCustomAgents()` + `resolveSpawnType`). Omitted accepts the type.
   */
  resolveType?: (type: string) => { ok: true; type: string } | { ok: false; message: string };
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
const MAX_DORMANT = 500;

/** Statuses whose generation has no final outcome yet. */
function isUnsettledStatus(status: AgentRecord["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_reset" ||
    status === "interrupted"
  );
}

/** The child session already holds an assistant message, so its file exists. */
function sessionHasAssistantMessage(session: AgentSession | undefined): boolean {
  if (session === undefined) return false;
  try {
    return session.messages.some((message) => message.role === "assistant");
  } catch {
    return false;
  }
}

function modelRefOf(model: ModelRef | undefined): ModelRef | undefined {
  return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

function scopedModelKeys(ctx: ExtensionContext): string[] {
  try {
    // Older hosts and test fixtures omit scopedModels; widen before reading.
    const scoped: ExtensionContext["scopedModels"] | undefined = ctx.scopedModels;
    if (scoped === undefined) return [];
    return scoped.map((entry) => `${entry.model.provider}/${entry.model.id}`);
  } catch {
    return [];
  }
}

function withUsageLimitNote(failure: string, usageLimit: SubagentUsageLimit): string {
  return `${failure}\n\nUsage limit: ${describeUsageLimit(usageLimit)}.`;
}

/** Parking is limited to records whose resume path preserves every invariant. */
function canParkForReset(record: AgentRecord): boolean {
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
type UsageLimitVerdict = "confirmed" | "unconfirmed" | "transient";

function corroborationVerdict(
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

function accountKey(owner: string, providerKey: string): string {
  return `${owner}\u0000${providerKey}`;
}

/**
 * Apply the Codex provider's structured limit entry from the failing child's
 * own branch. The entry is appended on that session's errored `message_end`,
 * so the root branch never carries it for a child failure.
 */
function withCodexUsageEntry(
  classification: UsageLimitClassification,
  model: ModelRef,
  session: AgentSession | undefined,
  failedAt: number,
): UsageLimitClassification {
  if (session === undefined || model.provider.toLowerCase() !== "openai-codex") {
    return classification;
  }
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
function childSessionId(record: AgentRecord, session: AgentSession | undefined): string {
  let sessionId: string | undefined;
  try {
    sessionId = session?.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  return sessionId !== undefined && sessionId !== "" ? sessionId : `subagent:${record.id}`;
}

function withSessionId(
  classification: UsageLimitClassification,
  sessionId: string | undefined,
): UsageLimitClassification {
  return sessionId === undefined ? classification : { ...classification, sessionId };
}

/** Terminal handling for a queued entry that never started (stop, shutdown, drop). */
type QueuedFinalizer = (notify: boolean) => void;

/** A background start waiting for a concurrency slot. */
interface QueueEntry {
  id: string;
  providerKey: string;
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
interface SuspendPlan {
  record: AgentRecord;
  status: "interrupted" | "waiting_for_reset";
  wait?: UsageWait;
  queueEntry?: QueueEntry;
}

interface SuspendPlanResult {
  suspended: AgentRecord[];
  /** Suspended records whose run must still settle. */
  running: AgentRecord[];
}

async function removeHookWorktree(pi: ExtensionAPI, path: string): Promise<void> {
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
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
type SpawnCwdInput =
  | string
  | number
  | boolean
  | null
  | SpawnCwdInput[]
  | { [key: string]: SpawnCwdInput }
  | undefined;

const SpawnCwdSchema = Type.String();

function assertValidSpawnCwd(cwd: SpawnCwdInput): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (!Value.Check(SpawnCwdSchema, cwd) || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
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
function occupiesPoolSlot(record: Pick<AgentRecord, "isBackground" | "parentAgentId">): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}

function isBudgetedToolActivity(activity: ToolActivity): boolean {
  return activity.type === "start" || !activity.toolName.includes("-error:");
}

function ownsUnsettledGeneration(record: AgentRecord): boolean {
  return (
    record.status === "running" ||
    record.status === "queued" ||
    (record.resultGeneration !== undefined &&
      record.terminalResultGeneration !== record.resultGeneration)
  );
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

function providerKeyFor(options: SpawnOptions, ctx: ExtensionContext): string {
  return (options.model?.provider ?? ctx.model?.provider ?? "unknown").toLowerCase();
}

interface RunBudgetState {
  controller?: RunBudgetController;
  forcedStatus?: ForcedTerminalStatus;
  forcedReason?: string;
}

type CancellationCause = NonNullable<AgentRecord["cancellation"]>["cause"];

function cancellationForGeneration(
  record: AgentRecord,
  generation: number,
): AgentRecord["cancellation"] {
  const cancellation: AgentRecord["cancellation"] = record.cancellation;
  return cancellation?.generation === generation ? cancellation : undefined;
}

interface SpawnOptions {
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
  model?: Model<any>;
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

interface AdoptedWorktree {
  path: string;
  branch: string;
  baseSha: string;
  repo: string;
  workPath?: string;
  hookManaged?: boolean;
}

/** Identity a revival reuses instead of allocating a new one. */
interface RevivalIdentity {
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

interface SessionClaim {
  file: string;
  token: string;
}

/** Validated inputs for one revival, with its session-file claim held. */
interface PreparedRevival {
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

type PrepareOutcome =
  | { kind: "ok"; prepared: PreparedRevival }
  /** `journal`: a permanent failure recorded as an error; otherwise left dormant. */
  | { kind: "failed"; reason: string; journal: boolean }
  | { kind: "stale" };

function terminalStatusFor(run: {
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
function journalRunOptionsOf(options: SpawnOptions, scopedModels: string[]): JournalRunOptions {
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

interface ResumeOptions {
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

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  private runner: AgentManagerRunner;
  private disposed = false;
  private activeRunBudgets = new Set<RunBudgetController>();
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /** Queue of background agents waiting to start. */
  private queue: QueueEntry[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Usage-limit inputs snapshotted per record at spawn. */
  private usageScopes = new Map<string, UsageLimitScope>();
  /** Records parked in `waiting_for_reset`, keyed by id. */
  private usageWaits = new Map<string, UsageWait>();
  /** Generation of a record's post-reset continuation run. */
  private wakeRuns = new Map<string, number>();
  /** Account id last classified per owner+provider; availability checks use it. */
  private classifiedAccounts = new Map<string, string>();
  /** Records whose resume() holds exclusive ownership across its async model switch. */
  private resumeReservations = new Set<string>();
  /** Worktree cleanup deferred by a parked spawn; runs on the task's final settle. */
  private deferredWorktrees = new Map<string, () => void>();
  private usageLimitListener?: UsageLimitListener;

  /** Durable-revival writer; undefined (child managers, tests) journals nothing. */
  private journalSink?: SubagentJournalSink;
  /** Fallback for dormant snapshots evicted from (or never loaded into) memory. */
  private journalLookup?: SubagentJournalLookup;
  /** Root session the dormant map and journal bookkeeping belong to. */
  private journalRoot?: string;
  /**
   * Evicted journaled terminal records, keyed by id, insertion-ordered so the
   * oldest is dropped first past `MAX_DORMANT`. Never part of the live views
   * (`agents`, `listAgents`, concurrency counts, `getRecord`).
   */
  private dormant = new Map<string, JournalAgentSnapshot>();
  /** Records excluded from revival: workflow steps, /btw, and their descendants. */
  private unjournaled = new Set<string>();
  /** Records whose child session file is known to hold the conversation. */
  private sessionFileConfirmed = new Set<string>();
  /** Records changed since the last flush; flushed together in one microtask. */
  private pendingJournal = new Map<string, AgentRecord>();
  private journalFlushQueued = false;
  /** Last appended snapshot per record (serialized), to skip identical writes. */
  private lastJournaled = new Map<string, string>();
  private journalFailureReported = new Set<string>();
  private journalFailures = 0;
  private lastJournalError?: string;

  /** Distinguishes this instance's session-file claims from a reloaded one's. */
  private readonly instanceToken = randomUUID();
  /** Session-file claim held per record id. */
  private sessionClaims = new Map<string, SessionClaim>();
  /** Spawn inputs of re-armed records with no session yet (wake reopens the file). */
  private revivalArgs = new Map<string, SpawnArgs>();
  /** Ids with a revival or dormant resume in flight. */
  private revivalReservations = new Set<string>();
  /** Bumped by dispose, suspend and root switches; stale revivals stop. */
  private revivalEpoch = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    runner: AgentManagerRunner = DEFAULT_AGENT_MANAGER_RUNNER,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.runner = runner;
    this.maxConcurrent = normalizeMaxConcurrent(maxConcurrent);
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = normalizeMaxConcurrent(n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Concrete scheduler bound; configured 0 remains displayable as unlimited. */
  getSchedulingMaxConcurrent(): number {
    return schedulingMaxConcurrent(this.maxConcurrent);
  }

  isProviderAvailable(providerKey: string, owner?: string): boolean {
    return this.providerBlock(providerKey, owner) === undefined;
  }

  /** Refusal text for `providerKey` under `owner`, with any usage-limit details. */
  providerUnavailableMessage(providerKey: string, owner?: string): string {
    const key = providerKey.toLowerCase();
    return providerUnavailableMessage(key, this.providerBlock(key, owner)?.closure);
  }

  private unavailableError(providerKey: string, owner: string | undefined): Error {
    const key = providerKey.toLowerCase();
    return new ProviderUnavailableError(key, this.providerBlock(key, owner)?.closure);
  }

  /**
   * Account key for `owner`'s closures on `providerKey`: the owner policy's
   * current account when it answers, else the account last classified for this
   * owner and provider, else `"default"`. Availability checks and closure
   * writes both use it, so a root closure and a manager closure share a key.
   */
  private accountFor(
    owner: string,
    providerKey: string,
    policy: UsageLimitPolicy | undefined = readUsageLimitPolicy(owner),
  ): string {
    const key = providerKey.toLowerCase();
    const fromPolicy = policy === undefined ? undefined : accountIdWithPolicy(policy, key);
    return fromPolicy ?? this.classifiedAccounts.get(accountKey(owner, key)) ?? "default";
  }

  /**
   * Why `providerKey` is closed for `owner`, or undefined when it is open. The
   * owner's usage-limit closures (policy first, then the manager's own record of
   * them, which carries the reset time and suggestion) are consulted before the
   * process-global transient registry. Other owners and accounts never block.
   * `usage` is true when a usage-limit closure (not a transient one) blocks.
   */
  private providerBlock(
    providerKey: string,
    owner: string | undefined,
  ): { closure?: UsageLimitClosure; usage: boolean } | undefined {
    const key = providerKey.toLowerCase();
    if (owner !== undefined) {
      const policy = readUsageLimitPolicy(owner);
      const accountId = this.accountFor(owner, key, policy);
      const closure = usageLimitClosure({ owner, providerKey: key, accountId });
      if (policy !== undefined && isClosedWithPolicy(policy, key, accountId)) {
        return { closure, usage: true };
      }
      if (closure !== undefined) return { closure, usage: true };
    }
    return isAvailable(key) ? undefined : { usage: false };
  }

  /** Observe usage-limit transitions (reported, parked, resumed, exhausted). */
  setUsageLimitListener(listener: UsageLimitListener | undefined): void {
    this.usageLimitListener = listener;
  }

  private notifyUsageLimit(record: AgentRecord): void {
    if (this.disposed || record.usageLimit === undefined) return;
    try {
      this.usageLimitListener?.(record);
    } catch {
      /* ignore observer errors */
    }
  }

  // ---- Durable revival journal (writer side) ----

  /**
   * Install or remove the journal writer. A different root session clears the
   * dormant map, the lookup, and the dedupe state: they describe another
   * session's file. Removing the sink keeps them, but hides dormant entries.
   */
  setJournalSink(sink: SubagentJournalSink | undefined): void {
    const root = sink?.rootSessionId;
    if (root !== undefined && root !== this.journalRoot) {
      this.dormant.clear();
      this.lastJournaled.clear();
      this.journalLookup = undefined;
      this.journalRoot = root;
      this.revivalEpoch++;
    }
    this.journalSink = sink;
  }

  /** Fallback consulted by `getDormant` when the in-memory map misses. */
  setJournalLookup(lookup: SubagentJournalLookup | undefined): void {
    this.journalLookup = lookup;
  }

  /** Journaling failures since construction, for diagnostics and tests. */
  getJournalHealth(): SubagentJournalHealth {
    return { failures: this.journalFailures, lastError: this.lastJournalError };
  }

  /**
   * Re-journal a live record after a change made outside the manager (a
   * result read flipping `resultConsumed`). Returns false for an unknown id.
   */
  journalRecord(id: string): boolean {
    const record = this.agents.get(id);
    if (record === undefined) return false;
    this.scheduleJournal(record);
    return true;
  }

  /** Set a live record's consecutive unclean-revival count and journal it. */
  setRevivals(id: string, revivals: number): boolean {
    const record = this.agents.get(id);
    if (record === undefined || !Number.isInteger(revivals) || revivals < 0) return false;
    record.revivals = revivals;
    this.scheduleJournal(record);
    return true;
  }

  /**
   * Load dormant snapshots (startup: terminal snapshots of the current root).
   * Call after `setJournalSink` for that root. Invalid snapshots and ids that
   * are live are skipped. Returns how many were stored.
   */
  hydrateDormant(snapshots: Iterable<JournalAgentSnapshot>): number {
    let stored = 0;
    for (const snapshot of snapshots) {
      if (!Value.Check(JournalAgentSnapshotSchema, snapshot)) continue;
      if (this.putDormant(snapshot)) stored++;
    }
    return stored;
  }

  /** Dormant snapshot by id; undefined while a live record holds the id or no sink is set. */
  getDormant(id: string): JournalAgentSnapshot | undefined {
    if (this.journalSink === undefined || this.agents.has(id)) return undefined;
    const stored = this.dormant.get(id);
    if (stored !== undefined) return stored;
    let found: JournalAgentSnapshot | undefined;
    try {
      found = this.journalLookup?.(id);
    } catch {
      return undefined;
    }
    return found !== undefined && found.id === id && Value.Check(JournalAgentSnapshotSchema, found)
      ? found
      : undefined;
  }

  /**
   * Newest top-level dormant snapshot whose handle or alias matches
   * case-insensitively, or whose id matches exactly. In-memory map only.
   */
  findDormantByHandle(handleOrAlias: string): JournalAgentSnapshot | undefined {
    if (this.journalSink === undefined) return undefined;
    const wanted = handleOrAlias.toLowerCase();
    let match: JournalAgentSnapshot | undefined;
    for (const entry of this.dormant.values()) {
      if (entry.parentAgentId !== undefined || this.agents.has(entry.id)) continue;
      if (
        entry.handle?.toLowerCase() === wanted ||
        entry.alias?.toLowerCase() === wanted ||
        entry.id === handleOrAlias
      ) {
        match = entry;
      }
    }
    return match;
  }

  /** Record that a dormant agent's result was read, and journal it. */
  markDormantResultConsumed(id: string): boolean {
    const sink = this.journalSink;
    const entry = this.getDormant(id);
    if (sink === undefined || entry === undefined) return false;
    if (entry.resultConsumed) return true;
    const updated: JournalAgentSnapshot = { ...entry, resultConsumed: true };
    this.putDormant(updated);
    try {
      sink.append(
        buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: updated }),
      );
    } catch (err) {
      this.noteJournalFailure(sink, id, err instanceof Error ? err : new Error(String(err)));
    }
    return true;
  }

  /**
   * Explicit stop of a dormant agent that has no run (interrupted, parked or
   * never revived): journal it `stopped` with `stoppedByUser` so no startup
   * revives it. Returns the stopped snapshot, or undefined when the id is
   * live, being revived, unknown, or already terminal.
   */
  stopDormant(id: string): JournalAgentSnapshot | undefined {
    const sink = this.journalSink;
    if (sink === undefined || this.disposed || this.revivalReservations.has(id)) return undefined;
    const entry = this.getDormant(id);
    if (entry === undefined || !isUnsettledStatus(entry.status)) return undefined;
    const stopped: JournalAgentSnapshot = {
      ...entry,
      status: "stopped",
      stoppedByUser: true,
      error: entry.error ?? "Stopped by user request while not running.",
      usageWait: undefined,
      steers: undefined,
    };
    this.putDormant(stopped);
    try {
      sink.append(
        buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: stopped }),
      );
    } catch (err) {
      this.noteJournalFailure(sink, id, err instanceof Error ? err : new Error(String(err)));
    }
    return stopped;
  }

  /** Whether a startup revival or dormant resume currently holds `id`. */
  isRevivalPending(id: string): boolean {
    return this.revivalReservations.has(id);
  }

  /** The only status writer: every transition is journaled. */
  private transition(record: AgentRecord, status: AgentRecord["status"]): void {
    record.status = status;
    this.scheduleJournal(record);
  }

  /**
   * Publish a terminal generation and journal it: a settle after an explicit
   * stop fills result/error without another status write.
   */
  private publishTerminal(record: AgentRecord): void {
    publishTerminalResult(record);
    this.scheduleJournal(record);
  }

  /** Publish an inline-consumed terminal generation and journal it. */
  private markTerminalConsumed(record: AgentRecord): void {
    markResultGenerationConsumed(record);
    this.scheduleJournal(record);
  }

  /**
   * Queue a journal write. Writes are coalesced in one microtask so a settle
   * path that sets status, then error/result/consumption synchronously, lands
   * as one complete entry. The microtask runs before any I/O callback, so the
   * entry precedes the run's first provider call.
   */
  private scheduleJournal(record: AgentRecord): void {
    if (this.journalSink === undefined || this.disposed) return;
    this.pendingJournal.set(record.id, record);
    if (this.journalFlushQueued) return;
    this.journalFlushQueued = true;
    queueMicrotask(() => {
      this.journalFlushQueued = false;
      this.flushJournal();
    });
  }

  /**
   * Write every coalesced journal entry now (e.g. inside `session_shutdown`,
   * where a pending microtask may never run before the process exits).
   */
  flushJournal(): void {
    const pending = [...this.pendingJournal.values()];
    this.pendingJournal.clear();
    for (const entry of pending) {
      if (this.agents.get(entry.id) === entry) this.writeJournal(entry);
    }
  }

  /** The sink this record journals to, or undefined when it must not be journaled. */
  private journalSinkFor(record: AgentRecord): SubagentJournalSink | undefined {
    const sink = this.journalSink;
    if (sink === undefined || this.disposed || this.unjournaled.has(record.id)) return undefined;
    // A record of another root session (spawned before a switch) is not this file's.
    const owner = this.usageScopes.get(record.id)?.owner;
    if (owner !== undefined && owner !== sink.rootSessionId) return undefined;
    // Host shutdown stops are not outcomes: the journal keeps the last real
    // state so startup can revive. A suspended record's suspend entry must
    // stay its latest, so nothing after it is journaled.
    const generation = record.resultGeneration ?? 1;
    if (
      record.cancellation?.generation === generation &&
      (record.cancellation.cause === "shutdown" || record.cancellation.cause === "suspend")
    ) {
      return undefined;
    }
    return sink;
  }

  /** Build and append one snapshot. Never throws; returns the snapshot built. */
  private writeJournal(record: AgentRecord): JournalAgentSnapshot | undefined {
    const sink = this.journalSinkFor(record);
    if (sink === undefined) return undefined;
    let data: SubagentJournalData;
    try {
      data = buildJournalData({
        rootSessionId: sink.rootSessionId,
        suspended: false,
        agent: this.journalSnapshot(record),
      });
    } catch (err) {
      this.noteJournalFailure(sink, record.id, err instanceof Error ? err : new Error(String(err)));
      return undefined;
    }
    const key = JSON.stringify(data.agent);
    if (this.lastJournaled.get(record.id) !== key) {
      try {
        sink.append(data);
        this.lastJournaled.set(record.id, key);
      } catch (err) {
        this.noteJournalFailure(
          sink,
          record.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    return data.agent;
  }

  private noteJournalFailure(sink: SubagentJournalSink, agentId: string, error: Error): void {
    this.journalFailures++;
    this.lastJournalError = error.message;
    if (this.journalFailureReported.has(agentId)) return;
    this.journalFailureReported.add(agentId);
    try {
      sink.reportError?.(agentId, error);
    } catch {
      /* a failing diagnostic must not break the run either */
    }
  }

  /**
   * Write the suspend entry (`suspended: true`) synchronously. `status` is
   * `interrupted`, or `waiting_for_reset` with the wait it continues.
   */
  private writeSuspendedJournal(
    record: AgentRecord,
    status: "interrupted" | "waiting_for_reset",
    wait: UsageWait | undefined,
  ): void {
    const sink = this.journalSinkFor(record);
    if (sink === undefined) return;
    this.pendingJournal.delete(record.id);
    try {
      const steers = status === "interrupted" ? [...(record.pendingSteers ?? [])] : undefined;
      const data = buildJournalData({
        rootSessionId: sink.rootSessionId,
        suspended: true,
        agent: this.journalSnapshot(record, { status, wait, steers }),
      });
      sink.append(data);
      this.lastJournaled.set(record.id, JSON.stringify(data.agent));
    } catch (err) {
      this.noteJournalFailure(sink, record.id, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Plain snapshot of a record; `buildJournalData` copies, caps and validates it. */
  private journalSnapshot(
    record: AgentRecord,
    override?: {
      status: AgentRecord["status"];
      wait: UsageWait | undefined;
      steers: string[] | undefined;
    },
  ): JournalAgentSnapshot {
    const status = override?.status ?? record.status;
    const terminal = !isUnsettledStatus(status);
    const sessionFile =
      record.sessionFile !== undefined &&
      (this.sessionFileConfirmed.has(record.id) || sessionHasAssistantMessage(record.session))
        ? record.sessionFile
        : undefined;
    const wait =
      override === undefined
        ? record.status === "waiting_for_reset"
          ? this.usageWaits.get(record.id)
          : undefined
        : override.wait;
    const worktree = record.worktree;
    const repo = record.worktreeRepo;
    const spawnOptions: JournalRunOptions = record.runOptions ?? {};
    return {
      id: record.id,
      handle: record.handle,
      alias: record.alias,
      type: record.type,
      description: record.description,
      parentAgentId: record.parentAgentId,
      depth: record.depth ?? 1,
      status,
      sessionFile,
      model: modelRefOf(record.session?.model) ?? record.spawnModel,
      // Spawn-time options, with the fields the record carries forward (a
      // parked foreground child becomes background; fast/daybreak can change).
      options: {
        ...spawnOptions,
        isBackground: record.isBackground,
        fastModeRequested: record.fastModeRequested,
        daybreakRequested: record.daybreakRequested,
        outputFile: record.outputFile ?? spawnOptions.outputFile,
      },
      prompt: sessionFile === undefined ? record.spawnPrompt : undefined,
      usageWait:
        wait === undefined
          ? undefined
          : {
              providerKey: wait.providerKey,
              resetAt: wait.classification.resetAt ?? record.usageLimit?.resetAt,
              classification: journalClassificationOf(wait.classification),
              steers: [...wait.continuation, ...(record.pendingSteers ?? [])],
            },
      worktree:
        worktree === undefined || repo === undefined
          ? undefined
          : {
              path: worktree.path,
              branch: worktree.branch,
              baseSha: worktree.baseSha,
              repo,
              workPath: worktree.workPath,
              hookManaged: worktree.hookManaged,
            },
      revivals: record.revivals ?? 0,
      resultConsumed: record.resultConsumed === true,
      stoppedByUser: record.stoppedByUser,
      result: terminal ? record.result : undefined,
      error: terminal ? record.error : undefined,
      steers: override?.steers,
      inMemorySession: record.inMemorySession,
    };
  }

  /**
   * The child's session file now holds the conversation (first assistant
   * message, turn end, or tool activity of this generation), so the journal can
   * point at it instead of carrying the prompt. One-shot per record.
   */
  private confirmSessionFile(record: AgentRecord, generation: number): void {
    if (record.resultGeneration !== generation || record.sessionFile === undefined) return;
    if (this.sessionFileConfirmed.has(record.id)) return;
    this.sessionFileConfirmed.add(record.id);
    record.spawnPrompt = undefined;
    this.scheduleJournal(record);
  }

  /** Store a dormant snapshot as the newest entry; false when its id is live. */
  private putDormant(snapshot: JournalAgentSnapshot): boolean {
    if (this.agents.has(snapshot.id)) return false;
    this.dormant.delete(snapshot.id);
    this.dormant.set(snapshot.id, snapshot);
    while (this.dormant.size > MAX_DORMANT) {
      const oldest = this.dormant.keys().next();
      if (oldest.done === true) break;
      this.dormant.delete(oldest.value);
    }
    return true;
  }

  /** Drop a record's journal bookkeeping (eviction or a failed spawn). */
  private forgetJournalState(id: string): void {
    this.pendingJournal.delete(id);
    this.lastJournaled.delete(id);
    this.sessionFileConfirmed.delete(id);
    this.unjournaled.delete(id);
    this.journalFailureReported.delete(id);
  }

  /**
   * Final journal write for an evicted record, then keep its terminal snapshot
   * for the dormant map. Catches up on changes made outside the manager
   * (result reads). The caller stores it after the live record is gone.
   */
  private retireJournal(record: AgentRecord): JournalAgentSnapshot | undefined {
    this.pendingJournal.delete(record.id);
    const snapshot = this.writeJournal(record);
    this.forgetJournalState(record.id);
    if (snapshot === undefined || isUnsettledStatus(snapshot.status)) return undefined;
    return snapshot;
  }

  private captureUsageScope(ctx: ExtensionContext, options: SpawnOptions): UsageLimitScope {
    const parent =
      options.parentAgentId === undefined ? undefined : this.usageScopes.get(options.parentAgentId);
    let owner = options.rootSessionId ?? parent?.owner;
    if (owner === undefined) {
      try {
        owner = ctx.sessionManager?.getSessionId?.();
      } catch {
        owner = undefined;
      }
    }
    const scoped = scopedModelKeys(ctx);
    // Widened read: test fixtures and RPC contexts may omit the registry.
    const modelRegistry: UsageModelRegistry | undefined = ctx.modelRegistry;
    return {
      owner,
      cwd: ctx.cwd ?? parent?.cwd ?? process.cwd(),
      modelRegistry: modelRegistry ?? parent?.modelRegistry,
      scoped: scoped.length > 0 ? scoped : (parent?.scoped ?? []),
    };
  }

  /**
   * Classify a terminal failure through the owner's usage-limit policy. Only
   * `quota`/`billing` results count, and only a confirmed exhaustion parks
   * (`corroborationVerdict`). Closures are keyed by owner, provider and
   * account. `eligible` is rechecked after every await, before any closure
   * read or write. Never switches the child's model.
   */
  private async evaluateUsageLimit(
    record: AgentRecord,
    failure: string,
    providerKey: string,
    model: ModelRef,
    session: AgentSession | undefined,
    allowPark: boolean,
    reportStatus: "reported" | "exhausted",
    eligible: () => boolean,
  ): Promise<UsageLimitDecision | undefined> {
    const failedAt = Date.now();
    const scope = this.usageScopes.get(record.id);
    const owner = scope?.owner;
    const policy = readUsageLimitPolicy(owner);
    if (scope === undefined || owner === undefined || policy === undefined) return undefined;
    const classified = classifyWithPolicy(policy, {
      provider: model.provider,
      modelId: model.id,
      errorMessage: failure,
    });
    if (classified === undefined || classified.kind === "transient") return undefined;
    const sessionId = childSessionId(record, session);
    const initial = withSessionId(
      withCodexUsageEntry(classified, model, session, failedAt),
      sessionId,
    );
    const preference = await preferenceFromPolicy(policy);
    if (!eligible()) return undefined;
    const corroboration = await corroborateWithPolicy(policy, initial);
    // A cancelled or superseded evaluation reads and writes no closure.
    if (!eligible()) return undefined;
    const verdict = corroborationVerdict(initial, corroboration);
    if (verdict === "transient") return undefined;
    // The child's session stays attached whatever the policy answered.
    const corroborated = withSessionId(corroboration?.classification ?? initial, sessionId);
    // Billing stays billing whatever corroboration answered: reported, never parked.
    const classification: UsageLimitClassification =
      initial.kind === "billing" ? { ...corroborated, kind: "billing" } : corroborated;

    const limitedAccount = classification.accountId;
    if (limitedAccount !== undefined) {
      this.classifiedAccounts.set(accountKey(owner, providerKey.toLowerCase()), limitedAccount);
    }
    // The key availability checks use; the limited account is closed too when
    // the policy's current account differs (as the root controller does).
    const accountId = this.accountFor(owner, providerKey, policy);
    const accountIds =
      limitedAccount === undefined || limitedAccount === accountId
        ? [accountId]
        : [accountId, limitedAccount];
    const now = Date.now();
    const resetAt =
      classification.resetAt !== undefined && Number.isFinite(classification.resetAt)
        ? classification.resetAt
        : undefined;
    const requestedUntil =
      resetAt !== undefined && resetAt > now ? resetAt : now + USAGE_LIMIT_DEFAULT_CLOSE_MS;
    for (const account of accountIds) {
      closeProviderWithPolicy(
        policy,
        providerKey,
        account,
        Math.min(requestedUntil, now + USAGE_LIMIT_MAX_WAIT_MS),
      );
    }
    const suggestedModel = this.suggestFallback(policy, scope, owner, model, record);
    for (const account of accountIds) {
      closeUntil({ owner, providerKey, accountId: account }, requestedUntil, { suggestedModel });
    }
    const park =
      allowPark &&
      preference === "auto-resume" &&
      classification.kind === "quota" &&
      verdict === "confirmed";
    return {
      classification,
      accountIds,
      park,
      usageLimit: {
        provider: model.provider,
        accountId: limitedAccount ?? accountId,
        kind: classification.kind,
        resetAt,
        suggestedModel,
        status: park ? "waiting_for_reset" : reportStatus,
      },
    };
  }

  /** Policy suggestion re-validated against availability and the parent's scope. */
  private suggestFallback(
    policy: UsageLimitPolicy,
    scope: UsageLimitScope,
    owner: string,
    current: ModelRef,
    record: AgentRecord,
  ): string | undefined {
    const registry = scope.modelRegistry;
    let available: ModelRef[] = [];
    try {
      available = (registry?.getAvailable?.() ?? []).map((entry) => ({
        provider: entry.provider,
        id: entry.id,
      }));
    } catch {
      available = [];
    }
    const pick = pickFallbackWithPolicy(policy, current, {
      available,
      scoped: scope.scoped,
      isClosed: (providerKey, accountId) => {
        const key = providerKey.toLowerCase();
        return (
          isClosedWithPolicy(policy, key, accountId) ||
          usageLimitClosure({ owner, providerKey: key, accountId }) !== undefined ||
          !isAvailable(key)
        );
      },
    });
    if (pick === undefined) return undefined;
    const key = `${pick.provider}/${pick.id}`;
    const lowered = key.toLowerCase();
    if (lowered === `${current.provider}/${current.id}`.toLowerCase()) return undefined;
    if (!available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === lowered)) {
      return undefined;
    }
    if (scope.scoped.length > 0 && !scope.scoped.some((entry) => entry.toLowerCase() === lowered)) {
      return undefined;
    }
    if (registry !== undefined) {
      const verdict = checkModelScope({
        model: pick,
        cwd: scope.cwd,
        modelRegistry: registry,
        callerSupplied: true,
        agentLabel: record.type,
        modelInput: key,
      });
      if (verdict.kind === "error") return undefined;
    }
    return key;
  }

  /** Evaluate only while this generation may still settle normally. */
  private async evaluateRunUsageLimit(
    record: AgentRecord,
    generation: number,
    runBudget: RunBudgetState,
    failure: string | undefined,
    providerKey: string,
    model: ModelRef | undefined,
    session: AgentSession | undefined,
    allowPark: boolean,
    reportStatus: "reported" | "exhausted",
  ): Promise<UsageLimitDecision | undefined> {
    const eligible = () =>
      !this.disposed &&
      record.resultGeneration === generation &&
      record.status !== "stopped" &&
      record.cancellation?.generation !== generation &&
      runBudget.forcedStatus === undefined;
    if (failure === undefined || model === undefined || !eligible()) return undefined;
    let decision: UsageLimitDecision | undefined;
    try {
      decision = await this.evaluateUsageLimit(
        record,
        failure,
        providerKey,
        model,
        session,
        allowPark,
        reportStatus,
        eligible,
      );
    } catch {
      decision = undefined;
    }
    return decision !== undefined && eligible() ? decision : undefined;
  }

  /**
   * Park a failed run: the generation stays unpublished and holds no pool slot.
   * Callers release their slot, detach signals, and mark their run settled.
   */
  private parkForReset(
    record: AgentRecord,
    generation: number,
    decision: UsageLimitDecision,
    providerKey: string,
    resumeOptions: ResumeOptions,
  ): void {
    const owner = this.usageScopes.get(record.id)?.owner ?? "";
    let release: (value: string | PromiseLike<string>) => void = () => undefined;
    const parkedPromise = new Promise<string>((resolve) => {
      release = resolve;
    });
    this.transition(record, "waiting_for_reset");
    // A parked foreground child has already answered its caller; from here it
    // behaves as background and reports through the completion notification.
    record.isBackground = true;
    record.usageLimit = { ...decision.usageLimit, status: "waiting_for_reset" };
    record.promise = parkedPromise;
    const wait: UsageWait = {
      generation,
      owner,
      providerKey,
      accountIds: decision.accountIds,
      classification: decision.classification,
      resumeOptions,
      continuation: [],
      parkedPromise,
      release,
    };
    this.usageWaits.set(record.id, wait);
    this.notifyUsageLimit(record);
    this.armUsageWake(record, wait, decision.usageLimit.resetAt);
  }

  private isCurrentWait(record: AgentRecord | undefined, wait: UsageWait): record is AgentRecord {
    return (
      !this.disposed &&
      record !== undefined &&
      this.usageWaits.get(record.id) === wait &&
      record.status === "waiting_for_reset" &&
      record.resultGeneration === wait.generation
    );
  }

  private armUsageWake(record: AgentRecord, wait: UsageWait, resetAt: number | undefined): void {
    const now = Date.now();
    let delay: number;
    if (resetAt !== undefined && resetAt + USAGE_LIMIT_RESET_MARGIN_MS > now) {
      wait.pollUntil = undefined;
      delay = Math.min(resetAt + USAGE_LIMIT_RESET_MARGIN_MS, now + USAGE_LIMIT_MAX_WAIT_MS) - now;
    } else {
      wait.pollUntil ??= now + USAGE_LIMIT_MAX_POLL_MS;
      if (now >= wait.pollUntil) {
        this.settleParked(record, wait, {
          status: "error",
          usageStatus: "exhausted",
          reason: `${record.error ?? "Provider usage limit."}\n\nAuto-resume gave up: no usage-window reset was confirmed within ${USAGE_LIMIT_MAX_POLL_MS / 3_600_000} h.`,
          notify: true,
        });
        return;
      }
      delay = Math.min(USAGE_LIMIT_POLL_MS, wait.pollUntil - now);
    }
    this.armWakeTimer(record, wait, delay);
  }

  private armWakeTimer(record: AgentRecord, wait: UsageWait, delay: number): void {
    if (wait.timer !== undefined) clearTimeout(wait.timer);
    wait.timer = setTimeout(() => {
      wait.timer = undefined;
      void this.wakeUsageLimited(record.id, wait);
    }, delay);
    wait.timer.unref?.();
  }

  private async wakeUsageLimited(id: string, wait: UsageWait): Promise<void> {
    const record = this.agents.get(id);
    if (!this.isCurrentWait(record, wait)) return;
    const policy = readUsageLimitPolicy(wait.owner);
    if (policy === undefined && wait.revived === true) {
      // A re-armed wait can wake before the extension that registers the
      // policy has started; give it a bounded chance to appear.
      const now = Date.now();
      wait.policyRetryUntil ??= now + REARM_POLICY_RETRY_MS;
      if (now < wait.policyRetryUntil) {
        this.armWakeTimer(
          record,
          wait,
          Math.min(REARM_POLICY_POLL_MS, wait.policyRetryUntil - now),
        );
        return;
      }
    }
    if (policy === undefined) {
      this.settleParked(record, wait, {
        status: "error",
        usageStatus: "exhausted",
        reason: `${record.error ?? "Provider usage limit."}\n\nAuto-resume gave up: the usage-limit policy is no longer available to confirm the reset.`,
        notify: true,
      });
      return;
    }
    const result = await corroborateWithPolicy(policy, wait.classification);
    const current = this.agents.get(id);
    if (current !== record || !this.isCurrentWait(current, wait)) return;
    if (result?.ready === true) {
      this.resumeAfterReset(record, wait);
      return;
    }
    let nextReset: number | undefined;
    if (result !== undefined && result.classification.kind !== "transient") {
      wait.classification = withSessionId(result.classification, wait.classification.sessionId);
      nextReset = result.classification.resetAt;
      if (record.usageLimit !== undefined) {
        record.usageLimit = { ...record.usageLimit, resetAt: nextReset };
      }
      // A new reset estimate re-parks the task on a different timer.
      this.scheduleJournal(record);
    }
    this.armUsageWake(record, wait, nextReset);
  }

  /** Resume the parked record on the same model as a new background generation. */
  private resumeAfterReset(record: AgentRecord, wait: UsageWait): void {
    this.usageWaits.delete(record.id);
    // The owner's policy confirmed the reset: reopen every account the limit closed.
    const policy = readUsageLimitPolicy(wait.owner);
    for (const accountId of wait.accountIds) {
      clearUsageLimitClosure({ owner: wait.owner, providerKey: wait.providerKey, accountId });
      if (policy !== undefined) {
        closeProviderWithPolicy(policy, wait.providerKey, accountId, Date.now());
      }
    }
    // Steering accepted since the last park joins what an earlier, re-parked
    // continuation carried; the wait holds it until a dispatch starts.
    wait.continuation = [...wait.continuation, ...(record.pendingSteers ?? [])];
    record.pendingSteers = undefined;
    const prompt = [USAGE_LIMIT_RESUME_PROMPT, ...wait.continuation].join("\n\n");
    if (record.usageLimit !== undefined) {
      record.usageLimit = { ...record.usageLimit, status: "resumed" };
    }
    const generation = (record.resultGeneration ?? 1) + 1;
    this.wakeRuns.set(record.id, generation);
    // Settlement of the parked promise stays with this wait until the
    // continuation actually starts; a queued continuation that never starts
    // (stop, shutdown, session switch) settles it through `finalize`.
    this.queueBackgroundResume(record.id, record, prompt, undefined, wait.resumeOptions, {
      onRunStarted: (promise) => {
        // Delivered in this run's prompt; never again.
        wait.continuation = [];
        if (promise !== wait.parkedPromise) wait.release(promise);
      },
      finalize: (notify) => this.settleDroppedWake(record, wait, generation, notify),
      repark: () => this.reparkQueuedWake(record, wait, generation),
      wait,
    });
    // After the status leaves waiting_for_reset, so observers never mistake
    // the resume for a second park.
    this.notifyUsageLimit(record);
  }

  /**
   * A queued post-reset continuation whose provider account was closed again
   * by a usage limit before a slot freed: return it to `waiting_for_reset` on
   * the new closure's reset, keeping the parked promise and its finalizer.
   */
  private reparkQueuedWake(record: AgentRecord, wait: UsageWait, generation: number): void {
    if (this.wakeRuns.get(record.id) === generation) this.wakeRuns.delete(record.id);
    const key = wait.providerKey.toLowerCase();
    const block = this.providerBlock(key, wait.owner);
    const resetAt = block?.closure?.until;
    // The account this re-closure is keyed under reopens with the others.
    const account = this.accountFor(wait.owner, key);
    if (!wait.accountIds.includes(account)) wait.accountIds.push(account);
    wait.generation = record.resultGeneration ?? generation;
    wait.pollUntil = undefined;
    if (resetAt !== undefined) wait.classification = { ...wait.classification, resetAt };
    this.transition(record, "waiting_for_reset");
    record.error = providerUnavailableMessage(key, block?.closure);
    record.usageLimit =
      record.usageLimit === undefined
        ? undefined
        : {
            ...record.usageLimit,
            resetAt: resetAt ?? record.usageLimit.resetAt,
            status: "waiting_for_reset",
          };
    this.usageWaits.set(record.id, wait);
    this.notifyUsageLimit(record);
    this.armUsageWake(record, wait, resetAt);
  }

  /**
   * Final outcome of a post-reset continuation that was queued and never
   * started. The caller has already set the terminal status and published it.
   */
  private settleDroppedWake(
    record: AgentRecord,
    wait: UsageWait,
    generation: number,
    notify: boolean,
  ): void {
    if (this.wakeRuns.get(record.id) === generation) this.wakeRuns.delete(record.id);
    record.error ??= record.cancellation?.reason;
    if (record.usageLimit !== undefined) {
      record.usageLimit = { ...record.usageLimit, status: "exhausted" };
    }
    this.finishDeferredWorktree(record);
    wait.release(record.result ?? "");
    if (!notify || this.disposed) return;
    this.notifyUsageLimit(record);
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore completion side-effect errors */
    }
  }

  /** Run the worktree cleanup a parked spawn deferred, exactly once. */
  private finishDeferredWorktree(record: AgentRecord): void {
    const finish = this.deferredWorktrees.get(record.id);
    if (finish === undefined) return;
    this.deferredWorktrees.delete(record.id);
    try {
      finish();
    } catch {
      /* ignore cleanup errors, like the spawn settle path */
    }
  }

  /**
   * Worktree cleanup for a spawn's final outcome. Synchronous so it can run
   * before the result is published; hook-managed removal completes in the
   * background, as it reports no branch.
   */
  private cleanupRecordWorktree(
    pi: ExtensionAPI,
    record: AgentRecord,
    baseCwd: string,
    customCwd: string | undefined,
    description: string,
  ): void {
    const worktree = record.worktree;
    if (worktree === undefined) return;
    if (worktree.hookManaged === true) {
      record.worktreeResult = { hasChanges: false };
      void removeHookWorktree(pi, worktree.path).catch(() => undefined);
      return;
    }
    const wtResult = cleanupWorktree(baseCwd, worktree, description);
    record.worktreeResult = wtResult;
    if (wtResult.hasChanges && wtResult.branch) {
      const repoNote = customCwd === undefined ? "" : ` in \`${baseCwd}\``;
      record.result =
        (record.result ?? "") +
        `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd === undefined ? "" : ` (run in \`${baseCwd}\`)`}`;
    }
  }

  /** Settle a parked record without running it again. */
  private settleParked(
    record: AgentRecord,
    wait: UsageWait | undefined,
    outcome: {
      status: "stopped" | "error";
      usageStatus?: SubagentUsageLimit["status"];
      reason: string;
      cause?: CancellationCause;
      notify: boolean;
    },
  ): void {
    if (wait !== undefined) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.timer = undefined;
    }
    this.usageWaits.delete(record.id);
    const generation = record.resultGeneration ?? 1;
    this.transition(record, outcome.status);
    if (outcome.cause !== undefined) {
      record.cancellation = {
        generation,
        cause: outcome.cause,
        reason: outcome.reason,
        requestedAt: Date.now(),
      };
    }
    record.error = outcome.reason;
    record.pendingSteers = undefined;
    if (record.usageLimit !== undefined && outcome.usageStatus !== undefined) {
      record.usageLimit = { ...record.usageLimit, status: outcome.usageStatus };
    }
    record.completedAt = Date.now();
    if (record.outputCleanup) {
      try {
        record.outputCleanup();
      } catch {
        /* ignore */
      }
      record.outputCleanup = undefined;
    }
    this.finishDeferredWorktree(record);
    this.publishTerminal(record);
    wait?.release(record.result ?? "");
    if (!outcome.notify || this.disposed) return;
    this.notifyUsageLimit(record);
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore completion side-effect errors */
    }
  }

  /**
   * Cancel every usage-limit wait (session switch), including post-reset
   * continuations still queued. They settle as `stopped` (usage status
   * `exhausted`) without a notification into the next session. Returns the count.
   */
  cancelUsageLimitWaits(reason: string): number {
    let count = 0;
    // settleParked never removes records, so iterating the live map is safe.
    for (const record of this.agents.values()) {
      if (record.status !== "waiting_for_reset") continue;
      this.settleParked(record, this.usageWaits.get(record.id), {
        status: "stopped",
        usageStatus: "exhausted",
        reason,
        cause: "shutdown",
        notify: false,
      });
      count++;
    }
    const continuations = this.queue.filter((entry) => entry.finalize !== undefined);
    this.queue = this.queue.filter((entry) => entry.finalize === undefined);
    for (const entry of continuations) {
      const record = this.agents.get(entry.id);
      if (record === undefined || record.status !== "queued") continue;
      this.stopQueuedRecord(record, "shutdown", reason);
      entry.finalize?.(false);
      count++;
    }
    return count;
  }

  /** Terminal state for a queued record that will never start. */
  private stopQueuedRecord(record: AgentRecord, cause: CancellationCause, reason: string): void {
    this.transition(record, "stopped");
    this.requestCancellation(record, record.resultGeneration ?? 1, cause, reason);
    record.completedAt = Date.now();
    this.publishTerminal(record);
  }

  /** Validate and apply a caller-selected model to an idle child session. */
  private async applyResumeModel(
    record: AgentRecord,
    session: AgentSession,
    input: string,
  ): Promise<void> {
    const model = this.resolveResumeModel(record, input);
    try {
      if (this.runner.setSessionModel === undefined) {
        await session.setModel(model);
      } else {
        await this.runner.setSessionModel(session, model);
      }
    } catch (error) {
      throw new ResumeModelError(
        `Failed to switch agent to "${input}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Synchronous validation of a resume's `provider/id`: format, registry,
   * authentication, the parent's scope, and owner-scoped availability.
   */
  private resolveResumeModel(record: AgentRecord, input: string): Model<Api> {
    const scope = this.usageScopes.get(record.id);
    return this.validateResumeModel(input, {
      registry: scope?.modelRegistry,
      cwd: scope?.cwd,
      owner: scope?.owner,
      agentLabel: record.type,
    });
  }

  /** `resolveResumeModel` for a dormant agent, against the current root context. */
  private resolveDormantModel(
    snapshot: JournalAgentSnapshot,
    input: string,
    ctx: ExtensionContext | undefined,
  ): Model<Api> {
    return this.validateResumeModel(input, {
      registry: ctx?.modelRegistry,
      cwd: ctx?.cwd,
      owner: this.journalSink?.rootSessionId,
      agentLabel: snapshot.type,
    });
  }

  /**
   * Shared caller-model validation for live and dormant resumes: provider/id
   * format, registry availability, model scope (strict), provider closure.
   */
  private validateResumeModel(
    input: string,
    scope: {
      registry: UsageModelRegistry | undefined;
      cwd: string | undefined;
      owner: string | undefined;
      agentLabel: string;
    },
  ): Model<Api> {
    const slash = input.indexOf("/");
    if (slash <= 0 || slash === input.length - 1) {
      throw new ResumeModelError(`Invalid model "${input}": expected provider/id.`);
    }
    const provider = input.slice(0, slash);
    const modelId = input.slice(slash + 1);
    const registry = scope.registry;
    const cwd = scope.cwd;
    if (registry === undefined || cwd === undefined) {
      throw new ResumeModelError(
        `Cannot resolve model "${input}": no model registry is available for this agent.`,
      );
    }
    let model: Model<Api> | undefined;
    let available: ModelEntry[] = [];
    try {
      model = registry.find(provider, modelId);
      available = registry.getAvailable?.() ?? registry.getAll();
    } catch {
      model = undefined;
    }
    const wanted = input.toLowerCase();
    if (
      model === undefined ||
      !available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === wanted)
    ) {
      throw new ResumeModelError(
        `Model not available: "${input}" (unknown to the registry or missing authentication).`,
      );
    }
    const verdict = checkModelScope({
      model,
      cwd,
      modelRegistry: registry,
      callerSupplied: true,
      agentLabel: scope.agentLabel,
      modelInput: input,
    });
    if (verdict.kind === "error") throw new ResumeModelError(verdict.message);
    const targetKey = model.provider.toLowerCase();
    const block = this.providerBlock(targetKey, scope.owner);
    if (block !== undefined) {
      throw new ResumeModelError(providerUnavailableMessage(targetKey, block.closure));
    }
    return model;
  }

  /** A live or unsettled run owns the record; resume() refuses it silently. */
  private resumeBlockedByRun(id: string, record: AgentRecord): boolean {
    return (
      record.status === "running" ||
      record.status === "queued" ||
      (record.resultGeneration !== undefined &&
        record.terminalResultGeneration !== record.resultGeneration) ||
      this.resumeReservations.has(id)
    );
  }

  /** Throw the owner-scoped availability refusal for the record's current provider. */
  private assertResumeProviderOpen(id: string, session: AgentSession): void {
    const key = (session.model?.provider ?? "unknown").toLowerCase();
    const block = this.providerBlock(key, this.usageScopes.get(id)?.owner);
    if (block !== undefined) {
      throw new ResumeModelError(providerUnavailableMessage(key, block.closure));
    }
  }

  /**
   * Side-effect-free pre-check for callers that prepare a resume (output file,
   * notification ids) before calling `resume()`. Returns false where `resume()`
   * would return undefined without starting (unknown, no session, live run,
   * pending model switch); throws the same `ResumeModelError` it would throw
   * for an invalid model or a closed provider. `resume()` re-checks everything.
   */
  assertResumable(
    id: string,
    model?: string,
    options?: { dormant?: boolean; ctx?: ExtensionContext },
  ): boolean {
    const record = this.agents.get(id);
    // Opt-in: a dormant or interrupted agent resumes through `resumeDormant`,
    // which re-validates everything when it reopens the file. A caller model
    // is checked here against the current root context (`ctx`), exactly as a
    // live resume checks it, and throws the same ResumeModelError.
    if (record === undefined && options?.dormant === true) {
      if (!this.canResumeDormant(id)) return false;
      const snapshot = this.getDormant(id);
      if (model !== undefined && snapshot !== undefined) {
        this.resolveDormantModel(snapshot, model, options.ctx);
      }
      return true;
    }
    if (this.disposed || !record?.session || this.resumeBlockedByRun(id, record)) return false;
    if (model === undefined) this.assertResumeProviderOpen(id, record.session);
    else this.resolveResumeModel(record, model);
    return true;
  }

  /** Start (or queue) a detached resume generation; shared by resume() and wake-ups. */
  private queueBackgroundResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    signal: AbortSignal | undefined,
    options: ResumeOptions,
    hooks: {
      onRunStarted?: (promise: Promise<string>) => void;
      finalize?: QueuedFinalizer;
      repark?: () => void;
      wait?: UsageWait;
    } = {},
  ): void {
    record.isBackground = true;
    beginResultGeneration(record);
    // A new generation is a new request: an earlier explicit stop no longer applies.
    record.stoppedByUser = undefined;
    record.result = undefined;
    record.error = undefined;
    record.cancellation = undefined;
    record.completedAt = undefined;
    this.transition(record, "queued");

    const start = () => {
      const before = record.promise;
      const revival = record.session === undefined ? this.revivalArgs.get(id) : undefined;
      if (revival === undefined) {
        this.startResume(id, record, prompt, signal, options);
      } else {
        // A re-armed record has no session yet: reopen its file (claimed at
        // re-arm) through the spawn path, as a wake continuation.
        this.startRevivedContinuation(id, record, revival, prompt, hooks.finalize);
      }
      if (record.promise !== undefined && (revival === undefined || record.promise !== before)) {
        hooks.onRunStarted?.(record.promise);
      }
    };
    if (occupiesPoolSlot(record) && this.runningBackground >= this.getSchedulingMaxConcurrent()) {
      // At the concurrency limit — queue it, drains when a slot frees.
      this.queue.push({
        id,
        providerKey: (
          record.session?.model?.provider ??
          record.spawnModel?.provider ??
          "unknown"
        ).toLowerCase(),
        start,
        finalize: hooks.finalize,
        repark: hooks.repark,
        wait: hooks.wait,
      });
    } else {
      start();
    }
  }

  private requestCancellation(
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

  private armRunBudgets(
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
        !this.disposed && record.resultGeneration === generation && record.status === "running",
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
        this.requestCancellation(
          record,
          generation,
          status === "watchdog_stopped" ? "watchdog" : "budget",
          reason,
          abortController,
        );
      },
      onDispose: (disposedController) => {
        this.activeRunBudgets.delete(disposedController);
      },
    });
    state.controller = controller;
    this.activeRunBudgets.add(controller);
    return state;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return this.spawnWith(pi, ctx, type, prompt, options, undefined);
  }

  /** True when a live record other than `id` holds `name` as handle or alias. */
  private nameTakenByLive(name: string, id: string): boolean {
    for (const record of this.agents.values()) {
      if (record.id === id) continue;
      if (record.handle === name || record.alias === name) return true;
    }
    return false;
  }

  /**
   * Spawn, or (with `identity`) recreate a journaled agent under its own id,
   * handle and alias. A re-arm identity parks the record instead of starting it.
   */
  private spawnWith(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
    identity: RevivalIdentity | undefined,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);
    const providerKey = providerKeyFor(options, ctx);
    const usageScope = this.captureUsageScope(ctx, options);
    if (identity?.scoped !== undefined) usageScope.scoped = [...identity.scoped];
    // A re-armed wait is expected to find its provider closed.
    if (identity?.rearm === undefined && !this.isProviderAvailable(providerKey, usageScope.owner)) {
      throw this.unavailableError(providerKey, usageScope.owner);
    }
    if (identity !== undefined && this.agents.has(identity.id)) {
      throw new Error(`Agent ${identity.id} is already live.`);
    }

    const id = identity?.id ?? randomUUID().slice(0, 17);
    const revivedHandle =
      identity?.handle !== undefined && !this.nameTakenByLive(identity.handle, id)
        ? identity.handle
        : undefined;
    const inheritedFastMode = snapshotFastMode(ctx.sessionManager?.getSessionId?.());
    const fastModeRequested = options.fastModeRequested ?? inheritedFastMode.requested;
    const inheritedDaybreak = snapshotDaybreak(ctx.sessionManager?.getSessionId?.());
    const daybreakRequested = options.daybreakRequested ?? inheritedDaybreak.requested;
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Handles are unique across the live tree, so every agent has one flat,
      // unambiguous address regardless of its ownership branch.
      handle:
        revivedHandle ??
        (options.parentAgentId === undefined && options.reclaim?.handle
          ? // A reclaimed handle is used as-is: it belongs to the conversation this
            // spawn is reopening, and re-deriving it would lose the numbering.
            options.reclaim.handle
          : assignHandle(handleBase(type), this.takenHandles(options.parentAgentId))),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias:
        identity === undefined
          ? options.parentAgentId === undefined
            ? options.reclaim?.alias
            : undefined
          : identity.alias !== undefined && !this.nameTakenByLive(identity.alias, id)
            ? identity.alias
            : undefined,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      resultGeneration: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation,
      sideConversation: options.sideConversation,
      workflowId: options.workflowId,
      workflowStepId: options.workflowStepId,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      fastModeRequested,
      fastModeSource: options.fastModeRequested === undefined ? "inherited" : "explicit",
      fastModeRevision: 0,
      daybreakRequested,
      daybreakSource: options.daybreakRequested === undefined ? "inherited" : "explicit",
      daybreakRevision: 0,
      spawnPrompt: prompt,
      runOptions: journalRunOptionsOf(options, usageScope.scoped),
      spawnModel: modelRefOf(options.model ?? ctx.model),
      revivals: identity?.revivals,
      pendingSteers:
        identity?.steers !== undefined && identity.steers.length > 0
          ? [...identity.steers]
          : undefined,
      outputFile: identity?.outputFile,
    };
    const reclaimedTombstone =
      identity === undefined && options.parentAgentId === undefined && options.reclaim !== undefined
        ? this.tombstones.get(options.reclaim.handle)
        : undefined;
    let previousTombstoneId: string | undefined;
    this.agents.set(id, record);
    this.usageScopes.set(id, usageScope);
    if (identity !== undefined) {
      this.dormant.delete(id);
      // A revival continues in its original worktree. Record it before the
      // first journal write: a revival queued behind the concurrency cap must
      // be journaled with it, or a restart before it starts loses the work.
      if (options.adoptWorktree !== undefined) {
        this.applyAdoptedWorktree(record, options.adoptWorktree);
      }
      if (identity.claim !== undefined) {
        this.sessionClaims.set(id, identity.claim);
        // Reopening an existing conversation: the file already holds it, so
        // the very first entry (even a queued one) points at the file and
        // never carries the continuation prompt. A kill before the run starts
        // must reopen the same file, not start a fresh session from the
        // interruption text.
        record.sessionFile = identity.claim.file;
        this.sessionFileConfirmed.add(id);
        record.spawnPrompt = undefined;
      }
    }
    // Workflow steps and /btw answers have single-shot aggregate delivery and
    // are never revived; neither are the children they own.
    if (
      options.workflowId !== undefined ||
      options.sideConversation === true ||
      options.mainSessionFork !== undefined ||
      (options.parentAgentId !== undefined && this.unjournaled.has(options.parentAgentId))
    ) {
      this.unjournaled.add(id);
    }
    this.scheduleJournal(record);
    if (identity !== undefined && identity.rearm === undefined) {
      // The revived record (with its revivals count) reaches the journal
      // before the runner is even invoked, so before any provider call. A
      // re-arm is not flushed here: its waiting_for_reset entry coalesces.
      this.flushJournal();
    }
    // The retained tombstone now describes this live incarnation. Besides
    // proving ownership for later alias rebinding, moving its id prevents the
    // evicted id from reopening a duplicate while this reclaimed record exists.
    if (
      reclaimedTombstone !== undefined &&
      reclaimedTombstone.handle === record.handle &&
      reclaimedTombstone.alias === record.alias
    ) {
      previousTombstoneId = reclaimedTombstone.id;
      reclaimedTombstone.id = id;
    }
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(
        handleBase(options.name),
        this.takenHandles(options.parentAgentId),
      );
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (identity?.rearm !== undefined) {
      this.armRevivedWait(record, args, identity.rearm.snapshot, identity.rearm.sessionFile);
      return id;
    }

    if (
      occupiesPoolSlot(record) &&
      !options.bypassQueue &&
      this.runningBackground >= this.getSchedulingMaxConcurrent()
    ) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, providerKey, start: () => this.startAgent(id, record, args) });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      this.usageScopes.delete(id);
      this.forgetJournalState(id);
      // A revival's claim is released by its caller, which still owns the snapshot.
      this.sessionClaims.delete(id);
      if (
        previousTombstoneId !== undefined &&
        reclaimedTombstone !== undefined &&
        reclaimedTombstone.id === id
      ) {
        reclaimedTombstone.id = previousTombstoneId;
      }
      throw err;
    }
    return id;
  }

  /**
   * Point a revived record at its original worktree (no new one is created);
   * returns the working path inside it. Idempotent.
   */
  private applyAdoptedWorktree(record: AgentRecord, adopt: AdoptedWorktree): string {
    const workPath = adopt.workPath ?? adopt.path;
    record.worktree = {
      path: adopt.path,
      branch: adopt.branch,
      baseSha: adopt.baseSha,
      workPath,
      hookManaged: adopt.hookManaged,
    };
    record.worktreeRepo = adopt.repo;
    this.worktreeRepos.add(adopt.repo);
    return workPath;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
  ) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    const providerKey = providerKeyFor(options, ctx);
    const owner = this.usageScopes.get(id)?.owner;
    if (!this.isProviderAvailable(providerKey, owner)) {
      throw this.unavailableError(providerKey, owner);
    }
    // Snapshot the requested model now; settle-time code must not read a ctx
    // the host may have retired. The live session model wins when available.
    const runModel = modelRefOf(options.model ?? ctx.model);
    // Continuation callbacks for a post-reset resume. A foreground caller's
    // callbacks stream into a tool call that has already returned, so drop them.
    const wakeResumeOptions: ResumeOptions = options.isBackground
      ? {
          budgets: options.budgets,
          onToolActivity: options.onToolActivity,
          onAssistantUsage: options.onAssistantUsage,
          onCompaction: options.onCompaction,
        }
      : { budgets: options.budgets };
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    // An adopted worktree came from its journaled repo; cleanup must target it.
    const baseCwd = options.adoptWorktree?.repo ?? customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    if (options.adoptWorktree !== undefined) {
      // Revival: continue in the original worktree (verified by the caller).
      const adopt = options.adoptWorktree;
      const workPath = this.applyAdoptedWorktree(record, adopt);
      // Same rule as a created worktree: a caller-supplied cwd maps to its
      // subdirectory, a plain spawn runs at the copy's root.
      worktreeCwd = customCwd === undefined ? adopt.path : workPath;
    } else if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = options.hookWorktreePath
        ? adoptHookWorktree(baseCwd, options.hookWorktreePath, id)
        : createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
            "Initialize git and commit at least once, or omit `isolation`.",
        );
      }
      record.worktree = wt;
      record.worktreeRepo = baseCwd;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd === undefined ? wt.path : wt.workPath;
      this.worktreeRepos.add(baseCwd);
    }

    this.transition(record, "running");
    record.startedAt = Date.now();
    const runGeneration = record.resultGeneration ?? 1;
    // A post-reset continuation of a re-armed record runs through this path; a
    // repeated limit then exhausts it instead of parking again.
    const isWakeRun = this.wakeRuns.get(id) === runGeneration;
    const runTookPoolSlot = occupiesPoolSlot(record);
    let runPoolSlotHeld = runTookPoolSlot;
    if (runTookPoolSlot) this.runningBackground++;
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => {
        if (
          this.requestCancellation(
            record,
            runGeneration,
            "parent_signal",
            "Parent run was cancelled.",
          )
        ) {
          this.transition(record, "stopped");
          record.completedAt ??= Date.now();
        }
      };
      if (options.signal.aborted) onParentAbort();
      else options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
    };
    const releaseRunPoolSlot = () => {
      if (!runPoolSlotHeld) return;
      runPoolSlotHeld = false;
      this.runningBackground--;
    };
    let staleRunSettled = false;
    let currentRunSettled = false;
    // Settle this generation as suspended (every settle path, after every await).
    const settleSuspendedRun = (session: AgentSession | undefined) => {
      runBudget.controller?.dispose();
      detach();
      releaseRunPoolSlot();
      currentRunSettled = true;
      this.finishSuspendedRun(record, session);
    };
    const settleStaleRun = () => {
      if (staleRunSettled) return;
      staleRunSettled = true;
      runBudget.controller?.dispose();
      detach();
      this.abortOwnedChildren(id);
      releaseRunPoolSlot();
      this.drainQueue();
    };
    const runBudget = this.armRunBudgets(
      record,
      runGeneration,
      options.budgets,
      record.abortController!,
    );

    const fastModeInitialization = {
      requested: record.fastModeRequested ?? false,
      source: record.fastModeSource ?? "default",
      revision: record.fastModeRevision ?? 0,
    };
    record.fastModeInitialization = fastModeInitialization;
    const daybreakInitialization = {
      requested: record.daybreakRequested ?? false,
      source: record.daybreakSource ?? "default",
      revision: record.daybreakRevision ?? 0,
    };
    record.daybreakInitialization = daybreakInitialization;
    const promise = this.runner
      .runAgent(ctx, type, prompt, {
        pi,
        agentId: id,
        model: options.model,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        mainSessionFork: options.mainSessionFork,
        readOnly: options.readOnly,
        resumeSessionFile: options.resumeSessionFile,
        nested: options.parentAgentId !== undefined,
        // Worktree wins for the working dir (the agent must run in the copy —
        // which, with a custom cwd, was created from that target). Config stays
        // with the parent project when a caller-supplied cwd is in play; it must
        // stay undefined otherwise so plain worktree runs keep resolving config
        // (incl. relative extension paths and memory) inside the worktree copy.
        cwd: worktreeCwd ?? customCwd,
        // Set iff a worktree was created (see above) — names the directory the
        // copy came from, so the prompt can tell the agent not to work there.
        worktreeBase: worktreeCwd ? baseCwd : undefined,
        configCwd: options.configCwd ?? (customCwd === undefined ? undefined : ctx.cwd),
        signal: record.abortController!.signal,
        onToolActivity: (activity) => {
          this.confirmSessionFile(record, runGeneration);
          if (isBudgetedToolActivity(activity)) {
            runBudget.controller?.noteToolActivity(activity.type);
          }
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onTurnEnd: (turnCount) => {
          this.confirmSessionFile(record, runGeneration);
          options.onTurnEnd?.(turnCount);
        },
        onFinishAttempt: this.dependencyCompletionGuard(record, runGeneration),
        onTextDelta: options.onTextDelta,
        onAssistantUsage: (usage) => {
          this.confirmSessionFile(record, runGeneration);
          runBudget.controller?.noteUsage(usage);
          addUsage(record.lifetimeUsage, usage);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        nestedRuntime: {
          manager: this,
          parentAgentId: id,
          depth: record.depth ?? 1,
          maxSubagentDepth: record.maxSubagentDepth,
        },
        fastMode: fastModeInitialization,
        fastModeGeneration: runGeneration,
        daybreak: daybreakInitialization,
        daybreakGeneration: runGeneration,
        onSessionCreated: (session) => {
          if (record.resultGeneration !== runGeneration) return;
          // Cancellation stops provider work, not ownership of the child that
          // startup created. Retain it even after shutdown for settlement cleanup.
          record.session = session;
          if (options.mainSessionFork) {
            record.sessionCostBaseline = getSessionCostBaseline(session) ?? undefined;
          }
          // Capture now, while the session object exists: after eviction this
          // path is the only thing that can reopen the conversation, and an
          // in-memory session reports undefined, which correctly means
          // "nothing to come back to".
          // Optional chaining, not defensiveness for its own sake: this is the
          // only field read off the session at creation, so an older pi or a
          // stubbed session must degrade to "not resumable" rather than throw
          // and take the whole spawn down with it.
          record.sessionFile = session.sessionManager?.getSessionFile?.();
          if (record.sessionFile === undefined) {
            if (options.mainSessionFork === undefined) record.inMemorySession = true;
          } else {
            record.inMemorySession = undefined;
            this.claimRecordSessionFile(record, record.sessionFile, runGeneration);
          }
          // A reopened conversation already lives in that file. A fresh one is
          // only written once it holds a message, so the journal keeps the
          // prompt until the run's first assistant message confirms the file.
          if (options.resumeSessionFile !== undefined) {
            this.confirmSessionFile(record, runGeneration);
          }
          // Caller wiring can use host-owned context; shutdown retires it.
          if (this.disposed) return;
          // Flush pre-session steers only while this generation is uncancelled.
          if (record.cancellation?.generation !== runGeneration && record.pendingSteers?.length) {
            for (const msg of record.pendingSteers) {
              session.steer(msg).catch(() => {});
            }
            record.pendingSteers = undefined;
          }
          options.onSessionCreated?.(session);
        },
      })
      .then(async ({ responseText, session, aborted, steered, failure }) => {
        try {
          if (this.wakeRuns.get(id) === runGeneration) this.wakeRuns.delete(id);
          if (this.isSuspendedGeneration(record, runGeneration)) {
            settleSuspendedRun(session);
            return responseText;
          }
          runBudget.controller?.dispose();
          // Before detach: a parent abort during evaluation must still cancel.
          const usageDecision = aborted
            ? undefined
            : await this.evaluateRunUsageLimit(
                record,
                runGeneration,
                runBudget,
                failure,
                providerKey,
                modelRefOf(session?.model) ?? runModel,
                session ?? record.session,
                !isWakeRun && canParkForReset(record),
                isWakeRun ? "exhausted" : "reported",
              );
          // A suspend during the evaluation keeps the worktree and publishes nothing.
          if (this.isSuspendedGeneration(record, runGeneration)) {
            settleSuspendedRun(session);
            return responseText;
          }
          if (usageDecision?.park === true) {
            // Parked: keep the session, transcript stream, and any worktree for
            // the same-model continuation; publish nothing yet. The worktree is
            // cleaned on the task's final settle, whichever path reaches it.
            detach();
            record.session = session;
            record.result = responseText;
            record.error = failure;
            if (record.worktree !== undefined) {
              this.deferredWorktrees.set(id, () =>
                this.cleanupRecordWorktree(pi, record, baseCwd, customCwd, options.description),
              );
            }
            this.abortOwnedChildren(id);
            releaseRunPoolSlot();
            currentRunSettled = true;
            this.parkForReset(record, runGeneration, usageDecision, providerKey, wakeResumeOptions);
            this.drainQueue();
            return responseText;
          }
          let finalResult = responseText;
          const terminalStatus = terminalStatusFor({ aborted, failure, steered });
          detach();

          // Final flush of streaming output file
          if (record.outputCleanup) {
            try {
              record.outputCleanup();
            } catch {
              /* ignore */
            }
            record.outputCleanup = undefined;
          }

          // Clean up worktree if used
          if (record.worktree) {
            const worktree = record.worktree;
            const hookManaged = worktree.hookManaged === true;
            const worktreePath = worktree.path;
            const wtResult = hookManaged
              ? (await removeHookWorktree(pi, worktreePath), { hasChanges: false })
              : cleanupWorktree(baseCwd, worktree, options.description);
            if (record.resultGeneration !== runGeneration) return responseText;
            if (this.isSuspendedGeneration(record, runGeneration)) {
              settleSuspendedRun(session);
              return responseText;
            }
            record.worktreeResult = wtResult;
            if (wtResult.hasChanges && wtResult.branch) {
              // With a caller-supplied cwd the branch lives in THAT repo, not the
              // parent session's — say so, or the orchestrator merges in the wrong repo.
              const repoNote = customCwd === undefined ? "" : ` in \`${baseCwd}\``;
              finalResult =
                finalResult +
                `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd === undefined ? "" : ` (run in \`${baseCwd}\`)`}`;
            }
          }

          if (record.resultGeneration !== runGeneration) return responseText;
          if (this.disposed) {
            record.session = session;
            this.abortOwnedChildren(id);
            releaseRunPoolSlot();
            currentRunSettled = true;
            this.removeRecord(id, record);
            return responseText;
          }
          // Publish status, output and generation together. Keeping the record
          // active through asynchronous worktree cleanup prevents resume/result
          // reads from observing a terminal status with unfinished output.
          if (record.status !== "stopped") {
            this.transition(record, runBudget.forcedStatus ?? terminalStatus);
          }
          if (runBudget.forcedReason !== undefined) record.error = runBudget.forcedReason;
          else if (record.cancellation?.generation === runGeneration) {
            record.error = record.cancellation.reason;
          } else if (failure) {
            record.error =
              usageDecision === undefined
                ? failure
                : withUsageLimitNote(failure, usageDecision.usageLimit);
          }
          if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
          record.result = finalResult;
          record.session = session;
          record.completedAt ??= Date.now();
          if (
            record.cancellation?.generation !== runGeneration &&
            runBudget.forcedStatus === undefined
          ) {
            // A usage-limit decision already applied its own closure via closeUntil.
            if (failure !== undefined && usageDecision === undefined) {
              const kind = classifyTerminalFailure(failure);
              if (kind) recordFailure(providerKey, kind, retryAfterMsFromFailure(failure));
            } else if (failure === undefined && !aborted) recordSuccess(providerKey);
          }
          this.publishTerminal(record);
          if (usageDecision !== undefined) this.notifyUsageLimit(record);

          this.abortOwnedChildren(id);

          // Fire onComplete for foreground agents too — lifecycle symmetry.
          // Mark resultConsumed so the callback skips notifications (result returned inline).
          if (options.isBackground) {
            releaseRunPoolSlot();
            currentRunSettled = true;
            try {
              this.onComplete?.(record);
            } catch {
              /* ignore completion side-effect errors */
            }
            this.drainQueue();
          } else {
            this.markTerminalConsumed(record);
            currentRunSettled = true;
            try {
              this.onComplete?.(record);
            } catch {
              /* ignore completion side-effect errors */
            }
          }
          return responseText;
        } finally {
          if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
        }
      })
      .catch(async (err) => {
        try {
          if (this.wakeRuns.get(id) === runGeneration) this.wakeRuns.delete(id);
          if (this.isSuspendedGeneration(record, runGeneration)) {
            settleSuspendedRun(undefined);
            return "";
          }
          runBudget.controller?.dispose();
          const error = err instanceof Error ? err.message : String(err);
          detach();

          // Final flush of streaming output file on error
          if (record.outputCleanup) {
            try {
              record.outputCleanup();
            } catch {
              /* ignore */
            }
            record.outputCleanup = undefined;
          }

          // Best-effort worktree cleanup on error
          if (record.worktree) {
            try {
              const worktree = record.worktree;
              const hookManaged = worktree.hookManaged === true;
              const worktreePath = worktree.path;
              const wtResult = hookManaged
                ? (await removeHookWorktree(pi, worktreePath), { hasChanges: false })
                : cleanupWorktree(baseCwd, worktree, options.description);
              if (record.resultGeneration !== runGeneration) return "";
              if (this.isSuspendedGeneration(record, runGeneration)) {
                settleSuspendedRun(undefined);
                return "";
              }
              record.worktreeResult = wtResult;
            } catch {
              /* ignore cleanup errors */
            }
          }

          if (record.resultGeneration !== runGeneration) return "";
          if (this.disposed) {
            this.abortOwnedChildren(id);
            releaseRunPoolSlot();
            currentRunSettled = true;
            this.removeRecord(id, record);
            return "";
          }
          if (record.status !== "stopped") {
            this.transition(record, runBudget.forcedStatus ?? "error");
          }
          record.error =
            runBudget.forcedReason ??
            (record.cancellation?.generation === runGeneration
              ? record.cancellation.reason
              : error);
          record.completedAt ??= Date.now();
          if (
            record.cancellation?.generation !== runGeneration &&
            runBudget.forcedStatus === undefined
          ) {
            const kind = classifyTerminalFailure(error);
            if (kind) recordFailure(providerKey, kind, retryAfterMsFromFailure(error));
          }
          this.publishTerminal(record);

          this.abortOwnedChildren(id);

          // Fire onComplete for foreground agents too — lifecycle symmetry.
          // Mark resultConsumed so the callback skips notifications (result returned inline).
          if (options.isBackground) {
            releaseRunPoolSlot();
            currentRunSettled = true;
            this.onComplete?.(record);
            this.drainQueue();
          } else {
            this.markTerminalConsumed(record);
            currentRunSettled = true;
            this.onComplete?.(record);
          }
          return "";
        } finally {
          if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
        }
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming starts.
    this.onSpawned?.(id);
  }

  private dependencyCompletionGuard(record: AgentRecord, generation: number) {
    let corrected = false;
    // A resumed generation must discard its prior terminal snapshot before any turn runs.
    record.pendingDependents = undefined;
    return () => {
      if (
        this.disposed ||
        record.resultGeneration !== generation ||
        record.status !== "running" ||
        record.cancellation?.generation === generation
      )
        return undefined;
      const pending: NonNullable<AgentRecord["pendingDependents"]> = [];
      for (const child of this.agents.values()) {
        if (child.parentAgentId !== record.id) continue;
        if (
          child.status === "running" ||
          child.status === "queued" ||
          child.status === "waiting_for_reset"
        ) {
          pending.push({
            id: child.id,
            handle: child.handle,
            status: child.status,
          });
        }
      }
      if (pending.length === 0) return undefined;
      if (!corrected) {
        corrected = true;
        const labels = pending
          .map((child) => (child.handle ? `${child.id}/@${child.handle}` : child.id))
          .join(", ");
        return {
          steer: `Delegated run(s) ${labels} you own are still running. Await their result with get_subagent_result (or stop them) before finishing.`,
        };
      }
      record.pendingDependents = pending;
      return { failure: "Owned delegated runs were unsettled at the terminal boundary." };
    };
  }

  /** Update both bootstrap and live state for the retained child generation. */
  setDaybreak(id: string, requested: boolean): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record) return undefined;
    record.daybreakRequested = requested;
    record.daybreakSource = "explicit";
    record.daybreakRevision = (record.daybreakRevision ?? 0) + 1;
    const state = setSessionDaybreak(record.session?.sessionManager?.getSessionId?.(), requested);
    if (state) record.daybreakRevision = state.revision;
    if (record.daybreakInitialization) {
      record.daybreakInitialization.requested = requested;
      record.daybreakInitialization.source = "explicit";
      record.daybreakInitialization.revision = record.daybreakRevision;
    }
    return record;
  }

  /** Update one accepted generation without changing resume persistence semantics. */
  setFastMode(id: string, requested: boolean): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record) return undefined;
    record.fastModeRequested = requested;
    record.fastModeSource = "explicit";
    record.fastModeRevision = (record.fastModeRevision ?? 0) + 1;
    if (record.fastModeInitialization) {
      record.fastModeInitialization.requested = requested;
      record.fastModeInitialization.source = "explicit";
      record.fastModeInitialization.revision = record.fastModeRevision;
    }
    const state = setSessionFastMode(record.session?.sessionManager?.getSessionId?.(), requested);
    if (state) record.fastModeRevision = state.revision;
    return record;
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId && this.agents.get(id) === record) {
        this.stopRecord(record, false);
      }
    }
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.getSchedulingMaxConcurrent()) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      const owner = this.usageScopes.get(next.id)?.owner;
      const block = this.providerBlock(next.providerKey, owner);
      // A post-reset continuation whose account was closed again by a usage
      // limit waits for the new reset instead of dispatching or dropping; a
      // transient closure from another run must not hold or drop the task.
      if (block?.usage === true && next.repark !== undefined) {
        next.repark();
        continue;
      }
      if (next.finalize === undefined && block !== undefined) {
        this.transition(record, "error");
        record.error = providerUnavailableMessage(next.providerKey.toLowerCase(), block.closure);
        record.completedAt = Date.now();
        this.publishTerminal(record);
        this.onComplete?.(record);
        continue;
      }
      try {
        next.start();
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        this.transition(record, "error");
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.publishTerminal(record);
        if (next.finalize === undefined) this.onComplete?.(record);
        else next.finalize(true);
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    let id: string;
    try {
      // spawn() invokes onSpawned synchronously before returning. Restore the
      // shared hook immediately so unrelated concurrent spawns cannot inherit
      // this foreground caller's callback while its run is awaited.
      id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    } finally {
      this.onSpawned = prevOnSpawned;
    }
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    // A live run cannot be resumed safely in either mode: it owns the record's
    // abort controller and session prompt. Refuse before changing its alias or
    // any run state so a failed attempt leaves every address intact.
    // Another resume may also hold this record across its asynchronous model
    // switch. Refuse before any side effect: the host applies a model after
    // async authentication with no running check, so two switches must never
    // overlap.
    if (this.resumeBlockedByRun(id, record)) return undefined;

    // Model switch first, before any alias or run state changes, so a refused
    // or failed switch leaves the record exactly as it was.
    if (options?.model !== undefined) {
      const session = record.session;
      const generation = record.resultGeneration;
      // Reserved synchronously, before the first await; released only after the
      // switch settles, and everything from there to the new generation's
      // running/queued state is synchronous.
      this.resumeReservations.add(id);
      try {
        await this.applyResumeModel(record, session, options.model);
      } finally {
        this.resumeReservations.delete(id);
      }
      if (
        this.disposed ||
        this.agents.get(id) !== record ||
        record.session !== session ||
        record.resultGeneration !== generation ||
        ownsUnsettledGeneration(record)
      ) {
        return undefined;
      }
    }
    // Same owner-scoped availability gate as spawn, for every resumed dispatch
    // (with or without a model, foreground or background). Synchronous and
    // before any state change; with a model it re-checks the switched target.
    this.assertResumeProviderOpen(id, record.session);
    // A caller-initiated resume starts a new task outcome; the previous
    // chain's usage-limit block no longer describes it.
    record.usageLimit = undefined;
    this.wakeRuns.delete(id);

    if (options?.name !== undefined) {
      const previousAlias = record.alias;
      const nextAlias = assignHandle(
        handleBase(options.name),
        this.takenHandles(record.parentAgentId, record),
      );
      const ownTombstone = record.handle ? this.tombstones.get(record.handle) : undefined;
      if (
        ownTombstone?.id === record.id &&
        ownTombstone.handle === record.handle &&
        ownTombstone.alias === previousAlias
      ) {
        ownTombstone.alias = nextAlias;
      }
      record.alias = nextAlias;
    }
    if (options?.fastModeRequested !== undefined) {
      record.fastModeRequested = options.fastModeRequested;
      record.fastModeSource = "explicit";
      record.fastModeRevision = (record.fastModeRevision ?? 0) + 1;
      const state = setSessionFastMode(
        record.session.sessionManager?.getSessionId?.(),
        options.fastModeRequested,
      );
      if (state) record.fastModeRevision = state.revision;
    }

    if (options?.daybreakRequested !== undefined) {
      this.setDaybreak(id, options.daybreakRequested);
    }

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      this.queueBackgroundResume(id, record, prompt, signal, options);
      return record;
    }

    // Foreground resume: run inline and return the settled record.
    const runGeneration = beginResultGeneration(record);
    // A new generation is a new request: an earlier explicit stop no longer applies.
    record.stoppedByUser = undefined;
    this.transition(record, "running");
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.cancellation = undefined;
    const abortController = new AbortController();
    record.abortController = abortController;
    const onParentAbort = () =>
      this.requestCancellation(
        record,
        runGeneration,
        "parent_signal",
        "Parent run was cancelled.",
        abortController,
      );
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener("abort", onParentAbort, { once: true });
    const runBudget = this.armRunBudgets(record, runGeneration, options?.budgets, abortController);
    const session = record.session;
    const resumeProviderKey = (session.model?.provider ?? "unknown").toLowerCase();

    const resumePromise = (async (): Promise<AgentRecord> => {
      try {
        const { text, failure, aborted, steered } = await this.runner.resumeAgent(session, prompt, {
          onFinishAttempt: this.dependencyCompletionGuard(record, runGeneration),
          maxTurns: resolveAgentMaxTurns(record.type, options?.maxTurns),
          onToolActivity: (activity) => {
            if (isBudgetedToolActivity(activity)) {
              runBudget.controller?.noteToolActivity(activity.type);
            }
            if (activity.type === "end") record.toolUses++;
            options?.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            runBudget.controller?.noteUsage(usage);
            addUsage(record.lifetimeUsage, usage);
            options?.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options?.onCompaction?.(info);
          },
          signal: abortController.signal,
        });
        if (this.isSuspendedGeneration(record, runGeneration)) {
          this.finishSuspendedRun(record, undefined);
          return record;
        }
        // A limit under auto-resume parks exactly like a foreground spawn: the
        // caller gets the paused record now and the outcome as a notification.
        const usageDecision = await this.evaluateRunUsageLimit(
          record,
          runGeneration,
          runBudget,
          failure,
          resumeProviderKey,
          modelRefOf(session.model),
          session,
          canParkForReset(record),
          "reported",
        );
        if (record.resultGeneration !== runGeneration) return record;
        // A suspend during the evaluation settles without an outcome.
        if (this.isSuspendedGeneration(record, runGeneration)) {
          this.finishSuspendedRun(record, undefined);
          return record;
        }
        if (this.disposed) {
          this.abortOwnedChildren(id);
          this.removeRecord(id, record);
          return record;
        }
        if (usageDecision?.park === true) {
          record.result = text;
          record.error = failure;
          this.abortOwnedChildren(id);
          // The caller's streaming callbacks belong to a call that returns now.
          this.parkForReset(record, runGeneration, usageDecision, resumeProviderKey, {
            budgets: options?.budgets,
          });
          return record;
        }
        // Same contract as the spawn path (#144): a failed final turn is an
        // error, not a completion — but the resumed text stays available.
        const cancellation = cancellationForGeneration(record, runGeneration);
        if (runBudget.forcedStatus !== undefined) this.transition(record, runBudget.forcedStatus);
        else if (cancellation) this.transition(record, "stopped");
        else this.transition(record, terminalStatusFor({ aborted, failure, steered }));
        if (cancellation) {
          record.error = cancellation.reason;
        }
        if (runBudget.forcedReason !== undefined) record.error = runBudget.forcedReason;
        else if (failure) {
          record.error =
            usageDecision === undefined
              ? failure
              : withUsageLimitNote(failure, usageDecision.usageLimit);
        }
        if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
        record.result = text;
        record.completedAt = Date.now();
        this.markTerminalConsumed(record);
        if (usageDecision !== undefined) this.notifyUsageLimit(record);
      } catch (err) {
        if (record.resultGeneration !== runGeneration) return record;
        if (this.isSuspendedGeneration(record, runGeneration)) {
          this.finishSuspendedRun(record, undefined);
          return record;
        }
        if (this.disposed) {
          this.abortOwnedChildren(id);
          this.removeRecord(id, record);
          return record;
        }
        const cancellation = cancellationForGeneration(record, runGeneration);
        this.transition(record, runBudget.forcedStatus ?? (cancellation ? "stopped" : "error"));
        record.error =
          runBudget.forcedReason ??
          cancellation?.reason ??
          (err instanceof Error ? err.message : String(err));
        record.completedAt = Date.now();
        this.markTerminalConsumed(record);
      } finally {
        runBudget.controller?.dispose();
        signal?.removeEventListener("abort", onParentAbort);
      }

      // Same contract as the spawn settle paths: children spawned during the
      // resumed turn must not outlive it — nothing else can see or reach them.
      this.abortOwnedChildren(id);

      return record;
    })();
    record.promise = resumePromise.then((settledRecord) => settledRecord.result ?? "");
    return resumePromise;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    this.transition(record, "running");
    record.startedAt = Date.now();
    const runGeneration = record.resultGeneration ?? 1;
    const resumeProviderKey = (record.session.model?.provider ?? "unknown").toLowerCase();
    const runTookPoolSlot = occupiesPoolSlot(record);
    let runPoolSlotHeld = runTookPoolSlot;
    if (runTookPoolSlot) this.runningBackground++;
    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => {
        if (
          this.requestCancellation(
            record,
            runGeneration,
            "parent_signal",
            "Parent run was cancelled.",
          )
        ) {
          this.transition(record, "stopped");
          record.completedAt ??= Date.now();
        }
      };
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }
    const detach = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
    };
    const releaseRunPoolSlot = () => {
      if (!runPoolSlotHeld) return;
      runPoolSlotHeld = false;
      this.runningBackground--;
    };
    let staleRunSettled = false;
    let currentRunSettled = false;
    const settleStaleRun = () => {
      if (staleRunSettled) return;
      staleRunSettled = true;
      runBudget.controller?.dispose();
      detach();
      this.abortOwnedChildren(id);
      releaseRunPoolSlot();
      this.drainQueue();
    };
    const runBudget = this.armRunBudgets(record, runGeneration, options.budgets, abortController);

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try {
      options.onStarted?.();
    } catch {
      /* ignore caller wiring errors */
    }

    const settle = () => {
      if (this.wakeRuns.get(id) === runGeneration) this.wakeRuns.delete(id);
      runBudget.controller?.dispose();
      detach();
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try {
          record.outputCleanup();
        } catch {
          /* ignore */
        }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      releaseRunPoolSlot();
      currentRunSettled = true;
      if (this.disposed) {
        this.removeRecord(id, record);
        return;
      }
      try {
        this.onComplete?.(record);
      } catch {
        /* ignore completion side-effect errors */
      }
      this.drainQueue();
    };

    const promise = this.runner
      .resumeAgent(record.session, prompt, {
        onFinishAttempt: this.dependencyCompletionGuard(record, runGeneration),
        maxTurns: resolveAgentMaxTurns(record.type, options.maxTurns),
        onToolActivity: (activity) => {
          if (isBudgetedToolActivity(activity)) {
            runBudget.controller?.noteToolActivity(activity.type);
          }
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          runBudget.controller?.noteUsage(usage);
          addUsage(record.lifetimeUsage, usage);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        signal: abortController.signal,
      })
      .then(async ({ text, failure, aborted, steered }) => {
        try {
          if (this.isSuspendedGeneration(record, runGeneration)) {
            this.settleSuspendedResume(id, runGeneration, runBudget, detach, () => {
              releaseRunPoolSlot();
              currentRunSettled = true;
            });
            return text;
          }
          runBudget.controller?.dispose();
          // A post-reset continuation that hits the limit again is exhausted;
          // any other resumed run may park like a fresh spawn.
          const isWakeRun = this.wakeRuns.get(id) === runGeneration;
          const usageDecision = await this.evaluateRunUsageLimit(
            record,
            runGeneration,
            runBudget,
            failure,
            resumeProviderKey,
            modelRefOf(record.session?.model),
            record.session,
            !isWakeRun && canParkForReset(record),
            isWakeRun ? "exhausted" : "reported",
          );
          if (record.resultGeneration !== runGeneration) return text;
          // A suspend during the evaluation settles without an outcome.
          if (this.isSuspendedGeneration(record, runGeneration)) {
            this.settleSuspendedResume(id, runGeneration, runBudget, detach, () => {
              releaseRunPoolSlot();
              currentRunSettled = true;
            });
            return text;
          }
          if (this.disposed) {
            settle();
            return text;
          }
          if (usageDecision?.park === true) {
            detach();
            record.result = text;
            record.error = failure;
            this.abortOwnedChildren(id);
            releaseRunPoolSlot();
            currentRunSettled = true;
            this.parkForReset(record, runGeneration, usageDecision, resumeProviderKey, {
              budgets: options.budgets,
              onToolActivity: options.onToolActivity,
              onAssistantUsage: options.onAssistantUsage,
              onCompaction: options.onCompaction,
            });
            this.drainQueue();
            return text;
          }
          // Don't overwrite status if externally stopped via abort().
          if (record.status !== "stopped") {
            const forcedStatus = runBudget.forcedStatus;
            if (forcedStatus === undefined) {
              // Same contract as the spawn path (#144): a failed final turn is an
              // error, not a completion — but the resumed text stays available.
              this.transition(record, terminalStatusFor({ aborted, failure, steered }));
              if (failure) {
                record.error =
                  usageDecision === undefined
                    ? failure
                    : withUsageLimitNote(failure, usageDecision.usageLimit);
              }
            } else {
              this.transition(record, forcedStatus);
              record.error = runBudget.forcedReason;
            }
          }
          if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
          if (record.cancellation?.generation === runGeneration && record.error === undefined) {
            record.error = record.cancellation.reason;
          }
          record.result = text;
          record.completedAt ??= Date.now();
          this.finishDeferredWorktree(record);
          this.publishTerminal(record);
          if (usageDecision !== undefined) this.notifyUsageLimit(record);
          settle();
          return text;
        } finally {
          if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
        }
      })
      .catch((err) => {
        try {
          if (this.isSuspendedGeneration(record, runGeneration)) {
            this.settleSuspendedResume(id, runGeneration, runBudget, detach, () => {
              releaseRunPoolSlot();
              currentRunSettled = true;
            });
            return "";
          }
          runBudget.controller?.dispose();
          if (record.resultGeneration !== runGeneration) return "";
          if (this.disposed) {
            settle();
            return "";
          }
          if (record.status !== "stopped") {
            this.transition(record, runBudget.forcedStatus ?? "error");
            record.error =
              runBudget.forcedReason ?? (err instanceof Error ? err.message : String(err));
          }
          if (record.cancellation?.generation === runGeneration && record.error === undefined) {
            record.error = record.cancellation.reason;
          }
          record.completedAt ??= Date.now();
          this.finishDeferredWorktree(record);
          this.publishTerminal(record);
          settle();
          return "";
        } finally {
          if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
        }
      });

    record.promise = promise;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    // A parked session is idle; hold the message for the post-reset prompt.
    if (record.status === "waiting_for_reset") {
      (record.pendingSteers ??= []).push(message);
      // Journaled so a revival delivers it after the reset.
      this.scheduleJournal(record);
      return true;
    }
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.cancellation?.generation === (record.resultGeneration ?? 1)) return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Dispose one record only after its current generation has settled. */
  disposeSettledRecord(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || record.status === "running" || record.status === "queued") return false;
    if (record.terminalResultGeneration !== record.resultGeneration) return false;
    this.removeRecord(id, record);
    return true;
  }

  /** Handles and aliases already in use across the live tree. */
  private takenHandles(parentAgentId: string | undefined, aliasOwner?: AgentRecord): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record !== aliasOwner && record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    if (parentAgentId === undefined) {
      for (const entry of this.tombstones.values()) {
        taken.add(entry.handle);
        // A reclaimed live record and its retained tombstone describe the same
        // conversation. Exclude that duplicate owner while still reserving all
        // unrelated tombstone aliases for deterministic collision numbering.
        const belongsToAliasOwner =
          aliasOwner?.id === entry.id &&
          aliasOwner.handle === entry.handle &&
          aliasOwner.alias === entry.alias;
        if (entry.alias && !belongsToAliasOwner) taken.add(entry.alias);
      }
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted)
        continue;
      if (record.status === "running" || record.status === "queued")
        return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined)
      return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (
        entry.handle.toLowerCase() === wanted ||
        entry.alias?.toLowerCase() === wanted ||
        entry.id === name
      ) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Active records across the full tree, including ownership-scoped nested agents. */
  getActiveCount(): number {
    return [...this.agents.values()].filter(ownsUnsettledGeneration).length;
  }

  /** Active top-level background records governed by the shared pool cap. */
  getScheduledActiveCount(): number {
    return [...this.agents.values()].filter(
      (record) =>
        ownsUnsettledGeneration(record) &&
        occupiesPoolSlot(record) &&
        // Parked records hold no pool slot until their continuation starts.
        record.status !== "waiting_for_reset",
    ).length;
  }

  /**
   * Explicit stop (stop_subagent, UI, RPC). Marks the record `stoppedByUser`
   * so durable revival never restarts it.
   */
  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    return this.stopRecord(record, true);
  }

  private stopRecord(record: AgentRecord, byUser: boolean): boolean {
    const id = record.id;
    // A parked record has no live run: cancel its wait and settle it now, with
    // a terminal usage status so exactly one final event follows the park.
    if (record.status === "waiting_for_reset") {
      if (byUser) record.stoppedByUser = true;
      this.settleParked(record, this.usageWaits.get(id), {
        status: "stopped",
        usageStatus: "exhausted",
        reason: "Stopped by user request.",
        cause: "user_stop",
        notify: true,
      });
      return true;
    }

    // Remove from queue if queued
    if (record.status === "queued") {
      if (byUser) record.stoppedByUser = true;
      const entry = this.queue.find((q) => q.id === id);
      this.queue = this.queue.filter((q) => q.id !== id);
      this.stopQueuedRecord(record, "user_stop", "Stopped by user request.");
      // A queued post-reset continuation still owes the parked task's promise
      // and its one final notification.
      if (entry?.finalize !== undefined) {
        entry.finalize(true);
        return true;
      }
      // Ordinary queued Agent calls historically settle without a completion
      // nudge. Workflow controllers still need this transition to reach their
      // aggregate/UI bookkeeping after cancellation.
      if (record.workflowId) {
        try {
          this.onComplete?.(record);
        } catch {
          /* ignore completion side-effect errors */
        }
      }
      return true;
    }

    if (record.status !== "running") return false;
    if (byUser) record.stoppedByUser = true;
    this.requestCancellation(
      record,
      record.resultGeneration ?? 1,
      "user_stop",
      "Stopped by user request.",
    );
    this.transition(record, "stopped");
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord, options?: { suspended?: boolean }): void {
    const suspended = options?.suspended === true;
    // A suspended record is revived or kept dormant from the journal; its
    // worktree is kept for the revival and its name stays with the journal.
    if (suspended) this.deferredWorktrees.delete(id);
    else this.tombstone(record);
    this.finishDeferredWorktree(record);
    // Before the scope and session go: the final snapshot reads both.
    const dormant = this.retireJournal(record);
    const wait = this.usageWaits.get(id);
    if (wait?.timer !== undefined) clearTimeout(wait.timer);
    this.usageWaits.delete(id);
    this.usageScopes.delete(id);
    this.wakeRuns.delete(id);
    this.revivalArgs.delete(id);
    // Captured now: a revival may claim this id again before disposal ends.
    const claim = this.sessionClaims.get(id);
    this.sessionClaims.delete(id);
    const releaseClaim = () => {
      if (claim !== undefined) releaseSessionFile(claim.file, claim.token);
    };
    if (record.session) {
      const session = record.session;
      try {
        unregisterChildSessionId(session.sessionManager.getSessionId());
      } catch {
        /* a stub or retired session manager has no id to release */
      }
      cleanupChildSessionOwner(session);
      // Pi's own runtime emits session_shutdown before dispose(); a bare dispose() skips
      // it, so extensions that own per-session processes (the Codex code-mode host and
      // exec bridge, MCP clients) never release them and the children leak. Emit it the
      // same way, then dispose regardless of handler failures.
      const shutdown = emitChildSessionShutdown(session);
      if (shutdown) {
        void shutdown
          .then(() => session.dispose?.())
          .catch(() => undefined)
          .finally(releaseClaim);
      } else {
        try {
          session.dispose?.();
        } finally {
          releaseClaim();
        }
      }
    } else {
      releaseClaim();
    }
    record.session = undefined;
    this.agents.delete(id);
    if (dormant !== undefined) this.putDormant(dormant);
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has both a handle to be
   * addressed by and a session file to reopen — an in-memory session leaves no
   * transcript, so the mention would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    if (record.parentAgentId !== undefined || !record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    });
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) =>
        a.completedAt <= b.completedAt ? a : b,
      );
      this.tombstones.delete(oldest.handle);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (record.terminalResultGeneration !== record.resultGeneration) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (record.terminalResultGeneration !== record.resultGeneration) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(ownsUnsettledGeneration);
  }

  // ---- Durable revival: session-file ownership ----

  private ownerToken(id: string, generation: number): string {
    return `${this.instanceToken}:${id}:${generation}`;
  }

  /**
   * Claim the record's child session file once its path is known. An existing
   * claim on the same file (a revival's pre-claim) is kept. Returns false when
   * another owner holds the file.
   */
  private claimRecordSessionFile(record: AgentRecord, file: string, generation: number): boolean {
    const existing = this.sessionClaims.get(record.id);
    if (existing?.file === file) return true;
    const token = this.ownerToken(record.id, generation);
    if (!claimSessionFile(file, token)) return false;
    if (existing !== undefined) releaseSessionFile(existing.file, existing.token);
    this.sessionClaims.set(record.id, { file, token });
    return true;
  }

  // ---- Durable revival: graceful suspend ----

  private isSuspendedGeneration(record: AgentRecord, generation: number): boolean {
    return (
      record.resultGeneration === generation &&
      cancellationForGeneration(record, generation)?.cause === "suspend"
    );
  }

  /**
   * Settle a suspended run: no worktree cleanup, publication, completion
   * callback, owned-child abort or journal write. The session is disposed and
   * its file released, so a revival can reopen it.
   */
  private finishSuspendedRun(record: AgentRecord, session: AgentSession | undefined): void {
    if (session !== undefined) record.session = session;
    if (record.outputCleanup) {
      try {
        record.outputCleanup();
      } catch {
        /* ignore */
      }
      record.outputCleanup = undefined;
    }
    if (this.agents.get(record.id) === record) {
      this.removeRecord(record.id, record, { suspended: true });
    }
    if (!this.disposed) this.drainQueue();
  }

  /** startResume's settle for a suspended generation. */
  private settleSuspendedResume(
    id: string,
    generation: number,
    runBudget: RunBudgetState,
    detach: () => void,
    releaseSlot: () => void,
  ): void {
    if (this.wakeRuns.get(id) === generation) this.wakeRuns.delete(id);
    runBudget.controller?.dispose();
    detach();
    releaseSlot();
    const record = this.agents.get(id);
    if (record !== undefined) this.finishSuspendedRun(record, undefined);
  }

  /**
   * Synchronous part of a graceful suspend. Every live journaled record that
   * is queued, running or waiting for a usage reset gets a `suspended: true`
   * entry first (interrupted, or waiting_for_reset with its usage wait and
   * steers), then is cancelled with cause `suspend`. Records without a run
   * (queued, parked) are removed at once; running ones on settle. Returns the
   * suspended records and the running ones whose settlement is pending.
   */
  private suspendNow(): SuspendPlanResult {
    this.revivalEpoch++;
    this.flushJournal();
    const plans: SuspendPlan[] = [];
    for (const record of this.agents.values()) {
      if (this.journalSinkFor(record) === undefined) continue;
      const generation = record.resultGeneration ?? 1;
      // A run already being cancelled for a real reason settles normally.
      if (record.cancellation?.generation === generation) continue;
      if (record.status === "waiting_for_reset") {
        plans.push({ record, status: "waiting_for_reset", wait: this.usageWaits.get(record.id) });
      } else if (record.status === "queued") {
        const queueEntry = this.queue.find((entry) => entry.id === record.id);
        // A queued post-reset continuation is still a usage wait.
        if (queueEntry?.wait === undefined) {
          plans.push({ record, status: "interrupted", queueEntry });
        } else {
          plans.push({ record, status: "waiting_for_reset", wait: queueEntry.wait, queueEntry });
        }
      } else if (record.status === "running") {
        plans.push({ record, status: "interrupted" });
      }
    }
    // Journal every suspension before anything is aborted.
    for (const plan of plans) this.writeSuspendedJournal(plan.record, plan.status, plan.wait);

    const running: AgentRecord[] = [];
    for (const plan of plans) {
      const record = plan.record;
      const generation = record.resultGeneration ?? 1;
      record.cancellation = {
        generation,
        cause: "suspend",
        reason: SUSPEND_REASON,
        requestedAt: Date.now(),
      };
      this.transition(record, "interrupted");
      this.deferredWorktrees.delete(record.id);
      if (plan.queueEntry !== undefined) {
        const entry = plan.queueEntry;
        this.queue = this.queue.filter((queued) => queued !== entry);
      }
      const wait = plan.wait ?? this.usageWaits.get(record.id);
      if (wait !== undefined) {
        if (wait.timer !== undefined) clearTimeout(wait.timer);
        wait.timer = undefined;
        this.usageWaits.delete(record.id);
      }
      const hasRun = plan.status === "interrupted" && plan.queueEntry === undefined;
      if (hasRun) {
        record.pendingSteers = undefined;
        record.abortController?.abort();
        running.push(record);
      } else {
        // No run will settle it: unblock anyone awaiting the parked promise
        // (the record reads "interrupted"), then dispose and release now.
        if (this.wakeRuns.get(record.id) === generation) this.wakeRuns.delete(record.id);
        wait?.release(record.result ?? "");
        this.removeRecord(record.id, record, { suspended: true });
      }
    }
    return { suspended: plans.map((plan) => plan.record), running };
  }

  /**
   * Graceful suspend for quit, /reload, or a session switch. Journaled live
   * records are journaled as suspended and cancelled without an outcome;
   * records outside the journal (workflow steps, /btw) are stopped as by
   * `abortAll`. Waits up to `SUSPEND_SETTLE_TIMEOUT_MS` for suspended runs to settle
   * (each settle disposes its session and releases its file).
   */
  async suspendAll(): Promise<SuspendSummary> {
    const { suspended, running } = this.suspendNow();
    const aborted = this.abortAll();
    const settled = new Set<string>();
    const pending = running.map((record) =>
      Promise.resolve(record.promise)
        .catch(() => undefined)
        .then(() => {
          settled.add(record.id);
        }),
    );
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SUSPEND_SETTLE_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.all(pending), bound]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return {
      suspended: suspended.map((record) => record.id),
      unsettled: running.filter((record) => !settled.has(record.id)).map((record) => record.id),
      aborted,
    };
  }

  // ---- Durable revival: startup revival and dormant resume ----

  /** Journal a revival that can never succeed as an error, and keep it dormant. */
  private journalRevivalFailure(snapshot: JournalAgentSnapshot, reason: string): void {
    const sink = this.journalSink;
    const failed: JournalAgentSnapshot = {
      ...snapshot,
      status: "error",
      error: reason,
      usageWait: undefined,
      steers: undefined,
    };
    if (sink !== undefined) {
      try {
        sink.append(
          buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: failed }),
        );
      } catch (err) {
        this.noteJournalFailure(
          sink,
          snapshot.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    this.putDormant(failed);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Validate one snapshot for a revival, re-arm or dormant resume and take its
   * session-file claim. Mirrors spawn's checks (type, registry, model scope,
   * provider closure); every failure names its reason. After each await the
   * revival must still be current (`isCurrent`), otherwise any claim is released.
   */
  private async prepareRevival(
    snapshot: JournalAgentSnapshot,
    mode: PreparedRevival["mode"],
    clean: boolean | undefined,
    revivals: number,
    context: RevivalContext,
    isCurrent: () => boolean,
  ): Promise<PrepareOutcome> {
    const permanent = (reason: string): PrepareOutcome => ({
      kind: "failed",
      reason,
      journal: true,
    });
    if (snapshot.options.workflowId !== undefined || snapshot.options.sideConversation === true) {
      return permanent("Workflow steps and /btw answers are not revivable.");
    }
    let type: SubagentType = snapshot.type;
    if (context.resolveType !== undefined) {
      let resolved: ReturnType<NonNullable<RevivalContext["resolveType"]>>;
      try {
        resolved = context.resolveType(snapshot.type);
      } catch (err) {
        return permanent(err instanceof Error ? err.message : String(err));
      }
      if (!resolved.ok) return permanent(resolved.message);
      type = resolved.type;
    }
    let model: Model<Api> | undefined;
    const ctx = context.ctx;
    if (snapshot.model !== undefined) {
      const key = `${snapshot.model.provider}/${snapshot.model.id}`;
      let available: ModelEntry[] = [];
      try {
        model = ctx.modelRegistry.find(snapshot.model.provider, snapshot.model.id);
        available = ctx.modelRegistry.getAvailable();
      } catch {
        model = undefined;
      }
      const wanted = key.toLowerCase();
      if (
        model === undefined ||
        !available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === wanted)
      ) {
        return permanent(
          `Model not available: "${key}" (unknown to the registry or missing authentication).`,
        );
      }
      const verdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        // Strict: a revival never runs a model outside the current scope.
        callerSupplied: true,
        agentLabel: snapshot.type,
        modelInput: key,
      });
      if (verdict.kind === "error") return permanent(verdict.message);
    }
    if (mode !== "rearm") {
      const providerKey = (model?.provider ?? ctx.model?.provider ?? "unknown").toLowerCase();
      const block = this.providerBlock(providerKey, this.journalSink?.rootSessionId);
      if (block !== undefined) {
        return permanent(providerUnavailableMessage(providerKey, block.closure));
      }
    }
    const steers = [...(snapshot.steers ?? []), ...(snapshot.usageWait?.steers ?? [])];
    if (
      snapshot.inMemorySession === true &&
      snapshot.sessionFile === undefined &&
      snapshot.status !== "queued"
    ) {
      return permanent(
        "Not revivable: its session was kept in memory (persist_session: false), so there is nothing to continue from.",
      );
    }

    let adopt: AdoptedWorktree | undefined;
    const worktree = snapshot.worktree;
    if (worktree !== undefined) {
      if (worktree.hookManaged === true) {
        const present = await this.directoryExists(worktree.path);
        if (!isCurrent()) return { kind: "stale" };
        if (!present) {
          return permanent(
            `Isolated worktree ${worktree.path} (branch "${worktree.branch}") no longer exists.`,
          );
        }
      } else {
        const probe = await probeWorktree(worktree);
        if (!isCurrent()) return { kind: "stale" };
        if (!probe.present) return permanent(probe.message);
      }
      adopt = { ...worktree };
    }

    const file = snapshot.sessionFile;
    let freshPrompt: string | undefined;
    let claim: SessionClaim | undefined;
    if (file !== undefined && (await this.fileExists(file))) {
      if (!isCurrent()) return { kind: "stale" };
      const outcome = await waitForSessionFileRelease(file, {
        timeoutMs: SESSION_FILE_RELEASE_TIMEOUT_MS,
      });
      if (!isCurrent()) return { kind: "stale" };
      const token = this.ownerToken(snapshot.id, 1);
      if (outcome !== "released" || !claimSessionFile(file, token)) {
        return {
          kind: "failed",
          reason: `Session file ${file} is still in use by another owner; it was not reopened.`,
          journal: false,
        };
      }
      claim = { file, token };
    } else {
      if (!isCurrent()) return { kind: "stale" };
      if (mode === "rearm" || mode === "resume") {
        return permanent(
          file === undefined
            ? "No saved session file to continue from."
            : `Session file ${file} is missing.`,
        );
      }
      if (snapshot.prompt === undefined) {
        return permanent(
          file === undefined
            ? "No saved session file or original prompt to continue from."
            : `Session file ${file} is missing and the original prompt was not kept.`,
        );
      }
      freshPrompt = snapshot.prompt;
    }
    return {
      kind: "ok",
      prepared: { snapshot, mode, clean, revivals, type, model, adopt, claim, freshPrompt, steers },
    };
  }

  /** Spawn options that re-create a journaled agent's run settings. */
  private revivalSpawnOptions(prepared: PreparedRevival, context: RevivalContext): SpawnOptions {
    const snapshot = prepared.snapshot;
    const saved = snapshot.options;
    const callbacks = context.callbacksFor?.(snapshot) ?? {};
    return {
      description: snapshot.description,
      model: prepared.model,
      maxTurns: saved.maxTurns,
      budgets: saved.budgets,
      thinkingLevel: saved.thinkingLevel,
      isolated: saved.isolated,
      // A reopened file already holds the conversation; re-sending the
      // parent's context would only duplicate it.
      inheritContext: prepared.claim === undefined ? saved.inheritContext : false,
      isolation: saved.isolation,
      cwd: saved.cwd,
      configCwd: saved.configCwd,
      // A revived foreground agent has no caller left to answer inline.
      isBackground: true,
      readOnly: saved.readOnly,
      maxSubagentDepth: saved.maxSubagentDepth,
      fastModeRequested: saved.fastModeRequested,
      daybreakRequested: saved.daybreakRequested,
      invocation:
        saved.invocation === undefined ? undefined : { ...saved.invocation, runInBackground: true },
      depth: snapshot.depth,
      parentAgentId: snapshot.parentAgentId,
      rootSessionId: this.journalSink?.rootSessionId,
      resumeSessionFile: prepared.claim?.file,
      adoptWorktree: prepared.adopt,
      onToolActivity: callbacks.onToolActivity,
      onTextDelta: callbacks.onTextDelta,
      onSessionCreated: callbacks.onSessionCreated,
      onTurnEnd: callbacks.onTurnEnd,
      onAssistantUsage: callbacks.onAssistantUsage,
      onCompaction: callbacks.onCompaction,
    };
  }

  /**
   * Start (or queue) a prepared revival under its journaled identity. Throws
   * what spawn would throw; the caller journals it and releases the claim.
   */
  private startPreparedRevival(
    prepared: PreparedRevival,
    context: RevivalContext,
    prompt: string,
  ): AgentRecord {
    const snapshot = prepared.snapshot;
    const options = this.revivalSpawnOptions(prepared, context);
    const identity: RevivalIdentity = {
      id: snapshot.id,
      handle: snapshot.handle,
      alias: snapshot.alias,
      revivals: prepared.revivals,
      steers: prepared.claim === undefined ? prepared.steers : undefined,
      scoped: snapshot.options.scopedModels ?? [],
      outputFile: snapshot.options.outputFile,
      claim: prepared.claim,
      rearm:
        prepared.mode === "rearm" && prepared.claim !== undefined
          ? { snapshot, sessionFile: prepared.claim.file }
          : undefined,
    };
    const id = this.spawnWith(context.pi, context.ctx, prepared.type, prompt, options, identity);
    const record = this.agents.get(id);
    if (record === undefined) throw new Error(`Revived agent ${id} disappeared while starting.`);
    // Journaled with the record's first entry (flushed before the runner ran).
    this.setRevivals(id, prepared.revivals);
    try {
      context.onRevived?.(record);
    } catch {
      /* caller wiring errors must not undo the revival */
    }
    return record;
  }

  /**
   * Re-arm a usage wait for a record recreated from the journal. No session is
   * open while it waits; the file stays claimed so the wake can reopen it.
   */
  private armRevivedWait(
    record: AgentRecord,
    args: SpawnArgs,
    snapshot: JournalAgentSnapshot,
    sessionFile: string,
  ): void {
    const saved = snapshot.usageWait;
    if (saved === undefined) throw new Error(`Agent ${record.id} has no journaled usage wait.`);
    const owner = this.journalSink?.rootSessionId ?? this.usageScopes.get(record.id)?.owner ?? "";
    const classification = usageClassificationOf(saved.classification);
    const providerKey = saved.providerKey.toLowerCase();
    const accountId = this.accountFor(owner, providerKey);
    const accountIds =
      classification.accountId === undefined || classification.accountId === accountId
        ? [accountId]
        : [accountId, classification.accountId];
    let release: (value: string | PromiseLike<string>) => void = () => undefined;
    const parkedPromise = new Promise<string>((resolve) => {
      release = resolve;
    });
    record.sessionFile = sessionFile;
    this.sessionFileConfirmed.add(record.id);
    record.spawnPrompt = undefined;
    record.pendingSteers = undefined;
    record.isBackground = true;
    record.promise = parkedPromise;
    const resetAt = saved.resetAt ?? classification.resetAt;
    record.usageLimit = {
      provider: classification.provider,
      accountId: classification.accountId ?? accountId,
      kind: classification.kind,
      resetAt,
      status: "waiting_for_reset",
    };
    const wait: UsageWait = {
      generation: record.resultGeneration ?? 1,
      owner,
      providerKey,
      accountIds,
      classification,
      resumeOptions: {
        budgets: args.options.budgets,
        onToolActivity: args.options.onToolActivity,
        onAssistantUsage: args.options.onAssistantUsage,
        onCompaction: args.options.onCompaction,
      },
      continuation: [...saved.steers],
      parkedPromise,
      release,
      revived: true,
    };
    this.usageWaits.set(record.id, wait);
    this.revivalArgs.set(record.id, args);
    const adopt = args.options.adoptWorktree;
    if (adopt !== undefined) {
      // Journaled while waiting (a second restart must still find it) and
      // cleaned up if the wait settles without a continuation.
      this.applyAdoptedWorktree(record, adopt);
      const customCwd = args.options.cwd ?? undefined;
      this.deferredWorktrees.set(record.id, () =>
        this.cleanupRecordWorktree(args.pi, record, adopt.repo, customCwd, record.description),
      );
    }
    this.transition(record, "waiting_for_reset");
    if (resetAt !== undefined && resetAt > Date.now()) {
      this.armUsageWake(record, wait, resetAt);
    } else {
      // The reset passed while the host was down (or was never estimated):
      // re-check readiness shortly instead of waiting a full poll interval.
      this.armWakeTimer(record, wait, REARM_RESET_GRACE_MS);
    }
  }

  /**
   * Post-reset continuation of a re-armed record: reopen its claimed session
   * file through the spawn path under the same id. A start failure settles the
   * parked task as an error instead of throwing into the wake timer.
   */
  private startRevivedContinuation(
    id: string,
    record: AgentRecord,
    args: SpawnArgs,
    prompt: string,
    finalize: QueuedFinalizer | undefined,
  ): void {
    record.abortController = new AbortController();
    // The continuation's own settle cleans an adopted worktree from here on.
    const deferredCleanup = this.deferredWorktrees.get(id);
    this.deferredWorktrees.delete(id);
    try {
      this.startAgent(id, record, {
        ...args,
        prompt,
        options: {
          ...args.options,
          resumeSessionFile: record.sessionFile,
          inheritContext: false,
        },
      });
      this.revivalArgs.delete(id);
    } catch (err) {
      if (deferredCleanup !== undefined) this.deferredWorktrees.set(id, deferredCleanup);
      this.transition(record, "error");
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      this.publishTerminal(record);
      if (finalize === undefined) {
        this.finishDeferredWorktree(record);
        try {
          this.onComplete?.(record);
        } catch {
          /* ignore completion side-effect errors */
        }
      } else finalize(true);
    }
  }

  /**
   * Revive journaled agents at startup. Call after `setJournalSink` for the root
   * whose journal produced `snapshots` (`reduceJournal(...).values()`). Per
   * `startupDisposition`: revive (same id, handle and options; reopen the
   * session file with the interruption prompt, or restart a never-started run
   * from its original prompt), re-arm a usage wait, keep capped and terminal
   * agents dormant. Nested children revive only with their parent (parents
   * first). Every outcome except a plain terminal dormant entry is reported
   * through `context.onRevivalReport` and returned.
   */
  async reviveFromJournal(
    snapshots: Iterable<RevivalSnapshot>,
    context: RevivalContext,
  ): Promise<RevivalReport[]> {
    const reports: RevivalReport[] = [];
    const report = (
      kind: RevivalReportKind,
      snapshot: JournalAgentSnapshot,
      message: string,
    ): void => {
      const entry: RevivalReport = {
        kind,
        agentId: snapshot.id,
        handle: snapshot.handle,
        description: snapshot.description,
        parentAgentId: snapshot.parentAgentId,
        message,
      };
      reports.push(entry);
      try {
        context.onRevivalReport?.(entry);
      } catch {
        /* reporting must not stop the revival pass */
      }
    };
    const sink = this.journalSink;
    const inputs = [...snapshots].filter((input) =>
      Value.Check(JournalAgentSnapshotSchema, input.agent),
    );
    if (sink === undefined || this.disposed) {
      for (const input of inputs) {
        if (startupDisposition(input).kind !== "dormant") {
          report("skipped", input.agent, "No journal is active for this session; not revived.");
        }
      }
      return reports;
    }
    const epoch = this.revivalEpoch;
    const isCurrent = () =>
      !this.disposed && this.revivalEpoch === epoch && this.journalSink === sink;

    interface Candidate {
      snapshot: JournalAgentSnapshot;
      mode: "revive" | "rearm";
      clean: boolean | undefined;
      revivals: number;
    }
    const dormant: JournalAgentSnapshot[] = [];
    const candidates: Candidate[] = [];
    for (const input of inputs) {
      const snapshot = input.agent;
      if (this.agents.has(snapshot.id) || this.revivalReservations.has(snapshot.id)) continue;
      const disposition = startupDisposition(input);
      if (disposition.kind === "dormant") {
        dormant.push(snapshot);
      } else if (disposition.kind === "capped") {
        // Journaled once as a terminal error: the next startup finds a plain
        // dormant error and neither revives nor reports it again.
        this.journalRevivalFailure(snapshot, CAPPED_REVIVAL_ERROR);
        report(
          "capped",
          snapshot,
          `Not revived: its run ended unexpectedly ${disposition.revivals + 1} times in a row. Resume it explicitly to continue.`,
        );
      } else if (disposition.kind === "revive") {
        candidates.push({
          snapshot,
          mode: "revive",
          clean: disposition.clean,
          revivals: disposition.revivals,
        });
      } else {
        candidates.push({ snapshot, mode: "rearm", clean: true, revivals: snapshot.revivals });
      }
    }
    this.hydrateDormant(dormant);
    for (const candidate of candidates) this.revivalReservations.add(candidate.snapshot.id);

    const prepared = new Map<string, PreparedRevival>();
    const releasePrepared = (item: PreparedRevival): void => {
      if (item.claim !== undefined && this.sessionClaims.get(item.snapshot.id) !== item.claim) {
        releaseSessionFile(item.claim.file, item.claim.token);
      }
    };
    try {
      // Prepare level by level so a child sees whether its parent made it.
      const depths = [...new Set(candidates.map((c) => c.snapshot.depth))].sort((a, b) => a - b);
      for (const depth of depths) {
        const level = candidates.filter((candidate) => candidate.snapshot.depth === depth);
        const outcomes = await Promise.all(
          level.map(async (candidate): Promise<[Candidate, PrepareOutcome]> => {
            const parentId = candidate.snapshot.parentAgentId;
            if (parentId !== undefined && !prepared.has(parentId) && !this.agents.has(parentId)) {
              return [
                candidate,
                {
                  kind: "failed",
                  reason: `Not revived: its parent agent ${parentId} is not being revived.`,
                  journal: false,
                },
              ];
            }
            const outcome = await this.prepareRevival(
              candidate.snapshot,
              candidate.mode,
              candidate.clean,
              candidate.revivals,
              context,
              isCurrent,
            );
            return [candidate, outcome];
          }),
        );
        for (const [candidate, outcome] of outcomes) {
          const snapshot = candidate.snapshot;
          if (outcome.kind === "ok") {
            prepared.set(snapshot.id, outcome.prepared);
          } else if (outcome.kind === "stale") {
            this.putDormant(snapshot);
          } else if (outcome.journal) {
            this.journalRevivalFailure(snapshot, outcome.reason);
            report("failed", snapshot, outcome.reason);
          } else {
            this.putDormant(snapshot);
            const parentSkip =
              snapshot.parentAgentId !== undefined &&
              !prepared.has(snapshot.parentAgentId) &&
              !this.agents.has(snapshot.parentAgentId) &&
              outcome.reason.startsWith("Not revived: its parent");
            report(parentSkip ? "skipped" : "failed", snapshot, outcome.reason);
          }
        }
      }

      if (!isCurrent()) {
        for (const item of prepared.values()) {
          releasePrepared(item);
          this.putDormant(item.snapshot);
          report("skipped", item.snapshot, "Revival cancelled: the session changed or shut down.");
        }
        return reports;
      }

      // Start synchronously, parents first, each parent told which children
      // are being revived for it.
      const ordered = [...prepared.values()].sort((a, b) => a.snapshot.depth - b.snapshot.depth);
      for (const item of ordered) {
        const snapshot = item.snapshot;
        const parentId = snapshot.parentAgentId;
        if (parentId !== undefined && !this.agents.has(parentId)) {
          releasePrepared(item);
          this.putDormant(snapshot);
          report("skipped", snapshot, `Not revived: its parent agent ${parentId} did not start.`);
          continue;
        }
        const children: InterruptedChildRun[] = ordered
          .filter((other) => other.snapshot.parentAgentId === snapshot.id)
          .map((other) => ({
            id: other.snapshot.id,
            handle: other.snapshot.handle,
            description: other.snapshot.description,
          }));
        const prompt =
          item.mode === "rearm"
            ? USAGE_LIMIT_RESUME_PROMPT
            : item.claim === undefined
              ? (item.freshPrompt ?? "")
              : buildInterruptionPrompt({
                  unclean: item.clean === undefined ? undefined : !item.clean,
                  steers: item.steers,
                  children,
                });
        try {
          this.startPreparedRevival(item, context, prompt);
        } catch (err) {
          releasePrepared(item);
          const reason = err instanceof Error ? err.message : String(err);
          this.journalRevivalFailure(snapshot, reason);
          report("failed", snapshot, reason);
          continue;
        }
        if (item.mode === "rearm") {
          report(
            "rearmed",
            snapshot,
            "Waiting for the provider usage window to reset again; it continues automatically.",
          );
        } else {
          const how =
            item.claim === undefined
              ? "restarts from its original prompt"
              : `continues from its saved session${item.clean === false ? ` (unclean exit, revival ${item.revivals} of 2)` : ""}`;
          report("revived", snapshot, `Revived: ${how}.`);
        }
      }
      return reports;
    } finally {
      for (const candidate of candidates) this.revivalReservations.delete(candidate.snapshot.id);
    }
  }

  /**
   * Whether `id` is a dormant (evicted or never-revived) agent whose saved
   * session `resumeDormant` could reopen. Side-effect free.
   */
  canResumeDormant(id: string): boolean {
    if (this.disposed || this.agents.has(id) || this.revivalReservations.has(id)) return false;
    return this.getDormant(id)?.sessionFile !== undefined;
  }

  /**
   * Continue a dormant or interrupted agent from its saved session file under
   * the same id, in the background, with the user's prompt (prefixed by the
   * interruption notice when it was interrupted). Throws with the reason when
   * it cannot: unknown id, live, no file, validation failure, or the file
   * still owned elsewhere. Nothing is journaled on failure.
   */
  async resumeDormant(
    id: string,
    prompt: string,
    context: RevivalContext,
    options?: { model?: string },
  ): Promise<AgentRecord> {
    if (this.disposed) throw new Error("The subagent manager is shut down.");
    if (this.agents.has(id) || this.revivalReservations.has(id)) {
      throw new Error(`Agent ${id} is live; resume it directly.`);
    }
    const saved = this.getDormant(id);
    if (saved === undefined) throw new Error(`No saved agent ${id} in this session.`);
    // A caller-selected model is validated like a live resume's (format,
    // availability, scope, provider closure; throws ResumeModelError) and
    // replaces the journaled one, so the revived run and its journal use it.
    const switched =
      options?.model === undefined
        ? undefined
        : this.resolveDormantModel(saved, options.model, context.ctx);
    const snapshot: JournalAgentSnapshot =
      switched === undefined
        ? saved
        : { ...saved, model: { provider: switched.provider, id: switched.id } };
    const sink = this.journalSink;
    const epoch = this.revivalEpoch;
    const isCurrent = () =>
      !this.disposed && this.revivalEpoch === epoch && this.journalSink === sink;
    this.revivalReservations.add(id);
    try {
      const outcome = await this.prepareRevival(
        snapshot,
        "resume",
        undefined,
        0,
        context,
        isCurrent,
      );
      if (outcome.kind === "stale")
        throw new Error("Resume cancelled: the session changed or shut down.");
      if (outcome.kind === "failed") throw new Error(outcome.reason);
      const item = outcome.prepared;
      if (this.agents.has(id)) {
        if (item.claim !== undefined) releaseSessionFile(item.claim.file, item.claim.token);
        throw new Error(`Agent ${id} became live while resuming.`);
      }
      const fullPrompt =
        snapshot.status === "interrupted" || snapshot.error === CAPPED_REVIVAL_ERROR
          ? `${buildInterruptionPrompt({ unclean: undefined, steers: item.steers })}\n\n${prompt}`
          : prompt;
      try {
        return this.startPreparedRevival(item, context, fullPrompt);
      } catch (err) {
        if (item.claim !== undefined) releaseSessionFile(item.claim.file, item.claim.token);
        throw err;
      }
    } finally {
      this.revivalReservations.delete(id);
    }
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Parked records settle as stopped; nothing will read a notification now.
    count += this.cancelUsageLimitWaits("Manager shutdown requested.");
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        this.transition(record, "stopped");
        this.requestCancellation(
          record,
          record.resultGeneration ?? 1,
          "shutdown",
          "Manager shutdown requested.",
        );
        record.completedAt = Date.now();
        this.publishTerminal(record);
        queued.finalize?.(false);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        this.requestCancellation(
          record,
          record.resultGeneration ?? 1,
          "shutdown",
          "Manager shutdown requested.",
        );
        this.transition(record, "stopped");
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(ownsUnsettledGeneration)
        .map((r) => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Shut the manager down. With `suspend: true`, journaled live records are
   * suspended first (journaled, cancelled without an outcome, worktrees kept);
   * everything else is stopped as before. Suspended runs dispose their
   * sessions and release their files when they settle.
   */
  dispose(options?: { suspend?: boolean }) {
    if (options?.suspend === true && !this.disposed) this.suspendNow();
    this.revivalEpoch++;
    this.disposed = true;
    clearInterval(this.cleanupInterval);
    for (const controller of this.activeRunBudgets) controller.dispose();
    this.activeRunBudgets.clear();
    this.abortAll();
    for (const [id, record] of this.agents) {
      if (
        record.resultGeneration === undefined ||
        record.terminalResultGeneration === record.resultGeneration
      ) {
        this.removeRecord(id, record);
      }
    }
    // Prune any orphaned git worktrees (crash recovery)
    try {
      pruneWorktrees(process.cwd());
    } catch {
      /* ignore */
    }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try {
        pruneWorktrees(repo);
      } catch {
        /* ignore */
      }
    }
  }
}
