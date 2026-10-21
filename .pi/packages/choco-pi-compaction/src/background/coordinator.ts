import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  CompactionEntryDraft,
  CompactionResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  AdmissionRecord,
  AdoptionConsumer,
  AppendRecord,
  Backend,
  BackgroundCompactionSettings,
  BackgroundUsage,
  CandidateFailure,
  CandidateRecord,
  CoordinatorApi,
  CoordinatorStatus,
  EstimateSource,
  FrozenSnapshot,
  ModelRef,
  PreparationRequest,
  PreparationRequestResult,
  PreparedCheckpoint,
  PrepareFailure,
  PreSnapshotParticipant,
  ProviderScope,
  ReasonCode,
  TokenCounter,
} from "./contract.ts";
import { type ModelBudget, resolveBackgroundLimits } from "../budget.ts";
import { renderFrozenPrefixPrompt } from "./snapshot.ts";
import {
  AdoptionDelivery,
  adoptionDraft,
  firstRetainedEntry,
  type CommittedCandidate,
  type DeliveredAdoptions,
} from "./adoption.ts";
import { arbitrationIntent, type HostCompactionTrigger } from "./arbitration.ts";
import {
  buildRecord,
  fingerprintPrefix,
  parseRecord,
  revalidateIdentity,
} from "./candidate-record.ts";
import { CandidateMachine, isOutstanding } from "./state-machine.ts";
import {
  processPreparationLimiter,
  systemClock,
  waitUntil,
  type SchedulerClock,
  type WorkSettlement,
} from "./scheduler.ts";

export interface SnapshotContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
  readonly entries: readonly SessionEntry[];
  readonly latestCheckpoint: { readonly id: string; readonly version: number } | null;
  readonly capturedAt: number;
  readonly participantEntryIds: readonly string[];
  readonly recoveryRecord?: CandidateRecord;
  /** Backend that will prepare this snapshot; lane-specific cut rules apply only to it. */
  readonly backendId: string;
}

/** Synchronous reads must refer to one currently held owner. No method starts a foreground run. */
export interface CoordinatorPort {
  getBranch(): readonly SessionEntry[];
  getBranchKey(): string;
  getProviderScope(): ProviderScope;
  getLatestCompactionEntry(): { readonly id: string; readonly version: number } | null;
  appendAnchor(): string | Promise<string>;
  /** Observe a proposal only; this is NOT permission to commit or invoke ctx.compact(). */
  proposeDraft(draft: CompactionEntryDraft): void;
  findCommittedCandidate(candidateId: string, fingerprint: string): CommittedCandidate | undefined;
}

interface CoordinatorDependencies {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  /** Scalar owner token check; must remain usable after the host context is invalidated. */
  readonly isOwnerCurrent: () => boolean;
  readonly appendRecord: AppendRecord;
  readonly port: CoordinatorPort;
  readonly backends: ReadonlyMap<string, Backend>;
  readonly settings: Readonly<BackgroundCompactionSettings>;
  /**
   * The host adapts the pure snapshot builder; the coordinator overrides its
   * runtime identity. A refusal names why no cut was frozen.
   */
  readonly freezeSnapshot: (context: SnapshotContext) => FrozenSnapshot | SnapshotRefused;
  readonly clock?: SchedulerClock;
  readonly createCandidateId?: () => string;
  readonly headroom?: () => number;
  /** Host-owned backend flag mapping; the neutral core does not infer provider IDs. */
  readonly isBackendEnabled: (
    backendId: string,
    settings: Readonly<BackgroundCompactionSettings>,
  ) => boolean;
  readonly isStaleContextError?: (cause: unknown) => boolean;
  /** In-process delivery ledger shared across reloads of the same owner; a fresh process starts empty. */
  readonly delivered?: DeliveredAdoptions;
  /**
   * Window and output cap of the owner's model. Admission and the backend
   * budget use `min(maxInputTokens, contextWindow - output cap - margin)`;
   * without it only the configured ceiling applies.
   */
  readonly modelBudget?: ModelBudget;
  /** Provider prompt counter; when it returns a count, it replaces the estimate. */
  readonly tokenCounter?: { readonly counter: TokenCounter; readonly model: ModelRef };
  /**
   * Failure port: observes each candidate's terminal `failed`, `canceled` or
   * `discarded-stale` transition exactly once, after the transition. Not
   * called once the coordinator is disposed or for a `disposed` teardown (a
   * lifecycle event, not a lane transition). A stale-context failure of the
   * observer is contained; any other failure reaches the caller.
   */
  readonly onCandidateFailure?: (failure: CandidateFailurePortEvent) => void;
}

/** What requested a candidate; `recovery` restores a persisted record at session start. */
export type CandidateTrigger = PreparationRequest["trigger"] | "recovery";

/** One candidate's terminal outcome as the failure port reports it. */
export interface CandidateFailurePortEvent {
  readonly candidateId: string;
  readonly backendId: string;
  readonly reason: CandidateFailure["reason"];
  readonly trigger: CandidateTrigger;
  /** Instructions the candidate was requested with (`/compact <instructions>`). */
  customInstructions?: string;
  /** Backend detail code, or the coordinator's own (`overflow` for an overflow cancel). */
  detail?: string;
}

export interface DetailedCoordinatorStatus extends CoordinatorStatus {
  readonly durationMs: number;
  readonly queueDelayMs: number;
  readonly preparationMs: number;
  readonly attempts: number;
  readonly usage?: BackgroundUsage;
  /** Estimate only: tokenEstimate minus usage.output. Real usefulness is backend-owned. */
  readonly estimatedReductionTokens?: number;
  readonly committedEntryId?: string;
  /** How admission sized the prompt of the current candidate. */
  readonly admission?: AdmissionRecord;
  /**
   * The retry delay the backend reported with the candidate's terminal
   * failure (`PrepareFailure.retryAfterMs`). Its presence marks a failure the
   * backend expects to clear (a capture-specific `unsupported`, for one).
   */
  readonly retryAfterMs?: number;
}

type CoordinatorArbitrationResult =
  | { readonly action: "proceed" }
  | {
      readonly action: "adopt";
      readonly candidateId: string;
      readonly draft: CompactionEntryDraft & CompactionResult;
      readonly compaction: CompactionResult;
    };

