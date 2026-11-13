import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { codexBackgroundAccountScope } from "../../../choco-pi-codex/src/adapter/compaction/background-v2.ts";
import { extractAccountId } from "../../../choco-pi-codex/src/providers/openai-codex/headers.ts";
import { ANTHROPIC_BACKEND_ID } from "../anthropic/backend.ts";
import { authModeOf } from "../anthropic/capability.ts";
import type { BackgroundCompactionSettings, ProviderScope } from "../background/contract.ts";
import { CODEX_BACKEND_SETTING_ID, isBackendEnabled } from "../background/settings.ts";

type AuthRegistry = Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;

/**
 * Provider scope of a session model: provider, model, endpoint and, when the
 * matching native backend is switched on, the auth mode (Anthropic) or the
 * hashed Codex account. Credentials are read in memory and never kept.
 */
export async function resolveProviderScope(
  model: Model<Api>,
  registry: AuthRegistry,
  settings: Readonly<BackgroundCompactionSettings>,
): Promise<ProviderScope> {
  const scope: ProviderScope = { provider: model.provider, model: model.id };
  if (model.baseUrl.length > 0) scope.baseUrl = model.baseUrl;
  if (isBackendEnabled(ANTHROPIC_BACKEND_ID, settings) && model.api === "anthropic-messages") {
    await bindAnthropicAuthMode(scope, model, registry);
  }
  if (isBackendEnabled(CODEX_BACKEND_SETTING_ID, settings) && model.provider === "openai-codex") {
    await bindCodexAccount(scope, model, registry);
  }
  return scope;
}

/** The key is inspected in memory for its auth mode only, never kept. */
async function bindAnthropicAuthMode(
  scope: ProviderScope,
  model: Model<Api>,
  registry: AuthRegistry,
): Promise<void> {
  const auth = await registry.getApiKeyAndHeaders(model);
  const mode = auth.ok ? authModeOf(auth.apiKey) : undefined;
  if (mode !== undefined) scope.authMode = mode;
}

/**
 * Codex scopes carry a non-secret hash of the OAuth account ID; the raw token
 * and account ID are never kept. Without one the Codex backend's capability
 * check refuses every candidate (fail closed).
 */
async function bindCodexAccount(
  scope: ProviderScope,
  model: Model<Api>,
  registry: AuthRegistry,
): Promise<void> {
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || auth.apiKey === undefined || auth.apiKey.length === 0) return;
  const accountId = readCodexAccountId(auth.apiKey);
  if (accountId === undefined) return;
  scope.authMode = "oauth";
  scope.accountScope = codexBackgroundAccountScope(accountId);
  const baseUrl = auth.baseUrl ?? model.baseUrl;
  if (baseUrl.length > 0) scope.baseUrl = baseUrl;
}

function readCodexAccountId(apiKey: string): string | undefined {
  try {
    return extractAccountId(apiKey);
  } catch {
    // Not a Codex OAuth token: leave the scope unbound to an account.
    return undefined;
  }
}
