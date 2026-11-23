import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import type { BackendFactory, BackgroundCompactionSettings } from "../background/contract.ts";
import {
  ANTHROPIC_BACKEND_SETTING_ID,
  CODEX_BACKEND_SETTING_ID,
  isBackendEnabled,
  TEXT_BACKEND_SETTING_ID,
} from "../background/settings.ts";
import { isFunction, isNonEmptyString, isOptional, isRecord, readProperty } from "../guards.ts";

export const COMPACTION_BACKENDS_SYMBOL = Symbol.for("choco-pi:compaction-backends/v1");

const BUILT_IN_BACKEND_IDS: ReadonlySet<string> = new Set([
  TEXT_BACKEND_SETTING_ID,
  ANTHROPIC_BACKEND_SETTING_ID,
  CODEX_BACKEND_SETTING_ID,
  "xai-native",
]);

export type ForegroundCompactHandler = (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined>;

export interface CompactionBackendProvider {
  readonly id: string;
  readonly backendFactory?: BackendFactory;
  readonly enabled?: (settings: Readonly<BackgroundCompactionSettings>) => boolean;
  readonly foregroundCompact?: ForegroundCompactHandler;
}

type ProviderTable = Map<string, CompactionBackendProvider[]>;

function isProvider<T>(value: T): value is T & CompactionBackendProvider {
  return (
    isRecord(value) &&
    isNonEmptyString(readProperty(value, "id")) &&
    isOptional(readProperty(value, "backendFactory"), isFunction) &&
    isOptional(readProperty(value, "enabled"), isFunction) &&
    isOptional(readProperty(value, "foregroundCompact"), isFunction)
  );
}

function isProviderTable<T>(value: T): value is T & ProviderTable {
  if (!(value instanceof Map)) return false;
  for (const [id, providers] of value) {
    if (!isNonEmptyString(id) || !Array.isArray(providers)) return false;
    if (!providers.every((provider) => isProvider(provider) && provider.id === id)) return false;
  }
  return true;
}

function providerTable(): ProviderTable {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, COMPACTION_BACKENDS_SYMBOL);
  const found: unknown = descriptor?.value;
  if (isProviderTable(found)) return found;
  if (descriptor !== undefined) throw new Error("Invalid compaction backend provider table");
  const table: ProviderTable = new Map();
  Object.defineProperty(globalThis, COMPACTION_BACKENDS_SYMBOL, {
    value: table,
    configurable: true,
  });
  return table;
}

export function registerCompactionBackendProvider(provider: CompactionBackendProvider): () => void {
  if (provider.id.length === 0) throw new Error("Compaction backend id must not be empty");
  if (BUILT_IN_BACKEND_IDS.has(provider.id)) {
    throw new Error(`Compaction backend id ${provider.id} is built in`);
  }
  const table = providerTable();
  table.set(provider.id, [...(table.get(provider.id) ?? []), provider]);
  return () => {
    const current = table.get(provider.id);
    if (current === undefined || !current.includes(provider)) return;
    const remaining = current.filter((entry) => entry !== provider);
    if (remaining.length === 0) table.delete(provider.id);
    else table.set(provider.id, remaining);
  };
}

export function compactionBackendProviders(): readonly CompactionBackendProvider[] {
  const providers: CompactionBackendProvider[] = [];
  for (const [id, registrations] of providerTable()) {
    const newest = registrations.at(-1);
    if (newest !== undefined && !BUILT_IN_BACKEND_IDS.has(id)) providers.push(newest);
  }
  return providers;
}

export function registeredBackendProvider(id: string): CompactionBackendProvider | undefined {
  return compactionBackendProviders().find(
    (provider) => provider.id === id && provider.backendFactory !== undefined,
  );
}

export function isCompactionBackendEnabled(
  id: string,
  settings: Readonly<BackgroundCompactionSettings>,
): boolean {
  if (isBackendEnabled(id, settings)) return true;
  if (!settings.enabled || BUILT_IN_BACKEND_IDS.has(id)) return false;
  const provider = registeredBackendProvider(id);
  if (provider === undefined) return false;
  return provider.enabled === undefined || provider.enabled(settings);
}

export function registeredForegroundHandlers(): readonly ForegroundCompactHandler[] {
  const handlers: ForegroundCompactHandler[] = [];
  for (const provider of compactionBackendProviders()) {
    if (provider.foregroundCompact !== undefined) handlers.push(provider.foregroundCompact);
  }
  return handlers;
}

export async function firstForegroundAnswer<Event, Context, Answer>(
  handlers: readonly ((event: Event, ctx: Context) => Promise<Answer | undefined>)[],
  event: Event,
  ctx: Context,
): Promise<Answer | undefined> {
  for (const handler of handlers) {
    const answer = await handler(event, ctx);
    if (answer !== undefined) return answer;
  }
  return undefined;
}