export interface CoordinatorHandle extends CoordinatorApi {
  status(): DetailedCoordinatorStatus;
  arbitrateHostCompaction(event?: HostCompactionTrigger): Promise<CoordinatorArbitrationResult>;
  arbitrateManualCompact(customInstructions?: string): Promise<CoordinatorArbitrationResult>;
  /** Call after the boundary/compact callback has settled, not while a proposal is in flight. */
  reconcileCommit(draftFinished?: boolean): Promise<void>;
  /** Unexpected background exceptions rethrow here; the launch promise never rejects. */
  waitForPreparation(): Promise<void>;
  recover(records: readonly unknown[]): Promise<boolean>;
  setEnabled(enabled: boolean): void;
  /** Permanently revoke this owner token; replacement owners need a new coordinator. */
  invalidate(reason?: ReasonCode): void;
  hostRefused(): Promise<void>;
}

interface Candidate {
  readonly id: string;
  readonly backendId: string;
  readonly trigger: CandidateTrigger;
  readonly machine: CandidateMachine;
  readonly abort: AbortController;
  readonly createdAt: number;
  readonly customInstructions?: string;
  snapshot?: FrozenSnapshot;
  branchKey?: string;
  checkpoint?: CandidateRecord["checkpoint"];
  startedAt?: number;
  preparedAt?: number;
  finishedAt?: number;
  attempts: number;
  committedEntryId?: string;
  /** Backend detail code behind the terminal failure reason. */
  detail?: string;
  /** Retry delay reported with the terminal failure, if any. */
  retryAfterMs?: number;
  admission?: AdmissionRecord;
  cancelDeadline: () => void;
}

class InvalidatedOwnerContextError extends Error {}

