import { setTimeout } from "node:timers/promises";
import { statusArtifact } from "../artifacts.ts";
import type { Host } from "./types.ts";

type Coordinator = NonNullable<ReturnType<Host["mainCoordinator"]>>;

/** A requested preparation, pinned to the owner generation that accepted it. */
export interface PreparationHandle {
  readonly coordinator: Coordinator;
  readonly generation: number;
  readonly lookup: () => Coordinator | undefined;
}

const SETTLE_DEADLINE_MS = 5000;
/** A real summarizer or native lane request over a ~16k-token prefix. */
const LIVE_SETTLE_DEADLINE_MS = 180_000;

function assertSameOwner(host: Host, handle: PreparationHandle): void {
  if (
    !host.isCurrent() ||
    handle.lookup() !== handle.coordinator ||
    handle.coordinator.ownerGeneration !== handle.generation
  )
    throw new Error("Owner changed during preparation");
}

function isPending(coordinator: Coordinator): boolean {
  const state = coordinator.status().state;
  return state === "preparing" || state === "queued";
}

/** Requests a threshold preparation; undefined when the owner has no coordinator. */
export async function requestPreparation(
  host: Host,
  lookup: () => Coordinator | undefined = () => host.mainCoordinator(),
): Promise<PreparationHandle | undefined> {
  const coordinator = lookup();
  if (!coordinator) {
    host.recorder.record("missing-coordinator", { sessionId: host.manager.getSessionId() });
    return undefined;
  }
  const handle = { coordinator, generation: coordinator.ownerGeneration, lookup };
  host.observeCoordinators();
  const requested = await coordinator.requestPreparation({ trigger: "threshold" });
  assertSameOwner(host, handle);
  host.recorder.record("preparation-request", requested);
  return handle;
}

/** Polls the real coordinator until it leaves queued/preparing; true when ready or already adopted. */
export async function awaitPreparation(host: Host, handle: PreparationHandle): Promise<boolean> {
  const budget = host.mode === "live" ? LIVE_SETTLE_DEADLINE_MS : SETTLE_DEADLINE_MS;
  const deadline = performance.now() + budget;
  while (isPending(handle.coordinator)) {
    if (performance.now() > deadline)
      throw new Error("Preparation did not settle within its deadline");
    await setTimeout(host.mode === "live" ? 100 : 5);
    assertSameOwner(host, handle);
  }
  host.recorder.record("preparation-settled", statusArtifact(handle.coordinator.status()));
  const state = handle.coordinator.status().state;
  return state === "ready" || state === "installed";
}

export async function prepare(
  host: Host,
  lookup: () => Coordinator | undefined = () => host.mainCoordinator(),
): Promise<boolean> {
  const handle = await requestPreparation(host, lookup);
  return handle ? awaitPreparation(host, handle) : false;
}
