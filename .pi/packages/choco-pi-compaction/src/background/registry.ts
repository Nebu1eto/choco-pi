import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BackendFactory, CoordinatorApi } from "./contract.ts";

const REGISTRY_SYMBOL = Symbol.for("choco-pi:compaction-coordinator");
export interface CoordinatorRegistry {
  readonly schemaVersion: 1;
  readonly backendFactories: Map<string, BackendFactory>;
  readonly coordinators: Map<string, CoordinatorApi>;
}
const CallableSchema = Type.Function([], Type.Unknown());
const CoordinatorRegistrationSchema = Type.Object({
  ownerKey: Type.String({ minLength: 1 }),
  ownerGeneration: Type.Integer({ minimum: 0 }),
  requestPreparation: CallableSchema,
  cancel: CallableSchema,
  status: CallableSchema,
  arbitrateHostCompaction: CallableSchema,
  arbitrateManualCompact: CallableSchema,
  registerConsumer: CallableSchema,
  registerParticipant: CallableSchema,
  dispose: CallableSchema,
});
const RegistrySlotSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  backendFactories: Type.Unknown(),
  coordinators: Type.Unknown(),
});
/** Validate callable presence; factories/coordinators themselves own their domain behavior. */
function isCoordinator<T>(value: T): value is T & CoordinatorApi {
  return Value.Check(CoordinatorRegistrationSchema, value);
}
function isFactoryMap<T>(value: T): value is T & Map<string, BackendFactory> {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, factory]) =>
        Value.Check(Type.String({ minLength: 1 }), key) && Value.Check(CallableSchema, factory),
    )
  );
}
function isCoordinatorMap<T>(value: T): value is T & Map<string, CoordinatorApi> {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, coordinator]) =>
        Value.Check(Type.String({ minLength: 1 }), key) &&
        isCoordinator(coordinator) &&
        key === coordinator.ownerKey,
    )
  );
}
function isRegistry<T>(value: T): value is T & CoordinatorRegistry {
  return (
    Value.Check(RegistrySlotSchema, value) &&
    isFactoryMap(value.backendFactories) &&
    isCoordinatorMap(value.coordinators)
  );
}
/** Share factory availability, not one global active session. Reject foreign/corrupt slots. */
export function getRegistry(): CoordinatorRegistry {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, REGISTRY_SYMBOL);
  const found: unknown = descriptor?.value;
  if (descriptor !== undefined) {
    if (!isRegistry(found)) throw new Error("Invalid background compaction registry");
    return found;
  }
  const registry: CoordinatorRegistry = {
    schemaVersion: 1,
    backendFactories: new Map(),
    coordinators: new Map(),
  };
  Object.defineProperty(globalThis, REGISTRY_SYMBOL, { value: registry, configurable: true });
  return registry;
}
/** First registration wins, including repeated imports in either extension load order. */
export function registerBackendFactory(id: string, factory: BackendFactory): BackendFactory {
  if (id.length === 0) throw new Error("Backend id must not be empty");
  const factories = getRegistry().backendFactories;
  const existing = factories.get(id);
  if (existing) return existing;
  factories.set(id, factory);
  return factory;
}
export function getCoordinator(
  ownerKey: string,
  ownerGeneration?: number,
): CoordinatorApi | undefined {
  const coordinator = getRegistry().coordinators.get(ownerKey);
  return ownerGeneration === undefined || coordinator?.ownerGeneration === ownerGeneration
    ? coordinator
    : undefined;
}
/** Callers dispose their old attachment before replacing it; stale writers cannot replace a newer generation. */
export function setCoordinator(ownerKey: string, coordinator: CoordinatorApi): void {
  if (!isCoordinator(coordinator) || ownerKey !== coordinator.ownerKey)
    throw new Error("Invalid coordinator owner");
  const coordinators = getRegistry().coordinators;
  const existing = coordinators.get(ownerKey);
  if (
    existing &&
    existing !== coordinator &&
    existing.ownerGeneration >= coordinator.ownerGeneration
  )
    throw new Error("Coordinator generation already registered");
  coordinators.set(ownerKey, coordinator);
}
/** Expected generation/instance protects a replacement owner against late cleanup. */
export function release(
  ownerKey: string,
  ownerGeneration: number,
  expected?: CoordinatorApi,
): boolean {
  const coordinators = getRegistry().coordinators;
  const coordinator = coordinators.get(ownerKey);
  if (
    !coordinator ||
    coordinator.ownerGeneration !== ownerGeneration ||
    (expected !== undefined && coordinator !== expected)
  )
    return false;
  return coordinators.delete(ownerKey);
}