const cooldowns = new WeakMap<SchedulerClock, Map<string, number>>();
function cooldownMap(clock: SchedulerClock): Map<string, number> {
  let map = cooldowns.get(clock);
  if (!map) {
    map = new Map();
    cooldowns.set(clock, map);
  }
  return map;
}
/** Self-delimiting cooldown-key field: `~` when absent, else `<length>:<value>`. */
function keyPart(value: string | undefined): string {
  return value === undefined ? "~" : `${value.length}:${value}`;
}
const AdoptionIdentitySchema = Type.Object(
  {
    candidateId: Type.String(),
    prefixFingerprint: Type.String(),
    ownerKey: Type.String(),
  },
  { additionalProperties: true },
);
const FreezeContainerSchema = Type.Union([
  Type.Array(Type.Unknown()),
  Type.Object({}, { additionalProperties: true }),
]);
function deepFreeze<T>(value: T): void {
  if (!Value.Check(FreezeContainerSchema, value) || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function immutableSet(source: ReadonlySet<string>): Set<string> {
  const values = new Set(source);
  const refuseMutation = (): never => {
    throw new Error("Frozen compaction file operations cannot be mutated");
  };
  Object.defineProperties(values, {
    add: { value: refuseMutation },
    delete: { value: refuseMutation },
    clear: { value: refuseMutation },
  });
  return Object.freeze(values);
}

function frozenCopy(source: FrozenSnapshot): FrozenSnapshot {
  const copy: FrozenSnapshot = structuredClone({
    ...source,
    fileOps: {
      read: new Set(source.fileOps.read),
      edited: new Set(source.fileOps.edited),
      written: new Set(source.fileOps.written),
    },
  });
  const snapshot: FrozenSnapshot = {
    ...copy,
    fileOps: {
      read: immutableSet(copy.fileOps.read),
      edited: immutableSet(copy.fileOps.edited),
      written: immutableSet(copy.fileOps.written),
    },
  };
  deepFreeze(snapshot);
  return snapshot;
}

type TerminalState = "canceled" | "failed" | "discarded-stale";

/** Explicit coordinator state; every step below receives it instead of closing over a factory. */
interface CoordinatorState {
  readonly deps: CoordinatorDependencies;
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly clock: SchedulerClock;
  readonly settings: BackgroundCompactionSettings;
  readonly participants: Map<string, PreSnapshotParticipant>;
  readonly consumers: Map<string, AdoptionConsumer>;
  readonly delivery: AdoptionDelivery;
  enabled: boolean;
  disposed: boolean;
  invalidated: boolean;
  /** Bounded, newest last. */
  readonly recentFailures: CandidateFailure[];
  arbitrating: boolean;
  candidate: Candidate | undefined;
  preparation: Promise<WorkSettlement>;
}

const PROCEED: CoordinatorArbitrationResult = { action: "proceed" };
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(["quota", "429", "529"]);
/** Refusals of one specific cut; the next request on the same scope may legally differ. */
const CUT_REFUSALS: ReadonlySet<string> = new Set(["no-legal-cut", "incompatible"]);

function ownerCurrent(state: CoordinatorState): boolean {
  if (state.disposed || state.invalidated) return false;
  if (state.deps.isOwnerCurrent()) return true;
  invalidate(state, "owner-changed");
  return false;
}

function active(state: CoordinatorState, current: Candidate): boolean {
  return (
    ownerCurrent(state) &&
    state.enabled &&
    state.candidate === current &&
    isOutstanding(current.machine.state) &&
    !current.abort.signal.aborted
  );
}

function finish(
  state: CoordinatorState,
  current: Candidate,
  terminal: TerminalState,
  reason: ReasonCode,
  portDetail?: string,
): void {
  if (!isOutstanding(current.machine.state)) return;
  // The frozen table has no adopting -> canceled edge. Invalidation of a proposal fails closed.
  current.machine.transition(
    current.machine.state === "adopting" && terminal === "canceled" ? "discarded-stale" : terminal,
    reason,
  );
  current.finishedAt = state.clock.now();
  current.cancelDeadline();
  current.abort.abort();
  reportFailure(state, current, reason, portDetail ?? current.detail);
}

/** The single failure-port call of a candidate, made right after its one terminal transition. */
function reportFailure(
  state: CoordinatorState,
  current: Candidate,
  reason: ReasonCode,
  detail: string | undefined,
): void {
  const observer = state.deps.onCandidateFailure;
  if (observer === undefined || state.disposed || reason === "disposed") return;
  const failure: CandidateFailurePortEvent = {
    candidateId: current.id,
    backendId: current.backendId,
    reason,
    trigger: current.trigger,
  };
  if (current.customInstructions !== undefined) {
    failure.customInstructions = current.customInstructions;
  }
  if (detail !== undefined) failure.detail = detail;
  try {
    observer(failure);
  } catch (cause) {
    if (!isStaleCause(state, cause)) throw cause;
  }
}

/**
 * Fail the candidate. A transport-class failure (retryable or rate-limited)
 * also starts the scope cooldown; a legality or compatibility refusal of one
 * cut must not throttle the next request on the same scope.
 */
function fail(
  state: CoordinatorState,
  current: Candidate,
  failure: {
    readonly reason: ReasonCode;
    readonly detail?: string;
    readonly cool: boolean;
    readonly retryAfterMs?: number;
  },
): void {
  current.detail = failure.detail;
  current.retryAfterMs = failure.retryAfterMs;
  finish(state, current, "failed", failure.reason);
  rememberFailure(state, current, failure.reason, failure.detail);
  if (failure.cool) cool(state, current);
}

/** Fail the candidate and start the scope cooldown so the next attempt waits. */
function failAndCool(
  state: CoordinatorState,
  current: Candidate,
  reason: ReasonCode,
  detail?: string,
): void {
  fail(state, current, { reason, detail, cool: true });
}

const RECENT_FAILURES = 8;
function rememberFailure(
  state: CoordinatorState,
  current: Candidate,
  reason: ReasonCode,
  detail: string | undefined,
): void {
  const entry: CandidateFailure = {
    candidateId: current.id,
    backendId: current.backendId,
    reason,
    detail: detail ?? null,
    at: state.clock.now(),
  };
  state.recentFailures.push(entry);
  if (state.recentFailures.length > RECENT_FAILURES) state.recentFailures.shift();
}

function invalidate(state: CoordinatorState, reason: ReasonCode = "owner-changed"): void {
  state.invalidated = true;
  if (state.candidate) finish(state, state.candidate, "discarded-stale", reason);
}

function finishCurrent(state: CoordinatorState, terminal: TerminalState, reason: ReasonCode): void {
  if (state.candidate) finish(state, state.candidate, terminal, reason);
}

function requireOwner(state: CoordinatorState): void {
  if (!ownerCurrent(state)) throw new InvalidatedOwnerContextError("Compaction owner invalidated");
}

function isStaleCause(state: CoordinatorState, cause: unknown): boolean {
  return (
    cause instanceof InvalidatedOwnerContextError ||
    state.deps.isStaleContextError?.(cause) === true
  );
}

/** Invalidate on stale-owner failures and return the fallback; rethrow anything else. */
async function containStaleOwner<T>(
  state: CoordinatorState,
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (!isStaleCause(state, cause)) throw cause;
    invalidate(state, "owner-changed");
    return fallback;
  }
}

function captureContext(state: CoordinatorState, backendId: string): SnapshotContext {
  const { port } = state.deps;
  requireOwner(state);
  const entries = structuredClone(port.getBranch());
  requireOwner(state);
  const providerScope = structuredClone(port.getProviderScope());
  requireOwner(state);
  const latestCheckpoint = structuredClone(port.getLatestCompactionEntry());
  requireOwner(state);
  return {
    ownerKey: state.ownerKey,
    ownerGeneration: state.ownerGeneration,
    entries,
    providerScope,
    latestCheckpoint,
    backendId,
    capturedAt: state.clock.now(),
    participantEntryIds: [],
  };
}

function validate(state: CoordinatorState, current: Candidate): boolean {
  if (!active(state, current) || !current.snapshot) return false;
  if (state.deps.port.getBranchKey() !== current.branchKey) {
    finish(state, current, "discarded-stale", "stale-prefix");
    return false;
  }
  const reason = revalidateIdentity(current.snapshot, captureContext(state, current.backendId));
  if (!reason) return true;
  finish(state, current, "discarded-stale", reason);
  return false;
}

function backendEnabled(state: CoordinatorState, id: string): boolean {
  return state.deps.isBackendEnabled(id, state.settings);
}

function coolingKey(current: Candidate): string {
  const scope = current.snapshot?.providerScope;
  if (scope === undefined) return `${keyPart(current.backendId)}|no-scope`;
  return [
    keyPart(current.backendId),
    "scope",
    keyPart(scope.provider),
    keyPart(scope.baseUrl),
    keyPart(scope.model),
    keyPart(scope.authMode),
    keyPart(scope.accountScope),
  ].join("|");
}

function cooldownUntil(state: CoordinatorState, current: Candidate): number {
  return cooldownMap(state.clock).get(coolingKey(current)) ?? 0;
}

function coolingDown(state: CoordinatorState, current: Candidate): boolean {
  return cooldownUntil(state, current) > state.clock.now();
}

function cool(
  state: CoordinatorState,
  current: Candidate,
  delay = state.settings.cooldownMs,
): void {
  const until = Math.max(cooldownUntil(state, current), state.clock.now() + delay);
  cooldownMap(state.clock).set(coolingKey(current), until);
}

/** Fails with "cooling" (no extra cooldown, no request sent) while the scope is cooling down. */
function refuseWhileCooling(state: CoordinatorState, current: Candidate): boolean {
  if (!coolingDown(state, current)) return false;
  const seconds = Math.ceil((cooldownUntil(state, current) - state.clock.now()) / 1000);
  current.detail = `cooling-down ${seconds}s`;
  finish(state, current, "failed", "cooling");
  return true;
}

// ---- preparation: participants -> snapshot selection -> admission -> scheduled backend run ----

async function runParticipants(
  state: CoordinatorState,
  current: Candidate,
): Promise<string[] | undefined> {
  const appendedEntryIds: string[] = [];
  for (const participant of Array.from(state.participants.values())) {
    if (!active(state, current)) return undefined;
    const appended = await participant.beforeSnapshot({
      ownerKey: state.ownerKey,
      ownerGeneration: state.ownerGeneration,
      signal: current.abort.signal,
    });
    if (!active(state, current)) return undefined;
    appendedEntryIds.push(...appended.appendedEntryIds);
  }
  return active(state, current) ? appendedEntryIds : undefined;
}

/** No cut could be frozen; `detail` is the builder's refusal code. */
export interface SnapshotRefused {
  readonly refused: true;
  readonly detail: string;
}

function isRefused(value: FrozenSnapshot | SnapshotRefused): value is SnapshotRefused {
  return "refused" in value;
}

function selectionFailure(
  captured: SnapshotContext,
  selected: FrozenSnapshot,
): ReasonCode | undefined {
  const fingerprint = fingerprintPrefix(captured.entries, selected.cutEntryId);
  const capturedIds = new Set(captured.entries.map((entry) => entry.id));
  if (
    !fingerprint ||
    !capturedIds.has(selected.cutEntryId) ||
    captured.participantEntryIds.some((id) => !capturedIds.has(id))
  )
    return "no-legal-cut";
  return selected.prefixFingerprint === fingerprint ? undefined : "malformed";
}

function entriesThrough(entries: readonly SessionEntry[], cutEntryId: string): SessionEntry[] {
  return entries.slice(0, entries.findIndex((entry) => entry.id === cutEntryId) + 1);
}

/** Capture the branch, ask the snapshot builder for a cut, and freeze it on the candidate. */
function selectSnapshot(
  state: CoordinatorState,
  current: Candidate,
  participantEntryIds: readonly string[],
): FrozenSnapshot | undefined {
  const captured = { ...captureContext(state, current.backendId), participantEntryIds };
  current.branchKey = state.deps.port.getBranchKey();
  const selected = state.deps.freezeSnapshot(captured);
  if (isRefused(selected)) {
    // A refused cut is a property of this branch, not of the provider scope: no cooldown.
    fail(state, current, { reason: "no-legal-cut", detail: selected.detail, cool: false });
    return undefined;
  }
  const failure = selectionFailure(captured, selected);
  if (failure) {
    fail(state, current, { reason: failure, detail: "prefix-mismatch", cool: false });
    return undefined;
  }
  const snapshot = frozenCopy({
    ...selected,
    entries: entriesThrough(captured.entries, selected.cutEntryId),
    ownerKey: state.ownerKey,
    ownerGeneration: state.ownerGeneration,
    providerScope: captured.providerScope,
    priorCheckpointId: captured.latestCheckpoint?.id ?? null,
    priorCheckpointVersion: captured.latestCheckpoint?.version ?? null,
    capturedAt: captured.capturedAt,
  });
  current.snapshot = snapshot;
  return snapshot;
}

/** Effective limits: the configured ceiling narrowed by the owner model's window. */
function effectiveLimits(state: CoordinatorState): {
  maxInputTokens: number;
  maxOutputTokens: number;
} {
  return (
    resolveBackgroundLimits(state.deps.modelBudget, state.settings) ?? {
      maxInputTokens: 0,
      maxOutputTokens: state.settings.maxOutputTokens,
    }
  );
}

function counterActive(state: CoordinatorState): boolean {
  return state.settings.countTokens && state.deps.tokenCounter !== undefined;
}

/** A provider count, or none plus the counter's fallback note. */
interface PromptCount {
  readonly counted: number | undefined;
  readonly detail?: string;
}

/**
 * Admit the snapshot when its prompt fits the effective input budget. A
 * provider count replaces the estimate; otherwise the rendered-prompt
 * estimate is used, then the raw estimate for snapshots that carry none. An
 * oversized prefix refuses this cut only: it does not cool the scope.
 */
function admitTokens(
  state: CoordinatorState,
  current: Candidate,
  snapshot: FrozenSnapshot,
  count: PromptCount,
): boolean {
  const counted = count.counted;
  const budget = effectiveLimits(state).maxInputTokens;
  const source: EstimateSource =
    counted === undefined ? (snapshot.estimateSource ?? "chars") : "counted";
  const tokens = counted ?? snapshot.promptTokenEstimate ?? snapshot.tokenEstimate;
  const ratio = counted === undefined ? snapshot.estimateRatio : undefined;
  const detail = counted === undefined ? count.detail : undefined;
  const admission: AdmissionRecord = { promptTokens: tokens, budget, source };
  if (ratio !== undefined) admission.ratio = ratio;
  if (detail !== undefined) admission.detail = detail;
  current.admission = admission;
  if (tokens <= budget) return true;
  fail(state, current, {
    reason: "oversized",
    detail:
      detail === undefined
        ? `prompt ${tokens} > budget ${budget} (${source})`
        : `prompt ${tokens} > budget ${budget} (${source}; ${detail})`,
    cool: false,
  });
  return false;
}

/**
 * Provider count of the rendered prompt, or an undefined count (with the
 * counter's last diagnostic, if any) to fall back to the estimate.
 */
async function countPromptTokens(
  state: CoordinatorState,
  current: Candidate,
  snapshot: FrozenSnapshot,
): Promise<PromptCount> {
  const hook = state.deps.tokenCounter;
  if (hook === undefined) return { counted: undefined };
  const prompt = renderFrozenPrefixPrompt(snapshot);
  let detail: string | undefined;
  const counted = await hook.counter.countTokens({
    system: prompt.system,
    promptText: prompt.promptText,
    model: hook.model,
    signal: current.abort.signal,
    onDiagnostic: (note) => {
      if (note.trim().length > 0) detail = note;
    },
  });
  const valid = counted !== undefined && Number.isSafeInteger(counted) && counted >= 0;
  return valid ? { counted } : { counted: undefined, detail };
}

/** Synchronous admission; with a counter the token gate runs inside the scheduled slot instead. */
function admitSnapshot(
  state: CoordinatorState,
  current: Candidate,
  snapshot: FrozenSnapshot,
): boolean {
  if (!validate(state, current) || refuseWhileCooling(state, current)) return false;
  return counterActive(state) || admitTokens(state, current, snapshot, { counted: undefined });
}

async function prepare(
  state: CoordinatorState,
  current: Candidate,
  backend: Backend,
): Promise<void> {
  if (!active(state, current)) return;
  const participantEntryIds = await runParticipants(state, current);
  if (!participantEntryIds) return;
  const snapshot = selectSnapshot(state, current, participantEntryIds);
  if (!snapshot || !admitSnapshot(state, current, snapshot)) return;
  const scheduled = processPreparationLimiter.submit({
    ownerKey: state.ownerKey,
    cap: state.settings.maxConcurrent,
    maxQueued: state.settings.maxQueued,
    headroom: state.deps.headroom?.() ?? 0,
    clock: state.clock,
    signal: current.abort.signal,
    run: () => runPreparation(state, current, backend, snapshot),
  });
  if (!scheduled.accepted) {
    failAndCool(state, current, "quota");
    return;
  }
  const settled = await scheduled.completed;
  if (!settled.ok) throw settled.cause;
}

interface AttemptContext {
  readonly state: CoordinatorState;
  readonly current: Candidate;
  readonly backend: Backend;
  readonly snapshot: FrozenSnapshot;
  readonly deadlineMs: number;
}

type AttemptOutcome = "retry" | "stop";

/** Runs inside the process limiter slot: capability, legality, then bounded attempts. */
async function runPreparation(
  state: CoordinatorState,
  current: Candidate,
  backend: Backend,
  snapshot: FrozenSnapshot,
): Promise<void> {
  if (!validate(state, current) || refuseWhileCooling(state, current)) return;
  current.machine.transition("preparing");
  current.startedAt = state.clock.now();
  const capability = await backend.capability(snapshot.providerScope);
  if (!validate(state, current)) return;
  if (!capability.supported) return failAndCool(state, current, capability.reason);
  const legality = backend.isLegalCut(snapshot);
  if (!legality.legal)
    return fail(state, current, { reason: legality.reason, detail: legality.detail, cool: false });
  if (counterActive(state)) {
    const count = await countPromptTokens(state, current, snapshot);
    if (!validate(state, current)) return;
    if (!admitTokens(state, current, snapshot, count)) return;
  }
  const attempt: AttemptContext = {
    state,
    current,
    backend,
    snapshot,
    deadlineMs: current.createdAt + state.settings.timeoutMs,
  };
  for (let number = 1; number <= state.settings.maxAttempts; number++) {
    if ((await runAttempt(attempt, number)) === "stop") return;
  }
}

async function runAttempt(context: AttemptContext, attempt: number): Promise<AttemptOutcome> {
  const { state, current, snapshot, deadlineMs } = context;
  if (!validate(state, current)) return "stop";
  if (state.clock.now() >= deadlineMs) {
    failAndCool(state, current, "timeout");
    return "stop";
  }
  if (refuseWhileCooling(state, current)) return "stop";
  current.attempts = attempt;
  const limits = effectiveLimits(state);
  const result = await context.backend.prepare(snapshot, {
    signal: current.abort.signal,
    candidateId: current.id,
    customInstructions: current.customInstructions,
    budget: {
      maxInputTokens: limits.maxInputTokens,
      maxOutputTokens: state.settings.maxOutputTokens,
      maxResultBytes: state.settings.maxResultBytes,
      maxAttempts: state.settings.maxAttempts,
      deadlineMs,
    },
  });
  if (!validate(state, current)) return "stop";
  if ("ok" in result) return retryAfterFailure(context, result, attempt);
  await recordPreparedCheckpoint(context, result);
  return "stop";
}

async function retryAfterFailure(
  context: AttemptContext,
  failure: PrepareFailure,
  attempt: number,
): Promise<AttemptOutcome> {
  const { state, current, deadlineMs } = context;
  const { settings, clock } = state;
  if (RATE_LIMIT_REASONS.has(failure.reason))
    cool(state, current, Math.max(settings.cooldownMs, failure.retryAfterMs ?? 0));
  if (!failure.retryable || attempt === settings.maxAttempts) {
    // Only a refusal of this particular cut leaves the scope uncooled; every
    // other terminal failure (auth, unsupported, oversized, transport) cools it
    // so the next request waits, honoring a reported retry delay.
    const refusal = CUT_REFUSALS.has(failure.reason);
    fail(state, current, {
      reason: failure.reason,
      detail: failure.detail,
      cool: !refusal,
      retryAfterMs: failure.retryAfterMs,
    });
    if (!refusal && failure.retryAfterMs !== undefined)
      cool(state, current, Math.max(settings.cooldownMs, failure.retryAfterMs));
    return "stop";
  }
  const delay = Math.max(
    settings.retryBaseMs * 2 ** (attempt - 1),
    failure.retryAfterMs ?? 0,
    cooldownUntil(state, current) - clock.now(),
  );
  await waitUntil(
    clock,
    Math.min(delay, Math.max(0, deadlineMs - clock.now())),
    current.abort.signal,
  );
  return validate(state, current) ? "retry" : "stop";
}

function recordForCheckpoint(
  context: AttemptContext,
  checkpoint: PreparedCheckpoint,
):
  | { readonly record: CandidateRecord }
  | { readonly reason: ReasonCode; readonly detail?: string } {
  const { state, current, snapshot } = context;
  if (checkpoint.candidateId !== current.id || checkpoint.backendId !== current.backendId)
    return { reason: "malformed" };
  const record = buildRecord(snapshot, checkpoint, state.clock.now(), {
    customInstructions: current.customInstructions,
    admission: current.admission,
  });
  if (!record) return { reason: "malformed" };
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > state.settings.maxResultBytes)
    return { reason: "oversized", detail: "result-bytes" };
  // The reasoning reserve is part of the output cap the backend was allowed to send.
  if (checkpoint.usage.output > effectiveLimits(state).maxOutputTokens)
    return { reason: "oversized", detail: "output-over-budget" };
  return { record };
}

