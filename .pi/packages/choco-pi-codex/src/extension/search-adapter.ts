import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSearchScope,
  hasCanonicalSearch,
  registerSearchAdapter,
  SearchError,
  type JsonValue,
  type SearchAdapter,
  type SearchAdapterContext,
  type SearchAdapterResponse,
  type SearchNativeReference,
  type SearchRequest,
  type SearchResult,
} from "../../../choco-pi-web-search/index.ts";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import type { BoundaryRecord, BoundaryValue } from "../tools/boundary.ts";
import { isBooleanValue, isNumberValue, isObjectValue, isStringValue } from "../tools/boundary.ts";
import type {
  CodexWebRunTransportErrorKind,
  OpenAICodexWebRunResult,
} from "../tools/web-run/backend.ts";
import type { CodexToolProviderErrorKind } from "../adapter/codex-tool-provider.ts";
import { conditionalProperties } from "../adapter/runtime-values.ts";

export const CODEX_WEB_RUN_SEARCH_ADAPTER_ID = "codex.web_run";
export const CODEX_WEB_RUN_SEARCH_TRANSPORT = "codex-native";

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadNativeBinary = memoizedImport(() => import("../tools/native/binary.ts"));
const loadToolProvider = memoizedImport(() => import("../adapter/codex-tool-provider.ts"));
const loadWebRunBackend = memoizedImport(() => import("../tools/web-run/backend.ts"));

function nativeWebRunEnabled(config: CodexConversionConfig): boolean {
  return ((!config.voiceFeaturesOnly && config.tools.webRun) || config.tools.webRunOnly) === true;
}

function isCurrent(context: SearchAdapterContext): boolean {
  return (
    context.session.active &&
    context.session.generation === context.generation &&
    !context.signal.aborted
  );
}

function isOwnerCurrent(
  session: SearchAdapterContext["session"],
  generation: number,
  signal: AbortSignal,
): boolean {
  return session.active && session.generation === generation && !signal.aborted;
}

function assertCurrent(context: SearchAdapterContext): void {
  if (context.signal.aborted)
    throw new SearchError("cancelled", "Native OpenAI search was cancelled", {
      family: "openai",
      adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
    });
  if (!isCurrent(context))
    throw new SearchError("stale-context", "Native OpenAI search session is no longer current", {
      family: "openai",
      adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
    });
}

function recencyDays(request: SearchRequest): number | undefined {
  if (request.recencyDays !== undefined) return request.recencyDays;
  switch (request.recencyFilter) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
    case "year":
      return 365;
    default:
      return undefined;
  }
}

function actionFor(request: SearchRequest): "search" | "image" | "open" | "click" | "find" {
  if (request.action) return request.action;
  if (request.imageQuery) return "image";
  if (request.open || request.url) return "open";
  if (request.click) return "click";
  if (request.find) return "find";
  return "search";
}

function nativeReferenceId(context: SearchAdapterContext): string | undefined {
  const refId = context.reference?.id;
  return refId?.trim() ? refId : undefined;
}

