import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type SearchAdapter,
  type SearchAdapterContext,
  SearchError,
  type SearchErrorKind,
  type SearchRequest,
} from "../../../choco-pi-web-search/index.ts";
import { resolveSyntheticClientOptions } from "../../src/client/utility-api.ts";
import type { ResolvedSyntheticConfig } from "../../src/config.ts";
import {
  createSyntheticSearchBackend,
  SYNTHETIC_SEARCH_ADAPTER_ID,
  type SyntheticSearchFailure,
} from "./backend.ts";

const MAX_TOTAL_SNIPPET_BYTES = 20_000;
const MAX_RESULT_SNIPPET_BYTES = 4_000;

export interface SyntheticSearchAdapterDependencies {
  getConfig: () => ResolvedSyntheticConfig;
}

function getApiKey(context: ExtensionContext | undefined): Promise<string | undefined> {
  return context
    ? context.modelRegistry.getApiKeyForProvider("synthetic")
    : Promise.resolve(undefined);
}

function coreErrorKind(failure: SyntheticSearchFailure): SearchErrorKind {
  switch (failure.kind) {
    case "aborted":
      return "cancelled";
    case "stale":
      return "stale-context";
    case "disabled":
    case "unconfigured":
      return "config";
    case "ineligible":
      return "entitlement";
    case "auth":
    case "quota":
    case "network":
      return failure.kind;
    case "request":
      return failure.retryable ? "transient" : "invalid-response";
  }
}

function throwCoreError(failure: SyntheticSearchFailure): never {
  throw new SearchError(coreErrorKind(failure), failure.message, {
    family: "synthetic",
    adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
    retryable: failure.retryable,
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function queryFor(request: SearchRequest): string {
  if (request.query) return request.query;
  const queries = request.queries;
  if (queries?.length) return queries.join("\n");
  throw new SearchError("invalid-request", "Synthetic search requires a query", {
    family: "synthetic",
    adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
  });
}

export function createSyntheticSearchAdapter(
  dependencies: SyntheticSearchAdapterDependencies,
): SearchAdapter {
  return {
    id: SYNTHETIC_SEARCH_ADAPTER_ID,
    family: "synthetic",
    transport: "synthetic-v2-search",
    billing: "subscription",
    capabilities: {
      actions: ["search"],
      constraints: { numResults: true },
    },
    async availability(context: SearchAdapterContext) {
      const config = dependencies.getConfig();
      if (!config.webSearch) {
        return {
          status: "disabled",
          reason: "Synthetic web search is disabled by configuration.",
          transport: "synthetic-v2-search",
          billing: "subscription",
        } as const;
      }
      let options: Awaited<ReturnType<typeof resolveSyntheticClientOptions>>;
      try {
        options = await resolveSyntheticClientOptions(config, () => getApiKey(context.context));
      } catch {
        if (context.signal.aborted) {
          throw new SearchError("cancelled", "Synthetic web search was cancelled", {
            family: "synthetic",
            adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
          });
        }
        throw new SearchError("auth", "Synthetic credentials could not be resolved", {
          family: "synthetic",
          adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
          retryable: true,
        });
      }
      if (context.signal.aborted) {
        throw new SearchError("cancelled", "Synthetic web search was cancelled", {
          family: "synthetic",
          adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
        });
      }
      if (!options) {
        return {
          status: "unavailable",
          reason: "Synthetic credentials or an unauthenticated proxy are required.",
          transport: "synthetic-v2-search",
          billing: "subscription",
        } as const;
      }
      return {
        status: "available",
        transport: "synthetic-v2-search",
        billing: "subscription",
      } as const;
    },
    async execute(request, context) {
      const config = dependencies.getConfig();
      const backend = createSyntheticSearchBackend({
        loadConfig: async () => config,
        getApiKey: () => getApiKey(context.context),
      });
      const execution = await backend.search(queryFor(request), context.signal);
      if (!execution.ok) throwCoreError(execution.error);

      const resultLimit = request.numResults ?? execution.results.length;
      const selected = execution.results.slice(0, resultLimit);
      const maxSnippetBytes =
        selected.length === 0
          ? 0
          : Math.min(
              MAX_RESULT_SNIPPET_BYTES,
              Math.floor(MAX_TOTAL_SNIPPET_BYTES / selected.length),
            );
      let excerpted = 0;
      const results = selected.map((result) => {
        const snippet = truncateUtf8(result.text, maxSnippetBytes);
        if (snippet !== result.text) excerpted++;
        return { title: result.title, url: result.url, snippet };
      });
      const warnings: string[] = [];
      if (selected.length < execution.results.length) {
        warnings.push(
          `Synthetic returned ${execution.results.length} results; limited to ${selected.length} by numResults.`,
        );
      }
      if (excerpted > 0) {
        warnings.push(
          `${excerpted} Synthetic result snippet(s) were excerpted to the shared 20KB response budget.`,
        );
      }
      return {
        answer: "",
        results,
        warnings,
        native: {
          backend: SYNTHETIC_SEARCH_ADAPTER_ID,
          providerFamily: "synthetic",
          published: selected.map((result) => result.published),
        },
      };
    },
  };
}
