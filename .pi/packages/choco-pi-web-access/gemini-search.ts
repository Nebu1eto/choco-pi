import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CredentialResolutionError } from "./credential-source.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./search-types.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export const RESOLVED_SEARCH_PROVIDERS = ["openai", "exa", "kagi"] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = (typeof RESOLVED_SEARCH_PROVIDERS)[number];
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type SearchProviderErrorKind =
  | "transient"
  | "quota"
  | "network"
  | "credential"
  | "config"
  | "auth"
  | "invalid-request"
  | "invalid-response"
  | "aborted"
  | "unknown";

export interface SearchRoutingConfig {
  providers: ResolvedSearchProvider[];
  fallbackOn: Array<
    Extract<SearchProviderErrorKind, "transient" | "quota" | "network" | "invalid-response">
  >;
}

export class SearchProviderError extends Error {
  readonly provider: ResolvedSearchProvider;
  readonly kind: SearchProviderErrorKind;
  readonly status?: number;
  readonly causeError: unknown;

  constructor(
    provider: ResolvedSearchProvider,
    kind: SearchProviderErrorKind,
    message: string,
    status: number | undefined,
    cause: unknown,
  ) {
    super(`${provider} search failed (${kind}): ${message}`);
    this.name = "SearchProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.causeError = cause;
  }
}

export interface ProviderSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
  provider: ResolvedSearchProvider;
  error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider | "all";
  providerResponses?: ProviderSearchResponse[];
  providerErrors?: ProviderSearchFailure[];
}

const CONFIG_PATH = getWebSearchConfigPath();
const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = [...RESOLVED_SEARCH_PROVIDERS];
const VALID_ROUTING_KINDS = ["transient", "quota", "network", "invalid-response"] as const;

type SearchConfig = {
  searchProvider: SearchProviderSelection;
  searchProviderConfigured: boolean;
  searchRouting?: SearchRoutingConfig;
};

type ConfigScalar = boolean | number | string | null;
type ConfigValue = ConfigScalar | ConfigObject | ConfigValue[];
interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();

function isConfigObject<Value>(value: Value): value is Value & ConfigObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function isResolvedSearchProvider(value: string): value is ResolvedSearchProvider {
  return RESOLVED_SEARCH_PROVIDERS.some((provider) => provider === value);
}

function isSearchProvider(value: string): value is SearchProvider {
  return SEARCH_PROVIDERS.some((provider) => provider === value);
}

function isFallbackKind(value: string): value is SearchRoutingConfig["fallbackOn"][number] {
  return VALID_ROUTING_KINDS.some((kind) => kind === value);
}

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
  if (cachedSearchConfig) return cachedSearchConfig;
  if (!existsSync(CONFIG_PATH)) {
    cachedSearchConfig = { searchProvider: "auto", searchProviderConfigured: false };
    return cachedSearchConfig;
  }

  const rawText = readFileSync(CONFIG_PATH, "utf-8");
  let raw: ConfigObject;
  try {
    const parsed: ConfigValue = JSON.parse(rawText);
    if (!isConfigObject(parsed)) throw new Error("expected a JSON object");
    raw = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }

  const searchProviderConfigured =
    Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
  cachedSearchConfig = {
    searchProvider: normalizeSearchProviderSelection(
      raw.searchProvider ?? raw.provider,
      `provider in ${CONFIG_PATH}`,
    ),
    searchProviderConfigured,
  };
  if (Object.hasOwn(raw, "searchRouting"))
    cachedSearchConfig.searchRouting = normalizeSearchRouting(raw.searchRouting);
  return cachedSearchConfig;
}

function normalizeSearchRouting<Value>(value: Value): SearchRoutingConfig {
  if (!isConfigObject(value)) {
    throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
  }
  const raw = value;
  const providers = normalizeResolvedProviderList(
    raw.providers,
    `searchRouting.providers in ${CONFIG_PATH}`,
  );
  if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
    throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
  }
  const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
  for (const kind of raw.fallbackOn) {
    if (!Check(StringValueSchema, kind) || !isFallbackKind(kind)) {
      throw new Error(
        `searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, network, or invalid-response`,
      );
    }
    if (!fallbackOn.includes(kind)) fallbackOn.push(kind);
  }
  return { providers, fallbackOn };
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
  const config = getSearchConfig();
  return config.searchProviderConfigured ? undefined : config.searchRouting;
}

