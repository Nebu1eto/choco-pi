import { conditionalProperties } from "./runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { DEFAULT_CODEX_BASE_URL } from "../providers/openai-codex/constants.ts";
import { extractAccountId } from "../providers/openai-codex/headers.ts";
import {
  OPENAI_PLATFORM_BASE_URL,
  isOpenAIPlatformModel,
  isOpenAISubscriptionSignInModel,
} from "./openai-sign-in.ts";
import {
  isCanonicalCodexAliasModel,
  isCanonicalCodexBaseUrl,
  isCanonicalCodexSubscriptionModel,
  isCodexTransportModel,
  isOpenAICodexModel,
} from "./prompt/codex-model.ts";

export const CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE =
  "web_run/imagegen requires an OpenAI Responses provider or /login openai (Sign in with ChatGPT)";

/** Login guidance: provider `openai` first; `openai-codex` remains an opt-in legacy route. */
export const CODEX_TOOL_PROVIDER_LOGIN_HINT =
  "run /login openai (Sign in with ChatGPT) or configure an openai API key; legacy fallback: /login openai-codex";

/**
 * The bundled web_run helper only calls the ChatGPT backend `/alpha/search`
 * route with a ChatGPT account id. api.openai.com serves neither, so the
 * `openai` credential must never be handed to it.
 */
export const OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON =
  "web_run needs the ChatGPT backend /alpha/search route, which api.openai.com does not serve; provider openai (Sign in with ChatGPT or API key) cannot run native web_run. Select an openai-codex (legacy) model to use it";

export interface CodexToolProvider {
  route: "openai-codex" | "configured-responses";
  baseUrl: string;
  responsesUrl: string;
  searchUrl: string;
  model: string | undefined;
  token: string;
  accountId: string;
  /** Present only for the stock `openai` provider on api.openai.com. */
  openAIPlatform?: { subscriptionSignIn: boolean };
}

export type CodexToolProviderErrorKind = "missing_credentials" | "auth" | "config" | "unsupported";

/** `search` needs the ChatGPT backend search route; `responses` needs a Responses/Images endpoint. */
export type CodexToolCapability = "responses" | "search";

export interface CodexToolProviderOptions {
  capability?: CodexToolCapability | undefined;
}

export class CodexToolProviderError extends Error {
  readonly kind: CodexToolProviderErrorKind;

  constructor(kind: CodexToolProviderErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexToolProviderError";
    this.kind = kind;
  }
}

export type CodexToolProviderModelRegistry = Pick<
  ModelRegistry,
  "find" | "getAvailable" | "getAll" | "getApiKeyAndHeaders"
> &
  Partial<Pick<ModelRegistry, "isUsingOAuth">>;

export interface CodexToolProviderContext {
  model: ExtensionContext["model"];
  modelRegistry: CodexToolProviderModelRegistry;
}

export type AllowConfiguredCodexToolProvider = (model: ExtensionContext["model"]) => boolean;

const CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";
const PREFERRED_TOOL_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

export function resolveCodexApiProviderBaseUrl(modelBaseUrl: string | undefined): string {
  const base = modelBaseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
  const normalized = base.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (url.pathname === "" || url.pathname === "/") return `${normalized}/api/codex`;
  } catch {
    // Keep string-only fallback below.
  }
  if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
  if (normalized.endsWith("/codex")) return normalized;
  if (normalized.endsWith("/backend-api") || normalized.endsWith("/api"))
    return `${normalized}/codex`;
  return normalized;
}

export function resolveCodexResponsesUrl(providerBaseUrl: string): string {
  const base = providerBaseUrl.replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  return `${resolveCodexApiProviderBaseUrl(base)}/responses`;
}

export function resolveCodexSearchUrl(providerBaseUrl: string): string {
  const normalized = providerBaseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/alpha/search")) return normalized;
  const base = normalized.endsWith("/responses")
    ? normalized.slice(0, -"/responses".length)
    : resolveCodexApiProviderBaseUrl(normalized);
  return `${base}/alpha/search`;
}

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName)
      return Value.Check(Type.String(), value) ? value : undefined;
  }
  return undefined;
}

function isResponsesModel(model: ExtensionContext["model"]): boolean {
  return Boolean(model?.api?.includes("responses"));
}

function isUsableOpenAICodexModel(model: ExtensionContext["model"]): boolean {
  return isOpenAICodexModel(model) && isResponsesModel(model);
}

function firstOpenAICodexModel(models: Model<Api>[]): Model<Api> | undefined {
  return models.find(isUsableOpenAICodexModel);
}

function isUsableOpenAIPlatformModel(model: ExtensionContext["model"]): boolean {
  return isOpenAIPlatformModel(model) && isResponsesModel(model);
}

