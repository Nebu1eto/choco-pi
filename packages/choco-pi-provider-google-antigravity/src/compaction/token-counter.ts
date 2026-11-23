/**
 * Google Antigravity prompt counter for background compaction admission.
 *
 * Counts through Cloud Code Assist `v1internal:countTokens` only when
 * `CHOCO_PI_ANTIGRAVITY_COUNT_TOKENS=1` (see {@link ANTIGRAVITY_COUNT_TOKENS_ENV}).
 * The registry key must be the packed `{token, project_id}` credential; any
 * other key, such as a Gemini API key Pi's inherited `google` API-key auth
 * resolved (GEMINI_API_KEY or a stored API key), is skipped without a request.
 * The request names the runtime model id agy would send for the base model's
 * first advertised level (the level does not change the count).
 */
import { readAntigravityApiKey } from "../auth/oauth.ts";
import { resolveRuntimeModel } from "../catalog/group.ts";
import { PROVIDER_ID } from "../config.ts";
import type { CountTokensResult } from "../client/count-tokens.ts";
import {
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  registerCompactionTokenCounter,
} from "./token-counter-slot.ts";

/** Opt-in switch for Google Antigravity counting; only the value `1` enables it. */
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
    // Loaded on first count so provider activation stays as light as before.
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

/** Offer the counter for `google` owner models; returns its unregister. */
export function registerAntigravityCompactionTokenCounter(): () => void {
  return registerCompactionTokenCounter(PROVIDER_ID, antigravityCompactionTokenCounter);
}