/** Validate the backend result, persist its candidate record, and mark the candidate ready. */
async function recordPreparedCheckpoint(
  context: AttemptContext,
  checkpoint: PreparedCheckpoint,
): Promise<void> {
  const { state, current } = context;
  const checked = recordForCheckpoint(context, checkpoint);
  if ("reason" in checked) return failAndCool(state, current, checked.reason, checked.detail);
  if (!validate(state, current)) return;
  await state.deps.appendRecord(checked.record);
  if (!validate(state, current)) return;
  current.checkpoint = structuredClone(checked.record.checkpoint);
  current.machine.transition("ready", "prepared");
  current.preparedAt = state.clock.now();
  current.cancelDeadline();
}

function launch(state: CoordinatorState, current: Candidate, backend: Backend): void {
  // Convert the background promise into a fulfilled observation. The explicit observer rethrows.
  state.preparation = prepare(state, current, backend).then(
    (): WorkSettlement => ({ ok: true }),
    (cause: unknown): WorkSettlement => {
      if (isStaleCause(state, cause)) {
        finish(state, current, "discarded-stale", "owner-changed");
        return { ok: true };
      }
      failAndCool(state, current, "malformed");
      return { ok: false, cause };
    },
  );
}

function newCandidate(
  state: CoordinatorState,
  id: string,
  backendId: string,
  trigger: CandidateTrigger,
  customInstructions?: string,
): Candidate {
  const current: Candidate = {
    id,
    backendId,
    trigger,
    customInstructions,
    machine: new CandidateMachine(),
    abort: new AbortController(),
    createdAt: state.clock.now(),
    attempts: 0,
    cancelDeadline: () => {},
  };
  current.machine.transition("queued");
  return current;
}

