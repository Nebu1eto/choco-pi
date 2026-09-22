import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSearchScope,
  registerSearchAdapter,
  SearchError,
  type SearchAdapterContext,
  type SearchAdapterResponse,
  type SearchErrorKind,
  type SearchRequest,
} from "../choco-pi-web-search/index.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import {
  resolveExaApiKey,
  searchWithExaApi,
  searchWithExaMcp,
  type ExaSearchOptions,
} from "./exa.ts";
import { resolveKagiApiKey, searchWithKagiApi, type KagiSearchOptions } from "./kagi.ts";
import {
  resolveOpenAIAuth,
  searchWithResolvedOpenAIAuth,
  type OpenAIResolvedAuth,
} from "./openai-search.ts";
import type { SearchResponse as LegacySearchResponse } from "./search-types.ts";
import { SearchTransportError, type SearchTransportFailureKind } from "./transport-error.ts";

const openAIAuthByAttempt = new WeakMap<SearchAdapterContext, OpenAIResolvedAuth>();
const exaKeyByAttempt = new WeakMap<SearchAdapterContext, string>();
const kagiKeyByAttempt = new WeakMap<SearchAdapterContext, string>();

function coreErrorKind(kind: SearchTransportFailureKind): SearchErrorKind {
  switch (kind) {
    case "auth":
      return "auth";
    case "cancelled":
      return "cancelled";
    case "config":
      return "config";
    case "network":
      return "network";
    case "quota":
      return "quota";
    case "request":
      return "invalid-request";
    case "response":
      return "invalid-response";
    case "stale":
      return "stale-context";
    case "transient":
      return "transient";
  }
}

function adapterError(cause: unknown, family: "openai" | "exa" | "kagi", id: string): SearchError {
  if (cause instanceof SearchError) return cause;
  if (cause instanceof SearchTransportError) {
    return new SearchError(coreErrorKind(cause.kind), cause.message, {
      family,
      adapterId: id,
      status: cause.status,
      retryable: cause.retryable,
    });
  }
  if (cause instanceof CredentialResolutionError) {
    return new SearchError(
      cause.category === "command-aborted" ? "cancelled" : "config",
      cause.message,
      { family, adapterId: id },
    );
  }
  return new SearchError(
    "invalid-response",
    cause instanceof Error ? cause.message : String(cause),
    {
      family,
      adapterId: id,
    },
  );
}

function requestQueries(request: SearchRequest): string[] {
  if (request.queries?.length) return request.queries;
  return request.query ? [request.query] : [];
}

function combineLegacyResponses(responses: LegacySearchResponse[]): SearchAdapterResponse {
  const seenResults = new Set<string>();
  const seenContent = new Set<string>();
  return {
    answer: responses
      .map((response) => response.answer)
      .filter(Boolean)
      .join("\n\n"),
    results: responses
      .flatMap((response) => response.results)
      .filter((result) => {
        if (seenResults.has(result.url)) return false;
        seenResults.add(result.url);
        return true;
      }),
    inlineContent: responses
      .flatMap((response) => response.inlineContent ?? [])
      .filter((entry) => {
        if (seenContent.has(entry.url)) return false;
        seenContent.add(entry.url);
        return true;
      }),
  };
}

function legacyOptions(request: SearchRequest, signal: AbortSignal): ExaSearchOptions {
  const options: ExaSearchOptions = { signal };
  if (request.numResults !== undefined) options.numResults = request.numResults;
  if (request.recencyFilter) options.recencyFilter = request.recencyFilter;
  if (request.domainFilter) options.domainFilter = request.domainFilter;
  if (request.includeContent !== undefined) options.includeContent = request.includeContent;
  if (request.exaSearchType) options.exaSearchType = request.exaSearchType;
  if (request.answerMode) options.answerMode = request.answerMode;
  return options;
}

async function executeQueries(
  request: SearchRequest,
  context: SearchAdapterContext,
  operation: (query: string) => Promise<LegacySearchResponse | null>,
): Promise<SearchAdapterResponse> {
  const responses: LegacySearchResponse[] = [];
  for (const query of requestQueries(request)) {
    if (!context.session.active || context.session.generation !== context.generation) {
      throw new SearchError("stale-context", "Search session changed during adapter execution");
    }
    const response = await operation(query);
    if (!context.session.active || context.session.generation !== context.generation) {
      throw new SearchError("stale-context", "Search session changed during adapter execution");
    }
    if (response) responses.push(response);
  }
  return combineLegacyResponses(responses);
}

