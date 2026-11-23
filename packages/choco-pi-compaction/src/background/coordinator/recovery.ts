import type { Backend, CandidateRecord, FrozenSnapshot, ReasonCode } from "../contract.ts";
import { type CommittedCandidate } from "../adoption.ts";
import { parseRecord, revalidateIdentity } from "../candidate-record.ts";
import { isOutstanding } from "../state-machine.ts";
import type { Candidate, CoordinatorState, SnapshotContext } from "./types.ts";
import { entriesThrough, isRefused, newCandidate } from "./preparation.ts";
import {
  active,
  backendEnabled,
  captureContext,
  finish,
  frozenCopy,
  ownerCurrent,
  validate,
} from "./state.ts";
import { findCommit, reconcileCommit } from "./arbitration.ts";

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

function discardRecord(state: CoordinatorState, record: CandidateRecord, reason: ReasonCode): void {
  const stale = newCandidate(state, record.candidateId, record.backendId, "recovery");
  state.candidate = stale;
  finish(state, stale, "discarded-stale", reason);
}

function recoveryContext(
  state: CoordinatorState,
  record: CandidateRecord,
): RecoveryContext | "next" | "refused" {
  const backend = state.deps.backends.get(record.backendId);
  const captured = captureContext(state, record.backendId);
  const committed = findCommit(state, record.candidateId, record.identity.prefixFingerprint);
  if (!ownerCurrent(state)) return "refused";
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

export async function recoverNewestFirst(
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
