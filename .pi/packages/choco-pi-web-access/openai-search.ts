import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

// The selected model runs the server-side web_search call and writes the cited summary.
// Prefer the newest mid-tier ("terra") model, then the newest bare mainline id; price
// tiers ("pro"/"ultra" id segments) are excluded, and the numeric-aware sort keeps
// e.g. gpt-5.10 ahead of gpt-5.9.
const EXCLUDED_MODEL_SEGMENTS = new Set(["pro", "ultra"]);
const MODEL_PREFERENCE = [
  (id: string) => id.includes("terra"),
  (id: string) => /^gpt-\d+(\.\d+)?$/.test(id),
];
const DEFAULT_SEARCH_PROVIDERS: readonly string[] = ["openai-codex", "openai"];

function pickSearchModel<T extends { id: string }>(models: readonly T[]): T | undefined {
  const candidates = models
    .filter((model) => !model.id.split("-").some((segment) => EXCLUDED_MODEL_SEGMENTS.has(segment)))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const prefers of MODEL_PREFERENCE) {
    const preferred = candidates.find((model) => prefers(model.id));
    if (preferred) return preferred;
  }
  return candidates[0];
}

type OpenAIJsonScalar = boolean | number | string | null;
type OpenAIJsonValue = OpenAIJsonScalar | OpenAIJsonObject | OpenAIJsonValue[];
interface OpenAIJsonObject {
  [key: string]: OpenAIJsonValue | undefined;
}

interface WebSearchConfig extends OpenAIJsonObject {
  openaiApiKey?: OpenAIJsonValue;
  openaiResponsesUrl?: OpenAIJsonValue;
  openaiSearchModel?: OpenAIJsonValue;
  openaiSearchProviders?: OpenAIJsonValue;
}

type ProviderHeaders = Record<string, string | null>;

interface OpenAIAuth {
  provider: string;
  apiKey: string;
  model: string;
  headers: ProviderHeaders;
  responsesUrl: string;
}

interface NormalizedDomainFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

interface WebSearchToolFilters {
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface WebSearchTool {
  type: "web_search";
  filters?: WebSearchToolFilters;
}

const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();

function isJsonObject<Value>(value: Value): value is Value & OpenAIJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
  if (cachedConfig) return cachedConfig;
  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = {};
    return cachedConfig;
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  try {
    const parsed: OpenAIJsonValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
    cachedConfig = parsed;
    return cachedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(
  domainFilter: string[] | undefined,
): NormalizedDomainFilters | null {
  if (!domainFilter?.length) return null;

  const allowedDomains: string[] = [];
  const blockedDomains: string[] = [];
  for (const raw of domainFilter) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
    if (!target.includes(domain)) target.push(domain);
  }

  if (allowedDomains.length === 0 && blockedDomains.length === 0) return null;
  const filters: NormalizedDomainFilters = {};
  if (allowedDomains.length > 0) filters.allowedDomains = allowedDomains.slice(0, 100);
  if (blockedDomains.length > 0) filters.blockedDomains = blockedDomains.slice(0, 100);
  return filters;
}

function decodeJwtPayload(token: string): OpenAIJsonObject | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const parsed: OpenAIJsonValue = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCodexJwt(token: string): boolean {
  const payload = decodeJwtPayload(token);
  return !!payload?.["https://api.openai.com/auth"];
}

function extractAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (!isJsonObject(auth)) return undefined;
  const id = auth.chatgpt_account_id;
  return Check(StringValueSchema, id) && id.trim().length > 0 ? id.trim() : undefined;
}

