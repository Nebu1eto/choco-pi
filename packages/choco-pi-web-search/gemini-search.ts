import { getCachedWebSearchConfig, isConfigObject } from "./config-loader.ts";
import { isAbortError, isBooleanValue, isNumberValue, isStringValue } from "./value-guards.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_ATTEMPT_DEADLINE_MS,
  DEFAULT_TOTAL_DEADLINE_MS,
  formatSearchRouteTarget,
  isValidSearchProviderFamily,
  parseSearchRouteTarget,
  resolveSearchScope,
  search as searchCore,
  searchProviderFamilies,
  searchProviderSelections,
  type SearchAttemptDiagnostic,
  type SearchBilling,
  type SearchProviderFamily,
  type SearchProviderName,
  type SearchProviderSelection,
  type SearchCapability,
  type SearchErrorKind,
  type JsonRecord,
  type SearchRequest,
  type SearchResponse as CoreSearchResponse,
  type SearchRouteTarget,
  type SearchRouting,
} from "./index.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./search-types.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export const RESOLVED_SEARCH_PROVIDERS = searchProviderFamilies;
export const SEARCH_PROVIDERS = searchProviderSelections;

export type ResolvedSearchProvider = SearchProviderFamily;
export type SearchProvider = SearchProviderName;
export type { SearchProviderSelection };
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
  targets?: SearchRouteTarget[];
  fallbackOn?: Array<
    Extract<SearchProviderErrorKind, "transient" | "quota" | "network" | "invalid-response">
  >;
  configuredPriority?: boolean;
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
  provider: SearchProviderFamily;
  adapterId?: string;
  transport?: string;
  billing?: SearchBilling;
  warnings?: string[];
  attempts?: readonly SearchAttemptDiagnostic[];
}

export interface ProviderSearchFailure {
  provider: SearchProviderFamily;
  error: string;
  kind?: SearchErrorKind;
}

export interface AttributedSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider | "all";
  providerResponses?: ProviderSearchResponse[];
  providerErrors?: ProviderSearchFailure[];
  adapterId?: string;
  transport?: string;
  billing?: SearchBilling;
  warnings?: string[];
  attempts?: readonly SearchAttemptDiagnostic[];
}

const CONFIG_PATH = getWebSearchConfigPath();
const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = [...RESOLVED_SEARCH_PROVIDERS];
const VALID_ROUTING_KINDS = ["transient", "quota", "network", "invalid-response"] as const;
const MIN_ATTEMPT_TIMEOUT_MS = 1_000;
const MAX_ATTEMPT_TIMEOUT_MS = 120_000;
const MIN_TOTAL_TIMEOUT_MS = 5_000;
const MAX_TOTAL_TIMEOUT_MS = 360_000;

type SearchConfig = {
  searchProvider: SearchProviderSelection;
  searchProviderConfigured: boolean;
  searchRouting?: SearchRoutingConfig;
  allowBilledApiFallback: boolean;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
};

function isResolvedSearchProvider(value: string): value is ResolvedSearchProvider {
  return RESOLVED_SEARCH_PROVIDERS.some((provider) => provider === value);
}

function isSearchProvider(value: string): value is SearchProvider {
  return SEARCH_PROVIDERS.some((provider) => provider === value);
}

type RoutingFallbackKind = NonNullable<SearchRoutingConfig["fallbackOn"]>[number];

function isFallbackKind(value: string): value is RoutingFallbackKind {
  return VALID_ROUTING_KINDS.some((kind) => kind === value);
}