/**
 * Resolve a stock `openai` model on api.openai.com whose provider has
 * configured auth (ChatGPT sign-in or API key). `getAvailable()` lists only
 * models with configured auth, so membership is the auth check.
 */
export function resolveOpenAIPlatformAuthModel(
  registry: Pick<CodexToolProviderModelRegistry, "find" | "getAvailable">,
  preferredModelId?: string | undefined,
): Model<Api> | undefined {
  const available = registry.getAvailable().filter((model) => isUsableOpenAIPlatformModel(model));
  if (available.length === 0) return undefined;
  const ids = preferredModelId
    ? [preferredModelId, ...PREFERRED_TOOL_MODEL_IDS]
    : PREFERRED_TOOL_MODEL_IDS;
  for (const id of ids) {
    const found = registry.find(OPENAI_PROVIDER, id);
    if (
      found &&
      isUsableOpenAIPlatformModel(found) &&
      available.some((model) => model.id === found.id)
    )
      return found;
  }
  return available[0];
}

function resolveOpenAICodexAuthModel(
  registry: CodexToolProviderModelRegistry,
  preferredModelId?: string | undefined,
): Model<Api> | undefined {
  const direct = preferredModelId
    ? registry.find(OPENAI_CODEX_PROVIDER, preferredModelId)
    : undefined;
  if (isUsableOpenAICodexModel(direct)) return direct;
  const preferred = PREFERRED_TOOL_MODEL_IDS.map((id) =>
    registry.find(OPENAI_CODEX_PROVIDER, id),
  ).find((model): model is Model<Api> => isUsableOpenAICodexModel(model));
  if (preferred) return preferred;
  const available = firstOpenAICodexModel(registry.getAvailable());
  return available ?? firstOpenAICodexModel(registry.getAll());
}

function resolveCodexToolAuthModel(
  ctx: CodexToolProviderContext,
  allowConfiguredProvider?: AllowConfiguredCodexToolProvider,
): Model<Api> {
  const model = ctx.model;
  if (model && isCodexTransportModel(model) && isResponsesModel(model)) return model;
  if (model && isUsableOpenAIPlatformModel(model)) return model;
  if (model && isResponsesModel(model) && allowConfiguredProvider?.(model)) return model;
  const openAIModel = resolveOpenAIPlatformAuthModel(ctx.modelRegistry, ctx.model?.id);
  if (openAIModel) return openAIModel;
  const openAICodexModel = resolveOpenAICodexAuthModel(ctx.modelRegistry, ctx.model?.id);
  if (openAICodexModel) return openAICodexModel;
  throw new CodexToolProviderError(
    "missing_credentials",
    `${CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE}; ${CODEX_TOOL_PROVIDER_LOGIN_HINT}`,
  );
}

function assertCapability(model: Model<Api>, capability: CodexToolCapability | undefined): void {
  // Fail before credentials are resolved so the openai token is never sent to a route it cannot use.
  if (capability === "search" && isOpenAIPlatformModel(model))
    throw new CodexToolProviderError("unsupported", OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON);
}

