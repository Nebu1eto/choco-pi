import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  registerSearchAdapter,
  SearchError,
  type JsonValue,
  type SearchAdapter,
  type SearchAdapterContext,
  type SearchAdapterResponse,
  type SearchAvailability,
  type SearchBilling,
  type SearchErrorKind,
  type SearchErrorOptions,
  type SearchRequest,
  type SearchResult,
  type SearchScope,
} from "../../packages/choco-pi-web-search/index.ts";

export const XAI_SEARCH_ADAPTER_ID = "xai.responses";
export const XAI_SEARCH_TRANSPORT = "responses";
export const XAI_PROVIDER_ID = "xai";
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
// Hardcoded on purpose: Pi has no `webSearchModel` setting to mirror. The web-access OpenAI
// transport's `openaiSearchModel` lives in that package's own config file, which this root
// extension must not read. grok-4.3 is the cheapest xAI chat model in Pi 1.4.0's catalog.
export const XAI_SEARCH_MODEL = "grok-4.3";
export const XAI_SEARCH_TIMEOUT_MS = 60_000;
// xAI documents at most five allowed or excluded domains, and never both in one request.
const XAI_MAX_DOMAINS = 5;
const XAI_DEFAULT_RESULT_LIMIT = 20;
const XAI_MAX_OUTPUT_TOKENS = 8192;
const MAX_ERROR_BODY_CHARS = 300;

export type XaiResolvedAuth =
  | { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string }
  | { ok: false; error: string };

/** The subset of Pi's `ModelRegistry` the adapter reads; Pi's registry satisfies it. */
export interface XaiModelRegistry {
  getProviderAuthStatus(provider: string): { configured: boolean };
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
  getApiKeyAndHeaders(model: Model<Api>): Promise<XaiResolvedAuth>;
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
  isUsingOAuth(model: Model<Api>): boolean;
}

export type XaiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface XaiSearchAdapterOptions {
  fetch?: XaiFetch;
  timeoutMs?: number;
  getRegistry?: (context: SearchAdapterContext) => XaiModelRegistry | undefined;
}

interface XaiAttemptSnapshot {
  model: Model<Api> | undefined;
  billing: SearchBilling;
}

const AnnotationSchema = Type.Object({
  type: Type.Literal("url_citation"),
  url: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
  start_index: Type.Optional(Type.Number()),
  end_index: Type.Optional(Type.Number()),
});
const OutputTextSchema = Type.Object({
  type: Type.String(),
  text: Type.String(),
  annotations: Type.Optional(Type.Array(Type.Unknown())),
});
const MessageItemSchema = Type.Object({
  type: Type.Literal("message"),
  content: Type.Array(Type.Unknown()),
});
const SourceSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
});
const WebSearchCallSchema = Type.Object({
  type: Type.Literal("web_search_call"),
  action: Type.Optional(Type.Object({ sources: Type.Optional(Type.Array(Type.Unknown())) })),
});
const XaiResponseSchema = Type.Object({
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  output: Type.Array(Type.Object({ type: Type.String() })),
  citations: Type.Optional(Type.Array(Type.Unknown())),
});
const CitationUrlSchema = Type.String({ minLength: 1 });

function errorOptions(extra: SearchErrorOptions = {}): SearchErrorOptions {
  return {
    family: "xai",
    adapterId: XAI_SEARCH_ADAPTER_ID,
    transport: XAI_SEARCH_TRANSPORT,
    ...extra,
  };
}

function xaiError(
  kind: SearchErrorKind,
  message: string,
  extra: SearchErrorOptions = {},
): SearchError {
  return new SearchError(kind, message, errorOptions(extra));
}

function isCurrent(context: SearchAdapterContext, generation: number): boolean {
  return context.session.active && context.session.generation === generation;
}

