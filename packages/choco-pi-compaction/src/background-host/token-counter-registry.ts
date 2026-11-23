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

/** Global symbol key for the shared compaction token-counter table across jiti `moduleCache: false` modules. */
export const COMPACTION_TOKEN_COUNTERS_SYMBOL = Symbol.for("choco-pi:compaction-token-counters/v1");

/** Provider-neutral request payload passed to a registered compaction token counter. */
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

/** Discriminated result of a compaction token-count call: token total, structured failure, or opt-in skip. */
export type CompactionTokenCountOutcome =
  | { readonly ok: true; readonly inputTokens: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly status?: number;
      readonly cache?: boolean;
    }
  | { readonly skipped: true };

/** Provider-supplied token counter registered in the compaction host's `globalThis` table. */
export interface CompactionTokenCounter {
  /** Optional environment variable that must be set to enable this counter. */
  readonly optInEnv?: string;
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

/** Appends a provider token counter to the shared `globalThis` table and returns a disposer. */
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

/** Returns the most recently registered token counter for `providerId`, if any. */
export function registeredTokenCounter(providerId: string): CompactionTokenCounter | undefined {
  return counterTable().get(providerId)?.at(-1);
}

/** Lists all distinct `optInEnv` variable names declared by currently registered token counters. */
export function registeredOptInEnvs(): readonly string[] {
  const names = new Set<string>();
  for (const counters of counterTable().values()) {
    for (const counter of counters) if (counter.optInEnv !== undefined) names.add(counter.optInEnv);
  }
  return [...names];
}

const isStatus = compile(finiteInt(0)).check;

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
