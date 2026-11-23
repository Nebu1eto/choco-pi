import {
  isFunction,
  isNumber,
  isObject,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../runtime-values.ts";
import type { UsageProviderAdapter } from "./types.ts";

export const USAGE_PROVIDER_REGISTRY_SYMBOL = Symbol.for("choco-pi:usage-providers/v1");

function isUsageProviderAdapter(value: RuntimeValue): value is UsageProviderAdapter {
  if (!isObject(value) || value === null) return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(value);
  return (
    isString(record.id) &&
    isString(record.displayName) &&
    isNumber(record.order) &&
    isFunction(record.readUsage)
  );
}

function isUsageProviderMap(value: RuntimeValue): value is Map<string, UsageProviderAdapter> {
  if (!(value instanceof Map)) return false;
  const entries = reinterpretHostValue<Map<RuntimeValue, RuntimeValue>>(value);
  for (const [id, adapter] of entries) {
    if (!isString(id) || !isUsageProviderAdapter(adapter)) return false;
  }
  return true;
}

function getRegistryMap(): Map<string, UsageProviderAdapter> {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const existing = slots[USAGE_PROVIDER_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const map = new Map<string, UsageProviderAdapter>();
    slots[USAGE_PROVIDER_REGISTRY_SYMBOL] = map;
    return map;
  }
  if (!isUsageProviderMap(existing)) {
    throw new TypeError(
      "Usage provider registry slot must be a Map<string, UsageProviderAdapter>.",
    );
  }
  return reinterpretHostValue<Map<string, UsageProviderAdapter>>(existing);
}

/**
 * Registers a usage provider adapter by `adapter.id`. Re-registering the same
 * id replaces the adapter. Returns an unregister callback that only removes
 * this exact adapter registration.
 */
export function registerUsageProvider(adapter: UsageProviderAdapter): () => void {
  const registry = getRegistryMap();
  registry.set(adapter.id, adapter);
  return () => {
    if (registry.get(adapter.id) === adapter) {
      registry.delete(adapter.id);
    }
  };
}

/** Returns all registered usage provider adapters ordered by `order` ascending. */
export function getUsageProviders(): readonly UsageProviderAdapter[] {
  const indexed = [...getRegistryMap().values()].map((adapter, index) => ({ adapter, index }));
  indexed.sort((a, b) => a.adapter.order - b.adapter.order || a.index - b.index);
  return indexed.map((entry) => entry.adapter);
}

/** Finds the registered adapter whose `providerIds` or `id` matches `providerId`. */
export function findUsageProviderAdapter(providerId: string): UsageProviderAdapter | undefined {
  for (const adapter of getUsageProviders()) {
    if (adapter.providerIds?.includes(providerId) || adapter.id === providerId) {
      return adapter;
    }
  }
  return undefined;
}
