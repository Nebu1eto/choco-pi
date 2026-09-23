import type { AgentBrowserConfigState, WebSearchProvider } from "./config.ts";
import {
  SearchError,
  registerSearchAdapter,
  type JsonValue,
  type SearchAdapter,
  type SearchAdapterContext,
  type SearchAdapterResponse,
  type SearchRequest,
  type SearchScope,
} from "../../../../choco-pi-web-search/index.ts";

import {
  AGENT_BROWSER_SEARCH_BACKENDS,
  AgentBrowserSearchError,
  WebSearchRequestGate,
  executeAgentBrowserSearchBackend,
  getAgentBrowserSearchBackendAvailability,
  type AgentBrowserSearchBackendRequest,
  type AgentBrowserSearchBackendResponse,
} from "./web-search.ts";

export interface AgentBrowserSearchAdapterOptions {
  loadConfigState(context: SearchAdapterContext): Promise<AgentBrowserConfigState>;
}

function assertAdapterContextCurrent(context: SearchAdapterContext): void {
  if (!context.session.active || context.session.generation !== context.generation) {
    throw new SearchError("stale-context", "Agent-browser search session is stale");
  }
  if (context.signal.aborted) {
    throw new SearchError("cancelled", "Agent-browser search was cancelled");
  }
}

function freshnessFor(request: SearchRequest): AgentBrowserSearchBackendRequest["freshness"] {
  switch (request.recencyFilter) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

function toBackendRequest(
  provider: WebSearchProvider,
  request: SearchRequest,
): AgentBrowserSearchBackendRequest {
  if (!request.query) {
    throw new SearchError("invalid-request", `${provider} search requires one query`, {
      family: provider,
      adapterId: `agent-browser.${provider}`,
    });
  }
  const requestedCount = request.numResults ?? 5;
  return {
    count: provider === "brave" ? Math.min(requestedCount, 10) : requestedCount,
    country: request.country,
    freshness: freshnessFor(request),
    offset: request.offset ?? 0,
    query: request.query,
    safesearch: request.safesearch,
    searchLang: request.language,
    searchType: request.exaSearchType,
  };
}

function resultMetadata(response: AgentBrowserSearchBackendResponse): JsonValue[] {
  return response.results.map((result) => {
    const metadata = { title: result.title, url: result.url };
    if (result.age) Object.assign(metadata, { age: result.age });
    if (result.description) Object.assign(metadata, { description: result.description });
    if (result.highlights) Object.assign(metadata, { highlights: result.highlights });
    if (result.language) Object.assign(metadata, { language: result.language });
    if (result.source) Object.assign(metadata, { source: result.source });
    return metadata;
  });
}

function toCanonicalResponse(response: AgentBrowserSearchBackendResponse): SearchAdapterResponse {
  let diagnostics: JsonValue = null;
  if (response.extraDetails) {
    const details = {};
    if (response.extraDetails.requestId) {
      Object.assign(details, { requestId: response.extraDetails.requestId });
    }
    if (response.extraDetails.searchType) {
      Object.assign(details, { searchType: response.extraDetails.searchType });
    }
    diagnostics = details;
  }
  return {
    answer: "",
    native: {
      diagnostics,
      provider: response.provider,
      resultMetadata: resultMetadata(response),
      returnedQuery: response.returnedQuery,
    },
    results: response.results.map((result) => ({
      snippet: result.description ?? result.highlights?.join(" ") ?? "",
      title: result.title,
      url: result.url,
    })),
  };
}

function translateBackendError(
  error: AgentBrowserSearchError,
  provider: WebSearchProvider,
): SearchError {
  return new SearchError(error.kind, error.message, {
    adapterId: `agent-browser.${provider}`,
    cause: error,
    deadlineKind: error.kind === "deadline" ? "attempt" : undefined,
    family: provider,
    retryable: error.kind === "deadline" ? true : error.retryable,
    status: error.status,
  });
}

function createAdapter(
  provider: WebSearchProvider,
  requestGate: WebSearchRequestGate,
  options: AgentBrowserSearchAdapterOptions,
): SearchAdapter {
  const descriptor = AGENT_BROWSER_SEARCH_BACKENDS[provider];
  const constraints = {
    country: true,
    exaSearchType: provider === "exa",
    language: provider === "brave",
    numResults: provider === "exa",
    offset: true,
    recencyFilter: true,
    safesearch: true,
  } as const;
  return {
    billing: "api",
    capabilities: { actions: ["search"], constraints },
    family: provider,
    id: descriptor.id,
    priority: descriptor.priority,
    transport: descriptor.transport,
    async availability(context) {
      const session = context.session;
      const generation = context.generation;
      const configState = await options.loadConfigState(context);
      if (!session.active || session.generation !== generation) {
        throw new SearchError("stale-context", "Agent-browser search session changed");
      }
      assertAdapterContextCurrent(context);
      return {
        ...getAgentBrowserSearchBackendAvailability(configState, provider),
        billing: "api",
        transport: descriptor.transport,
      };
    },
    async execute(request, context) {
      const session = context.session;
      const generation = context.generation;
      const backendRequest = toBackendRequest(provider, request);
      const configState = await options.loadConfigState(context);
      if (!session.active || session.generation !== generation) {
        throw new SearchError("stale-context", "Agent-browser search session changed");
      }
      assertAdapterContextCurrent(context);
      try {
        const response = await executeAgentBrowserSearchBackend({
          configState,
          guard: {
            generation,
            isCurrent: (expectedGeneration) =>
              session.active && session.generation === expectedGeneration,
          },
          provider,
          request: backendRequest,
          requestGate,
          signal: context.signal,
        });
        assertAdapterContextCurrent(context);
        return toCanonicalResponse(response);
      } catch (error) {
        if (error instanceof AgentBrowserSearchError) {
          throw translateBackendError(error, provider);
        }
        throw error;
      }
    },
  };
}

export function registerAgentBrowserSearchAdapters(
  scope: SearchScope,
  options: AgentBrowserSearchAdapterOptions,
): () => void {
  const requestGate = new WebSearchRequestGate();
  const unregisterBrave = registerSearchAdapter(
    scope,
    createAdapter("brave", requestGate, options),
  );
  let unregisterExa: () => void;
  try {
    unregisterExa = registerSearchAdapter(scope, createAdapter("exa", requestGate, options));
  } catch (error) {
    unregisterBrave();
    throw error;
  }
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    unregisterExa();
    unregisterBrave();
  };
}