function assertCurrent(context: SearchAdapterContext, generation: number): void {
  if (!isCurrent(context, generation)) {
    throw xaiError("stale-context", "xAI search session changed while the request was running");
  }
  if (context.signal.aborted) throw xaiError("cancelled", "xAI search was cancelled");
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function defaultRegistry(context: SearchAdapterContext): XaiModelRegistry | undefined {
  return context.context?.modelRegistry;
}

function findSearchModel(registry: XaiModelRegistry): Model<Api> | undefined {
  return (
    registry.find(XAI_PROVIDER_ID, XAI_SEARCH_MODEL) ??
    registry.getAll().find((model) => model.provider === XAI_PROVIDER_ID)
  );
}

function billingFor(registry: XaiModelRegistry, model: Model<Api> | undefined): SearchBilling {
  if (!model) return "unknown";
  return registry.isUsingOAuth(model) ? "subscription" : "api";
}

function queriesFor(request: SearchRequest): string[] {
  if (request.queries?.length) return request.queries;
  if (request.query) return [request.query];
  throw xaiError("invalid-request", "xAI search requires a query");
}

interface XaiDomainFilters {
  allowed_domains?: string[];
  excluded_domains?: string[];
}

export function buildXaiDomainFilters(
  domainFilter: readonly string[] | undefined,
): XaiDomainFilters | undefined {
  if (!domainFilter?.length) return undefined;
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const raw of domainFilter) {
    const negative = raw.startsWith("-");
    const domain = (negative ? raw.slice(1) : raw).toLowerCase();
    const target = negative ? excluded : allowed;
    if (!target.includes(domain)) target.push(domain);
  }
  if (allowed.length > 0 && excluded.length > 0) {
    throw xaiError(
      "capability",
      "xAI web search cannot combine allowed and excluded domains in one request",
      { retryable: true },
    );
  }
  const list = allowed.length > 0 ? allowed : excluded;
  if (list.length > XAI_MAX_DOMAINS) {
    throw xaiError(
      "capability",
      `xAI web search accepts at most ${XAI_MAX_DOMAINS} domains per filter`,
      { retryable: true },
    );
  }
  return allowed.length > 0 ? { allowed_domains: allowed } : { excluded_domains: excluded };
}

function instructionsFor(request: SearchRequest): string {
  const lines = [
    "Search the web and answer concisely, grounded only in the web results.",
    "Cite sources inline.",
  ];
  if (request.numResults !== undefined) {
    lines.push(
      `Prefer around ${Math.min(request.numResults, XAI_DEFAULT_RESULT_LIMIT)} distinct sources.`,
    );
  }
  return lines.join(" ");
}

export function buildXaiRequestBody(query: string, request: SearchRequest) {
  const filters = buildXaiDomainFilters(request.domainFilter);
  const tool = filters ? { type: "web_search", filters } : { type: "web_search" };
  return {
    model: XAI_SEARCH_MODEL,
    input: [
      { role: "system", content: instructionsFor(request) },
      { role: "user", content: query },
    ],
    tools: [tool],
    store: false,
    stream: false,
    max_output_tokens: XAI_MAX_OUTPUT_TOKENS,
  };
}

function responsesUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw xaiError("config", "xAI provider base URL is not a valid absolute URL", { cause });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw xaiError("config", "xAI provider base URL must use http or https");
  }
  return `${parsed.toString().replace(/\/+$/, "")}/responses`;
}

function requestHeaders(apiKey: string, headers: ProviderHeaders | undefined): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== null) result.set(name, value);
  }
  result.set("Authorization", `Bearer ${apiKey}`);
  result.set("Content-Type", "application/json");
  return result;
}

interface XaiHttpFailure {
  kind: SearchErrorKind;
  retryable: boolean;
}

function httpErrorKind(status: number): XaiHttpFailure {
  let failure: XaiHttpFailure = { kind: "invalid-request", retryable: false };
  if (status === 401 || status === 403) failure = { kind: "auth", retryable: false };
  else if (status === 429) failure = { kind: "quota", retryable: true };
  else if (status === 408 || status >= 500) failure = { kind: "transient", retryable: true };
  return failure;
}

function displayTitle(title: string | undefined, url: string): string {
  // xAI labels inline citations with their visible number ("1", "2"), which is not a title.
  if (title && title.trim() && !/^\d+$/.test(title.trim())) return title.trim();
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function snippetAround(text: string, start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined || !text) return "";
  const snippet = text
    .slice(Math.max(0, start - 150), Math.min(text.length, end + 50))
    .replace(/\[\[(\d+)\]\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

interface ParsedXaiResponse {
  id: string | undefined;
  status: string | undefined;
  answer: string;
  results: SearchResult[];
}

/** Parses a raw xAI Responses API body at the I/O boundary. */
export function parseXaiResponse(text: string, status?: number): ParsedXaiResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw xaiError("invalid-response", "xAI Responses API returned invalid JSON", {
      status,
      retryable: true,
    });
  }
  if (!Check(XaiResponseSchema, value)) {
    throw xaiError("invalid-response", "xAI Responses API returned an unexpected payload", {
      status,
      retryable: true,
    });
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string | undefined, snippet: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ title: displayTitle(title, url), url, snippet });
  };
  const answers: string[] = [];
  for (const item of value.output) {
    if (Check(MessageItemSchema, item)) {
      for (const part of item.content) {
        if (!Check(OutputTextSchema, part)) continue;
        if (part.text.trim()) answers.push(part.text);
        for (const annotation of part.annotations ?? []) {
          if (!Check(AnnotationSchema, annotation)) continue;
          add(
            annotation.url,
            annotation.title,
            snippetAround(part.text, annotation.start_index, annotation.end_index),
          );
        }
      }
    } else if (Check(WebSearchCallSchema, item)) {
      for (const source of item.action?.sources ?? []) {
        if (Check(SourceSchema, source)) add(source.url, source.title, "");
      }
    }
  }
  for (const citation of value.citations ?? []) {
    if (Check(CitationUrlSchema, citation) && citation.trim()) add(citation.trim(), undefined, "");
  }
  return {
    id: value.id,
    status: value.status,
    answer: answers.join("\n").trim(),
    results,
  };
}

