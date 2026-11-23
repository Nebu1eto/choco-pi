import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  hasCanonicalSearch,
  isSearchError,
  search as unifiedSearch,
} from "../../choco-pi-web-search/index.ts";
import { hostParamsAs } from "../schema-bridge.ts";
import { toCanonicalSearchParams } from "../snake-params.ts";
import { isAbortError, isNumberValue, isStringValue } from "../value-guards.ts";
import type { ExtractedContent } from "../extract.ts";
import { getConfiguredSearchRouting, search } from "../gemini-search.ts";
import type { IndexedCuratorSearchEntry } from "../curator-server.ts";
import {
  generateSummaryDraft,
  type SummaryGenerationContext,
  type SummaryMeta,
} from "../summary-review.ts";
import type { QueryResultData } from "../storage.ts";
import { buildSearchErrorPlan, type SearchErrorDetails } from "../render-search-error.ts";
import {
  getSummaryGenerationDeadlineMs,
  loadConfigForExtensionInit,
  loadCuratorBootstrap,
  normalizeQueryList,
  normalizeRecencyFilter,
  resolveRequestedProvider,
  resolveWorkflow,
  toCuratorProvider,
  webSearchParams,
  type CuratorWorkflow,
  type DetailObject,
  type SummaryWorkflow,
  type ToolNames,
  type WebSearchParams,
} from "../extension-config.ts";
import {
  canonicalRequestForQuery,
  formatOwnedReferences,
  formatSearchDiagnostics,
  indexedCuratorEntryToQueryResult,
  renderSearchErrorPlan,
  searchOptionsForCanonicalRequest,
  toCuratorSearchEntries,
} from "../search-formatting.ts";
import {
  activeCurators,
  closeCurator,
  pendingCurates,
  type PendingCurate,
  type SearchRuntime,
} from "../curator-lifecycle.ts";