function getSearchConfig(): SearchConfig {
  const raw = getCachedWebSearchConfig();

  const searchProviderConfigured =
    Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
  if (Object.hasOwn(raw, "searchProvider") && Object.hasOwn(raw, "provider")) {
    throw new Error(
      `Conflicting search configuration in ${CONFIG_PATH}: both searchProvider and provider are present`,
    );
  }
  const providerValue = raw.searchProvider ?? raw.provider;
  const config: SearchConfig = {
    searchProvider: normalizeConfiguredSearchProvider(providerValue),
    searchProviderConfigured,
    allowBilledApiFallback:
      raw.allowBilledApiFallback === undefined
        ? false
        : normalizeBoolean(raw.allowBilledApiFallback, `allowBilledApiFallback in ${CONFIG_PATH}`),
  };
  const hasPriority = Object.hasOwn(raw, "priority") && raw.priority !== undefined;
  const hasSearchRouting = Object.hasOwn(raw, "searchRouting") && raw.searchRouting !== undefined;
  if (hasPriority && hasSearchRouting) {
    throw new Error(
      `Conflicting search configuration in ${CONFIG_PATH}: use priority or searchRouting, not both`,
    );
  }
  if (hasPriority) {
    const targets = normalizePriorityTargets(raw.priority, `priority in ${CONFIG_PATH}`);
    if (targets.length > 0) {
      config.searchRouting = {
        providers: targets.map((target) => target.family),
        targets,
        configuredPriority: true,
      };
    }
  }
  if (hasSearchRouting) {
    if (searchProviderConfigured) {
      throw new Error(
        `Conflicting search configuration in ${CONFIG_PATH}: use searchProvider/provider or searchRouting, not both`,
      );
    }
    config.searchRouting = normalizeSearchRouting(raw.searchRouting);
  }
  if (raw.attemptTimeoutMs !== undefined) {
    config.attemptTimeoutMs = normalizeTimeoutMs(
      raw.attemptTimeoutMs,
      `attemptTimeoutMs in ${CONFIG_PATH}`,
      MIN_ATTEMPT_TIMEOUT_MS,
      MAX_ATTEMPT_TIMEOUT_MS,
    );
  }
  if (raw.totalTimeoutMs !== undefined) {
    config.totalTimeoutMs = normalizeTimeoutMs(
      raw.totalTimeoutMs,
      `totalTimeoutMs in ${CONFIG_PATH}`,
      MIN_TOTAL_TIMEOUT_MS,
      MAX_TOTAL_TIMEOUT_MS,
    );
  }
  return config;
}

function normalizeTimeoutMs<Value>(value: Value, label: string, min: number, max: number): number {
  if (!isNumberValue(value) || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return Math.floor(value);
}

export function normalizePriorityTargets<Value>(
  value: Value,
  label = "priority",
): SearchRouteTarget[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const targets: SearchRouteTarget[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isStringValue(entry)) {
      throw new Error(`${label} contains an invalid entry: ${String(entry)}`);
    }
    const parsed = parseSearchRouteTarget(entry);
    if (!parsed) {
      throw new Error(`${label} contains an invalid provider or model: ${entry}`);
    }
    const key = formatSearchRouteTarget(parsed).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(parsed);
  }
  return targets;
}

function normalizeConfiguredSearchProvider<Value>(value: Value): SearchProviderSelection {
  if (isStringValue(value)) {
    const normalized = value.trim().toLowerCase();
    if (!isSearchProvider(normalized)) {
      throw new Error(`Invalid provider in ${CONFIG_PATH}: ${value}`);
    }
  }
  return normalizeSearchProviderSelection(value, `provider in ${CONFIG_PATH}`);
}

function normalizeBoolean<Value>(value: Value, label: string): boolean {
  if (!isBooleanValue(value)) throw new Error(`${label} must be a boolean`);
  return value;
}

function normalizeSearchRouting<Value>(value: Value): SearchRoutingConfig {
  if (!isConfigObject(value)) {
    throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
  }
  const raw = value;
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new Error(`searchRouting.providers in ${CONFIG_PATH} must be a non-empty array`);
  }
  const hasTargetEntry = raw.providers.some(
    (entry) =>
      isStringValue(entry) &&
      (entry.includes("/") || entry.trim().toLowerCase() === "openai-codex"),
  );
  const targets = hasTargetEntry
    ? normalizePriorityTargets(raw.providers, `searchRouting.providers in ${CONFIG_PATH}`)
    : undefined;
  const providers = targets
    ? targets.map((target) => target.family)
    : normalizeProviderFamilyList(
        raw.providers,
        `searchRouting.providers in ${CONFIG_PATH}`,
        isValidSearchProviderFamily,
      );
  if (raw.fallbackOn === undefined) {
    const result: SearchRoutingConfig = { providers, configuredPriority: true };
    if (targets) result.targets = targets;
    return result;
  }
  if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
    throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
  }
  const fallbackOn: RoutingFallbackKind[] = [];
  for (const kind of raw.fallbackOn) {
    if (!isStringValue(kind) || !isFallbackKind(kind)) {
      throw new Error(
        `searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, network, or invalid-response`,
      );
    }
    if (!fallbackOn.includes(kind)) fallbackOn.push(kind);
  }
  const result: SearchRoutingConfig = { providers, fallbackOn };
  if (targets) result.targets = targets;
  return result;
}

