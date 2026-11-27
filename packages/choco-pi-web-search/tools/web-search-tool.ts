import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import pLimit from "p-limit";
import { hasCanonicalSearch, isSearchError, search as unifiedSearch } from "../index.ts";
import { hostParamsAs } from "../schema-bridge.ts";
import { toCanonicalSearchParams } from "../snake-params.ts";
import { isAbortError } from "../value-guards.ts";
import type { ExtractedContent } from "../extract.ts";
import {
  getConfiguredSearchDeadlines,
  getConfiguredSearchRouting,
  search,
} from "../gemini-search.ts";
import {
  generateSummaryDraft,
  type SummaryGenerationContext,
  type SummaryMeta,
} from "../summary-review.ts";
import type { QueryResultData } from "../storage.ts";
import { buildSearchErrorPlan, type SearchErrorDetails } from "../render-search-error.ts";
import {
  getSummaryGenerationDeadlineMs,
  isSummaryEnabled,
  loadConfigForExtensionInit,
  normalizeQueryList,
  normalizeRecencyFilter,
  resolveRequestedProvider,
  toProviderLabel,
  webSearchParams,
  type DetailObject,
  type SummaryWorkflow,
  type ToolNames,
  type WebSearchParams,
} from "../extension-config.ts";
import {
  canonicalRequestForQuery,
  formatOwnedReferences,
  formatSearchDiagnostics,
  renderSearchErrorPlan,
  searchOptionsForCanonicalRequest,
} from "../search-formatting.ts";
import type { SearchRuntime } from "../search-runtime.ts";

const MAX_CONCURRENT_QUERIES = 3;

