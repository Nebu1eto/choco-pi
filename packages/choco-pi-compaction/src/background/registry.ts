import {
  hasMethods,
  hasProperty,
  isFunction,
  isNonEmptyString,
  isNonNegativeInteger,
  readProperty,
} from "../guards.ts";
import type { BackendFactory, CoordinatorApi } from "./contract.ts";

const REGISTRY_SYMBOL = Symbol.for("choco-pi:compaction-coordinator:v2");
export interface CoordinatorRegistry {
  readonly schemaVersion: 2;
  readonly backendFactories: Map<string, BackendFactory>;
  readonly coordinators: Map<string, CoordinatorApi>;
  readonly delivered: Map<string, Map<string, Set<string>>>;
}
export type RegistryAvailability =
  | { readonly status: "available"; readonly registry: CoordinatorRegistry }
  | { readonly status: "conflict" };
const COORDINATOR_METHODS = [
  "requestPreparation",
  "cancel",
  "status",
  "arbitrateHostCompaction",
  "arbitrateManualCompact",
  "registerConsumer",
  "registerParticipant",
  "dispose",
] as const;
function isCoordinator<T>(value: T): value is T & CoordinatorApi {
  return (
    hasMethods(value, COORDINATOR_METHODS) &&
    isNonEmptyString(readProperty(value, "ownerKey")) &&
    isNonNegativeInteger(readProperty(value, "ownerGeneration"))
  );
}
function isFactoryMap<T>(value: T): value is T & Map<string, BackendFactory> {
  return (
    value instanceof Map &&
    [...value].every(([key, factory]) => isNonEmptyString(key) && isFunction(factory))
  );
}
function isCoordinatorMap<T>(value: T): value is T & Map<string, CoordinatorApi> {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, coordinator]) =>
        isNonEmptyString(key) && isCoordinator(coordinator) && key === coordinator.ownerKey,
    )
  );
}
function isRegistry<T>(value: T): value is T & CoordinatorRegistry {
  return (
    hasProperty(value, "backendFactories") &&
    hasProperty(value, "coordinators") &&
    hasProperty(value, "delivered") &&
    readProperty(value, "schemaVersion") === 2 &&
    isFactoryMap(readProperty(value, "backendFactories")) &&
    isCoordinatorMap(readProperty(value, "coordinators")) &&
    readProperty(value, "delivered") instanceof Map
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
export function registryAvailability(): RegistryAvailability {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, REGISTRY_SYMBOL);
  if (descriptor !== undefined) {
    const found: unknown = descriptor.value;
    try {
      if (isRegistry(found)) return { status: "available", registry: found };
    } catch {
      return { status: "conflict" };
    }
    return { status: "conflict" };
  }
  const registry = emptyRegistry();
  try {
    Object.defineProperty(globalThis, REGISTRY_SYMBOL, { value: registry, configurable: true });
  } catch {
    return { status: "conflict" };
  }
  return { status: "available", registry };
}
export function getRegistry(): CoordinatorRegistry {
  const availability = registryAvailability();
  return availability.status === "available" ? availability.registry : emptyRegistry();
}
const DEPARTED_LEDGERS = 16;

export function deliveredAdoptionsFor(ownerKey: string): Map<string, Set<string>> {
  const availability = registryAvailability();
  if (availability.status !== "available") return new Map();
  const ledger = availability.registry.delivered;
  let owned = ledger.get(ownerKey);
  if (owned === undefined) {
    owned = new Map();
  }
  ledger.delete(ownerKey);
  ledger.set(ownerKey, owned);
  return owned;
}

function pruneDepartedLedgers(registry: CoordinatorRegistry): void {
  const departed = [...registry.delivered.keys()].filter((key) => !registry.coordinators.has(key));
  for (const key of departed.slice(0, Math.max(0, departed.length - DEPARTED_LEDGERS))) {
    registry.delivered.delete(key);
  }
}
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
  const ledger = registry.delivered.get(ownerKey);
  if (ledger !== undefined) {
    registry.delivered.delete(ownerKey);
    registry.delivered.set(ownerKey, ledger);
  }
  pruneDepartedLedgers(registry);
  return removed;
}