export function getConfiguredSearchRouting(): SearchRouting | undefined {
  const config = getSearchConfig();
  if (config.searchProviderConfigured && config.searchProvider !== "auto") return undefined;
  if (!config.searchRouting) return undefined;
  const routing: SearchRouting = { providers: config.searchRouting.providers };
  if (config.searchRouting.targets) routing.targets = config.searchRouting.targets;
  if (config.searchRouting.fallbackOn) routing.fallbackOn = config.searchRouting.fallbackOn;
  if (config.searchRouting.configuredPriority === true) routing.configuredPriority = true;
  return routing;
}

export interface SearchDeadlines {
  attemptDeadlineMs: number;
  totalDeadlineMs: number;
}

export function getConfiguredSearchDeadlines(): SearchDeadlines {
  const config = getSearchConfig();
  const attemptDeadlineMs = config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_DEADLINE_MS;
  const totalDeadlineMs = Math.max(
    config.totalTimeoutMs ?? DEFAULT_TOTAL_DEADLINE_MS,
    attemptDeadlineMs,
  );
  return { attemptDeadlineMs, totalDeadlineMs };
}

function normalizeResolvedProviderList<Value>(
  value: Value,
  label: string,
): ResolvedSearchProvider[] {
  return normalizeProviderFamilyList(value, label, isResolvedSearchProvider);
}