function directUrl(request: SearchRequest): string | undefined {
  if (!request.url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch (cause) {
    throw new SearchError("invalid-request", "Open requires a valid HTTP(S) URL", {
      family: "openai",
      adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new SearchError("invalid-request", "Open supports only HTTP(S) URLs", {
      family: "openai",
      adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
    });
  return parsed.toString();
}

function queryItem(query: string, request: SearchRequest): BoundaryRecord {
  const item: BoundaryRecord = { q: query };
  const recent = recencyDays(request);
  if (recent !== undefined) item["recency"] = recent;
  if (request.domainFilter) item["domains"] = [...request.domainFilter];
  return item;
}

export function buildCodexWebRunParams(
  request: SearchRequest,
  context: SearchAdapterContext,
): BoundaryRecord {
  const params: BoundaryRecord = {};
  const action = actionFor(request);
  if (action === "search") {
    const queries = request.queries ?? (request.query ? [request.query] : []);
    params["search_query"] = queries.map((query) => queryItem(query, request));
  } else if (action === "image") {
    const query = request.imageQuery ?? request.query;
    if (query) params["image_query"] = [queryItem(query, request)];
  } else {
    const refId = directUrl(request) ?? nativeReferenceId(context);
    if (!refId)
      throw new SearchError("stale-context", `${action} requires a live native reference`, {
        family: "openai",
        adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
      });
    if (action === "open") {
      const operation: BoundaryRecord = { ref_id: refId };
      if (request.lineno !== undefined) operation["lineno"] = request.lineno;
      params["open"] = [operation];
    } else if (action === "click" && request.click) {
      params["click"] = [{ ref_id: refId, id: request.click.id }];
    } else if (action === "find" && request.find) {
      params["find"] = [{ ref_id: refId, pattern: request.find.pattern }];
    }
  }
  if (request.responseLength) params["response_length"] = request.responseLength;
  if (request.searchContextSize)
    params["settings"] = { search_context_size: request.searchContextSize };
  return params;
}

function jsonValue(value: BoundaryValue): JsonValue | undefined {
  if (value === null || isBooleanValue(value) || isNumberValue(value) || isStringValue(value))
    return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = jsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (!isObjectValue(value)) return undefined;
  const object: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = jsonValue(item);
    if (normalized !== undefined) object[key] = normalized;
  }
  return object;
}

function httpUrl(value: BoundaryValue): string | undefined {
  if (!isStringValue(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedResult(value: BoundaryValue): SearchResult | undefined {
  if (!isObjectValue(value)) return undefined;
  const title = value["title"];
  const snippet = value["snippet"];
  const url = httpUrl(value["url"]);
  if (!url || !isStringValue(title) || !isStringValue(snippet)) return undefined;
  return { title, url, snippet };
}

function collectResults(value: BoundaryValue, results: SearchResult[]): void {
  if (!isObjectValue(value)) return;
  const searchResults = value["search_results"];
  if (!Array.isArray(searchResults)) return;
  for (const item of searchResults) {
    const result = normalizedResult(item);
    if (result) results.push(result);
  }
}

function collectNativeReferenceIds(value: BoundaryValue, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNativeReferenceIds(item, ids);
    return;
  }
  if (!isObjectValue(value)) return;
  const refId = value["ref_id"];
  if (isStringValue(refId) && refId.trim()) ids.add(refId);
  for (const item of Object.values(value)) collectNativeReferenceIds(item, ids);
}

export function normalizeCodexWebRunResponse(
  output: OpenAICodexWebRunResult,
): SearchAdapterResponse {
  const results: SearchResult[] = [];
  collectResults(output.details, results);
  const ids = new Set<string>();
  collectNativeReferenceIds(output.details, ids);
  const references: SearchNativeReference[] = [...ids].map((id) => ({
    id,
    kind: "codex-web-run",
    native: { refId: id },
  }));
  const native = jsonValue(output.details);
  return {
    answer: output.text,
    results,
    ...conditionalProperties(native !== undefined, { native }),
    ...conditionalProperties(references.length > 0, { references }),
  };
}

function providerErrorKind(kind: CodexToolProviderErrorKind): "auth" | "config" {
  return kind === "config" ? "config" : "auth";
}

function transportErrorKind(
  kind: CodexWebRunTransportErrorKind,
):
  | "auth"
  | "cancelled"
  | "config"
  | "invalid-request"
  | "invalid-response"
  | "network"
  | "quota"
  | "stale-context"
  | "transient" {
  switch (kind) {
    case "auth":
      return "auth";
    case "cancelled":
      return "cancelled";
    case "config":
    case "missing_binary":
      return "config";
    case "request":
      return "invalid-request";
    case "network":
      return "network";
    case "quota":
      return "quota";
    case "stale_session":
      return "stale-context";
    case "protocol":
      return "invalid-response";
    case "transport":
      return "transient";
  }
}

function searchError(
  kind:
    | "auth"
    | "cancelled"
    | "config"
    | "invalid-request"
    | "invalid-response"
    | "network"
    | "quota"
    | "stale-context"
    | "transient",
  error: Error,
  status?: number | undefined,
): SearchError {
  return new SearchError(kind, error.message, {
    family: "openai",
    adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
    ...conditionalProperties(status !== undefined, { status }),
    ...conditionalProperties(kind === "quota", { retryable: status === 429 }),
    cause: error,
  });
}

export function createCodexWebRunSearchAdapter(
  getConfig: () => CodexConversionConfig,
): SearchAdapter {
  return {
    id: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
    family: "openai",
    transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
    priority: -100,
    billing: "subscription",
    capabilities: {
      actions: ["search", "image", "open", "click", "find"],
      constraints: {
        url: true,
        lineno: true,
        recencyFilter: true,
        recencyDays: true,
        domainFilter: true,
        responseLength: true,
        searchContextSize: true,
      },
    },
    async availability(context) {
      const config = structuredClone(getConfig());
      const hostContext = context.context;
      const modelRegistry = hostContext?.modelRegistry;
      const customRustBinariesDir = config.tools.customRustBinariesDir;
      assertCurrent(context);
      if (!nativeWebRunEnabled(config))
        return {
          status: "disabled",
          reason: "Native OpenAI web search is disabled by Codex tool configuration",
          transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
          billing: "subscription",
        };
      if (!modelRegistry)
        return {
          status: "unavailable",
          reason: "Native OpenAI web search requires a bound host context",
          transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
          billing: "subscription",
        };
      const [{ getBundledToolBinaryPath }, providerModule] = await Promise.all([
        loadNativeBinary(),
        loadToolProvider(),
      ]);
      assertCurrent(context);
      const binaryPath =
        process.env["PI_CODEX_WEB_RUN_BIN"]?.trim() ||
        getBundledToolBinaryPath("web_run", {}, customRustBinariesDir);
      if (!binaryPath)
        return {
          status: "unavailable",
          reason: `web_run binary is not bundled for ${process.platform}-${process.arch}`,
          transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
          billing: "subscription",
        };
      try {
        await providerModule.resolveOpenAICodexToolProvider(modelRegistry);
        assertCurrent(context);
      } catch (error) {
        assertCurrent(context);
        if (error instanceof providerModule.CodexToolProviderError) {
          if (error.kind === "auth") throw searchError("auth", error);
          return {
            status: error.kind === "config" ? "error" : "unavailable",
            reason:
              error.kind === "missing_credentials"
                ? "OpenAI Codex subscription credentials are not configured"
                : error.message,
            transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
            billing: "subscription",
          };
        }
        throw error;
      }
      return {
        status: "available",
        transport: CODEX_WEB_RUN_SEARCH_TRANSPORT,
        billing: "subscription",
      };
    },
    async execute(request, context) {
      const config = structuredClone(getConfig());
      const hostContext = context.context;
      const modelRegistry = hostContext?.modelRegistry;
      const customRustBinariesDir = config.tools.customRustBinariesDir;
      const model = config.openai.webSearchModel;
      const ownerSession = context.session;
      const ownerGeneration = context.generation;
      const ownerSignal = context.signal;
      const sessionId = ownerSession.id;
      assertCurrent(context);
      if (!nativeWebRunEnabled(config))
        throw new SearchError("config", "Native OpenAI web search is disabled", {
          family: "openai",
          adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
        });
      if (!modelRegistry)
        throw new SearchError("stale-context", "Native OpenAI search lost its host context", {
          family: "openai",
          adapterId: CODEX_WEB_RUN_SEARCH_ADAPTER_ID,
        });
      const params = buildCodexWebRunParams(request, context);
      const [
        { getBundledToolBinaryPath },
        providerModule,
        { CodexWebRunTransportError, executeOpenAICodexWebRun },
      ] = await Promise.all([loadNativeBinary(), loadToolProvider(), loadWebRunBackend()]);
      assertCurrent(context);
      const binaryPath =
        process.env["PI_CODEX_WEB_RUN_BIN"]?.trim() ||
        getBundledToolBinaryPath("web_run", {}, customRustBinariesDir);
      let provider;
      try {
        provider = await providerModule.resolveOpenAICodexToolProvider(modelRegistry);
        assertCurrent(context);
      } catch (error) {
        assertCurrent(context);
        if (error instanceof providerModule.CodexToolProviderError)
          throw searchError(providerErrorKind(error.kind), error);
        throw error;
      }
      try {
        const output = await executeOpenAICodexWebRun({
          binaryPath,
          params,
          provider,
          sessionId,
          model,
          signal: ownerSignal,
          isSessionCurrent: () => isOwnerCurrent(ownerSession, ownerGeneration, ownerSignal),
        });
        assertCurrent(context);
        return normalizeCodexWebRunResponse(output);
      } catch (error) {
        assertCurrent(context);
        if (error instanceof CodexWebRunTransportError)
          throw searchError(transportErrorKind(error.kind), error, error.status);
        throw error;
      }
    },
  };
}

export interface CodexWebSearchAdapterRegistration {
  canonical: boolean;
  unregister(): void;
}

export function registerCodexWebRunSearchAdapter(
  pi: Pick<ExtensionAPI, "events">,
  runtime: { state: Pick<AdapterState, "canonicalSearch" | "config"> },
): CodexWebSearchAdapterRegistration {
  const scope = getSearchScope(pi.events);
  const canonical = hasCanonicalSearch(scope);
  runtime.state.canonicalSearch = canonical;
  const unregister = registerSearchAdapter(
    scope,
    createCodexWebRunSearchAdapter(() => runtime.state.config),
  );
  return { canonical, unregister };
}