function normalizeResolvedProviderList<Value>(
  value: Value,
  label: string,
): ResolvedSearchProvider[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const providers: ResolvedSearchProvider[] = [];
  for (const provider of value) {
    const normalized = Check(StringValueSchema, provider) ? provider.trim().toLowerCase() : "";
    if (!isResolvedSearchProvider(normalized)) {
      throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
    }
    if (providers.includes(normalized)) {
      throw new Error(`${label} must not contain duplicates: ${normalized}`);
    }
    providers.push(normalized);
  }
  return providers;
}

export function normalizeSearchProviderSelection<Value>(
  value: Value,
  label = "provider",
): SearchProviderSelection {
  if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
  const normalized = Check(StringValueSchema, value) ? value.trim().toLowerCase() : "";
  return isSearchProvider(normalized) ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
  provider?: SearchProviderSelection;
  includeContent?: boolean;
  extensionContext?: ExtensionContext;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isAbortError(cause: unknown): boolean {
  return errorMessage(cause).toLowerCase().includes("abort");
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
  if (options.recencyFilter) return false;
  if (
    Check(NumberValueSchema, options.numResults) &&
    Number.isFinite(options.numResults) &&
    Math.floor(options.numResults) !== 5
  )
    return false;
  return true;
}

function isOpenAICodexSelected(ctx?: ExtensionContext): boolean {
  return ctx?.model?.provider === "openai-codex";
}

async function tryOpenAIInAuto(
  query: string,
  options: FullSearchOptions,
  fallbackErrors: string[],
): Promise<AttributedSearchResponse | null> {
  if (!shouldTryOpenAIInAuto(options)) return null;
  try {
    if (await isOpenAISearchAvailable(options.extensionContext)) {
      const result = await searchWithOpenAI(query, options, options.extensionContext);
      return { ...result, provider: "openai" };
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    fallbackErrors.push(`OpenAI: ${errorMessage(err)}`);
  }
  return null;
}

function providerErrorStatus(message: string): number | undefined {
  const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

function classifyProviderError(
  provider: ResolvedSearchProvider,
  cause: unknown,
): SearchProviderError {
  if (cause instanceof SearchProviderError) return cause;
  const message = errorMessage(cause);
  const lower = message.toLowerCase();
  const status = providerErrorStatus(message);
  let kind: SearchProviderErrorKind = "unknown";
  if (
    cause instanceof CredentialResolutionError ||
    /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)
  )
    kind = "credential";
  else if (isAbortError(cause)) kind = "aborted";
  else if (status === 401 || status === 403) kind = "auth";
  else if (status === 400 || status === 422) kind = "invalid-request";
  else if (status === 402 || status === 429) kind = "quota";
  else if (status !== undefined && (status === 408 || status === 425 || status >= 500))
    kind = "transient";
  else if (/rate limit|quota|too many requests/.test(lower)) kind = "quota";
  else if (/unauthorized|forbidden|permission denied/.test(lower)) kind = "auth";
  else if (/bad request|invalid request/.test(lower)) kind = "invalid-request";
  else if (
    /invalid json|no parseable response|no parseable results|invalid response|returned empty response/.test(
      lower,
    )
  )
    kind = "invalid-response";
  else if (/temporar|service unavailable|server error/.test(lower)) kind = "transient";
  else if (
    cause instanceof TypeError ||
    /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)
  )
    kind = "network";
  else if (
    /invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)
  )
    kind = "config";
  return new SearchProviderError(provider, kind, message, status, cause);
}

async function searchWithResolvedProvider(
  provider: ResolvedSearchProvider,
  query: string,
  options: FullSearchOptions,
): Promise<ProviderSearchResponse> {
  if (provider === "openai")
    return { ...(await searchWithOpenAI(query, options, options.extensionContext)), provider };
  if (provider === "kagi") return { ...(await searchWithKagi(query, options)), provider };
  const result = await searchWithExa(query, options);
  if (result) return { ...result, provider };
  throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(
  provider: ResolvedSearchProvider,
  options: FullSearchOptions,
): Promise<boolean> {
  if (provider === "openai") return isOpenAISearchAvailable(options.extensionContext);
  if (provider === "kagi") return isKagiAvailable();
  return isExaAvailable();
}

function providerLabel(provider: ResolvedSearchProvider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "kagi") return "Kagi";
  return "Exa";
}

