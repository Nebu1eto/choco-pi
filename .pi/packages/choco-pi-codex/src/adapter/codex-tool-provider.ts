import { conditionalProperties } from "./runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { DEFAULT_CODEX_BASE_URL } from "../providers/openai-codex/constants.ts";
import { extractAccountId } from "../providers/openai-codex/headers.ts";
import {
  isCanonicalCodexAliasModel,
  isCanonicalCodexBaseUrl,
  isCanonicalCodexSubscriptionModel,
  isCodexTransportModel,
  isOpenAICodexModel,
} from "./prompt/codex-model.ts";

export const CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE =
  "web_run/imagegen requires an OpenAI Codex-compatible Responses provider or /login openai-codex";

export interface CodexToolProvider {
  route: "openai-codex" | "configured-responses";
  baseUrl: string;
  responsesUrl: string;
  searchUrl: string;
  model: string | undefined;
  token: string;
  accountId: string;
}

export type CodexToolProviderErrorKind = "missing_credentials" | "auth" | "config";

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
>;

export interface CodexToolProviderContext {
  model: ExtensionContext["model"];
  modelRegistry: CodexToolProviderModelRegistry;
}

export type AllowConfiguredCodexToolProvider = (model: ExtensionContext["model"]) => boolean;

const CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_PROVIDER = "openai-codex";

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

function resolveOpenAICodexAuthModel(
  registry: CodexToolProviderModelRegistry,
  preferredModelId?: string | undefined,
): Model<Api> | undefined {
  const direct = preferredModelId
    ? registry.find(OPENAI_CODEX_PROVIDER, preferredModelId)
    : undefined;
  if (isUsableOpenAICodexModel(direct)) return direct;
  const preferred = [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ]
    .map((id) => registry.find(OPENAI_CODEX_PROVIDER, id))
    .find((model): model is Model<Api> => isUsableOpenAICodexModel(model));
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
  if (model && isResponsesModel(model) && allowConfiguredProvider?.(model)) return model;
  const openAICodexModel = resolveOpenAICodexAuthModel(ctx.modelRegistry, ctx.model?.id);
  if (openAICodexModel) return openAICodexModel;
  throw new CodexToolProviderError(
    "missing_credentials",
    `${CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE}; run /login openai-codex or select an OpenAI Codex-compatible provider`,
  );
}

function resolveConfiguredResponsesUrl(modelBaseUrl: string | undefined): string {
  const base = modelBaseUrl?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Configured Responses provider is missing a base URL");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

export async function resolveCodexToolProvider(
  ctx: CodexToolProviderContext,
  allowConfiguredProvider?: AllowConfiguredCodexToolProvider,
): Promise<CodexToolProvider> {
  const model = resolveCodexToolAuthModel(ctx, allowConfiguredProvider);
  return resolveCodexToolProviderForModel(ctx.modelRegistry, model);
}

/** Resolve only the canonical OpenAI Codex subscription transport.
 *
 * The conversation model is deliberately not accepted: callers on Anthropic,
 * Synthetic, or arbitrary Responses proxies must never forward that provider's
 * credential to the native OpenAI search helper.
 */
export async function resolveOpenAICodexToolProvider(
  modelRegistry: CodexToolProviderModelRegistry,
): Promise<CodexToolProvider> {
  const model = resolveOpenAICodexAuthModel(modelRegistry);
  if (!model) {
    throw new CodexToolProviderError(
      "missing_credentials",
      `${CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE}; run /login openai-codex`,
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
  return {
    route: codexTransport ? "openai-codex" : "configured-responses",
    baseUrl,
    responsesUrl,
    searchUrl: resolveCodexSearchUrl(responsesUrl),
    model: model.id,
    token,
    accountId:
      headerValue(auth.headers, "chatgpt-account-id") ??
      (codexTransport ? extractAccountId(token) : ""),
  };
}

export function codexToolProviderHeaders(provider: CodexToolProvider): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${provider.token}`);
  headers.set("ChatGPT-Account-ID", provider.accountId);
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
