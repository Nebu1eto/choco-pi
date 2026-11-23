/**
 * Process-global registry of provider prompt token counters for background
 * compaction admission.
 *
 * A provider package registers a counter for its Pi provider id on extension
 * activation and unregisters it on `session_shutdown`; compaction looks the
 * counter up by the owner model's provider when it sizes a prompt, so it never
 * imports provider internals. The table lives on
 * `Symbol.for("choco-pi:compaction-token-counters/v1")` because every
 * extension loads through its own module instance; this module keeps no state
 * of its own.
 *
 * Slot protocol (v1), shared with providers that write the slot without
 * importing this package: the value is a `Map` from provider id to an array
 * of counters, newest registration last. A counter is an object with a
 * `countTokens(request)` method and an optional `optInEnv` string. A
 * registration appends its own counter object; its unregister removes that
 * exact object (never a newer one) and deletes an emptied provider entry.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

import {
  finiteInt,
  isBoolean,
  isFunction,
  isNonEmptyString,
  isNonNegativeInteger,
  isOptional,
  isRecord,
  isString,
  readProperty,
} from "../guards.ts";
import { compile } from "@earendil-works/pi-schema";

export const COMPACTION_TOKEN_COUNTERS_SYMBOL = Symbol.for("choco-pi:compaction-token-counters/v1");

/**
 * One count request. Compaction has already resolved the owner model's
 * request auth: `apiKey` is trimmed and non-empty, and `baseUrl` is the
 * registry's base URL or else the model's own.
 */
export interface CompactionTokenCountRequest {
  readonly model: Model<Api>;
  readonly system: string;
  readonly promptText: string;
  readonly signal: AbortSignal;
  readonly apiKey: string;
  readonly headers: ProviderHeaders | undefined;
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

/**
 * A count, a failure, or a skip. A failure is reported as
 * `count-tokens: <code>[ <status>]`; `cache` overrides whether it suppresses
 * further requests for the model (by default `auth`, `malformed`, and an
 * `http` 5xx do). A skip leaves the prompt uncounted without a diagnostic.
 */
export type CompactionTokenCountOutcome =
  | { readonly ok: true; readonly inputTokens: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly status?: number;
      readonly cache?: boolean;
    }
  | { readonly skipped: true };

export interface CompactionTokenCounter {
  /**
   * Environment variable that must be `1` for this counter to run; read once
   * when compaction creates its counter. Absent: always enabled.
   */
  readonly optInEnv?: string;
  /** Count the prompt; a throw is contained and reported as `count-tokens: error`. */
  countTokens(request: CompactionTokenCountRequest): Promise<CompactionTokenCountOutcome>;
}

type CounterTable = Map<string, CompactionTokenCounter[]>;

function isCounter<T>(value: T): value is T & CompactionTokenCounter {
  return (
    isRecord(value) &&
    isFunction(readProperty(value, "countTokens")) &&
    isOptional(readProperty(value, "optInEnv"), isString)
  );
}

function isCounterTable<T>(value: T): value is T & CounterTable {
  if (!(value instanceof Map)) return false;
  for (const [providerId, counters] of value) {
    if (!isNonEmptyString(providerId) || !Array.isArray(counters)) return false;
    if (!counters.every((counter) => isCounter(counter))) return false;
  }
  return true;
}

function counterTable(): CounterTable {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, COMPACTION_TOKEN_COUNTERS_SYMBOL);
  const found: unknown = descriptor?.value;
  if (isCounterTable(found)) return found;
  if (descriptor !== undefined) throw new Error("Invalid compaction token counter table");
  const table: CounterTable = new Map();
  Object.defineProperty(globalThis, COMPACTION_TOKEN_COUNTERS_SYMBOL, {
    value: table,
    configurable: true,
  });
  return table;
}

/**
 * Register `counter` for owner models of `providerId`. The newest
 * registration answers; the returned unregister removes only this one, so an
 * older registration's cleanup never drops a newer one.
 */
export function registerCompactionTokenCounter(
  providerId: string,
  counter: CompactionTokenCounter,
): () => void {
  if (providerId.length === 0) throw new Error("Token counter provider id must not be empty");
  const table = counterTable();
  table.set(providerId, [...(table.get(providerId) ?? []), counter]);
  return () => {
    const current = table.get(providerId);
    if (current === undefined || !current.includes(counter)) return;
    const remaining = current.filter((entry) => entry !== counter);
    if (remaining.length === 0) table.delete(providerId);
    else table.set(providerId, remaining);
  };
}

/** The newest counter registered for `providerId`, if any. */
export function registeredTokenCounter(providerId: string): CompactionTokenCounter | undefined {
  return counterTable().get(providerId)?.at(-1);
}

/** Opt-in variables of every registered counter (read when a compaction counter is created). */
export function registeredOptInEnvs(): readonly string[] {
  const names = new Set<string>();
  for (const counters of counterTable().values()) {
    for (const counter of counters) if (counter.optInEnv !== undefined) names.add(counter.optInEnv);
  }
  return [...names];
}

const isStatus = compile(finiteInt(0)).check;

/** A counter's answer as compaction reads it; another module instance wrote it. */
export function isTokenCountOutcome<T>(value: T): value is T & CompactionTokenCountOutcome {
  if (!isRecord(value)) return false;
  if (readProperty(value, "skipped") === true) return true;
  const ok = readProperty(value, "ok");
  if (ok === true) return isNonNegativeInteger(readProperty(value, "inputTokens"));
  return (
    ok === false &&
    isNonEmptyString(readProperty(value, "code")) &&
    isOptional(readProperty(value, "status"), isStatus) &&
    isOptional(readProperty(value, "cache"), isBoolean)
  );
}
