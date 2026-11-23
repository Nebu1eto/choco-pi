import { AdoptionDelivery } from "../adoption.ts";
import { systemClock } from "../scheduler.ts";
import type {
  CoordinatorDependencies,
  CoordinatorHandle,
  CoordinatorState,
  DetailedCoordinatorStatus,
} from "./types.ts";
import { containStaleOwner, finishCurrent, invalidate } from "./state.ts";
import { requestPreparation } from "./preparation.ts";
import { arbitrate, reconcileCommit } from "./arbitration.ts";
import { recoverNewestFirst } from "./recovery.ts";

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
    cutAttempts: new Map(),
    noProgress: new Map(),
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