function resolveConfiguredResponsesUrl(modelBaseUrl: string | undefined): string {
  const base = modelBaseUrl?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Configured Responses provider is missing a base URL");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

export async function resolveCodexToolProvider(
  ctx: CodexToolProviderContext,
  allowConfiguredProvider?: AllowConfiguredCodexToolProvider,
  options: CodexToolProviderOptions = {},
): Promise<CodexToolProvider> {
  const model = resolveCodexToolAuthModel(ctx, allowConfiguredProvider);
  assertCapability(model, options.capability);
  return resolveCodexToolProviderForModel(ctx.modelRegistry, model);
}

/** Resolve credentials for the native OpenAI search helper.
 *
 * The conversation model is deliberately not accepted: callers on Anthropic,
 * Synthetic, or arbitrary Responses proxies must never forward that provider's
 * credential to the native OpenAI search helper.
 *
 * A configured `openai` provider takes precedence and is rejected as
 * `unsupported` (api.openai.com has no search route) without touching the
 * legacy `openai-codex` credential; that legacy chain is used only when
 * `openai` is not configured.
 */
export async function resolveOpenAICodexToolProvider(
  modelRegistry: CodexToolProviderModelRegistry,
): Promise<CodexToolProvider> {
  const openAIModel = resolveOpenAIPlatformAuthModel(modelRegistry);
  if (openAIModel) assertCapability(openAIModel, "search");
  const model = resolveOpenAICodexAuthModel(modelRegistry);
  if (!model) {
    throw new CodexToolProviderError(
      "missing_credentials",
      `${CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE}; ${CODEX_TOOL_PROVIDER_LOGIN_HINT}`,
    );
  }
  return resolveCodexToolProviderForModel(modelRegistry, model, true);
}

async function resolveCodexToolProviderForModel(
  modelRegistry: CodexToolProviderModelRegistry,
  model: Model<Api>,
  requireOpenAI: boolean = false,
): Promise<CodexToolProvider> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new CodexToolProviderError("auth", auth.error);
  const resolvedBaseUrl = auth.baseUrl ?? model.baseUrl;
  const stockOpenAICodex = isOpenAICodexModel(model);
  const canonicalSubscription = isCanonicalCodexSubscriptionModel({
    ...model,
    baseUrl: resolvedBaseUrl,
  });
  const canonicalAlias = isCanonicalCodexAliasModel(model);
  if (canonicalAlias && !isCanonicalCodexBaseUrl(resolvedBaseUrl)) {
    throw new CodexToolProviderError(
      "config",
      "Canonical OpenAI Codex subscription auth is required.",
    );
  }
  const codexTransport = stockOpenAICodex || canonicalSubscription;
  if (requireOpenAI && (!codexTransport || !isCanonicalCodexBaseUrl(resolvedBaseUrl))) {
    throw new CodexToolProviderError(
      "config",
      "Resolved credential is not a canonical OpenAI Codex subscription.",
    );
  }
  const authorization = headerValue(auth.headers, "Authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  const token = codexTransport ? (auth.apiKey ?? authorization) : (authorization ?? auth.apiKey);
  if (!token)
    throw new CodexToolProviderError(
      "missing_credentials",
      CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE,
    );
  const baseUrl = codexTransport
    ? resolveCodexApiProviderBaseUrl(resolvedBaseUrl)
    : resolvedBaseUrl?.trim().replace(/\/+$/, "");
  if (!baseUrl)
    throw new CodexToolProviderError(
      "config",
      "Configured Responses provider is missing a base URL",
    );
  const responsesUrl = codexTransport
    ? resolveCodexResponsesUrl(baseUrl)
    : resolveConfiguredResponsesUrl(baseUrl);
  const openAIPlatform =
    !codexTransport &&
    isOpenAIPlatformModel(model) &&
    baseUrl.replace(/\/+$/, "") === OPENAI_PLATFORM_BASE_URL;
  return {
    route: codexTransport ? "openai-codex" : "configured-responses",
    baseUrl,
    responsesUrl,
    searchUrl: resolveCodexSearchUrl(responsesUrl),
    model: model.id,
    token,
    // api.openai.com has no ChatGPT account scope; never forward one there.
    accountId: openAIPlatform
      ? ""
      : (headerValue(auth.headers, "chatgpt-account-id") ??
        (codexTransport ? extractAccountId(token) : "")),
    ...conditionalProperties(openAIPlatform, {
      openAIPlatform: {
        subscriptionSignIn: isOpenAISubscriptionSignInModel(model, {
          isUsingOAuth: (candidate) => modelRegistry.isUsingOAuth?.(candidate) ?? false,
        }),
      },
    }),
  };
}

export function codexToolProviderHeaders(provider: CodexToolProvider): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${provider.token}`);
  if (!provider.openAIPlatform) headers.set("ChatGPT-Account-ID", provider.accountId);
  headers.set("originator", CODEX_ORIGINATOR);
  headers.set("User-Agent", codexWebRunUserAgent(CODEX_ORIGINATOR));
  headers.set("version", "0.0.0");
  headers.set("content-type", "application/json");
  return headers;
}

export function codexWebRunUserAgent(originator: string = CODEX_ORIGINATOR): string {
  const platform =
    process.platform === "darwin"
      ? "Mac OS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;
  const release = "unknown";
  const arch = process.arch === "arm64" ? "arm64" : process.arch;
  const terminal = process.env["TERM_PROGRAM"]?.trim() || process.env["TERM"]?.trim() || "unknown";
  return `${originator}/0.0.0 (${platform} ${release}; ${arch}) ${terminal}`;
}

export function codexToolProviderEnv(provider: CodexToolProvider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODEX_ACCESS_TOKEN: provider.token,
    PI_CODEX_ACCOUNT_ID: provider.accountId,
    PI_CODEX_BASE_URL: provider.baseUrl,
    PI_CODEX_RESPONSES_URL: provider.responsesUrl,
    PI_CODEX_SEARCH_URL: provider.searchUrl,
    ...conditionalProperties(Boolean(provider.model), { PI_CODEX_MODEL: provider.model }),
  };
  if (provider.route === "configured-responses") delete env["PI_CODEX_AGENT_IDENTITY_JWT"];
  return env;
}
