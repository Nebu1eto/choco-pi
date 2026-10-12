import type {
  Adoption,
  AdoptionConsumer,
  CoordinatorApi,
} from "../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import { getRegistry } from "../../../.pi/packages/choco-pi-compaction/src/background/registry.ts";
import type { Recorder } from "./artifacts.ts";
export interface ConsumerNotice {
  consumer: string;
  adoptionId: string;
  evidenceRef: number;
  candidateId?: string;
  committedEntryId?: string;
}
interface ProbeState {
  current: boolean;
  recorder: Recorder;
  registrations: { consumer: string; ownerKey: string }[];
  notifications: ConsumerNotice[];
}
function invokeConsumer(
  state: ProbeState,
  consumer: AdoptionConsumer,
  ownerKey: string,
  generation: number,
  adoption: Adoption,
): ReturnType<AdoptionConsumer["onAdopted"]> {
  if (!state.current) throw new Error("Adoption reached disposed consumer probe");
  const evidenceRef = state.recorder.record("consumer-invoked", {
    consumer: consumer.id,
    ownerKey,
    generation,
    ...adoption,
  });
  state.notifications.push({
    consumer: consumer.id,
    adoptionId: adoption.adoptionId,
    candidateId: adoption.candidateId,
    committedEntryId: adoption.committedEntryId,
    evidenceRef,
  });
  return consumer.onAdopted(adoption);
}
function registerObserved(
  state: ProbeState,
  coordinator: CoordinatorApi,
  original: CoordinatorApi["registerConsumer"],
  consumer: AdoptionConsumer,
): () => void {
  if (!state.current) throw new Error("Consumer probe disposed");
  const ownerKey = coordinator.ownerKey;
  const generation = coordinator.ownerGeneration;
  state.registrations.push({ consumer: consumer.id, ownerKey });
  state.recorder.record("consumer-registration", { consumer: consumer.id, ownerKey, generation });
  return original.call(coordinator, {
    id: consumer.id,
    onAdopted: (adoption) => invokeConsumer(state, consumer, ownerKey, generation, adoption),
  });
}
function restoreRegistrar(
  coordinator: CoordinatorApi,
  wrapped: CoordinatorApi["registerConsumer"],
  previous: PropertyDescriptor | undefined,
): void {
  if (coordinator.registerConsumer !== wrapped) return;
  if (previous) Object.defineProperty(coordinator, "registerConsumer", previous);
  else Reflect.deleteProperty(coordinator, "registerConsumer");
}
function observeCoordinator(
  state: ProbeState,
  coordinator: CoordinatorApi,
  existing: Set<CoordinatorApi>,
  owned: CoordinatorApi[],
  restores: (() => void)[],
): void {
  if (existing.has(coordinator)) return;
  existing.add(coordinator);
  owned.push(coordinator);
  const previous = Object.getOwnPropertyDescriptor(coordinator, "registerConsumer");
  const original = coordinator.registerConsumer;
  const wrapped = (consumer: AdoptionConsumer) =>
    registerObserved(state, coordinator, original, consumer);
  coordinator.registerConsumer = wrapped;
  restores.push(() => restoreRegistrar(coordinator, wrapped, previous));
}
function restoreSet(
  map: Map<string, CoordinatorApi>,
  wrapped: Map<string, CoordinatorApi>["set"],
  previous: PropertyDescriptor | undefined,
): void {
  if (map.set !== wrapped) return;
  if (previous) Object.defineProperty(map, "set", previous);
  else Reflect.deleteProperty(map, "set");
}
/** Observe public registration; preserve the callback's exact result/promise. */
export function installConsumerProbe(recorder: Recorder) {
  const map = getRegistry().coordinators;
  const previous = Object.getOwnPropertyDescriptor(map, "set");
  const originalSet = map.set;
  const existing = new Set(map.values());
  const restores: (() => void)[] = [];
  const ownedCoordinators: CoordinatorApi[] = [];
  const state: ProbeState = { current: true, recorder, registrations: [], notifications: [] };
  const wrapped = (key: string, coordinator: CoordinatorApi) => {
    if (!state.current) throw new Error("Coordinator registration reached disposed probe");
    observeCoordinator(state, coordinator, existing, ownedCoordinators, restores);
    return originalSet.call(map, key, coordinator);
  };
  map.set = wrapped;
  return {
    registrations: state.registrations,
    notifications: state.notifications,
    ownedCoordinators,
    dispose() {
      if (!state.current) return;
      state.current = false;
      for (const restore of restores) restore();
      restoreSet(map, wrapped, previous);
    },
  };
}
