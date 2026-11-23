import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "../schema-bridge.ts";
import { rejectLegacyParamNames } from "../snake-params.ts";
import { isAbortError, isNumberValue, isStringValue } from "../value-guards.ts";
import type { ExtractedContent } from "../extract.ts";
import { search } from "../gemini-search.ts";
import type { SearchResult } from "../search-types.ts";
import {
  buildResearchArtifact,
  storeResearchArtifact,
  withClaimAssessment,
} from "../source-check.ts";
import {
  normalizeRecencyFilter,
  resolveRequestedProvider,
  searchProviderSchema,
  type ToolNames,
} from "../extension-config.ts";
import { formatSourceCheckResult } from "../search-formatting.ts";
import { fetchAllContent, type SearchRuntime } from "../curator-lifecycle.ts";

export function registerSourceCheckTool(
  pi: ExtensionAPI,
  _runtime: SearchRuntime,
  toolNames: ToolNames,
  getSearchContentEnabled: boolean,
): void {
  pi.registerTool({
    name: toolNames.sourceCheck,
    label: "Source Check",
    description:
      "Check a claim against web sources and return a bounded machine-readable research artifact with exact passage citations.",
    promptSnippet: "Verify a claim with passage-level source citations.",
    parameters: hostParams(
      obj({
        claim: str({ description: "The assertion to check against web sources." }),
        queries: opt(arr(str(), { description: "Search queries (default: the claim)." })),
        num_results: opt(
          int({
            minimum: 1,
            maximum: 20,
            description: "Results per query (default: 5, max: 20).",
          }),
        ),
        fetch_content: opt(
          bool({ description: "Fetch up to 5 result pages for exact passage extraction." }),
        ),
        recency_filter: opt(
          oneOf(["day", "week", "month", "year"], { description: "Filter by recency." }),
        ),
        domain_filter: opt(
          arr(str(), { description: "Limit to domains; prefix with - to exclude." }),
        ),
        provider: opt(
          searchProviderSchema(
            "Search provider or non-empty list of providers to search simultaneously; all searches every available provider",
          ),
        ),
      }),
    ),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      rejectLegacyParamNames(Object.keys(params), [
        "numResults",
        "fetchContent",
        "recencyFilter",
        "domainFilter",
      ]);
      const claim = isStringValue(params.claim) ? params.claim.trim() : "";
      if (!claim) {
        return {
          content: [{ type: "text", text: "Error: 'claim' is required." }],
          details: { error: "Missing claim" },
        };
      }

      const requestedQueries = Array.isArray(params.queries)
        ? params.queries
            .filter((query): query is string => isStringValue(query))
            .map((query) => query.trim())
            .filter(Boolean)
        : [];
      const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
      const numResults =
        isNumberValue(params.num_results) && Number.isFinite(params.num_results)
          ? Math.min(20, Math.max(1, Math.floor(params.num_results)))
          : 5;
      const domainFilter = Array.isArray(params.domain_filter)
        ? params.domain_filter.filter((domain): domain is string => isStringValue(domain))
        : undefined;
      const recencyFilter = normalizeRecencyFilter(params.recency_filter);
      const resultsByUrl = new Map<string, SearchResult>();
      const summaries: string[] = [];
      const errors: Array<{ query: string; error: string }> = [];
      let provider: string | undefined;
      let backend: string | undefined;
      const searchWarnings = new Set<string>();

      for (const query of queries) {
        if (signal?.aborted) break;
        try {
          const response = await search(query, {
            provider: resolveRequestedProvider(params.provider),
            numResults,
            recencyFilter,
            domainFilter,
            signal,
            extensionContext: ctx,
          });
          if (signal?.aborted) break;
          provider ??= response.provider;
          backend ??= response.transport;
          for (const warning of response.warnings ?? []) searchWarnings.add(warning);
          if (response.answer) summaries.push(`${query}: ${response.answer}`);
          for (const result of response.results) {
            if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
          }
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) break;
          errors.push({ query, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const results = [...resultsByUrl.values()]
        .slice(0, 20)
        .map((result, index) => ({ ...result, rank: index + 1 }));
      let fetched: ExtractedContent[] = [];
      if (params.fetch_content && results.length > 0) {
        const urls = results.slice(0, 5).map((result) => result.url);
        try {
          fetched = await fetchAllContent(urls, signal);
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) throw err;
          fetched = urls.map((url) => ({
            url,
            title: "",
            content: "",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
      const artifact = withClaimAssessment(
        buildResearchArtifact({
          query: claim,
          provider,
          backend,
          warnings: [...searchWarnings],
          summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
          results,
          fetched,
          recency: recencyFilter,
          domainFilter,
        }),
        [claim],
      );
      if (errors.length > 0) artifact.errors = errors;
      storeResearchArtifact(artifact);
      pi.appendEntry("web-search-results", {
        id: artifact.id,
        type: "research",
        timestamp: artifact.timestamp,
        artifact,
      });
      return {
        content: [
          {
            type: "text",
            text: formatSourceCheckResult(
              artifact,
              getSearchContentEnabled ? toolNames.getSearchContent : null,
            ),
          },
        ],
        details: {
          responseId: artifact.id,
          artifact,
          sourceCount: artifact.sources.length,
          passageCount: artifact.passages.length,
        },
      };
    },
  });
}