function resolveConfiguredResponsesUrl<Value>(value: Value): string {
  if (value === undefined) return OPENAI_RESPONSES_URL;
  if (!Check(StringValueSchema, value) || value.trim().length === 0) {
    throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must use http or https`);
  }
  return url.toString();
}

function resolveConfiguredSearchProviders<Value>(value: Value): readonly string[] {
  if (value === undefined) return DEFAULT_SEARCH_PROVIDERS;
  if (
    !Array.isArray(value) ||
    value.some((entry) => !Check(StringValueSchema, entry) || entry.trim().length === 0)
  ) {
    throw new Error(
      `openaiSearchProviders in ${CONFIG_PATH} must be an array of non-empty Pi provider ids`,
    );
  }
  return value.map((entry) => entry.trim());
}

function resolveConfiguredSearchModel<Value>(value: Value): string | undefined {
  if (value == null) return undefined;
  if (!Check(StringValueSchema, value) || value.trim().length === 0) {
    throw new Error(`openaiSearchModel in ${CONFIG_PATH} must be a non-empty string`);
  }
  return value.trim();
}

function toRequestHeaders(headers: ProviderHeaders) {
  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) requestHeaders[name] = value;
  }
  return requestHeaders;
}

async function resolvePiAuth(
  ctx: ExtensionContext,
  responsesUrl: string,
  providers: readonly string[],
  modelOverride?: string,
): Promise<OpenAIAuth | undefined> {
  let models: ReturnType<typeof ctx.modelRegistry.getAll>;
  try {
    models = ctx.modelRegistry.getAll();
  } catch {
    return undefined;
  }
  for (const provider of providers) {
    const preferred = pickSearchModel(models.filter((model) => model.provider === provider));
    if (!preferred) continue;
    try {
      const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(preferred);
      if (resolved.ok && resolved.apiKey) {
        return {
          provider,
          apiKey: resolved.apiKey,
          model: modelOverride ?? preferred.id,
          headers: resolved.headers ?? {},
          responsesUrl,
        };
      }
    } catch {}
  }
  return undefined;
}

export async function resolveOpenAIAuth(
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<OpenAIAuth | undefined> {
  const config = loadConfig();
  const responsesUrl = resolveConfiguredResponsesUrl(config.openaiResponsesUrl);
  const modelOverride = resolveConfiguredSearchModel(config.openaiSearchModel);
  const providers = resolveConfiguredSearchProviders(config.openaiSearchProviders);
  if (ctx) {
    const auth = await resolvePiAuth(ctx, responsesUrl, providers, modelOverride);
    if (auth) return auth;
  }

  const hasSource = hasCredentialSource({
    provider: "OpenAI",
    configuredValue: config.openaiApiKey,
    environmentValue: process.env.OPENAI_API_KEY,
  });
  if (!hasSource) return undefined;
  const apiKey = await resolveCredential({
    provider: "OpenAI",
    configuredValue: config.openaiApiKey,
    environmentValue: process.env.OPENAI_API_KEY,
    signal,
  });
  return apiKey
    ? {
        provider: "openai",
        apiKey,
        model: modelOverride ?? "gpt-5.6-terra",
        headers: {},
        responsesUrl,
      }
    : undefined;
}

export async function isOpenAISearchAvailable(ctx?: ExtensionContext): Promise<boolean> {
  const config = loadConfig();
  const responsesUrl = resolveConfiguredResponsesUrl(config.openaiResponsesUrl);
  const providers = resolveConfiguredSearchProviders(config.openaiSearchProviders);
  if (ctx && (await resolvePiAuth(ctx, responsesUrl, providers))) return true;
  return hasCredentialSource({
    provider: "OpenAI",
    configuredValue: config.openaiApiKey,
    environmentValue: process.env.OPENAI_API_KEY,
  });
}

function buildInstructions(options: SearchOptions): string {
  const lines = [
    "Search the web and return a concise answer grounded only in the web results.",
    "Include clickable source citations in the response text when possible.",
  ];

  if (options.recencyFilter) {
    let label: string;
    switch (options.recencyFilter) {
      case "day":
        label = "past 24 hours";
        break;
      case "week":
        label = "past week";
        break;
      case "month":
        label = "past month";
        break;
      case "year":
        label = "past year";
        break;
    }
    lines.push(`Prefer sources from the ${label}.`);
  }

  if (
    Check(NumberValueSchema, options.numResults) &&
    Number.isFinite(options.numResults) &&
    options.numResults > 0
  ) {
    lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
  }

  const filters = normalizeDomainFilters(options.domainFilter);
  if (filters?.allowedDomains?.length)
    lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
  if (filters?.blockedDomains?.length)
    lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);

  return lines.join(" ");
}

function buildWebSearchTool(options: SearchOptions): WebSearchTool {
  const tool: WebSearchTool = { type: "web_search" };
  const filters = normalizeDomainFilters(options.domainFilter);
  if (filters) {
    const toolFilters: WebSearchToolFilters = {};
    if (filters.allowedDomains) toolFilters.allowed_domains = filters.allowedDomains;
    if (filters.blockedDomains) toolFilters.blocked_domains = filters.blockedDomains;
    tool.filters = toolFilters;
  }
  return tool;
}

async function parseOpenAIResponse(response: Response): Promise<OpenAIJsonObject> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: OpenAIJsonValue = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { output: parsed };
      return isJsonObject(parsed) ? parsed : { output: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI API returned invalid JSON: ${message}`);
    }
  }

  const outputItems: OpenAIJsonValue[] = [];
  let completedResponse: OpenAIJsonObject | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: OpenAIJsonValue = JSON.parse(data);
      if (!isJsonObject(parsed)) continue;
      if (parsed.type === "response.output_item.done" && parsed.item) outputItems.push(parsed.item);
      if (
        (parsed.type === "response.done" || parsed.type === "response.completed") &&
        isJsonObject(parsed.response)
      ) {
        completedResponse = parsed.response;
      }
    } catch {}
  }

  if (completedResponse) {
    const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
    return output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
  }
  if (outputItems.length > 0) return { output: outputItems };
  throw new Error("OpenAI API returned no parseable response output");
}

