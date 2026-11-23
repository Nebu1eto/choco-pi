import type { Api, Model } from "@earendil-works/pi-ai";

import {
  AnthropicCapabilityGate,
  type AnthropicSupportEntry,
  type CooldownObserver,
  normalizeBaseUrl,
} from "../anthropic/capability.ts";
import { type BearerAuth, bearerCredentialOf } from "../auth.ts";
import type { ProviderScope } from "../background/contract.ts";
import type { XaiAuthMode } from "./details.ts";

export const XAI_PROVIDER = "xai";
export const XAI_API = "openai-responses";
export const XAI_FIRST_PARTY_HOST = "api.x.ai";
const MODEL_PREFIX = "grok-";
const API_KEY_PREFIX = "xai-";

export function xaiAuthModeOf(apiKey: string | undefined): XaiAuthMode | undefined {
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return apiKey.startsWith(API_KEY_PREFIX) ? "api-key" : "oauth";
}

export function xaiAuthModeFromAuth(auth: BearerAuth): XaiAuthMode | undefined {
  return xaiAuthModeOf(bearerCredentialOf(auth));
}

function firstPartyHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === XAI_FIRST_PARTY_HOST;
  } catch {
    return false;
  }
}

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

export function isXaiResponsesModel(model: Pick<Model<Api>, "api" | "provider">): boolean {
  return model.api === XAI_API && model.provider === XAI_PROVIDER;
}

export interface XaiGateOptions {
  readonly cooldownMs: number;
  readonly allowList?: readonly AnthropicSupportEntry[];
  readonly now?: () => number;
  readonly onCooldown?: CooldownObserver;
}

export function createXaiCapabilityGate(options: XaiGateOptions): AnthropicCapabilityGate {
  return new AnthropicCapabilityGate({
    enabled: true,
    cooldownMs: options.cooldownMs,
    allowList: options.allowList,
    policy: xaiSupportPolicy,
    now: options.now,
    onCooldown: options.onCooldown,
  });
}

export function xaiCapturedProviders(allowList?: readonly AnthropicSupportEntry[]): string[] {
  if (allowList === undefined) return [XAI_PROVIDER];
  return [...new Set(allowList.map((entry) => entry.provider))];
}

export function xaiGateAdmitsModel(
  gate: AnthropicCapabilityGate,
  model: Pick<Model<Api>, "provider" | "id" | "baseUrl">,
): boolean {
  const candidate = { provider: model.provider, model: model.id, baseUrl: model.baseUrl };
  return (["api-key", "oauth"] as const).some(
    (authMode) => gate.match({ ...candidate, authMode }) !== undefined,
  );
}