function resolveBackend(
  state: CoordinatorState,
  requestedId: string | undefined,
): Backend | undefined {
  const { backends } = state.deps;
  const backendId = requestedId ?? (backends.size === 1 ? backends.keys().next().value : undefined);
  const backend = backendId === undefined ? undefined : backends.get(backendId);
  return backend && backendEnabled(state, backend.id) ? backend : undefined;
}

function requestPreparation(
  state: CoordinatorState,
  request: PreparationRequest,
): PreparationRequestResult {
  if (!ownerCurrent(state))
    return { accepted: false, reason: state.disposed ? "disposed" : "owner-changed" };
  if (!state.enabled) return { accepted: false, reason: "disabled" };
  if (state.candidate && isOutstanding(state.candidate.machine.state))
    return { accepted: false, reason: "busy" };
  const backend = resolveBackend(state, request.backendId);
  if (!backend) return { accepted: false, reason: "unsupported" };
  const current = newCandidate(
    state,
    state.deps.createCandidateId?.() ?? randomUUID(),
    backend.id,
    request.trigger,
    request.customInstructions,
  );
  state.candidate = current;
  current.cancelDeadline = state.clock.setTimer(
    () => failAndCool(state, current, "timeout"),
    state.settings.timeoutMs,
  );
  launch(state, current, backend);
  return { accepted: true, candidateId: current.id };
}

