/**
 * Static support policy for xAI server-side compaction.
 *
 * Eligible: Pi's built-in `xai` provider on the `openai-responses` API at the
 * first-party endpoint `https://api.x.ai/v1`, a `grok-` model, and either auth
 * mode (OAuth and API keys both reach api.x.ai). Nothing is probed over the
 * network. Failures cool the combination down through the shared gate.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  AnthropicCapabilityGate,
  type AnthropicSupportEntry,
  normalizeBaseUrl,
} from "../anthropic/capability.ts";
import type { ProviderScope } from "../background/contract.ts";
import type { XaiAuthMode } from "./details.ts";

export const XAI_PROVIDER = "xai";
export const XAI_API = "openai-responses";
export const XAI_FIRST_PARTY_HOST = "api.x.ai";
const MODEL_PREFIX = "grok-";
/** xAI API keys carry this prefix; any other bearer credential is treated as OAuth. */
const API_KEY_PREFIX = "xai-";

export function xaiAuthModeOf(apiKey: string | undefined): XaiAuthMode | undefined {
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return apiKey.startsWith(API_KEY_PREFIX) ? "api-key" : "oauth";
}

function firstPartyHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === XAI_FIRST_PARTY_HOST;
  } catch {
    return false;
  }
}

/** The default policy: provider, host and model family; any auth mode. */
export function xaiSupportPolicy(scope: ProviderScope): AnthropicSupportEntry | undefined {
  const { authMode, baseUrl } = scope;
  if (authMode !== "oauth" && authMode !== "api-key") return undefined;
  if (baseUrl === undefined || scope.provider !== XAI_PROVIDER) return undefined;
  if (!firstPartyHost(baseUrl) || !scope.model.startsWith(MODEL_PREFIX)) return undefined;
  return {
    provider: XAI_PROVIDER,
    model: scope.model,
    baseUrl: normalizeBaseUrl(baseUrl),
    authMode,
  };
}

/** Whether a session model is an xAI Responses model this lane may serve (before auth). */
export function isXaiResponsesModel(model: Pick<Model<Api>, "api" | "provider">): boolean {
  return model.api === XAI_API && model.provider === XAI_PROVIDER;
}

export interface XaiGateOptions {
  readonly cooldownMs: number;
  /** Exact combinations replacing the default policy (tests, synthetic providers). */
  readonly allowList?: readonly AnthropicSupportEntry[];
  readonly now?: () => number;
}

/** The shared cooldown gate with the xAI policy. */
export function createXaiCapabilityGate(options: XaiGateOptions): AnthropicCapabilityGate {
  return new AnthropicCapabilityGate({
    enabled: true,
    cooldownMs: options.cooldownMs,
    allowList: options.allowList,
    policy: xaiSupportPolicy,
    now: options.now,
  });
}

/** Providers whose Responses stream must be captured for replay under a policy. */
export function xaiCapturedProviders(allowList?: readonly AnthropicSupportEntry[]): string[] {
  if (allowList === undefined) return [XAI_PROVIDER];
  return [...new Set(allowList.map((entry) => entry.provider))];
}

/** Whether the gate's static policy admits a model under either auth mode (no I/O, no credentials). */
export function xaiGateAdmitsModel(
  gate: AnthropicCapabilityGate,
  model: Pick<Model<Api>, "provider" | "id" | "baseUrl">,
): boolean {
  const candidate = { provider: model.provider, model: model.id, baseUrl: model.baseUrl };
  return (["api-key", "oauth"] as const).some(
    (authMode) => gate.match({ ...candidate, authMode }) !== undefined,
  );
}
