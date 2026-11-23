/** Adoption: commit lookup, host-compaction arbitration, and commit reconciliation. */
import type { FrozenSnapshot } from "../contract.ts";
import { adoptionDraft, firstRetainedEntry, type CommittedCandidate } from "../adoption.ts";
import { arbitrationIntent, type HostCompactionTrigger } from "../arbitration.ts";
import { type WorkSettlement } from "../scheduler.ts";
import type { Candidate, CoordinatorArbitrationResult, CoordinatorState } from "./types.ts";
import {
  PROCEED,
  containStaleOwner,
  finish,
  finishCurrent,
  isAdoptionIdentity,
  ownerCurrent,
  validate,
} from "./state.ts";

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
    isAdoptionIdentity(details) &&
    details.candidateId === candidateId &&
    details.prefixFingerprint === fingerprint &&
    details.ownerKey === state.ownerKey
  );
}

export function findCommit(
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

export function reconcileCommit(state: CoordinatorState, draftFinished = false): Promise<void> {
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

export async function arbitrate(
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