export function registerWebAccessSearchAdapters(pi: Pick<ExtensionAPI, "events">): void {
  if (!pi.events) return;
  const scope = getSearchScope(pi.events);

  registerSearchAdapter(scope, {
    id: "web-access.openai",
    family: "openai",
    transport: "responses-api",
    priority: 20,
    billing: "api",
    capabilities: {
      actions: ["search"],
      constraints: {
        numResults: false,
        domainFilter: true,
        recencyFilter: false,
      },
    },
    async availability(context) {
      try {
        const auth = await resolveOpenAIAuth(context.context, {
          signal: context.signal,
          isCurrent: () =>
            context.session.active && context.session.generation === context.generation,
        });
        if (!auth)
          return { status: "unavailable", reason: "OpenAI credentials are not configured" };
        openAIAuthByAttempt.set(context, auth);
        return {
          status: "available",
          transport: auth.transport,
          billing: auth.billing,
        };
      } catch (cause) {
        throw adapterError(cause, "openai", "web-access.openai");
      }
    },
    async execute(request, context) {
      try {
        const auth = openAIAuthByAttempt.get(context);
        if (!auth) throw new SearchError("stale-context", "OpenAI auth snapshot is unavailable");
        return await executeQueries(request, context, (query) =>
          searchWithResolvedOpenAIAuth(query, legacyOptions(request, context.signal), auth),
        );
      } catch (cause) {
        throw adapterError(cause, "openai", "web-access.openai");
      }
    },
  });

  registerSearchAdapter(scope, {
    id: "web-access.exa",
    family: "exa",
    transport: "exa-dynamic",
    priority: 10,
    billing: "free",
    capabilities: {
      actions: ["search"],
      constraints: {
        numResults: true,
        recencyFilter: true,
        domainFilter: true,
        domainExclusions: true,
        includeContent: true,
        exaSearchType: true,
        answerMode: true,
      },
    },
    async availability(context) {
      try {
        const key = await resolveExaApiKey(context.signal);
        if (key) exaKeyByAttempt.set(context, key);
        return {
          status: "available",
          transport: key ? "exa-api" : "exa-mcp",
          billing: key ? "api" : "free",
        };
      } catch (cause) {
        throw adapterError(cause, "exa", "web-access.exa");
      }
    },
    async execute(request, context) {
      try {
        const key = exaKeyByAttempt.get(context);
        if (!key && request.answerMode) {
          throw new SearchError(
            "capability",
            "Exa MCP cannot guarantee recency or domain filters; configure an Exa API key",
            { family: "exa", adapterId: "web-access.exa", retryable: true },
          );
        }
        return await executeQueries(request, context, (query) =>
          key
            ? searchWithExaApi(query, legacyOptions(request, context.signal), key)
            : searchWithExaMcp(query, legacyOptions(request, context.signal)),
        );
      } catch (cause) {
        throw adapterError(cause, "exa", "web-access.exa");
      }
    },
  });

  registerSearchAdapter(scope, {
    id: "web-access.kagi",
    family: "kagi",
    transport: "kagi-api",
    priority: 10,
    billing: "api",
    capabilities: {
      actions: ["search"],
      constraints: { numResults: true, includeContent: true },
    },
    async availability(context) {
      try {
        const key = await resolveKagiApiKey(context.signal);
        if (!key) return { status: "unavailable", reason: "Kagi API key is not configured" };
        kagiKeyByAttempt.set(context, key);
        return { status: "available", transport: "kagi-api", billing: "api" };
      } catch (cause) {
        throw adapterError(cause, "kagi", "web-access.kagi");
      }
    },
    async execute(request, context) {
      try {
        const key = kagiKeyByAttempt.get(context);
        if (!key) throw new SearchError("stale-context", "Kagi auth snapshot is unavailable");
        const options: KagiSearchOptions = legacyOptions(request, context.signal);
        return await executeQueries(request, context, (query) =>
          searchWithKagiApi(query, options, key),
        );
      } catch (cause) {
        throw adapterError(cause, "kagi", "web-access.kagi");
      }
    },
  });
}