// ---- adoption: commit lookup, arbitration, reconciliation ----

function committedEntryMatches(
  state: CoordinatorState,
  committed: CommittedCandidate,
  candidateId: string,
  fingerprint: string,
): boolean {
  const entry = state.deps.port
    .getBranch()
    .find((item) => item.id === committed.id && item.type === "compaction");
  const details = entry && entry.type === "compaction" ? entry.details : undefined;
  return (
    Value.Check(AdoptionIdentitySchema, details) &&
    details.candidateId === candidateId &&
    details.prefixFingerprint === fingerprint &&
    details.ownerKey === state.ownerKey
  );
}

function findCommit(
  state: CoordinatorState,
  candidateId: string,
  fingerprint: string,
): CommittedCandidate | undefined {
  if (!ownerCurrent(state)) return undefined;
  const committed = state.deps.port.findCommittedCandidate(candidateId, fingerprint);
  if (
    !ownerCurrent(state) ||
    !committed ||
    committed.candidateId !== candidateId ||
    committed.fingerprint !== fingerprint
  )
    return undefined;
  return committedEntryMatches(state, committed, candidateId, fingerprint) ? committed : undefined;
}

async function installCommitted(
  state: CoordinatorState,
  current: Candidate,
  committed: CommittedCandidate,
  fingerprint: string,
): Promise<void> {
  current.machine.transition("installed");
  current.committedEntryId = committed.id;
  current.finishedAt = state.clock.now();
  await state.delivery.deliver(
    {
      adoptionId: `${state.ownerKey}:${committed.id}:${current.id}`,
      candidateId: current.id,
      committedEntryId: committed.id,
      backendId: current.backendId,
      fingerprint,
    },
    [...state.consumers.values()],
    () => ownerCurrent(state),
  );
}

async function observeCommit(state: CoordinatorState, draftFinished: boolean): Promise<void> {
  const current = state.candidate;
  if (!current || current.machine.state !== "adopting" || !ownerCurrent(state)) return;
  const fingerprint = current.snapshot?.prefixFingerprint;
  if (!fingerprint) return;
  const committed = findCommit(state, current.id, fingerprint);
  if (!ownerCurrent(state)) return;
  if (committed) {
    await installCommitted(state, current, committed, fingerprint);
    // Recheck after the await so a lost owner is invalidated before the caller continues.
    ownerCurrent(state);
    return;
  }
  if (validate(state, current) && draftFinished)
    current.machine.transition("ready", "draft-not-committed");
}

function reconcileCommit(state: CoordinatorState, draftFinished = false): Promise<void> {
  return containStaleOwner(state, () => observeCommit(state, draftFinished), undefined);
}

async function arbitrateAdopting(
  state: CoordinatorState,
  current: Candidate,
  event: HostCompactionTrigger,
): Promise<CoordinatorArbitrationResult> {
  await reconcileCommit(state);
  if (!ownerCurrent(state)) return PROCEED;
  // Even an uncommitted proposal does not indefinitely block hard-limit recovery.
  if (
    event.customInstructions !== undefined &&
    event.customInstructions !== current.customInstructions &&
    current.machine.state === "adopting"
  )
    finish(state, current, "discarded-stale", "manual-instructions");
  return PROCEED;
}

/** Ensure a retained entry follows the cut, appending an anchor when the cut is the branch tip. */
async function retainedEntryAfterCut(
  state: CoordinatorState,
  current: Candidate,
  snapshot: FrozenSnapshot,
): Promise<string | undefined> {
  const { port } = state.deps;
  let first = firstRetainedEntry(port.getBranch(), snapshot.cutEntryId);
  if (!first) {
    await port.appendAnchor();
    if (!validate(state, current)) return undefined;
    first = firstRetainedEntry(port.getBranch(), snapshot.cutEntryId);
  }
  if (first && port.getBranch().some((entry) => entry.id === first)) return first;
  finish(state, current, "discarded-stale", "stale-prefix");
  return undefined;
}

async function proposeAdoption(
  state: CoordinatorState,
  current: Candidate,
): Promise<CoordinatorArbitrationResult> {
  const checkpoint = current.checkpoint;
  if (!checkpoint || !validate(state, current)) return PROCEED;
  const snapshot = current.snapshot;
  if (!snapshot) return PROCEED;
  const first = await retainedEntryAfterCut(state, current, snapshot);
  if (!first) return PROCEED;
  const draft = adoptionDraft(checkpoint, {
    firstKeptEntryId: first,
    fingerprint: snapshot.prefixFingerprint,
    ownerKey: state.ownerKey,
    tokensBefore: snapshot.tokenEstimate,
  });
  current.machine.transition("adopting");
  state.deps.port.proposeDraft(draft);
  return { action: "adopt", candidateId: current.id, draft, compaction: draft };
}

