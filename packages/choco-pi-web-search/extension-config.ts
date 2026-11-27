import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { arr, bool, compile, map, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import type { JsonSchema, Schema } from "@earendil-works/pi-schema";
import {
  canonicalSearchParams,
  DEFAULT_ATTEMPT_DEADLINE_MS,
  formatSearchRouteTarget,
  resolveSearchScope,
  searchProviderSchema as canonicalSearchProviderSchema,
} from "./index.ts";
import {
  getCachedWebSearchConfig,
  isConfigObject,
  loadWebSearchConfig,
  saveWebSearchConfig,
  type ConfigObject,
  type ConfigValue,
} from "./config-loader.ts";
import { camelToSnake, SNAKE_CAPABILITY_NAMES, type SnakeWebSearchParams } from "./snake-params.ts";
import { isBooleanValue, isNumberValue, isStringValue } from "./value-guards.ts";
import type { ExtractedContent } from "./extract.ts";
import type { FindMode } from "./content-find.ts";
import {
  getConfiguredSearchRouting,
  normalizePriorityTargets,
  normalizeSearchProviderSelection,
  type SearchProvider,
  type SearchProviderSelection,
  type ResolvedSearchProvider,
} from "./gemini-search.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { storeFetchedContentResult, type StoredSearchData } from "./storage.ts";
import type { AuthFetchProfile } from "./auth-fetch.ts";
import { isExaAvailable } from "./exa.ts";
import { isKagiAvailable } from "./kagi.ts";
import { isOpenAISearchAvailable } from "./openai-search.ts";
import { SUMMARY_GENERATION_DEADLINE_MS } from "./summary-review.ts";
import type { RecencyFilter } from "./source-check.ts";

export type ExtensionTheme = ExtensionContext["ui"]["theme"];
export const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();
export { isConfigObject, type ConfigObject, type ConfigValue };

export type DetailScalar = boolean | number | string | null | undefined;
export type DetailValue = DetailScalar | DetailObject | DetailValue[];
export interface DetailObject {
  [key: string]: DetailValue;
}

export interface WebSearchConfig extends ConfigObject {
  openaiApiKey?: ConfigValue;
  exaApiKey?: ConfigValue;
  kagiApiKey?: ConfigValue;
  priority?: ConfigValue;
  provider?: ConfigValue;
  searchProvider?: ConfigValue;
  allowBilledApiFallback?: ConfigValue;
  attemptTimeoutMs?: ConfigValue;
  totalTimeoutMs?: ConfigValue;
  summary?: ConfigValue;
  summaryModel?: string;
  summaryGenerationDeadlineMs?: ConfigValue;
  maxInlineContentChars?: ConfigValue;
  webSearch?: {
    enabled?: boolean;
  };
  tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
  commands?: Partial<Record<"search", { enabled?: boolean }>>;
  toolNames?: Partial<ToolNames>;
  shortcuts?: {
    activity?: KeyId;
  };
  ssrf?: {
    allowRanges?: string[];
    trustEnvProxy?: boolean;
  };
}

export interface ProviderAvailability {
  all: boolean;
  openai: boolean;
  exa: boolean;
  kagi: boolean;
  synthetic: boolean;
  brave: boolean;
  google: boolean;
  xai: boolean;
  [key: string]: boolean;
}

export type SummaryWorkflow = "auto-summary";

export function isDetailObject<Value>(value: Value): value is Value & DetailObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

export function loadConfig(): WebSearchConfig {
  return getCachedWebSearchConfig();
}

export async function saveConfig(
  updates: Partial<WebSearchConfig>,
  removeKeys?: readonly string[],
): Promise<void> {
  const patch: ConfigObject = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) patch[key] = value;
  }
  await saveWebSearchConfig(patch, removeKeys);
}

export type ToolNames = {
  webSearch: string;
  sourceCheck: string;
  fetchContent: string;
  getSearchContent: string;
};

