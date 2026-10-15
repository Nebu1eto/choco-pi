import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BackendFactory, CoordinatorApi } from "./contract.ts";

const REGISTRY_SYMBOL = Symbol.for("choco-pi:compaction-coordinator");
export interface CoordinatorRegistry {
  readonly schemaVersion: 1;
  readonly backendFactories: Map<string, BackendFactory>;
  readonly coordinators: Map<string, CoordinatorApi>;
  /** Per owner key: consumer IDs already given each adoption ID in this process (survives reload). */
  readonly delivered: Map<string, Map<string, Set<string>>>;
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
  delivered: Type.Unknown(),
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
    isCoordinatorMap(value.coordinators) &&
    value.delivered instanceof Map
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
    delivered: new Map(),
  };
  Object.defineProperty(globalThis, REGISTRY_SYMBOL, { value: registry, configurable: true });
  return registry;
}
/**
 * Delivery ledgers kept for owners that no longer have a coordinator. A
 * reload releases the owner before its replacement registers, so a ledger
 * must outlive its owner briefly; one that is never reclaimed is dropped
 * once this many newer departed owners exist.
 */
const DEPARTED_LEDGERS = 16;

/** The in-process delivery ledger for one owner key, created on first use. */
export function deliveredAdoptionsFor(ownerKey: string): Map<string, Set<string>> {
  const ledger = getRegistry().delivered;
  let owned = ledger.get(ownerKey);
  if (owned === undefined) {
    owned = new Map();
  }
  // Re-insert so the map's order tracks most recent use.
  ledger.delete(ownerKey);
  ledger.set(ownerKey, owned);
  return owned;
}

/** Drop the oldest departed owners' ledgers beyond the retention window. */
function pruneDepartedLedgers(): void {
  const registry = getRegistry();
  const departed = [...registry.delivered.keys()].filter((key) => !registry.coordinators.has(key));
  for (const key of departed.slice(0, Math.max(0, departed.length - DEPARTED_LEDGERS))) {
    registry.delivered.delete(key);
  }
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
  const removed = coordinators.delete(ownerKey);
  // The departing owner's ledger becomes the newest departed entry so the
  // retention window starts at departure (a reload re-acquires it next).
  const ledger = getRegistry().delivered.get(ownerKey);
  if (ledger !== undefined) {
    getRegistry().delivered.delete(ownerKey);
    getRegistry().delivered.set(ownerKey, ledger);
  }
  pruneDepartedLedgers();
  return removed;
}