function arbitrateCandidate(
  state: CoordinatorState,
  current: Candidate | undefined,
  event: HostCompactionTrigger,
): Promise<CoordinatorArbitrationResult> {
  if (current?.machine.state === "adopting") return arbitrateAdopting(state, current, event);
  const intent = arbitrationIntent(
    current?.machine.state ?? "idle",
    event,
    current?.customInstructions,
  );
  if (intent === "discard-instructions" && current)
    finish(state, current, "discarded-stale", "manual-instructions");
  if (intent === "cancel-overflow" && current) {
    finish(state, current, "canceled", "canceled", "overflow");
  }
  if (intent === "await-outstanding" && current) return awaitOutstanding(state, current, event);
  if (intent !== "adopt" || !current) return Promise.resolve(PROCEED);
  return proposeAdoption(state, current);
}

/**
 * Wait for the in-flight preparation, then adopt it if it is still this
 * owner's ready candidate; otherwise the host proceeds with its own summary
 * exactly as before. The wait ends at the first of: the preparation settling,
 * the candidate being finished (its abort fires on timeout, cancellation or
 * owner invalidation), the host aborting its compaction, or the preparation
 * timeout. The physical work keeps running and settles its own scheduler slot.
 */
async function awaitOutstanding(
  state: CoordinatorState,
  current: Candidate,
  event: HostCompactionTrigger,
): Promise<CoordinatorArbitrationResult> {
  const settled = await firstOf(state, state.preparation, [current.abort.signal, event.signal]);
  if (!settled || !ownerCurrent(state)) return PROCEED;
  if (state.candidate !== current || current.machine.state !== "ready") return PROCEED;
  return proposeAdoption(state, current);
}

/** Resolves true when `work` settles first; false on any abort or the preparation timeout. */
function firstOf(
  state: CoordinatorState,
  work: Promise<WorkSettlement>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const cleanups: (() => void)[] = [];
    const finishWith = (value: boolean): void => {
      if (done) return;
      done = true;
      for (const cleanup of cleanups) cleanup();
      resolve(value);
    };
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) return finishWith(false);
      const onAbort = (): void => finishWith(false);
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    cleanups.push(state.clock.setTimer(() => finishWith(false), state.settings.timeoutMs));
    work.then(
      (result) => finishWith(result.ok),
      () => finishWith(false),
    );
  });
}

async function arbitrate(
  state: CoordinatorState,
  event: HostCompactionTrigger,
): Promise<CoordinatorArbitrationResult> {
  if (!ownerCurrent(state)) return PROCEED;
  if (state.arbitrating) {
    // A manual request can invalidate an automatic proposal awaiting its anchor.
    if (
      event.customInstructions !== undefined &&
      event.customInstructions !== state.candidate?.customInstructions
    )
      finishCurrent(state, "discarded-stale", "manual-instructions");
    return PROCEED;
  }
  state.arbitrating = true;
  const current = state.candidate;
  try {
    return await containStaleOwner(state, () => arbitrateCandidate(state, current, event), PROCEED);
  } finally {
    state.arbitrating = false;
  }
}

// ---- recovery from persisted candidate records ----

type RecoveryStep = "next" | "recovered" | "refused";

interface RecoveryContext {
  readonly state: CoordinatorState;
  readonly record: CandidateRecord;
  readonly backend: Backend;
  readonly captured: SnapshotContext;
  readonly committed: CommittedCandidate | undefined;
  readonly comparison: SnapshotContext;
}

function recordedPriorCheckpoint(
  record: CandidateRecord,
): { readonly id: string; readonly version: number } | null {
  const { priorCheckpointId, priorCheckpointVersion } = record.identity;
  return priorCheckpointId !== null && priorCheckpointVersion !== null
    ? { id: priorCheckpointId, version: priorCheckpointVersion }
    : null;
}

/** Record a discarded candidate so status reports why the persisted record was refused. */
function discardRecord(state: CoordinatorState, record: CandidateRecord, reason: ReasonCode): void {
  const stale = newCandidate(state, record.candidateId, record.backendId, "recovery");
  state.candidate = stale;
  finish(state, stale, "discarded-stale", reason);
}

/** Resolve the record's backend and comparison context, or the step to take when it cannot recover. */
function recoveryContext(
  state: CoordinatorState,
  record: CandidateRecord,
): RecoveryContext | "next" | "refused" {
  const backend = state.deps.backends.get(record.backendId);
  const captured = captureContext(state, record.backendId);
  const committed = findCommit(state, record.candidateId, record.identity.prefixFingerprint);
  if (!ownerCurrent(state)) return "refused";
  // A committed record is compared against the checkpoint that preceded its own commit.
  const comparison =
    committed && captured.latestCheckpoint?.id === committed.id
      ? { ...captured, latestCheckpoint: recordedPriorCheckpoint(record) }
      : captured;
  const reason = revalidateIdentity(record.identity, comparison, { acceptEarlierGeneration: true });
  if (reason || !backend || !backendEnabled(state, record.backendId)) {
    discardRecord(state, record, reason ?? "unsupported");
    return "next";
  }
  return { state, record, backend, captured, committed, comparison };
}

function recoverySnapshot(context: RecoveryContext): FrozenSnapshot | undefined {
  const { state, record, captured } = context;
  const entries = entriesThrough(captured.entries, record.identity.cutEntryId);
  const selected = state.deps.freezeSnapshot({ ...captured, entries, recoveryRecord: record });
  if (isRefused(selected) || selected.cutEntryId !== record.identity.cutEntryId) return undefined;
  return frozenCopy({
    ...selected,
    ...record.identity,
    ownerGeneration: state.ownerGeneration,
    entries,
  });
}

/** After an await, a committed record must still be the latest checkpoint on an unchanged branch. */
function committedRecoveryCurrent(
  context: RecoveryContext,
  current: Candidate,
  committed: CommittedCandidate,
): boolean {
  const { state, comparison } = context;
  const snapshot = current.snapshot;
  if (!snapshot) return false;
  const reason = revalidateIdentity(snapshot, {
    ...captureContext(state, current.backendId),
    latestCheckpoint: comparison.latestCheckpoint,
  });
  if (reason || state.deps.port.getBranchKey() !== current.branchKey) {
    finish(state, current, "discarded-stale", reason ?? "stale-prefix");
    return false;
  }
  const latest = state.deps.port.getLatestCompactionEntry();
  if (latest?.id === committed.id && findCommit(state, current.id, snapshot.prefixFingerprint))
    return true;
  finish(state, current, "discarded-stale", "checkpoint-changed");
  return false;
}

function recoveryStillCurrent(context: RecoveryContext, current: Candidate): boolean {
  if (!active(context.state, current)) return false;
  return context.committed
    ? committedRecoveryCurrent(context, current, context.committed)
    : validate(context.state, current);
}