interface XaiCallAuth {
  apiKey: string;
  headers: ProviderHeaders | undefined;
  url: string;
}

async function resolveCallAuth(
  registry: XaiModelRegistry,
  model: Model<Api> | undefined,
  context: SearchAdapterContext,
  generation: number,
): Promise<XaiCallAuth> {
  let resolved: XaiResolvedAuth;
  try {
    if (model) {
      resolved = await registry.getApiKeyAndHeaders(model);
    } else {
      const apiKey = await registry.getApiKeyForProvider(XAI_PROVIDER_ID);
      resolved = apiKey ? { ok: true, apiKey } : { ok: false, error: "no credential" };
    }
  } catch (cause) {
    assertCurrent(context, generation);
    throw xaiError("auth", "Failed to resolve xAI credentials from the Pi model registry", {
      cause,
    });
  }
  assertCurrent(context, generation);
  if (!resolved.ok || !resolved.apiKey) {
    throw xaiError(
      "auth",
      "xAI credentials could not be resolved; run /login for xAI or set XAI_API_KEY",
    );
  }
  const baseUrl = resolved.baseUrl ?? model?.baseUrl ?? XAI_DEFAULT_BASE_URL;
  return { apiKey: resolved.apiKey, headers: resolved.headers, url: responsesUrl(baseUrl) };
}

async function callXai(
  fetchImpl: XaiFetch,
  auth: XaiCallAuth,
  query: string,
  request: SearchRequest,
  context: SearchAdapterContext,
  generation: number,
  timeoutMs: number,
): Promise<ParsedXaiResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const body = JSON.stringify(buildXaiRequestBody(query, request));
  let response: Response;
  try {
    response = await fetchImpl(auth.url, {
      method: "POST",
      headers: requestHeaders(auth.apiKey, auth.headers),
      body,
      signal: AbortSignal.any([context.signal, timeout]),
    });
  } catch (cause) {
    assertCurrent(context, generation);
    if (timeout.aborted) {
      throw xaiError("deadline", `xAI search timed out after ${timeoutMs}ms`, {
        deadlineKind: "attempt",
        retryable: true,
      });
    }
    const message = cause instanceof Error ? redact(cause.message, auth.apiKey) : "request failed";
    throw xaiError("network", `xAI request failed: ${message}`, { retryable: true });
  }
  assertCurrent(context, generation);
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    assertCurrent(context, generation);
    if (timeout.aborted) {
      throw xaiError("deadline", `xAI search timed out after ${timeoutMs}ms`, {
        deadlineKind: "attempt",
        retryable: true,
      });
    }
    const message = cause instanceof Error ? redact(cause.message, auth.apiKey) : "read failed";
    throw xaiError("network", `xAI response could not be read: ${message}`, { retryable: true });
  }
  assertCurrent(context, generation);
  if (!response.ok) {
    const { kind, retryable } = httpErrorKind(response.status);
    const detail = redact(text, auth.apiKey)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ERROR_BODY_CHARS);
    throw xaiError(
      kind,
      `xAI Responses API error ${response.status}${detail ? `: ${detail}` : ""}`,
      {
        status: response.status,
        retryable,
      },
    );
  }
  const result = parseXaiResponse(text, response.status);
  if (result.status === "failed") {
    throw xaiError("transient", "xAI Responses API reported a failed response", {
      status: response.status,
      retryable: true,
    });
  }
  if (!result.answer && result.results.length === 0) {
    throw xaiError("invalid-response", "xAI web search returned no answer or citations", {
      status: response.status,
      retryable: true,
    });
  }
  return result;
}

