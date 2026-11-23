/**
 * Process-global registry of provider compaction backends.
 *
 * The built-in lanes stay wired by this package: the `text` and
 * `anthropic-native` background backends, Codex's `codex-native-v2` factory
 * (registered by the Codex package through the neutral coordinator registry),
 * and the Anthropic and xAI server-side `session_before_compact` handlers. A
 * future provider lane registers a {@link CompactionBackendProvider} here
 * instead of adding a branch to the host wiring:
 *
 * - `backendFactory`: a background backend under the provider's `id`. It is
 *   admitted by the owner's foreign-backend switch and `enabled` (default:
 *   whenever background compaction is on), and it is selected for an owner
 *   whose scope its own `capability` check supports, after the Anthropic
 *   backend and before the text backend.
 * - `foregroundCompact`: answers `session_before_compact` server-side after
 *   the built-in Anthropic and xAI handlers declined, before the local
 *   summarizer.
 *
 * An id a built-in backend uses is ignored, so registration never replaces a
 * built-in lane. With nothing registered every path behaves as before. The
 * table lives on `Symbol.for("choco-pi:compaction-backends/v1")` because each
 * extension loads through its own module instance: a `Map` from id to that
 * id's registrations, newest last.
 */
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

/** Built-in lane ids a registration cannot take (`xai-native` is the xAI server-side lane). */
const BUILT_IN_BACKEND_IDS: ReadonlySet<string> = new Set([
  TEXT_BACKEND_SETTING_ID,
  ANTHROPIC_BACKEND_SETTING_ID,
  CODEX_BACKEND_SETTING_ID,
  "xai-native",
]);

/** A `session_before_compact` answer, or undefined to let the next handler answer. */
export type ForegroundCompactHandler = (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined>;

export interface CompactionBackendProvider {
  /** Stable lane id; also the background backend's id when `backendFactory` is set. */
  readonly id: string;
  readonly backendFactory?: BackendFactory;
  /** Whether the settings enable the background backend; called only while background compaction is on. */
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

/**
 * Register a provider lane. The newest registration of an id answers; the
 * returned unregister removes only this one. A built-in id throws.
 */
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

/** The newest registration of each non-built-in id, in first-registration order. */
export function compactionBackendProviders(): readonly CompactionBackendProvider[] {
  const providers: CompactionBackendProvider[] = [];
  for (const [id, registrations] of providerTable()) {
    const newest = registrations.at(-1);
    if (newest !== undefined && !BUILT_IN_BACKEND_IDS.has(id)) providers.push(newest);
  }
  return providers;
}

/** The registered provider that supplies the background backend `id`, if any. */
export function registeredBackendProvider(id: string): CompactionBackendProvider | undefined {
  return compactionBackendProviders().find(
    (provider) => provider.id === id && provider.backendFactory !== undefined,
  );
}

/**
 * The host's backend flag mapping: the built-in settings switches, then a
 * registered backend's own `enabled` (default on) while background
 * compaction is enabled.
 */
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

/** Registered `session_before_compact` handlers, in provider order. */
export function registeredForegroundHandlers(): readonly ForegroundCompactHandler[] {
  const handlers: ForegroundCompactHandler[] = [];
  for (const provider of compactionBackendProviders()) {
    if (provider.foregroundCompact !== undefined) handlers.push(provider.foregroundCompact);
  }
  return handlers;
}

/** The first handler's answer; each runs only after every earlier one declined. */
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