export function registerWebSearchTool(
  pi: ExtensionAPI,
  runtime: SearchRuntime,
  toolNames: ToolNames,
  getSearchContentEnabled: boolean,
): void {
  const {
    publishReferences,
    publishAttributedReferences,
    resolveCoreReference,
    loadSummaryModelChoices,
    buildSearchReturn,
  } = runtime;
  pi.registerTool({
    name: toolNames.webSearch,
    label: "Web Search",
    description:
      "Search the web and return a concise cited summary. Full raw results are stored and retrievable via get_search_content.",
    promptSnippet: "Search the web and synthesize cited results.",
    parameters: hostParamsAs<WebSearchParams>(webSearchParams),

    async execute(
      _callId,
      rawParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<DetailObject>> {
      const params = toCanonicalSearchParams(rawParams);
      const directAction =
        (params.action !== undefined && params.action !== "search") ||
        params.imageQuery !== undefined ||
        params.url !== undefined ||
        params.open === true ||
        params.click !== undefined ||
        params.find !== undefined ||
        params.reference !== undefined;
      if (directAction) {
        if (!hasCanonicalSearch(pi.events)) {
          return {
            content: [
              {
                type: "text",
                text: "Error: This search action requires unified search core.",
              },
            ],
            details: { error: "Direct search action requires unified search core" },
          };
        }
        if (!ctx) {
          return {
            content: [{ type: "text", text: "Error: This search action requires a live session." }],
            details: { error: "Missing extension context" },
          };
        }
        const request = canonicalRequestForQuery(params);
        resolveCoreReference(request);
        const config = loadConfigForExtensionInit();
        const deadlines = getConfiguredSearchDeadlines();
        const response = await unifiedSearch(request, {
          context: ctx,
          signal,
          routing: getConfiguredSearchRouting(),
          allowBilledApiFallback: config.allowBilledApiFallback === true,
          attemptDeadlineMs: deadlines.attemptDeadlineMs,
          totalDeadlineMs: deadlines.totalDeadlineMs,
        });
        const references = publishReferences(response.references);
        const resultLines = response.results.map(
          (result) =>
            `- [${result.title}](${result.url})${result.snippet ? ` — ${result.snippet}` : ""}`,
        );
        const diagnosticLines = formatSearchDiagnostics({
          query: request.query ?? request.imageQuery ?? request.url ?? "direct action",
          answer: response.answer,
          results: response.results,
          error: null,
          provider: response.provider,
          backend: response.transport,
          adapterId: response.adapterId,
          transport: response.transport,
          billing: response.billing,
          warnings: response.warnings,
          attempts: response.attempts,
          providerErrors: response.providerErrors,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                response.answer,
                ...resultLines,
                ...formatOwnedReferences(references),
                ...(diagnosticLines.length > 0
                  ? ["**Search diagnostics:**", ...diagnosticLines]
                  : []),
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          details: {
            provider: response.provider,
            adapterId: response.adapterId,
            transport: response.transport,
            billing: response.billing,
            warnings: response.warnings,
            attempts: response.attempts.map((attempt) => ({ ...attempt })),
            providerErrors: response.providerErrors?.map((failure) => ({ ...failure })),
            references: references?.map((reference) => ({ ...reference })),
          },
        };
      }

      const rawQueryList: unknown[] = Array.isArray(params.queries)
        ? params.queries
        : params.query === undefined
          ? []
          : [params.query];
      const queryList = normalizeQueryList(rawQueryList);
      const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
      const canonicalRequest = canonicalRequestForQuery(params);
      if (recencyFilter !== undefined) canonicalRequest.recencyFilter = recencyFilter;

      if (queryList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No query provided. Use 'query' or 'queries' parameter.",
            },
          ],
          details: { error: "No query provided" },
        };
      }

      const resolvedProvider = resolveRequestedProvider(params.provider);
      const limit = pLimit(MAX_CONCURRENT_QUERIES);
      let completedCount = 0;

      onUpdate?.({
        content: [
          {
            type: "text",
            text:
              queryList.length === 1
                ? `Searching: "${queryList[0]}"...`
                : `Searching ${queryList.length} queries...`,
          },
        ],
        details: { phase: "search", progress: 0, currentQuery: queryList[0] },
      });

      const perQueryResults = await Promise.all(
        queryList.map((query) =>
          limit(
            async (): Promise<{
              result: QueryResultData;
              inlineContent: ExtractedContent[];
            }> => {
              if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
              try {
                const response = publishAttributedReferences(
                  await search(
                    query,
                    searchOptionsForCanonicalRequest(
                      canonicalRequest,
                      resolvedProvider,
                      signal,
                      ctx,
                    ),
                  ),
                );
                completedCount += 1;
                onUpdate?.({
                  content: [
                    {
                      type: "text",
                      text: `Searched ${completedCount}/${queryList.length}: "${query}"`,
                    },
                  ],
                  details: {
                    phase: "search",
                    progress: completedCount / queryList.length,
                    currentQuery: query,
                  },
                });
                return {
                  result: {
                    query,
                    answer: response.answer,
                    results: response.results,
                    error: null,
                    provider: response.provider,
                    backend: response.transport,
                    adapterId: response.adapterId,
                    transport: response.transport,
                    billing: response.billing,
                    warnings: response.warnings,
                    attempts: response.attempts,
                    providerErrors: response.providerErrors,
                    references: response.references,
                  },
                  inlineContent: response.inlineContent ?? [],
                };
              } catch (err) {
                if (signal?.aborted || isAbortError(err)) throw err;
                const message = err instanceof Error ? err.message : String(err);
                const requestedProvider = toProviderLabel(resolvedProvider);
                const diagnostic = isSearchError(err) ? err : undefined;
                completedCount += 1;
                return {
                  result: {
                    query,
                    answer: "",
                    results: [],
                    error: message,
                    provider: diagnostic?.family ?? requestedProvider,
                    adapterId: diagnostic?.adapterId,
                    transport: diagnostic?.transport,
                    backend: diagnostic?.transport,
                    billing: diagnostic?.billing,
                    attempts: diagnostic?.attempts,
                  },
                  inlineContent: [],
                };
              }
            },
          ),
        ),
      );

      const searchResults: QueryResultData[] = [];
      const allUrls: string[] = [];
      const allInlineContent: ExtractedContent[] = [];
      for (const entry of perQueryResults) {
        searchResults.push(entry.result);
        for (const r of entry.result.results) {
          if (!allUrls.includes(r.url)) allUrls.push(r.url);
        }
        if (entry.inlineContent.length > 0) allInlineContent.push(...entry.inlineContent);
      }

      const config = loadConfigForExtensionInit();
      const hasSuccessfulQuery = searchResults.some((entry) => entry.error === null);
      const shouldSummarize =
        hasSuccessfulQuery &&
        ctx !== undefined &&
        (params.summary !== undefined ? params.summary : isSummaryEnabled(config));

      let approvedSummary: string | undefined;
      let summaryMeta: SummaryMeta | undefined;
      if (shouldSummarize && ctx) {
        onUpdate?.({
          content: [{ type: "text", text: "Summarizing search results..." }],
          details: { phase: "generating-summary", progress: 1 },
        });
        const summaryContext: SummaryGenerationContext = {
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
          isProjectTrusted: () => ctx.isProjectTrusted(),
        };
        const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
        const generated = await generateSummaryDraft(
          searchResults,
          summaryContext,
          signal,
          summaryModelChoices.defaultSummaryModel ?? undefined,
          undefined,
          undefined,
          getSummaryGenerationDeadlineMs(),
        );
        approvedSummary = generated.summary;
        summaryMeta = generated.meta;
      }

      return buildSearchReturn({
        queryList,
        results: searchResults,
        urls: allUrls,
        includeContent: params.includeContent ?? false,
        inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
        workflow: shouldSummarize ? "auto-summary" : undefined,
        approvedSummary,
        summaryMeta,
        getSearchContentEnabled,
      });
    },

    renderCall(args, theme) {
      // SAFETY: This renderer receives arguments validated by the registered web-search parameter schema.
      const input = args as { query?: unknown; queries?: unknown };
      const rawQueryList: unknown[] = Array.isArray(input.queries)
        ? input.queries
        : input.query === undefined
          ? []
          : [input.query];
      const queryList = normalizeQueryList(rawQueryList);
      if (queryList.length === 0) {
        return new Text(
          theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"),
          0,
          0,
        );
      }
      if (queryList.length === 1) {
        const q = queryList[0];
        const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
        return new Text(
          theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`),
          0,
          0,
        );
      }
      const lines = [
        theme.fg("toolTitle", theme.bold("search ")) +
          theme.fg("accent", `${queryList.length} queries`),
      ];
      for (const q of queryList.slice(0, 5)) {
        const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
        lines.push(theme.fg("muted", `  "${display}"`));
      }
      if (queryList.length > 5) {
        lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      // SAFETY: Search results and partial updates are created by this tool with the fields declared below.
      const details = result.details as {
        queryCount?: number;
        successfulQueries?: number;
        totalResults?: number;
        error?: string;
        fetchId?: string;
        fetchUrls?: string[];
        phase?: string;
        progress?: number;
        currentQuery?: string;
        summary?: {
          text: string;
          workflow: SummaryWorkflow;
          model: string | null;
          durationMs: number;
          tokenEstimate: number;
          fallbackUsed: boolean;
          fallbackReason?: string;
          phase?: "summary-model" | "deterministic-fallback";
          edited?: boolean;
        };
      };

      if (isPartial) {
        if (details?.phase === "generating-summary") {
          return new Text(theme.fg("accent", "summarizing search results..."), 0, 0);
        }
        const progress = details?.progress ?? 0;
        const bar =
          "\u2588".repeat(Math.floor(progress * 10)) +
          "\u2591".repeat(10 - Math.floor(progress * 10));
        const query = details?.currentQuery || "";
        const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
        const label = display ? `[${bar}] ${display}` : `[${bar}] ${details?.phase || "searching"}`;
        return new Text(theme.fg("accent", label), 0, 0);
      }

      if (details?.error) {
        // SAFETY: The error branch established the required error field; remaining fields are optional diagnostics.
        const plan = buildSearchErrorPlan(details as SearchErrorDetails);
        if (plan) return renderSearchErrorPlan(plan, expanded, theme);
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const queryInfo =
        details?.queryCount === 1
          ? ""
          : `${details?.successfulQueries}/${details?.queryCount} queries, `;
      let statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
      if (details?.fetchId && details?.fetchUrls) {
        statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
      } else if (details?.fetchId) {
        statusLine += theme.fg("muted", " (content ready)");
      }

      const lines = [statusLine];
      if (details?.summary?.text) {
        lines.push("");
        lines.push(theme.fg("accent", "── Summary " + "─".repeat(44)));
        lines.push("");
        for (const line of details.summary.text.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push("");
        const metaParts = [
          details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
          `duration=${details.summary.durationMs}ms`,
          `tokens~${details.summary.tokenEstimate}`,
          details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
        ];
        if (details.summary.fallbackReason) {
          metaParts.push(`reason=${details.summary.fallbackReason}`);
        }
        lines.push(theme.fg("dim", "  " + metaParts.filter(Boolean).join(" · ")));
      } else {
        const textContent = result.content.find((c) => c.type === "text")?.text || "";
        const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
        for (const line of preview.split("\n")) {
          lines.push(theme.fg("dim", line));
        }
      }

      if (details?.fetchUrls && details.fetchUrls.length > 0) {
        lines.push(theme.fg("muted", "Fetching:"));
        for (const u of details.fetchUrls.slice(0, 5)) {
          const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
          lines.push(theme.fg("dim", "  " + display));
        }
        if (details.fetchUrls.length > 5) {
          lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
        }
      }

      const totalLines = lines.length;

      if (!expanded) {
        const box = new Box(1, 0);
        box.addChild(new Text(statusLine, 0, 0));

        let collapsedLines = 1;
        const summaryPreview = details?.summary?.text?.trim() || "";
        if (summaryPreview) {
          const preview =
            summaryPreview.length > 120 ? summaryPreview.slice(0, 117) + "..." : summaryPreview;
          box.addChild(new Text(theme.fg("dim", preview), 0, 0));
          collapsedLines++;
        } else {
          const textContent = result.content.find((c) => c.type === "text")?.text || "";
          const firstContentLine = textContent.split("\n").find((l) => {
            const t = l.trim();
            return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
          });
          const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
          if (fallbackLine) {
            const preview =
              fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
            box.addChild(new Text(theme.fg("dim", preview), 0, 0));
            collapsedLines++;
          }
        }
        const moreLines = Math.max(0, totalLines - collapsedLines);
        if (moreLines > 0) {
          box.addChild(
            new Text(
              theme.fg(
                "muted",
                `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`,
              ),
              0,
              0,
            ),
          );
        }
        return box;
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