export function registerWebSearchTool(
  pi: ExtensionAPI,
  runtime: SearchRuntime,
  toolNames: ToolNames,
  curateKey: string,
): void {
  const {
    publishReferences,
    publishAttributedReferences,
    resolveCoreReference,
    buildCurationCancelledReturn,
    loadSummaryModelChoices,
    buildSearchReturn,
    openCuratorBrowser,
  } = runtime;
  pi.registerTool({
    name: toolNames.webSearch,
    label: "Web Search",
    description: "Search the web and return a cited synthesized answer.",
    promptSnippet: "Search the web and synthesize cited results.",
    parameters: hostParamsAs<WebSearchParams>(webSearchParams),

    async execute(callId, rawParams, signal, onUpdate, ctx) {
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
        const response = await unifiedSearch(request, {
          context: ctx,
          signal,
          routing: getConfiguredSearchRouting(),
          allowBilledApiFallback: config.allowBilledApiFallback === true,
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
            references,
          },
        };
      }
      const rawQueryList: unknown[] = Array.isArray(params.queries)
        ? params.queries
        : params.query === undefined
          ? []
          : [params.query];
      const queryList = normalizeQueryList(rawQueryList);
      const configWorkflow = loadConfigForExtensionInit().workflow;
      const workflow = resolveWorkflow(params.workflow ?? configWorkflow, ctx?.hasUI !== false);
      const shouldCurate = workflow === "summary-review";
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

      if (shouldCurate && !ctx) {
        return {
          content: [
            { type: "text", text: "Error: Curation requires an active extension context." },
          ],
          details: { error: "Missing extension context" },
        };
      }

      if (shouldCurate) {
        closeCurator(callId);

        let resolvePromise: (value: AgentToolResult<DetailObject>) => void = () => {};
        const promise = new Promise<AgentToolResult<DetailObject>>((resolve) => {
          resolvePromise = resolve;
        });
        const includeContent = params.includeContent ?? false;
        const searchResults = new Map<number, QueryResultData>();
        const resultSlots = new Map<number, number>();
        const allInlineContent: ExtractedContent[] = [];
        let nextResultIndex = queryList.length;
        const searchAbort = new AbortController();
        const searchSignal = signal
          ? AbortSignal.any([signal, searchAbort.signal])
          : searchAbort.signal;
        let cancelled = false;

        const requestedProvider = resolveRequestedProvider(params.provider);
        const bootstrap = await loadCuratorBootstrap(requestedProvider, ctx, {
          numResults: params.numResults,
          recencyFilter,
        });
        const availableProviders = bootstrap.availableProviders;
        const defaultProvider = bootstrap.defaultProvider;
        const searchProvider = requestedProvider;
        const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
        const curatorWorkflow: CuratorWorkflow = "summary-review";

        const summaryContext: SummaryGenerationContext = {
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
          isProjectTrusted: () => ctx.isProjectTrusted(),
        };
        const summaryModelChoices = await loadSummaryModelChoices(summaryContext);

        // SAFETY: Pi's update callback accepts the text-only result shape used by PendingCurate; details remain an optional property bag.
        const pc: PendingCurate = {
          phase: "searching",
          workflow: curatorWorkflow,
          summaryContext,
          searchResults,
          resultSlots,
          allInlineContent,
          queryList,
          includeContent,
          numResults: params.numResults,
          recencyFilter,
          domainFilter: params.domainFilter,
          searchRequest: canonicalRequest,
          availableProviders,
          defaultProvider,
          searchProvider,
          summaryModels: summaryModelChoices.summaryModels,
          defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
          timeoutSeconds: curatorTimeoutSeconds,
          onUpdate: onUpdate as PendingCurate["onUpdate"],
          signal,
          abortSearches: () => {
            if (!searchAbort.signal.aborted) searchAbort.abort();
          },
          finish: () => {},
          cancel: () => {},
        };

        const finish = (value: AgentToolResult<DetailObject>) => {
          if (cancelled) return;
          cancelled = true;
          pc.abortSearches();
          signal?.removeEventListener("abort", onAbort);
          pendingCurates.delete(callId);
          resolvePromise(value);
        };

        const cancel = (reason: "user" | "stale" = "stale") => {
          if (cancelled) return;
          const conn = activeCurators.get(callId)?.getConnectionState();
          finish(
            buildCurationCancelledReturn(reason, {
              queries: Array.from(searchResults.values()),
              queryCount: queryList.length,
              browserConnected: conn?.browserConnected,
              lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
              curatorUrl: pc.curatorUrl,
              browserOpenError: pc.browserOpenError,
            }),
          );
        };

        pc.finish = finish;
        pc.cancel = cancel;

        const onAbort = () => closeCurator(callId);
        pendingCurates.set(callId, pc);
        signal?.addEventListener("abort", onAbort, { once: true });
        pc.browserPromise = openCuratorBrowser(callId, pc, ctx, false);

        for (let qi = 0; qi < queryList.length; qi++) {
          if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Searching ${qi + 1}/${queryList.length}: "${queryList[qi]}"...`,
              },
            ],
            details: {
              phase: "searching",
              progress: qi / queryList.length,
              currentQuery: queryList[qi],
            },
          });
          const requestedProvider = pc.searchProvider;
          try {
            const response = publishAttributedReferences(
              await search(
                queryList[qi],
                searchOptionsForCanonicalRequest(
                  pc.searchRequest,
                  requestedProvider,
                  searchSignal,
                  ctx,
                ),
              ),
            );
            if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
            if (response.inlineContent) allInlineContent.push(...response.inlineContent);
            const entries = toCuratorSearchEntries(response);
            const curator = activeCurators.get(callId);
            for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
              const entry = entries[entryIndex];
              const resultIndex = entryIndex === 0 ? qi : nextResultIndex++;
              const indexedEntry: IndexedCuratorSearchEntry = {
                ...entry,
                queryIndex: resultIndex,
                query: queryList[qi],
              };
              searchResults.set(resultIndex, indexedCuratorEntryToQueryResult(indexedEntry));
              resultSlots.set(resultIndex, qi);
              if (curator) {
                if (entry.error) {
                  curator.pushError(resultIndex, entry.error, entry.provider, {
                    query: queryList[qi],
                    slotIndex: qi,
                  });
                } else {
                  curator.pushResult(resultIndex, {
                    ...entry,
                    query: queryList[qi],
                    slotIndex: qi,
                  });
                }
              }
            }
          } catch (err) {
            if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
            const message = err instanceof Error ? err.message : String(err);
            const failedProvider = toCuratorProvider(requestedProvider);
            const diagnostic = isSearchError(err) ? err : undefined;
            searchResults.set(qi, {
              query: queryList[qi],
              answer: "",
              results: [],
              error: message,
              provider: diagnostic?.family ?? failedProvider,
              adapterId: diagnostic?.adapterId,
              transport: diagnostic?.transport,
              backend: diagnostic?.transport,
              billing: diagnostic?.billing,
              attempts: diagnostic?.attempts,
            });
            resultSlots.set(qi, qi);
            const curator = activeCurators.get(callId);
            if (curator) {
              curator.pushError(qi, message, failedProvider, {
                query: queryList[qi],
                slotIndex: qi,
              });
            }
          }
        }

        if (signal?.aborted || cancelled || searchAbort.signal.aborted) {
          cancel();
          return promise;
        }

        await pc.browserPromise;
        const curator = activeCurators.get(callId);
        if (curator && !cancelled) {
          curator.searchesDone();
          if (pc.browserOpenError) {
            pc.onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `All searches complete. Open the curator manually: ${pc.curatorUrl}`,
                },
              ],
              details: {
                phase: "curator-fallback",
                progress: 1,
                curatorUrl: pc.curatorUrl,
                timeoutSeconds: pc.timeoutSeconds,
                shortcut: curateKey,
                browserOpenError: pc.browserOpenError,
              },
            });
          } else {
            pc.onUpdate?.({
              content: [
                {
                  type: "text",
                  text: "All searches complete — waiting for summary approval in browser...",
                },
              ],
              details: {
                phase: "curating",
                progress: 1,
                curatorUrl: pc.curatorUrl,
                timeoutSeconds: pc.timeoutSeconds,
                shortcut: curateKey,
              },
            });
          }
        }

        return promise;
      }

      const searchResults: QueryResultData[] = [];
      const allUrls: string[] = [];
      const allInlineContent: ExtractedContent[] = [];
      const resolvedProvider = resolveRequestedProvider(params.provider);

      for (let i = 0; i < queryList.length; i++) {
        const query = queryList[i];

        onUpdate?.({
          content: [
            { type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` },
          ],
          details: { phase: "search", progress: i / queryList.length, currentQuery: query },
        });

        try {
          const response = publishAttributedReferences(
            await search(
              query,
              searchOptionsForCanonicalRequest(canonicalRequest, resolvedProvider, signal, ctx),
            ),
          );
          const {
            answer,
            results,
            inlineContent,
            provider,
            adapterId,
            transport,
            billing,
            warnings,
            attempts,
            providerErrors,
            references,
          } = response;

          searchResults.push({
            query,
            answer,
            results,
            error: null,
            provider,
            backend: transport,
            adapterId,
            transport,
            billing,
            warnings,
            attempts,
            providerErrors,
            references,
          });
          for (const r of results) {
            if (!allUrls.includes(r.url)) {
              allUrls.push(r.url);
            }
          }
          if (inlineContent) allInlineContent.push(...inlineContent);
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          const requestedProvider = toCuratorProvider(resolvedProvider);
          const diagnostic = isSearchError(err) ? err : undefined;
          searchResults.push({
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
          });
        }
      }

      let approvedSummary: string | undefined;
      let summaryMeta: SummaryMeta | undefined;
      if (workflow === "auto-summary") {
        if (!ctx) {
          return {
            content: [
              { type: "text", text: "Error: Auto-summary requires an active extension context." },
            ],
            details: { error: "Missing extension context" },
          };
        }
        onUpdate?.({
          content: [{ type: "text", text: "Generating summary..." }],
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
        workflow: workflow === "auto-summary" ? "auto-summary" : undefined,
        approvedSummary,
        summaryMeta,
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
      type QueryDetail = {
        query: string;
        provider: string | null;
        answer: string | null;
        sources: Array<{ title: string; url: string }>;
        error: string | null;
      };
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
        curated?: boolean;
        curatedFrom?: number;
        curatedQueries?: QueryDetail[];
        cancelled?: boolean;
        cancelReason?: string;
        browserConnected?: boolean;
        lastHeartbeatAgeMs?: number | null;
        cancelledQueries?: import("../render-search-error.ts").CancelledQueryDetail[];
        curatorUrl?: string;
        browserOpenError?: string;
        timeoutSeconds?: number;
        shortcut?: string;
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
        if (details?.phase === "curator-fallback") {
          const lines = [theme.fg("warning", "Open the search curator manually:")];
          if (details?.curatorUrl) lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
          if (details?.browserOpenError)
            lines.push(theme.fg("dim", `  auto-open failed: ${details.browserOpenError}`));
          const timeout = isNumberValue(details?.timeoutSeconds)
            ? details.timeoutSeconds
            : undefined;
          const shortcut = isStringValue(details?.shortcut) ? details.shortcut : curateKey;
          lines.push(
            theme.fg(
              "dim",
              timeout
                ? `  auto-submits after ${timeout}s idle; ${shortcut} reopens`
                : `  ${shortcut} reopens`,
            ),
          );
          return new Text(lines.join("\n"), 0, 0);
        }
        if (
          details?.phase === "curating" ||
          details?.phase === "waiting-for-approval" ||
          details?.phase === "generating-summary"
        ) {
          const phaseText =
            details?.phase === "generating-summary"
              ? "generating summary draft..."
              : details?.phase === "waiting-for-approval"
                ? "summary draft ready; approve in browser..."
                : "waiting for summary approval in browser...";
          const lines = [theme.fg("accent", phaseText)];
          if (details?.curatorUrl) {
            lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
          }
          const timeout = isNumberValue(details?.timeoutSeconds)
            ? details.timeoutSeconds
            : undefined;
          const shortcut = isStringValue(details?.shortcut) ? details.shortcut : curateKey;
          if (timeout) {
            lines.push(
              theme.fg("dim", `  auto-submits after ${timeout}s idle; ${shortcut} reopens`),
            );
          } else {
            lines.push(theme.fg("dim", `  ${shortcut} reopens`));
          }
          return new Text(lines.join("\n"), 0, 0);
        }
        if (details?.phase === "searching") {
          const progress = details?.progress ?? 0;
          const bar =
            "\u2588".repeat(Math.floor(progress * 10)) +
            "\u2591".repeat(10 - Math.floor(progress * 10));
          const query = details?.currentQuery || "";
          const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
          return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
        }
        const progress = details?.progress ?? 0;
        const bar =
          "\u2588".repeat(Math.floor(progress * 10)) +
          "\u2591".repeat(10 - Math.floor(progress * 10));
        return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
      }

      if (details?.error) {
        // SAFETY: The error branch established the required error field; remaining fields are optional diagnostics.
        const plan = buildSearchErrorPlan(details as SearchErrorDetails);
        if (plan) return renderSearchErrorPlan(plan, expanded, theme);
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      let statusLine: string;
      const queryInfo =
        details?.queryCount === 1
          ? ""
          : `${details?.successfulQueries}/${details?.queryCount} queries, `;
      statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
      if (details?.curated && details?.curatedFrom) {
        statusLine += theme.fg(
          "muted",
          ` (${details.queryCount}/${details.curatedFrom} queries curated)`,
        );
      }
      if (details?.fetchId && details?.fetchUrls) {
        statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
      } else if (details?.fetchId) {
        statusLine += theme.fg("muted", " (content ready)");
      }

      const lines = [statusLine];
      if (details?.summary?.text) {
        lines.push("");
        lines.push(
          theme.fg("accent", `── Summary (${details.summary.workflow}) ` + "─".repeat(32)),
        );
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
          details.summary.phase ? `phase=${details.summary.phase}` : "",
          details.summary.edited ? "edited=true" : "edited=false",
        ];
        if (details.summary.fallbackReason) {
          metaParts.push(`reason=${details.summary.fallbackReason}`);
        }
        lines.push(theme.fg("dim", "  " + metaParts.filter(Boolean).join(" · ")));
      }

      const queryDetails = details?.curatedQueries;
      if (queryDetails?.length) {
        const kept = queryDetails.length;
        const from = details?.curatedFrom ?? kept;
        lines.push("");
        lines.push(
          theme.fg(
            "accent",
            `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ` + "\u2500".repeat(24),
          ),
        );

        for (const cq of queryDetails) {
          lines.push("");
          const dq = cq.query.length > 65 ? cq.query.slice(0, 62) + "..." : cq.query;
          const providerLabel = cq.provider ? ` (${cq.provider})` : "";
          lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

          if (cq.error) {
            lines.push(theme.fg("error", `  ${cq.error}`));
          } else if (cq.answer) {
            lines.push("");
            for (const line of cq.answer.split("\n")) {
              lines.push(`  ${line}`);
            }
          }

          if (cq.sources.length > 0) {
            lines.push("");
            for (const s of cq.sources) {
              const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
              const title = s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title;
              lines.push(
                theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`),
              );
            }
          }
        }
        lines.push("");
      } else {
        const textContent = result.content.find((c) => c.type === "text")?.text || "";
        const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
        for (const line of preview.split("\n")) {
          lines.push(theme.fg("dim", line));
        }
      }

      if (details?.fetchUrls && details.fetchUrls.length > 0) {
        if (details.curated) {
          lines.push(theme.fg("muted", `Fetching ${details.fetchUrls.length} URLs in background`));
        } else {
          lines.push(theme.fg("muted", "Fetching:"));
          for (const u of details.fetchUrls.slice(0, 5)) {
            const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
            lines.push(theme.fg("dim", "  " + display));
          }
          if (details.fetchUrls.length > 5) {
            lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
          }
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
        } else if (details?.curatedQueries?.length) {
          for (const cq of details.curatedQueries.slice(0, 3)) {
            const dq = cq.query.length > 55 ? cq.query.slice(0, 52) + "..." : cq.query;
            const srcCount = cq.sources?.length ?? 0;
            const suffix = cq.error
              ? theme.fg("error", " (error)")
              : theme.fg("dim", ` · ${srcCount} sources`);
            box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
            collapsedLines++;
          }
          if (details.curatedQueries.length > 3) {
            box.addChild(
              new Text(
                theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`),
                0,
                0,
              ),
            );
            collapsedLines++;
          }
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
