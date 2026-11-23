import type { Api, Model } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "../config.ts";

export interface AntigravitySignInRegistry {
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string | undefined };
  getAll(): readonly Model<Api>[];
  isUsingOAuth(model: Model<Api>): boolean;
}

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
