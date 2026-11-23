/**
 * Writer for background compaction's provider token-counter slot (protocol
 * v1), so this package can offer a prompt counter without importing the
 * compaction package. The slot on
 * `Symbol.for("choco-pi:compaction-token-counters/v1")` is a `Map` from Pi
 * provider id to an array of counters, newest registration last; compaction
 * asks the newest. A registration appends its own counter object and its
 * unregister removes exactly that object. The Google Antigravity provider registers its counter for `google`.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_TOKEN_COUNTERS_SYMBOL = Symbol.for("choco-pi:compaction-token-counters/v1");

/** What compaction passes: the owner model's prompt and its already resolved request auth. */
export interface CompactionTokenCountRequest {
  readonly model: Model<Api>;
  readonly system: string;
  readonly promptText: string;
  readonly signal: AbortSignal;
  /** Trimmed, non-empty registry key for the model. */
  readonly apiKey: string;
  readonly headers: ProviderHeaders | undefined;
  /** The registry's base URL, else the model's. */
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

/** Reported by compaction as `count-tokens: <code>[ <status>]`; a skip stays silent. */
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
  /** Environment variable that must be `1` when compaction creates its counter. */
  readonly optInEnv?: string;
  countTokens(request: CompactionTokenCountRequest): Promise<CompactionTokenCountOutcome>;
}

/** The slot's table; compaction validates entries when it reads them. */
function counterTable(): Map<string, CompactionTokenCounter[]> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, COMPACTION_TOKEN_COUNTERS_SYMBOL);
  const found: unknown = descriptor?.value;
  if (found instanceof Map) return found;
  if (descriptor !== undefined) throw new Error("Invalid compaction token counter table");
  const table = new Map<string, CompactionTokenCounter[]>();
  Object.defineProperty(globalThis, COMPACTION_TOKEN_COUNTERS_SYMBOL, {
    value: table,
    configurable: true,
  });
  return table;
}

/** Register `counter` for `providerId`; the returned unregister removes only this registration. */
export function registerCompactionTokenCounter(
  providerId: string,
  counter: CompactionTokenCounter,
): () => void {
  const table = counterTable();
  const existing = table.get(providerId);
  table.set(providerId, [...(Array.isArray(existing) ? existing : []), counter]);
  return () => {
    const current = table.get(providerId);
    if (!Array.isArray(current) || !current.includes(counter)) return;
    const remaining = current.filter((entry) => entry !== counter);
    if (remaining.length === 0) table.delete(providerId);
    else table.set(providerId, remaining);
  };
}

/**
 * Keep a counter registered while this extension instance is active: from
 * activation until `session_shutdown`, and again from a later
 * `session_start` of the same instance.
 */
export function bindCompactionTokenCounter(pi: ExtensionAPI, register: () => () => void): void {
  let unregister: (() => void) | undefined = register();
  pi.on("session_start", () => {
    unregister ??= register();
  });
  pi.on("session_shutdown", () => {
    unregister?.();
    unregister = undefined;
  });
}