function normalizeProviderFamilyList<Value>(
  value: Value,
  label: string,
  isAccepted: (candidate: string) => boolean,
): ResolvedSearchProvider[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const providers: ResolvedSearchProvider[] = [];
  for (const provider of value) {
    const normalized = isStringValue(provider) ? provider.trim().toLowerCase() : "";
    if (!isAccepted(normalized)) {
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
  const normalized = isStringValue(value) ? value.trim().toLowerCase() : "";
  return isSearchProvider(normalized) ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
  provider?: SearchProviderSelection;
  includeContent?: boolean;
  extensionContext?: ExtensionContext;
  allowBilledApiFallback?: boolean;
  recencyDays?: number;
  country?: string;
  language?: string;
  safesearch?: "off" | "moderate" | "strict";
  offset?: number;
  exaSearchType?: "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  answerMode?: "answer" | "results" | "both";
  responseLength?: "short" | "medium" | "long";
  searchContextSize?: "low" | "medium" | "high";
  requiredCapabilities?: SearchCapability[];
  providerOptions?: Readonly<Record<string, JsonRecord>>;
}

function fromCoreResponse(response: CoreSearchResponse): AttributedSearchResponse {
  const providerResponses = response.providerResponses?.flatMap((entry) =>
    entry.provider === "all"
      ? []
      : [
          {
            answer: entry.answer,
            results: entry.results,
            inlineContent: entry.inlineContent,
            provider: entry.provider,
            adapterId: entry.adapterId,
            transport: entry.transport,
            billing: entry.billing,
            warnings: entry.warnings,
            attempts: entry.attempts,
            references: entry.references,
          },
        ],
  );
  const mapped: AttributedSearchResponse = {
    answer: response.answer,
    results: response.results,
    provider: response.provider,
    adapterId: response.adapterId,
    transport: response.transport,
    billing: response.billing,
    attempts: response.attempts,
  };
  if (response.inlineContent) mapped.inlineContent = response.inlineContent;
  if (response.references?.length) mapped.references = response.references;
  if (response.warnings?.length) mapped.warnings = response.warnings;
  if (providerResponses) mapped.providerResponses = providerResponses;
  if (response.providerErrors)
    mapped.providerErrors = response.providerErrors.map(({ provider, error, kind }) => ({
      provider,
      error,
      kind,
    }));
  return mapped;
}

async function searchWithCore(
  query: string,
  options: FullSearchOptions,
  config: SearchConfig,
  provider: SearchProviderSelection,
): Promise<AttributedSearchResponse | undefined> {
  const context = options.extensionContext;
  if (!context || !resolveSearchScope(context)) return undefined;
  let routing: SearchRouting | undefined;
  if (
    (!config.searchProviderConfigured || config.searchProvider === "auto") &&
    config.searchRouting
  ) {
    routing = { providers: config.searchRouting.providers };
    if (config.searchRouting.targets) routing.targets = config.searchRouting.targets;
    if (config.searchRouting.fallbackOn) routing.fallbackOn = config.searchRouting.fallbackOn;
    if (config.searchRouting.configuredPriority === true) routing.configuredPriority = true;
  }
  const request: SearchRequest = { query };
  if (!(routing && provider === "auto")) request.provider = provider;
  if (options.numResults !== undefined) request.numResults = options.numResults;
  if (options.recencyFilter) request.recencyFilter = options.recencyFilter;
  if (options.recencyDays !== undefined) request.recencyDays = options.recencyDays;
  if (options.domainFilter) request.domainFilter = options.domainFilter;
  if (options.includeContent !== undefined) request.includeContent = options.includeContent;
  if (options.country) request.country = options.country;
  if (options.language) request.language = options.language;
  if (options.safesearch) request.safesearch = options.safesearch;
  if (options.offset !== undefined) request.offset = options.offset;
  if (options.exaSearchType) request.exaSearchType = options.exaSearchType;
  if (options.answerMode) request.answerMode = options.answerMode;
  if (options.responseLength) request.responseLength = options.responseLength;
  if (options.searchContextSize) request.searchContextSize = options.searchContextSize;
  if (options.requiredCapabilities) request.requiredCapabilities = options.requiredCapabilities;
  if (options.providerOptions) request.providerOptions = options.providerOptions;
  const attemptDeadlineMs = config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_DEADLINE_MS;
  const totalDeadlineMs = Math.max(
    config.totalTimeoutMs ?? DEFAULT_TOTAL_DEADLINE_MS,
    attemptDeadlineMs,
  );
  const response = await searchCore(request, {
    context,
    signal: options.signal,
    routing,
    allowBilledApiFallback: options.allowBilledApiFallback ?? config.allowBilledApiFallback,
    attemptDeadlineMs,
    totalDeadlineMs,
  });
  return fromCoreResponse(response);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
  if (options.recencyFilter) return false;
  return true;
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
  if (provider === "exa") {
    const result = await searchWithExa(query, options);
    if (result) return { ...result, provider };
    throw new Error("Exa search returned no results.");
  }
  throw new Error(
    `${provider} search requires an integrated choco-pi-web-search session and adapter`,
  );
}

async function isResolvedProviderAvailable(
  provider: ResolvedSearchProvider,
  options: FullSearchOptions,
): Promise<boolean> {
  if (provider === "openai") return isOpenAISearchAvailable(options.extensionContext);
  if (provider === "kagi") return isKagiAvailable();
  if (provider === "exa") return isExaAvailable();
  return false;
}

function providerLabel(provider: ResolvedSearchProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "kagi":
      return "Kagi";
    case "exa":
      return "Exa";
    case "synthetic":
      return "Synthetic";
    case "brave":
      return "Brave";
    case "google":
      return "Google";
    case "xai":
      return "xAI";
    default:
      return provider;
  }
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
  const fallbackOn = routing.fallbackOn ?? ["transient", "quota", "network", "invalid-response"];
  const configuredPriority = routing.configuredPriority === true;
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
      if (
        configuredPriority &&
        (classified.kind === "auth" ||
          classified.kind === "quota" ||
          isFallbackKind(classified.kind))
      ) {
        continue;
      }
      if (!isFallbackKind(classified.kind) || !fallbackOn.includes(classified.kind))
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
  const coreResponse = await searchWithCore(query, options, config, provider);
  if (coreResponse) return coreResponse;
  if (Array.isArray(provider))
    return searchWithProviders(query, options, normalizeResolvedProviderList(provider, "provider"));
  if (provider === "all") return searchWithProviders(query, options);
  if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
  if (!config.searchProviderConfigured && config.searchRouting)
    return searchWithConfiguredRouting(query, options, config.searchRouting);

  const fallbackErrors: string[] = [];
  const openAIResult = await tryOpenAIInAuto(query, options, fallbackErrors);
  if (openAIResult) return openAIResult;
  if (isExaAvailable()) {
    try {
      const result = await searchWithExa(query, options);
      if (result) return { ...result, provider: "exa" };
    } catch (err) {
      if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
      fallbackErrors.push(`Exa: ${errorMessage(err)}`);
    }
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
