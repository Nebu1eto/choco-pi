import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AdmissionRecord,
  Backend,
  CandidateRecord,
  EstimateSource,
  FrozenSnapshot,
  PreparationRequest,
  PreparationRequestResult,
  PreparedCheckpoint,
  PrepareFailure,
  ReasonCode,
} from "../contract.ts";
import { resolveBackgroundLimits } from "../../budget.ts";
import { cutFingerprint, renderFrozenPrefixPrompt } from "../snapshot.ts";
import { buildRecord, fingerprintPrefix } from "../candidate-record.ts";
import { CandidateMachine, isOutstanding } from "../state-machine.ts";
import { processPreparationLimiter, waitUntil, type WorkSettlement } from "../scheduler.ts";
import type {
  Candidate,
  CandidateTrigger,
  CoordinatorState,
  SnapshotContext,
  SnapshotRefused,
} from "./types.ts";
import {
  CUT_REFUSALS,
  RATE_LIMIT_REASONS,
  active,
  backendEnabled,
  captureContext,
  cool,
  cooldownUntil,
  fail,
  failAndCool,
  finish,
  frozenCopy,
  isStaleCause,
  ownerCurrent,
  refuseWhileCooling,
  remember,
  suppressed,
  validate,
} from "./state.ts";

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

export function isRefused(value: FrozenSnapshot | SnapshotRefused): value is SnapshotRefused {
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

export function entriesThrough(
  entries: readonly SessionEntry[],
  cutEntryId: string,
): SessionEntry[] {
  return entries.slice(0, entries.findIndex((entry) => entry.id === cutEntryId) + 1);
}

function selectSnapshot(
  state: CoordinatorState,
  current: Candidate,
  participantEntryIds: readonly string[],
): FrozenSnapshot | undefined {
  const captured = { ...captureContext(state, current.backendId), participantEntryIds };
  current.branchKey = state.deps.port.getBranchKey();
  const selected = state.deps.freezeSnapshot(captured);
  if (isRefused(selected)) {
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

interface PromptCount {
  readonly counted: number | undefined;
  readonly detail?: string;
}

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
  if (checkpoint.usage.output > effectiveLimits(state).maxOutputTokens)
    return { reason: "oversized", detail: "output-over-budget" };
  return { record };
}

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

export function newCandidate(
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

export function requestPreparation(
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
  const fingerprint = cutFingerprint(
    state.deps.port.getBranch(),
    `${backend.id}|${state.deps.cutSalt?.(backend.id) ?? ""}`,
  );
  if (suppressed(state, request, backend.id, fingerprint))
    return { accepted: false, reason: "no-legal-cut" };
  const attempt = (state.cutAttempts.get(fingerprint) ?? 0) + 1;
  remember(state.cutAttempts, fingerprint, attempt);
  const current = newCandidate(
    state,
    state.deps.createCandidateId?.() ?? randomUUID(),
    backend.id,
    request.trigger,
    request.customInstructions,
  );
  current.cutFingerprint = fingerprint;
  current.attempt = attempt;
  if (request.tokensAtTrigger !== undefined) current.tokensAtTrigger = request.tokensAtTrigger;
  state.candidate = current;
  current.cancelDeadline = state.clock.setTimer(
    () => failAndCool(state, current, "timeout"),
    state.settings.timeoutMs,
  );
  launch(state, current, backend);
  return { accepted: true, candidateId: current.id };
}