export const DEFAULT_TOOL_NAMES: ToolNames = {
  webSearch: "web_search",
  sourceCheck: "source_check",
  fetchContent: "fetch_content",
  getSearchContent: "get_search_content",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const DEFAULT_SHORTCUTS = {
  activity: "ctrl+shift+w",
} satisfies Record<string, KeyId>;
const MAX_SUMMARY_GENERATION_DEADLINE_MS = 600_000;
const MIN_ATTEMPT_TIMEOUT_SECONDS = 5;
const MAX_ATTEMPT_TIMEOUT_SECONDS = 120;

export type WebSearchParams = SnakeWebSearchParams;

const isSchemaPropertyMap = compile(map(map(unknown()))).check;
const isRequiredList = compile(arr(str())).check;

function canonicalSchemaProperties(): Record<string, Schema> {
  const { properties } = canonicalSearchParams;
  if (!isSchemaPropertyMap(properties)) {
    throw new Error("canonicalSearchParams must be an object schema with properties");
  }
  return properties;
}

function canonicalSchemaRequired(): { required?: string[] } {
  const { required } = canonicalSearchParams;
  return isRequiredList(required) ? { required: required.map(camelToSnake) } : {};
}

function snakeSchemaProperties() {
  const renamed = Object.entries(canonicalSchemaProperties()).map(
    ([name, schema]) => [camelToSnake(name), schema] as const,
  );
  return {
    ...Object.fromEntries(renamed),
    required_capabilities: arr(oneOf(SNAKE_CAPABILITY_NAMES), { uniqueItems: true }),
  };
}
export const webSearchParams: JsonSchema = {
  type: "object",
  properties: {
    ...snakeSchemaProperties(),
    summary: opt(
      bool({
        description:
          "Return a concise summary (default: true). Full raw results are always stored for get_search_content.",
      }),
    ),
  },
  ...canonicalSchemaRequired(),
  additionalProperties: false,
};

export function searchProviderSchema(description: string) {
  return { ...canonicalSearchProviderSchema(description) };
}

export function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
  const override = config.tools?.[key]?.enabled;
  if (isBooleanValue(override)) return override;
  return (key !== "webSearch" && key !== "sourceCheck") || config.webSearch?.enabled !== false;
}

export function isCommandEnabled(config: WebSearchConfig, name: "search"): boolean {
  return config.commands?.[name]?.enabled !== false;
}

export function joinToolNames(names: string[]): string {
  if (names.length === 0) return "stored content";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

export function resolveToolNames(config: WebSearchConfig): ToolNames {
  if (config.toolNames !== undefined && !isConfigObject(config.toolNames)) {
    throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
  }
  const names = { ...DEFAULT_TOOL_NAMES };
  // SAFETY: DEFAULT_TOOL_NAMES is a closed ToolNames object, so Object.keys returns only ToolNames keys.
  for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
    const value = config.toolNames?.[key];
    if (value === undefined) continue;
    if (!isStringValue(value))
      throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
    const trimmed = value.trim();
    if (!TOOL_NAME_PATTERN.test(trimmed)) {
      throw new Error(
        `toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`,
      );
    }
    names[key] = trimmed;
  }
  // SAFETY: DEFAULT_TOOL_NAMES is a closed ToolNames object, so Object.keys returns only ToolNames keys.
  const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>).filter((key) =>
    isToolEnabled(config, key),
  );
  const seen = new Map<string, keyof ToolNames>();
  for (const key of registeredKeys) {
    const name = names[key];
    const previous = seen.get(name);
    if (previous)
      throw new Error(
        `toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`,
      );
    seen.set(name, key);
  }
  return names;
}

export function loadConfigForExtensionInit(): WebSearchConfig {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pi-web-access] ${message}`);
    return {};
  }
}

export async function loadConfigForExtensionInitAsync(): Promise<WebSearchConfig> {
  try {
    return await loadWebSearchConfig({ fresh: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pi-web-access] ${message}`);
    return {};
  }
}

