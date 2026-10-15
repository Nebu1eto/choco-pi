import { join } from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  readStoredCredential,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";

/** An OAuth token closer than this to expiry would need a refresh, which E2E prohibits. */
const MIN_TOKEN_LIFETIME_MS = 20 * 60_000;

/**
 * Mirrors the user's refreshed catalog entry for `anthropic/claude-haiku-5-5`
 * (absent from the installed SDK's built-in catalog). Seeded into the
 * launcher's in-memory models store only; no catalog network refresh.
 */
export const LIVE_HAIKU_MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
  promptCache: { short: 300, long: 3600 },
};

/**
 * Mirrors the user's refreshed catalog entry for `anthropic/claude-fable-5-1`
 * (`<agent dir>/models-store.json`; absent from the installed SDK's built-in
 * catalog). Typed fields only; seeded like {@link LIVE_HAIKU_MODEL}.
 */
export const LIVE_FABLE_MODEL: Model<"anthropic-messages"> = {
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsStrictTools: true,
  },
  promptCache: { short: 300, long: 3600 },
};

/**
 * Mirrors the user's refreshed catalog entry for `openai-codex/gpt-6-luna`
 * (`<agent dir>/models-store.json`; absent from the installed SDK's built-in
 * catalog). Its 272K window is the catalog value; the worktree `.pi/models.json`
 * override raises it to 1,050,000 when a launch applies that file.
 */
export const LIVE_LUNA_MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
  },
};

/**
 * The user's refreshed Synthetic catalog entry for `synthetic/hf:moonshotai/Kimi-K3`
 * (Synthetic models API, cached in `<agent dir>/models-store.json` within its
 * 4h TTL on 2026-10-14: context_length 524,288, max output 65,536, $3/$15 per
 * MTok). Synthetic is an extension provider, not a built-in one, so a seeded
 * store entry resolves to nothing before the extension loads; the launcher
 * registers this mirror of `registerSyntheticProvider`'s static fields first,
 * and the real provider extension re-registers over it when it loads.
 *
 * `hf:zai-org/GLM-5.3` mirrors the provider package's static catalog entry
 * (`extensions/provider/models.ts`: 524,288 window, 65,536 output, $1.4/$4.4 per
 * MTok, reasoning always on with `high`/`max` only) with the package's
 * `applyDefaultCompat` defaults (`supportsDeveloperRole: false`,
 * `maxTokensField: "max_tokens"`).
 */
export const LIVE_SYNTHETIC_PROVIDER: ProviderConfig = {
  baseUrl: "https://api.synthetic.new/openai/v1",
  apiKey: "$SYNTHETIC_API_KEY",
  api: "openai-completions",
  headers: { Referer: "https://pi.dev", "X-Title": "@choco-pi/provider-synthetic" },
  models: [
    {
      id: "hf:moonshotai/Kimi-K3",
      name: "moonshotai/Kimi-K3",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.45, cacheWrite: 0 },
      contextWindow: 524_288,
      maxTokens: 65_536,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        supportsReasoningEffort: true,
      },
    },
    {
      id: "hf:zai-org/GLM-5.3",
      name: "zai-org/GLM-5.3",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      contextWindow: 524_288,
      maxTokens: 65_536,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        supportsReasoningEffort: true,
      },
    },
  ],
};

/** Extension-owned live providers, registered before the live model is resolved. */
export const LIVE_PROVIDER_MIRRORS: ReadonlyMap<string, ProviderConfig> = new Map([
  ["synthetic", LIVE_SYNTHETIC_PROVIDER],
]);

/** Live subjects seeded into the isolated in-memory models store. */
export const LIVE_SEEDED_MODELS: readonly Model<Api>[] = [
  LIVE_HAIKU_MODEL,
  LIVE_FABLE_MODEL,
  LIVE_LUNA_MODEL,
];

export interface LiveSpec {
  readonly provider: string;
  readonly modelId: string;
}

export function parseLiveSpec(spec: string): LiveSpec {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error("Live model must be provider/model");
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** The real agent dir, resolved before a launcher scopes PI_CODING_AGENT_DIR. */
export function sourceAgentDir(): string {
  return getAgentDir();
}

/**
 * Reads the provider credential once through the public read-only SDK API. The
 * result is memory-only: never written, refreshed, logged or persisted.
 */
export function readLiveCredential(provider: string, agentDir: string): Credential {
  const credential = readStoredCredential(provider, join(agentDir, "auth.json"));
  if (!credential) throw new Error(`No stored credential for ${provider}`);
  if (credential.type === "oauth" && credential.expires - Date.now() < MIN_TOKEN_LIFETIME_MS)
    throw new Error(`Stored ${provider} OAuth token near expiry; refresh is prohibited in E2E`);
  return credential;
}

export function isAnthropicModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/** Strings that must never reach an artifact. */
export function credentialSecrets(credential: Credential): string[] {
  if (credential.type === "oauth") return [credential.access, credential.refresh];
  return credential.key ? [credential.key] : [];
}