async function searchWithProviders(
  query: string,
  options: FullSearchOptions,
  selectedProviders?: ResolvedSearchProvider[],
): Promise<AttributedSearchResponse> {
  const providers =
    selectedProviders ??
    (
      await Promise.all(
        ALL_SEARCH_PROVIDERS.map(async (provider) => ({
          provider,
          available: await isResolvedProviderAvailable(provider, options),
        })),
      )
    )
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
  if (providers.length === 0)
    throw new Error('No configured search provider available for provider "all".');

  const settled = await Promise.allSettled(
    providers.map((provider) => searchWithResolvedProvider(provider, query, options)),
  );
  if (options.signal?.aborted) throw new Error("Aborted");
  const successes: ProviderSearchResponse[] = [];
  const failures: ProviderSearchFailure[] = [];
  for (let index = 0; index < settled.length; index++) {
    const outcome = settled[index];
    const provider = providers[index];
    if (!outcome || !provider) continue;
    if (outcome.status === "fulfilled") successes.push(outcome.value);
    else failures.push({ provider, error: errorMessage(outcome.reason) });
  }
  if (successes.length === 0) {
    const label = selectedProviders ? "Selected-provider" : "All-provider";
    throw new Error(
      `${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`,
    );
  }

  const results: SearchResult[] = [];
  const seenResultUrls = new Set<string>();
  const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
  const seenInlineUrls = new Set<string>();
  for (const response of successes) {
    for (const result of response.results) {
      if (!seenResultUrls.has(result.url)) {
        seenResultUrls.add(result.url);
        results.push(result);
      }
    }
    for (const content of response.inlineContent ?? []) {
      if (!seenInlineUrls.has(content.url)) {
        seenInlineUrls.add(content.url);
        inlineContent.push(content);
      }
    }
  }
  const answerSections = successes.map(
    (response) =>
      `## ${providerLabel(response.provider)}\n\n${response.answer || "(No answer text returned.)"}`,
  );
  if (failures.length > 0)
    answerSections.push(
      `## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
    );
  const response: AttributedSearchResponse = {
    provider: "all",
    answer: answerSections.join("\n\n"),
    results,
    providerResponses: successes,
  };
  if (failures.length > 0) response.providerErrors = failures;
  if (inlineContent.length > 0) response.inlineContent = inlineContent;
  return response;
}

async function searchWithConfiguredRouting(
  query: string,
  options: FullSearchOptions,
  routing: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
  const diagnostics: string[] = [];
  for (const provider of routing.providers) {
    if (!(await isResolvedProviderAvailable(provider, options))) {
      diagnostics.push(`${provider}: unavailable`);
      continue;
    }
    try {
      return await searchWithResolvedProvider(provider, query, options);
    } catch (err) {
      const classified = classifyProviderError(provider, err);
      diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(err)}`);
      if (!isFallbackKind(classified.kind) || !routing.fallbackOn.includes(classified.kind))
        throw classified;
    }
  }
  throw new Error(`Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`);
}

export async function search(
  query: string,
  options: FullSearchOptions = {},
): Promise<AttributedSearchResponse> {
  const config = getSearchConfig();
  const provider =
    options.provider === undefined || options.provider === "auto"
      ? config.searchProvider
      : options.provider;
  if (Array.isArray(provider))
    return searchWithProviders(query, options, normalizeResolvedProviderList(provider, "provider"));
  if (provider === "all") return searchWithProviders(query, options);
  if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
  if (!config.searchProviderConfigured && config.searchRouting)
    return searchWithConfiguredRouting(query, options, config.searchRouting);

  const fallbackErrors: string[] = [];
  let triedOpenAI = false;
  if (!options.extensionContext || isOpenAICodexSelected(options.extensionContext)) {
    triedOpenAI = true;
    const result = await tryOpenAIInAuto(query, options, fallbackErrors);
    if (result) return result;
  }
  if (isExaAvailable()) {
    try {
      const result = await searchWithExa(query, options);
      if (result) return { ...result, provider: "exa" };
    } catch (err) {
      if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
      fallbackErrors.push(`Exa: ${errorMessage(err)}`);
    }
  }
  if (!triedOpenAI) {
    const result = await tryOpenAIInAuto(query, options, fallbackErrors);
    if (result) return result;
  }
  if (isKagiAvailable()) {
    try {
      return { ...(await searchWithKagi(query, options)), provider: "kagi" };
    } catch (err) {
      if (isAbortError(err)) throw err;
      fallbackErrors.push(`Kagi: ${errorMessage(err)}`);
    }
  }
  if (fallbackErrors.length > 0)
    throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
  throw new Error(
    "No search provider available. Either:\n" +
      "  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
      `  2. Set openaiApiKey, exaApiKey, or kagiApiKey in ${CONFIG_PATH}\n` +
      "  3. Set OPENAI_API_KEY, EXA_API_KEY, or KAGI_API_KEY env vars",
  );
}