export function createXaiSearchAdapter(options: XaiSearchAdapterOptions = {}): SearchAdapter {
  const fetchImpl: XaiFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? XAI_SEARCH_TIMEOUT_MS;
  const getRegistry = options.getRegistry ?? defaultRegistry;
  const snapshots = new WeakMap<SearchAdapterContext, XaiAttemptSnapshot>();

  function registryFor(
    context: SearchAdapterContext,
    generation: number,
  ): XaiModelRegistry | undefined {
    try {
      return getRegistry(context);
    } catch (cause) {
      assertCurrent(context, generation);
      throw xaiError("config", "Pi model registry is unavailable for xAI search", { cause });
    }
  }

  return {
    id: XAI_SEARCH_ADAPTER_ID,
    family: "xai",
    transport: XAI_SEARCH_TRANSPORT,
    billing: "api",
    // Grok search is billed per call; it runs only when a caller names the xai family.
    explicitOnly: true,
    capabilities: {
      actions: ["search"],
      constraints: { numResults: true, domainFilter: true, domainExclusions: true },
    },
    availability(context): SearchAvailability {
      const generation = context.generation;
      assertCurrent(context, generation);
      const registry = registryFor(context, generation);
      if (!registry) {
        return {
          status: "unavailable",
          reason: "xAI search requires a Pi host context with a model registry",
          transport: XAI_SEARCH_TRANSPORT,
        };
      }
      let configured: boolean;
      let model: Model<Api> | undefined;
      let billing: SearchBilling;
      try {
        configured = registry.getProviderAuthStatus(XAI_PROVIDER_ID).configured;
        model = configured ? findSearchModel(registry) : undefined;
        billing = configured ? billingFor(registry, model) : "api";
      } catch (cause) {
        assertCurrent(context, generation);
        const message = cause instanceof Error ? cause.message : "registry lookup failed";
        return {
          status: "unavailable",
          reason: `xAI provider status could not be read: ${message}`,
          transport: XAI_SEARCH_TRANSPORT,
        };
      }
      if (!configured) {
        return {
          status: "unavailable",
          reason: "xAI provider is not configured; run /login for xAI or set XAI_API_KEY",
          transport: XAI_SEARCH_TRANSPORT,
        };
      }
      snapshots.set(context, { model, billing });
      return { status: "available", transport: XAI_SEARCH_TRANSPORT, billing };
    },
    async execute(request, context): Promise<SearchAdapterResponse> {
      const generation = context.generation;
      assertCurrent(context, generation);
      const queries = queriesFor(request);
      buildXaiDomainFilters(request.domainFilter);
      const registry = registryFor(context, generation);
      if (!registry) {
        throw xaiError("config", "xAI search requires a Pi host context with a model registry");
      }
      const snapshot = snapshots.get(context) ?? {
        model: findSearchModel(registry),
        billing: "unknown",
      };
      const auth = await resolveCallAuth(registry, snapshot.model, context, generation);
      const answers: string[] = [];
      const results: SearchResult[] = [];
      const seen = new Set<string>();
      const responseIds: JsonValue[] = [];
      const warnings: string[] = [];
      for (const query of queries) {
        const parsed = await callXai(
          fetchImpl,
          auth,
          query,
          request,
          context,
          generation,
          timeoutMs,
        );
        if (parsed.id) responseIds.push(parsed.id);
        if (parsed.status === "incomplete") {
          warnings.push("xAI returned an incomplete response; the answer may be truncated.");
        }
        if (parsed.answer)
          answers.push(queries.length > 1 ? `## ${query}\n\n${parsed.answer}` : parsed.answer);
        for (const result of parsed.results) {
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          results.push(result);
        }
      }
      const limit = request.numResults ?? XAI_DEFAULT_RESULT_LIMIT;
      if (results.length > limit) {
        warnings.push(`xAI returned ${results.length} sources; limited to ${limit}.`);
      }
      const response: SearchAdapterResponse = {
        answer: answers.join("\n\n"),
        results: results.slice(0, limit),
        native: { backend: XAI_SEARCH_ADAPTER_ID, model: XAI_SEARCH_MODEL, responseIds },
      };
      if (warnings.length > 0) response.warnings = warnings;
      return response;
    },
  };
}

export function registerXaiSearchAdapter(
  scope: SearchScope,
  options: XaiSearchAdapterOptions = {},
): () => void {
  return registerSearchAdapter(scope, createXaiSearchAdapter(options));
}

export interface XaiRegistrationGate {
  /** Registers when the xai provider is configured and unregisters when it is not. */
  sync(registry: Pick<XaiModelRegistry, "getProviderAuthStatus"> | undefined): boolean;
  dispose(): void;
}

/**
 * Keeps the adapter registered only while Pi reports configured xai credentials, so an
 * unconfigured provider never appears in the curator or provider availability lists.
 * Reads only auth status, never credentials.
 */
export function createXaiRegistrationGate(
  scope: SearchScope,
  options: XaiSearchAdapterOptions = {},
): XaiRegistrationGate {
  let unregister: (() => void) | undefined;
  const dispose = () => {
    unregister?.();
    unregister = undefined;
  };
  return {
    sync(registry) {
      let configured = false;
      try {
        configured = registry?.getProviderAuthStatus(XAI_PROVIDER_ID).configured === true;
      } catch {
        configured = false;
      }
      if (!configured) {
        dispose();
        return false;
      }
      unregister ??= registerXaiSearchAdapter(scope, options);
      return true;
    },
    dispose,
  };
}
