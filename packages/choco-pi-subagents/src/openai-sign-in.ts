import type { Api, Model } from "@earendil-works/pi-ai";

export const OPENAI_PLATFORM_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_SIGN_IN_FAST_REASON =
  "accepted but not honored by api.openai.com subscription sign-in";
export const OPENAI_SIGN_IN_DAYBREAK_REASON =
  "not controllable on api.openai.com (no account id, no entitlement endpoint); server echo is not a grant";
export const OPENAI_SIGN_IN_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

export interface OAuthStatusRegistry {
  isUsingOAuth?(model: Model<Api>): boolean;
}

export function isOpenAISubscriptionSignIn(
  model: Model<Api> | undefined,
  registry: OAuthStatusRegistry | undefined,
): boolean {
  if (model === undefined || registry?.isUsingOAuth === undefined) return false;
  if (model.provider !== "openai") return false;
  if ((model.baseUrl ?? "").replace(/\/+$/, "") !== OPENAI_PLATFORM_BASE_URL) return false;
  try {
    return registry.isUsingOAuth(model) === true;
  } catch {
    return false;
  }
}