export function normalizeProviderInput<Value>(
  value: Value,
  label = "provider",
): SearchProviderSelection | undefined {
  if (value === undefined) return undefined;
  return normalizeSearchProviderSelection(value, label);
}

export function resolveRequestedProvider<Value>(requested: Value): SearchProviderSelection {
  const normalizedRequested = normalizeProviderInput(requested);
  if (normalizedRequested && normalizedRequested !== "auto") return normalizedRequested;
  const config = loadConfig();
  return (
    normalizeProviderInput(
      config.searchProvider ?? config.provider,
      `provider in ${WEB_SEARCH_CONFIG_PATH}`,
    ) ?? "auto"
  );
}

export function toProviderLabel(
  provider: SearchProviderSelection,
): Exclude<SearchProvider, "auto"> | undefined {
  if (Array.isArray(provider)) return "all";
  return provider === "auto" ? undefined : provider;
}

export function normalizeRecencyFilter<Value>(value: Value): RecencyFilter | undefined {
  if (!isStringValue(value)) return undefined;
  switch (value) {
    case "day":
      return "day";
    case "week":
      return "week";
    case "month":
      return "month";
    case "year":
      return "year";
    default:
      return undefined;
  }
}

export function isSummaryEnabled(config: WebSearchConfig = loadConfig()): boolean {
  if (isBooleanValue(config.summary)) return config.summary;
  if (isConfigObject(config.summary) && isBooleanValue(config.summary.enabled)) {
    return config.summary.enabled;
  }
  if (isStringValue(config.workflow) && config.workflow.trim().toLowerCase() === "none") {
    return false;
  }
  return true;
}

