/**
 * Synthetic prompt counter for background compaction admission: the
 * Anthropic-compatible `/anthropic/v1/messages/count_tokens` endpoint on the
 * origin of the model's (or registry's) base URL. An invalid base URL throws,
 * which compaction reports as `count-tokens: error`.
 */
import type { CountTokensResult } from "../client/count-tokens.ts";
import {
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  registerCompactionTokenCounter,
} from "./token-counter-slot.ts";

/** The Pi provider id the provider entry registers. */
const SYNTHETIC_PROVIDER_ID = "synthetic";

function toOutcome(result: CountTokensResult): CompactionTokenCountOutcome {
  if (result.ok) return { ok: true, inputTokens: result.inputTokens };
  return result.status === undefined
    ? { ok: false, code: result.code }
    : { ok: false, code: result.code, status: result.status };
}

export const syntheticCompactionTokenCounter: CompactionTokenCounter = {
  async countTokens(request) {
    // Loaded on first count so provider activation stays as light as before.
    const { countSyntheticTokens } = await import("../client/count-tokens.ts");
    return toOutcome(
      await countSyntheticTokens({
        apiKey: request.apiKey,
        model: request.model.id,
        system: request.system,
        promptText: request.promptText,
        baseUrl: request.baseUrl,
        fetch: request.fetch,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      }),
    );
  },
};

/** Offer the counter for `synthetic` owner models; returns its unregister. */
export function registerSyntheticCompactionTokenCounter(): () => void {
  return registerCompactionTokenCounter(SYNTHETIC_PROVIDER_ID, syntheticCompactionTokenCounter);
}