function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, "");
  }
}

function extractSnippetAround(
  text: string,
  start: OpenAIJsonValue | undefined,
  end: OpenAIJsonValue | undefined,
): string {
  if (!Check(NumberValueSchema, start) || !Check(NumberValueSchema, end) || !text) return "";
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text
    .slice(before, after)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(
  results: SearchResult[],
  seen: Set<string>,
  url: OpenAIJsonValue | undefined,
  title: OpenAIJsonValue | undefined,
  snippet = "",
): void {
  if (!Check(StringValueSchema, url) || url.trim().length === 0) return;
  const cleanUrl = cleanSourceUrl(url);
  if (seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title: Check(StringValueSchema, title) && title.trim().length > 0 ? title : cleanUrl,
    url: cleanUrl,
    snippet,
  });
}

function extractSearchResults(
  output: OpenAIJsonValue[],
  numResults: number | undefined,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of output) {
    if (!isJsonObject(item) || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isJsonObject(part)) continue;
      const text = Check(StringValueSchema, part.text) ? part.text : "";
      const annotations = part.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!isJsonObject(annotation) || annotation.type !== "url_citation") continue;
        addResult(
          results,
          seenUrls,
          annotation.url,
          annotation.title,
          extractSnippetAround(text, annotation.start_index, annotation.end_index),
        );
      }
    }
  }

  for (const item of output) {
    if (!isJsonObject(item) || item.type !== "web_search_call") continue;
    const actionSources = isJsonObject(item.action) ? item.action.sources : undefined;
    const sourceGroups = [actionSources, item.sources, item.results];
    for (const group of sourceGroups) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!isJsonObject(source)) continue;
        addResult(
          results,
          seenUrls,
          source.url ?? source.source_website_url,
          source.title ?? source.caption,
        );
      }
    }
  }

  if (Check(NumberValueSchema, numResults) && Number.isFinite(numResults) && numResults > 0) {
    return results.slice(0, Math.min(Math.floor(numResults), 20));
  }
  return results;
}

function extractAnswer(output: OpenAIJsonValue[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isJsonObject(item) || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isJsonObject(part)) continue;
      const text = part.text;
      if (Check(StringValueSchema, text) && text.trim().length > 0) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

export async function searchWithOpenAI(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<SearchResponse> {
  const auth = await resolveOpenAIAuth(ctx, options.signal);
  if (!auth) {
    throw new Error(
      "OpenAI web search unavailable. Either:\n" +
        "  1. Use /login to sign in with a Codex subscription\n" +
        `  2. Create ${CONFIG_PATH} with { "openaiApiKey": "your-key" }\n` +
        "  3. Set OPENAI_API_KEY environment variable",
    );
  }

  const activityId = activityMonitor.logStart({ type: "api", query });
  const headers = Object.assign(toRequestHeaders(auth.headers), {
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
  });
  const useCodexEndpoint = auth.provider === "openai-codex" || isCodexJwt(auth.apiKey);
  if (useCodexEndpoint) {
    const accountId = extractAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
  }

  const body = {
    model: auth.model,
    instructions: buildInstructions(options),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [buildWebSearchTool(options)],
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
    tool_choice: "required" as const,
    parallel_tool_calls: true,
  };

  try {
    const response = await fetch(useCodexEndpoint ? CODEX_RESPONSES_URL : auth.responsesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
        : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      activityMonitor.logError(activityId, `HTTP ${response.status}`);
      const errorText = redactCredential(await response.text(), auth.apiKey);
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const parsed = await parseOpenAIResponse(response);
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    const answer = extractAnswer(output);
    const results = extractSearchResults(output, options.numResults);

    if (!answer && results.length === 0) {
      throw new Error("OpenAI web_search returned no answer or sources");
    }

    activityMonitor.logComplete(activityId, response.status);
    return { answer, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redactedMessage = redactCredential(message, auth.apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) {
      activityMonitor.logComplete(activityId, 0);
    } else {
      activityMonitor.logError(activityId, redactedMessage);
    }
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}
