/** Coordinator state transitions: owner currency, terminal finishes, failure reporting, no-progress suppression, and cooldowns. */
import { compile, obj, str } from "@earendil-works/pi-schema";
import type {
  CandidateFailure,
  FrozenSnapshot,
  PreparationRequest,
  ReasonCode,
} from "../contract.ts";
import { isRecord } from "../../guards.ts";
import { revalidateIdentity } from "../candidate-record.ts";
import { isOutstanding } from "../state-machine.ts";
import { type SchedulerClock } from "../scheduler.ts";
import type {
  Candidate,
  CandidateFailurePortEvent,
  CoordinatorArbitrationResult,
  CoordinatorState,
  SnapshotContext,
  SuppressedPortEvent,
  TerminalState,
} from "./types.ts";

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

export const isAdoptionIdentity = compile(
  obj({ candidateId: str(), prefixFingerprint: str(), ownerKey: str() }, { open: true }),
).check;

function deepFreeze<T>(value: T): void {
  if (!(Array.isArray(value) || isRecord(value)) || Object.isFrozen(value)) return;
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

export function frozenCopy(source: FrozenSnapshot): FrozenSnapshot {
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

export const PROCEED: CoordinatorArbitrationResult = { action: "proceed" };

export const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(["quota", "429", "529"]);

/** Refusals of one specific cut; the next request on the same scope may legally differ. */
export const CUT_REFUSALS: ReadonlySet<string> = new Set(["no-legal-cut", "incompatible"]);

export function ownerCurrent(state: CoordinatorState): boolean {
  if (state.disposed || state.invalidated) return false;
  if (state.deps.isOwnerCurrent()) return true;
  invalidate(state, "owner-changed");
  return false;
}

export function active(state: CoordinatorState, current: Candidate): boolean {
  return (
    ownerCurrent(state) &&
    state.enabled &&
    state.candidate === current &&
    isOutstanding(current.machine.state) &&
    !current.abort.signal.aborted
  );
}

export function finish(
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
  if (current.attempt !== undefined) failure.attempt = current.attempt;
  if (current.cutFingerprint !== undefined) failure.cutFingerprint = current.cutFingerprint;
  if (current.tokensAtTrigger !== undefined) failure.tokensAtTrigger = current.tokensAtTrigger;
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
export function fail(
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
  // A retry delay marks a refusal the backend expects to clear without the branch changing.
  if (failure.reason === "no-legal-cut" && failure.retryAfterMs === undefined)
    markNoProgress(state, current);
  finish(state, current, "failed", failure.reason);
  rememberFailure(state, current, failure.reason, failure.detail);
  if (failure.cool) cool(state, current);
}

/** Fail the candidate and start the scope cooldown so the next attempt waits. */
export function failAndCool(
  state: CoordinatorState,
  current: Candidate,
  reason: ReasonCode,
  detail?: string,
): void {
  fail(state, current, { reason, detail, cool: true });
}

const REMEMBERED_CUTS = 32;

/** Insert into a bounded insertion-ordered map, dropping the oldest entries. */
export function remember<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > REMEMBERED_CUTS) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

function noProgressKey(fingerprint: string, backendId: string): string {
  return `${keyPart(fingerprint)}|${keyPart(backendId)}`;
}

/** The lane just ended with no legal cut for this fingerprint: remember it so an unchanged retrigger is not started. */
function markNoProgress(state: CoordinatorState, current: Candidate): void {
  if (current.cutFingerprint === undefined) return;
  remember(state.noProgress, noProgressKey(current.cutFingerprint, current.backendId), {
    reported: false,
  });
}

/**
 * Whether a non-manual request repeats a no-legal-cut attempt over an
 * unchanged cut. Journals (through the observer) once per fingerprint and lane.
 */
export function suppressed(
  state: CoordinatorState,
  request: PreparationRequest,
  backendId: string,
  fingerprint: string,
): boolean {
  if (request.trigger === "manual") return false;
  const entry = state.noProgress.get(noProgressKey(fingerprint, backendId));
  if (entry === undefined) return false;
  if (!entry.reported) {
    entry.reported = true;
    const event: SuppressedPortEvent = {
      backendId,
      trigger: request.trigger,
      attempt: (state.cutAttempts.get(fingerprint) ?? 0) + 1,
      cutFingerprint: fingerprint,
    };
    try {
      state.deps.onSuppressed?.(
        request.tokensAtTrigger === undefined
          ? event
          : { ...event, tokensAtTrigger: request.tokensAtTrigger },
      );
    } catch (cause) {
      if (!isStaleCause(state, cause)) throw cause;
    }
  }
  return true;
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

export function invalidate(state: CoordinatorState, reason: ReasonCode = "owner-changed"): void {
  state.invalidated = true;
  if (state.candidate) finish(state, state.candidate, "discarded-stale", reason);
}

export function finishCurrent(
  state: CoordinatorState,
  terminal: TerminalState,
  reason: ReasonCode,
): void {
  if (state.candidate) finish(state, state.candidate, terminal, reason);
}

function requireOwner(state: CoordinatorState): void {
  if (!ownerCurrent(state)) throw new InvalidatedOwnerContextError("Compaction owner invalidated");
}

export function isStaleCause(state: CoordinatorState, cause: unknown): boolean {
  return (
    cause instanceof InvalidatedOwnerContextError ||
    state.deps.isStaleContextError?.(cause) === true
  );
}

/** Invalidate on stale-owner failures and return the fallback; rethrow anything else. */
export async function containStaleOwner<T>(
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

export function captureContext(state: CoordinatorState, backendId: string): SnapshotContext {
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

export function validate(state: CoordinatorState, current: Candidate): boolean {
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

export function backendEnabled(state: CoordinatorState, id: string): boolean {
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

export function cooldownUntil(state: CoordinatorState, current: Candidate): number {
  return cooldownMap(state.clock).get(coolingKey(current)) ?? 0;
}

function coolingDown(state: CoordinatorState, current: Candidate): boolean {
  return cooldownUntil(state, current) > state.clock.now();
}

export function cool(
  state: CoordinatorState,
  current: Candidate,
  delay = state.settings.cooldownMs,
): void {
  const until = Math.max(cooldownUntil(state, current), state.clock.now() + delay);
  cooldownMap(state.clock).set(coolingKey(current), until);
}

/** Fails with "cooling" (no extra cooldown, no request sent) while the scope is cooling down. */
export function refuseWhileCooling(state: CoordinatorState, current: Candidate): boolean {
  if (!coolingDown(state, current)) return false;
  const seconds = Math.ceil((cooldownUntil(state, current) - state.clock.now()) / 1000);
  current.detail = `cooling-down ${seconds}s`;
  finish(state, current, "failed", "cooling");
  return true;
}
