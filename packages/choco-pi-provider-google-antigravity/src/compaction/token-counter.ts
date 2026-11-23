import { readAntigravityApiKey } from "../auth/oauth.ts";
import { resolveRuntimeModel } from "../catalog/group.ts";
import { PROVIDER_ID } from "../config.ts";
import type { CountTokensResult } from "../client/count-tokens.ts";
import {
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  registerCompactionTokenCounter,
} from "@choco-pi/shared/compaction-token-counter-slot";

export const ANTIGRAVITY_COUNT_TOKENS_ENV = "CHOCO_PI_ANTIGRAVITY_COUNT_TOKENS";

function toOutcome(result: CountTokensResult): CompactionTokenCountOutcome {
  if (result.ok) return { ok: true, inputTokens: result.inputTokens };
  return result.status === undefined
    ? { ok: false, code: result.code }
    : { ok: false, code: result.code, status: result.status };
}

export const antigravityCompactionTokenCounter: CompactionTokenCounter = {
  optInEnv: ANTIGRAVITY_COUNT_TOKENS_ENV,
  async countTokens(request) {
    const credential = readAntigravityApiKey(request.apiKey);
    if (credential === undefined) return { skipped: true };
    let runtimeId: string;
    try {
      runtimeId = resolveRuntimeModel(request.model.id, undefined).runtimeId;
    } catch {
      return { ok: false, code: "model-unavailable", cache: true };
    }
    const { countAntigravityTokens } = await import("../client/count-tokens.ts");
    return toOutcome(
      await countAntigravityTokens({
        token: credential.token,
        model: runtimeId,
        system: request.system,
        promptText: request.promptText,
        fetch: request.fetch,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      }),
    );
  },
};

export function registerAntigravityCompactionTokenCounter(): () => void {
  return registerCompactionTokenCounter(PROVIDER_ID, antigravityCompactionTokenCounter);
}