export function getConfiguredSummaryModel(
  config: WebSearchConfig = loadConfig(),
): string | undefined {
  if (isConfigObject(config.summary) && isStringValue(config.summary.model)) {
    const trimmed = config.summary.model.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (isStringValue(config.summaryModel)) {
    const trimmed = config.summaryModel.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function getConfiguredPriorityEntries(config: WebSearchConfig = loadConfig()): string[] {
  if (Array.isArray(config.priority)) {
    try {
      return normalizePriorityTargets(config.priority).map(formatSearchRouteTarget);
    } catch {
      return [];
    }
  }
  if (isConfigObject(config.searchRouting) && Array.isArray(config.searchRouting.providers)) {
    try {
      return normalizePriorityTargets(config.searchRouting.providers).map(formatSearchRouteTarget);
    } catch {
      return [];
    }
  }
  return [];
}

export function getAttemptTimeoutSeconds(config: WebSearchConfig = loadConfig()): number {
  const raw = config.attemptTimeoutMs;
  if (!isNumberValue(raw) || !Number.isFinite(raw) || raw <= 0) {
    return Math.round(DEFAULT_ATTEMPT_DEADLINE_MS / 1000);
  }
  const seconds = Math.round(raw / 1000);
  return Math.max(MIN_ATTEMPT_TIMEOUT_SECONDS, Math.min(MAX_ATTEMPT_TIMEOUT_SECONDS, seconds));
}

export function normalizeQueryList(queryList: unknown[]): string[] {
  const normalized: string[] = [];
  for (const query of queryList) {
    if (!isStringValue(query)) continue;
    const trimmed = query.trim();
    if (trimmed.length > 0) normalized.push(trimmed);
  }
  return normalized;
}

export function getSummaryGenerationDeadlineMs(): number {
  const config = loadConfig();
  const value =
    (isConfigObject(config.summary) ? config.summary.deadlineMs : undefined) ??
    config.summaryGenerationDeadlineMs;
  if (!isNumberValue(value) || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return SUMMARY_GENERATION_DEADLINE_MS;
  }
  return Math.min(value, MAX_SUMMARY_GENERATION_DEADLINE_MS);
}

export async function getProviderAvailability(
  ctx: ExtensionContext,
): Promise<ProviderAvailability> {
  const scope = resolveSearchScope(ctx);
  const providers = {
    openai: await isOpenAISearchAvailable(ctx),
    exa: isExaAvailable(),
    kagi: isKagiAvailable(),
    synthetic: [...(scope?.adapters.values() ?? [])].some(
      (adapter) => adapter.family === "synthetic",
    ),
    brave: [...(scope?.adapters.values() ?? [])].some((adapter) => adapter.family === "brave"),
    google: [...(scope?.adapters.values() ?? [])].some((adapter) => adapter.family === "google"),
    xai: [...(scope?.adapters.values() ?? [])].some((adapter) => adapter.family === "xai"),
  };
  const { google: _explicitOnlyGoogle, xai: _explicitOnlyXai, ...fanoutProviders } = providers;
  return { all: Object.values(fanoutProviders).some(Boolean), ...providers };
}

export function firstAvailableProvider(
  available: ProviderAvailability,
  fallback: ResolvedSearchProvider,
): ResolvedSearchProvider {
  if (available.openai) return "openai";
  if (available.exa) return "exa";
  if (available.kagi) return "kagi";
  if (available.synthetic) return "synthetic";
  if (available.brave) return "brave";
  return fallback;
}

export function resolveProvider(
  provider: SearchProviderSelection,
  available: ProviderAvailability,
): Exclude<SearchProvider, "auto"> {
  if (Array.isArray(provider)) return "all";
  if (provider === "auto") {
    const routing = getConfiguredSearchRouting();
    if (routing) {
      for (const candidate of routing.providers) {
        if (available[candidate]) return candidate;
      }
      return routing.providers[0];
    }
    return firstAvailableProvider(available, "openai");
  }
  return provider;
}

const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

export function getMaxInlineContentChars(config = loadConfig()): number {
  const value = config.maxInlineContentChars;
  if (!isNumberValue(value) || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_MAX_INLINE_CONTENT_CHARS;
  }
  return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

export function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
  return results.map(({ thumbnail: _thumbnail, ...rest }) => rest);
}

export function storeFetchResult(
  pi: { appendEntry<Value>(type: string, data: Value): void },
  responseId: string,
  data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] },
  authProfile?: AuthFetchProfile,
): boolean {
  if (authProfile?.cache === "off") return false;
  pi.appendEntry("web-search-results", storeFetchedContentResult(responseId, data));
  return true;
}

export interface InitialContentSlice {
  text: string;
  endOffset: number;
  totalBytes: number;
  totalLines: number;
  shownBytes: number;
  shownLines: number;
}

export function initialContentSlice(content: string, maxChars: number): InitialContentSlice {
  let endOffset = Math.min(content.length, maxChars);
  if (endOffset < content.length) {
    const lineBreak = content.lastIndexOf("\n", endOffset);
    if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
  }
  const text = content.slice(0, endOffset);
  return {
    text,
    endOffset,
    totalBytes: Buffer.byteLength(content),
    totalLines: content.length === 0 ? 0 : content.split("\n").length,
    shownBytes: Buffer.byteLength(text),
    shownLines: text.length === 0 ? 0 : text.split("\n").length,
  };
}

export function normalizeFindMode(value: string | undefined): FindMode {
  return value === "exact" || value === "case-insensitive" || value === "fuzzy"
    ? value
    : "case-insensitive";
}

export function normalizeFindQueries(value: string | string[]): string[] {
  const queries = (Array.isArray(value) ? value : [value])
    .map((query) => query.trim())
    .filter(Boolean);
  if (queries.length === 0) throw new Error("find_text must contain at least one non-empty string");
  return queries;
}

export function formatInputValue<Value>(value: Value): string {
  if (isStringValue(value)) return JSON.stringify(value);
  if (isNumberValue(value)) return Number.isNaN(value) ? "NaN" : String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
