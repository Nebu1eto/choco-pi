import type { Api, Model } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "../config.ts";

/** The synchronous slice of Pi's ModelRegistry that reports how `google` is signed in. */
export interface AntigravitySignInRegistry {
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string | undefined };
  getAll(): readonly Model<Api>[];
  isUsingOAuth(model: Model<Api>): boolean;
}

/**
 * Whether Pi holds a stored OAuth credential for `google`, the only credential this provider
 * accepts. Pi's inherited Gemini API-key auth also reports `google` as configured (a stored API
 * key, a runtime key or GEMINI_API_KEY); none of those counts. Reads auth status only, never a
 * credential, and makes no network call. Any registry failure reads as not signed in.
 */
export function hasAntigravitySignIn(registry: AntigravitySignInRegistry | undefined): boolean {
  if (registry === undefined) return false;
  try {
    const status = registry.getProviderAuthStatus(PROVIDER_ID);
    if (!status.configured || status.source !== "stored") return false;
    const model = registry.getAll().find((candidate) => candidate.provider === PROVIDER_ID);
    return model !== undefined && registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}
