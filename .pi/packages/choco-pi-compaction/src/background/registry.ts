import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BackendFactory, CoordinatorApi } from "./contract.ts";

/**
 * Process-wide slot that keeps backend factories, coordinators and delivery
 * ledgers alive across `/reload` (a reload re-imports this module, so module
 * state alone would be lost).
 *
 * The key is versioned. A process started with older code may still hold an
 * earlier slot shape under an earlier key (`choco-pi:compaction-coordinator`,
 * schema 1); that slot is never read, written or deleted. Any future shape
 * change must bump both the key suffix and `schemaVersion`.
 *
 * A slot under this key that fails validation (written by foreign or
 * incompatible code) makes the registry unavailable for this process: nothing
 * here throws, the slot is left untouched, and every operation degrades (see
 * `registryAvailability`). The host turns background compaction off and asks
 * for a restart.
 */
const REGISTRY_SYMBOL = Symbol.for("choco-pi:compaction-coordinator:v2");
export interface CoordinatorRegistry {
  readonly schemaVersion: 2;
  readonly backendFactories: Map<string, BackendFactory>;
  readonly coordinators: Map<string, CoordinatorApi>;
  /** Per owner key: consumer IDs already given each adoption ID in this process (survives reload). */
  readonly delivered: Map<string, Map<string, Set<string>>>;
}
/** Whether the process-wide registry can be used, and the registry when it can. */
export type RegistryAvailability =
  | { readonly status: "available"; readonly registry: CoordinatorRegistry }
  /** The global slot holds a value this code cannot validate; it is left untouched. */
  | { readonly status: "conflict" };
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
  schemaVersion: Type.Literal(2),
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
function emptyRegistry(): CoordinatorRegistry {
  return {
    schemaVersion: 2,
    backendFactories: new Map(),
    coordinators: new Map(),
    delivered: new Map(),
  };
}
/**
 * Probe the process-wide registry, creating it when the slot is absent.
 * Never throws and never replaces or repairs an existing slot.
 */
export function registryAvailability(): RegistryAvailability {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, REGISTRY_SYMBOL);
  if (descriptor !== undefined) {
    // An accessor slot has no `value` and fails validation like any foreign value.
    const found: unknown = descriptor.value;
    return isRegistry(found) ? { status: "available", registry: found } : { status: "conflict" };
  }
  const registry = emptyRegistry();
  try {
    Object.defineProperty(globalThis, REGISTRY_SYMBOL, { value: registry, configurable: true });
  } catch {
    // A non-extensible global cannot hold the slot; nothing can be shared.
    return { status: "conflict" };
  }
  return { status: "available", registry };
}
/**
 * Share factory availability, not one global active session. While the slot
 * is in conflict this returns a fresh registry that is not stored anywhere, so
 * reads see nothing and writes are discarded; use `registryAvailability` to
 * tell the two apart.
 */
export function getRegistry(): CoordinatorRegistry {
  const availability = registryAvailability();
  return availability.status === "available" ? availability.registry : emptyRegistry();
}
/**
 * Delivery ledgers kept for owners that no longer have a coordinator. A
 * reload releases the owner before its replacement registers, so a ledger
 * must outlive its owner briefly; one that is never reclaimed is dropped
 * once this many newer departed owners exist.
 */
const DEPARTED_LEDGERS = 16;

/**
 * The in-process delivery ledger for one owner key, created on first use.
 * Detached (not retained across reload) while the registry is in conflict.
 */
export function deliveredAdoptionsFor(ownerKey: string): Map<string, Set<string>> {
  const availability = registryAvailability();
  if (availability.status !== "available") return new Map();
  const ledger = availability.registry.delivered;
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
function pruneDepartedLedgers(registry: CoordinatorRegistry): void {
  const departed = [...registry.delivered.keys()].filter((key) => !registry.coordinators.has(key));
  for (const key of departed.slice(0, Math.max(0, departed.length - DEPARTED_LEDGERS))) {
    registry.delivered.delete(key);
  }
}
/**
 * First registration wins, including repeated imports in either extension load
 * order. While the registry is in conflict the factory is returned unstored.
 */
export function registerBackendFactory(id: string, factory: BackendFactory): BackendFactory {
  if (id.length === 0) throw new Error("Backend id must not be empty");
  const availability = registryAvailability();
  if (availability.status !== "available") return factory;
  const factories = availability.registry.backendFactories;
  const existing = factories.get(id);
  if (existing) return existing;
  factories.set(id, factory);
  return factory;
}
/** The registered coordinator; undefined while the registry is in conflict. */
export function getCoordinator(
  ownerKey: string,
  ownerGeneration?: number,
): CoordinatorApi | undefined {
  const availability = registryAvailability();
  if (availability.status !== "available") return undefined;
  const coordinator = availability.registry.coordinators.get(ownerKey);
  return ownerGeneration === undefined || coordinator?.ownerGeneration === ownerGeneration
    ? coordinator
    : undefined;
}
/**
 * Callers dispose their old attachment before replacing it; stale writers
 * cannot replace a newer generation (that and an invalid coordinator throw).
 * Returns false without storing while the registry is in conflict; the caller
 * must then treat the coordinator as unregistered.
 */
export function setCoordinator(ownerKey: string, coordinator: CoordinatorApi): boolean {
  if (!isCoordinator(coordinator) || ownerKey !== coordinator.ownerKey)
    throw new Error("Invalid coordinator owner");
  const availability = registryAvailability();
  if (availability.status !== "available") return false;
  const coordinators = availability.registry.coordinators;
  const existing = coordinators.get(ownerKey);
  if (
    existing &&
    existing !== coordinator &&
    existing.ownerGeneration >= coordinator.ownerGeneration
  )
    throw new Error("Coordinator generation already registered");
  coordinators.set(ownerKey, coordinator);
  return true;
}
/**
 * Expected generation/instance protects a replacement owner against late
 * cleanup. False while the registry is in conflict.
 */
export function release(
  ownerKey: string,
  ownerGeneration: number,
  expected?: CoordinatorApi,
): boolean {
  const availability = registryAvailability();
  if (availability.status !== "available") return false;
  const registry = availability.registry;
  const coordinator = registry.coordinators.get(ownerKey);
  if (
    !coordinator ||
    coordinator.ownerGeneration !== ownerGeneration ||
    (expected !== undefined && coordinator !== expected)
  )
    return false;
  const removed = registry.coordinators.delete(ownerKey);
  // The departing owner's ledger becomes the newest departed entry so the
  // retention window starts at departure (a reload re-acquires it next).
  const ledger = registry.delivered.get(ownerKey);
  if (ledger !== undefined) {
    registry.delivered.delete(ownerKey);
    registry.delivered.set(ownerKey, ledger);
  }
  pruneDepartedLedgers(registry);
  return removed;
}