async function restoreCandidate(
  context: RecoveryContext,
  current: Candidate,
): Promise<RecoveryStep> {
  const { state, record } = context;
  current.machine.transition("preparing");
  current.checkpoint = record.checkpoint;
  current.machine.transition("ready", "recovered");
  current.preparedAt = state.clock.now();
  if (!context.committed) return "recovered";
  current.machine.transition("adopting", "recovered");
  await reconcileCommit(state);
  if (!ownerCurrent(state)) return "refused";
  return current.machine.state === "installed" ? "recovered" : "refused";
}

async function recoverRecord(
  state: CoordinatorState,
  record: CandidateRecord,
): Promise<RecoveryStep> {
  const context = recoveryContext(state, record);
  if (context === "next" || context === "refused") return context;
  const snapshot = recoverySnapshot(context);
  if (!snapshot) {
    discardRecord(state, record, "no-legal-cut");
    return "next";
  }
  const current = newCandidate(
    state,
    record.candidateId,
    record.backendId,
    "recovery",
    record.customInstructions,
  );
  state.candidate = current;
  current.branchKey = state.deps.port.getBranchKey();
  current.snapshot = snapshot;
  const capability = await context.backend.capability(snapshot.providerScope);
  if (!recoveryStillCurrent(context, current)) return "refused";
  if (!capability.supported) {
    finish(state, current, "discarded-stale", capability.reason);
    return "next";
  }
  const legality = context.backend.isLegalCut(snapshot);
  if (!legality.legal) {
    finish(state, current, "discarded-stale", legality.reason);
    return "next";
  }
  return restoreCandidate(context, current);
}

function recoveryOpen(state: CoordinatorState): boolean {
  return ownerCurrent(state) && state.enabled;
}

async function recoverNewestFirst(
  state: CoordinatorState,
  records: readonly unknown[],
): Promise<boolean> {
  if (!recoveryOpen(state) || (state.candidate && isOutstanding(state.candidate.machine.state)))
    return false;
  for (const value of records.toReversed()) {
    if (!recoveryOpen(state)) return false;
    const record = parseRecord(value);
    if (!record) continue;
    const step = await recoverRecord(state, record);
    if (step !== "next") return step === "recovered";
  }
  return false;
}

// ---- status and registration ----

function status(state: CoordinatorState): DetailedCoordinatorStatus {
  const { ownerKey, ownerGeneration } = state;
  const current = state.candidate;
  if (!current)
    return {
      ownerKey,
      ownerGeneration,
      state: "idle",
      recentFailures: [...state.recentFailures],
      durationMs: 0,
      queueDelayMs: 0,
      preparationMs: 0,
      attempts: 0,
    };
  const end = current.finishedAt ?? state.clock.now();
  return {
    ownerKey,
    ownerGeneration,
    state: current.machine.state,
    candidateId: current.id,
    backendId: current.backendId,
    reason: current.machine.reason,
    detail: current.detail,
    customInstructions: current.customInstructions,
    recentFailures: [...state.recentFailures],
    durationMs: Math.max(0, end - current.createdAt),
    queueDelayMs: Math.max(0, (current.startedAt ?? end) - current.createdAt),
    preparationMs:
      current.startedAt === undefined
        ? 0
        : Math.max(0, (current.preparedAt ?? end) - current.startedAt),
    attempts: current.attempts,
    usage: current.checkpoint ? { ...current.checkpoint.usage } : undefined,
    estimatedReductionTokens:
      current.checkpoint && current.snapshot
        ? Math.max(0, current.snapshot.tokenEstimate - current.checkpoint.usage.output)
        : undefined,
    committedEntryId: current.committedEntryId,
    admission: current.admission,
    retryAfterMs: current.retryAfterMs,
  };
}

/** Register by id; the returned disposer only removes the exact registration it created. */
function registerById<T extends { readonly id: string }>(
  registry: Map<string, T>,
  item: T,
): () => void {
  registry.set(item.id, item);
  return () => {
    if (registry.get(item.id) === item) registry.delete(item.id);
  };
}

function setEnabled(state: CoordinatorState, value: boolean): void {
  state.enabled = value;
  state.settings.enabled = value;
  if (!value) finishCurrent(state, "canceled", "disabled");
}

function dispose(state: CoordinatorState): void {
  if (state.disposed) return;
  state.disposed = true;
  finishCurrent(state, "canceled", "disposed");
  state.participants.clear();
  state.consumers.clear();
}

async function waitForPreparation(state: CoordinatorState): Promise<void> {
  const result = await state.preparation;
  if (!result.ok) throw result.cause;
}

function initialState(deps: CoordinatorDependencies): CoordinatorState {
  const settings = { ...deps.settings };
  return {
    deps,
    ownerKey: deps.ownerKey,
    ownerGeneration: deps.ownerGeneration,
    clock: deps.clock ?? systemClock,
    settings,
    participants: new Map(),
    consumers: new Map(),
    delivery: new AdoptionDelivery(deps.delivered),
    enabled: settings.enabled,
    disposed: false,
    invalidated: false,
    recentFailures: [],
    arbitrating: false,
    candidate: undefined,
    preparation: Promise.resolve({ ok: true }),
  };
}

export function createCoordinator(deps: CoordinatorDependencies): CoordinatorHandle {
  const state = initialState(deps);
  return {
    ownerKey: state.ownerKey,
    ownerGeneration: state.ownerGeneration,
    requestPreparation: (request = { trigger: "threshold" }) =>
      Promise.resolve(requestPreparation(state, request)),
    cancel: (reason = "canceled") => finishCurrent(state, "canceled", reason),
    invalidate: (reason) => invalidate(state, reason),
    setEnabled: (value) => setEnabled(state, value),
    status: () => status(state),
    arbitrateHostCompaction: (event = { reason: "threshold" }) => arbitrate(state, event),
    arbitrateManualCompact: (customInstructions) =>
      arbitrate(state, { reason: "manual", customInstructions }),
    reconcileCommit: (draftFinished) => reconcileCommit(state, draftFinished),
    hostRefused: () => reconcileCommit(state, true),
    waitForPreparation: () => waitForPreparation(state),
    recover: (records) => containStaleOwner(state, () => recoverNewestFirst(state, records), false),
    registerConsumer: (consumer) => registerById(state.consumers, consumer),
    registerParticipant: (participant) => registerById(state.participants, participant),
    dispose: () => dispose(state),
  };
}
