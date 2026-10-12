import { join } from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";

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
