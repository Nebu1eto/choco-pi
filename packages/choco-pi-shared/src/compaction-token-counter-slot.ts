import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_TOKEN_COUNTERS_SYMBOL = Symbol.for("choco-pi:compaction-token-counters/v1");

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

/** Cross-extension provider contract for counting compaction input tokens via `globalThis[Symbol.for(...)]`. */
export interface CompactionTokenCounter {
  /** Optional environment variable that must be set to enable this counter. */
  readonly optInEnv?: string;
  countTokens(request: CompactionTokenCountRequest): Promise<CompactionTokenCountOutcome>;
}

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

/** Ties a compaction token counter registration to `session_start` and `session_shutdown` lifecycle events. */
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
