import type { Api, Model } from "@earendil-works/pi-ai";

export const OPENAI_PLATFORM_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_SIGN_IN_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

export const OPENAI_SIGN_IN_FAST_REASON =
  "accepted but not honored by api.openai.com subscription sign-in";
export const OPENAI_SIGN_IN_DAYBREAK_REASON =
  "not controllable on api.openai.com (no account id, no entitlement endpoint); server echo is not a grant";
export const OPENAI_SIGN_IN_COMPACTION_REASON =
  "server-side compaction is unavailable on api.openai.com subscription sign-in; local compaction is used";
export const OPENAI_SIGN_IN_USAGE_REASON =
  "ChatGPT usage window is unavailable for openai sign-in (api.openai.com exposes no usage endpoint)";

export interface OpenAISignInModel {
  provider?: string | undefined;
  baseUrl?: string | undefined;
}

export interface OAuthAwareModelRegistry {
  isUsingOAuth(model: Model<Api>): boolean;
}

function normalizedBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function isOpenAIPlatformModel(model: OpenAISignInModel | null | undefined): boolean {
  return (
    (model?.provider ?? "").trim().toLowerCase() === "openai" &&
    normalizedBaseUrl(model?.baseUrl) === OPENAI_PLATFORM_BASE_URL
  );
}

export function isOpenAISubscriptionSignInModel(
  model: Model<Api> | null | undefined,
  registry: OAuthAwareModelRegistry | null | undefined,
): boolean {
  if (!model || !registry || !isOpenAIPlatformModel(model)) return false;
  try {
    return registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

export function isOpenAISignInUsageLimitError(message: string | null | undefined): boolean {
  return (message ?? "").includes(OPENAI_SIGN_IN_USAGE_LIMIT_CODE);
}
