import type { CountTokensResult } from "../client/count-tokens.ts";
import {
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  registerCompactionTokenCounter,
} from "@choco-pi/shared/compaction-token-counter-slot";

const SYNTHETIC_PROVIDER_ID = "synthetic";

function toOutcome(result: CountTokensResult): CompactionTokenCountOutcome {
  if (result.ok) return { ok: true, inputTokens: result.inputTokens };
  return result.status === undefined
    ? { ok: false, code: result.code }
    : { ok: false, code: result.code, status: result.status };
}

export const syntheticCompactionTokenCounter: CompactionTokenCounter = {
  async countTokens(request) {
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

export function registerSyntheticCompactionTokenCounter(): () => void {
  return registerCompactionTokenCounter(SYNTHETIC_PROVIDER_ID, syntheticCompactionTokenCounter);
}
