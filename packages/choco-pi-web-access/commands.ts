import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSearchError } from "../choco-pi-web-search/index.ts";
import { rewriteSearchQuery } from "./query-rewrite.ts";
import { search, type SearchProviderSelection } from "./gemini-search.ts";
import { deleteResult, getAllResults, type QueryResultData } from "./storage.ts";
import {
  startCuratorServer,
  type CuratorServerHandle,
  type IndexedCuratorSearchEntry,
} from "./curator-server.ts";
import type { SummaryGenerationContext } from "./summary-review.ts";
import {
  isCommandEnabled,
  loadConfig,
  loadConfigForExtensionInit,
  loadCuratorBootstrap,
  normalizeProviderInput,
  normalizeQueryList,
  resolveCuratorSearchProvider,
  resolveWorkflow,
  saveConfig,
  shouldAutoOpenCuratorBrowser,
  toCuratorProvider,
  WEB_SEARCH_CONFIG_PATH,
  type CuratorBootstrap,
  type ToolNames,
  type WebSearchConfig,
  type WebSearchWorkflow,
} from "./extension-config.ts";
import { indexedCuratorEntryToQueryResult, toCuratorSearchEntries } from "./search-formatting.ts";
import {
  activeCurators,
  closeCurator,
  getGlimpseOpen,
  glimpseWins,
  openInBrowser,
  openInGlimpse,
  type SearchReturnOptions,
  type SearchRuntime,
} from "./curator-lifecycle.ts";

export function registerWebAccessCommands(
  pi: ExtensionAPI,
  runtime: SearchRuntime,
  initConfig: WebSearchConfig,
  toolNames: ToolNames,
): void {
  const {
    publishAttributedReferences,
    generateSummaryForSelectedIndices,
    loadSummaryModelChoices,
    resolveSummaryForSubmit,
    buildSearchReturn,
    filterByQueryIndices,
    collectAllResultsAndUrls,
  } = runtime;
  pi.registerCommand("websearch", {
    description: "Open web search curator",
    handler: async (args, ctx) => {
      const sessionToken = randomUUID();
      const commandCallId = `cmd:${sessionToken}`;
      closeCurator(commandCallId);

      const raw = args.trim();
      const queries = raw.length > 0 ? normalizeQueryList(raw.split(",")) : [];

      let bootstrap: CuratorBootstrap;
      try {
        bootstrap = await loadCuratorBootstrap(undefined, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to load web search config: ${message}`, "error");
        return;
      }
      const availableProviders = bootstrap.availableProviders;
      const initialProvider = bootstrap.defaultProvider;
      const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
      const commandConfig = loadConfig();
      const rawSearchProvider =
        normalizeProviderInput(
          commandConfig.searchProvider ?? commandConfig.provider ?? "auto",
          `provider in ${WEB_SEARCH_CONFIG_PATH}`,
        ) ?? "auto";
      let currentSearchProvider: SearchProviderSelection = Array.isArray(rawSearchProvider)
        ? rawSearchProvider
        : rawSearchProvider === "auto"
          ? "auto"
          : initialProvider;
      const summaryContext: SummaryGenerationContext = {
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        cwd: ctx.cwd,
        isProjectTrusted: () => ctx.isProjectTrusted(),
      };
      const summaryModelChoices = await loadSummaryModelChoices(summaryContext);

      ctx.ui.notify("Opening web search curator...", "info");

      const collected = new Map<number, QueryResultData>();
      const searchAbort = new AbortController();
      let aborted = false;
      let commandHandle: CuratorServerHandle | null = null;
      const isCommandActive = () =>
        commandHandle !== null && activeCurators.get(commandCallId) === commandHandle;

      function sendFollowUpFromReturn(payload: ReturnType<typeof buildSearchReturn>) {
        pi.sendMessage(
          {
            customType: "web-search-results",
            content: payload.content,
            display: true,
            details: payload.details,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }

      try {
        const handle = await startCuratorServer(
          {
            queries,
            sessionToken,
            timeout: curatorTimeoutSeconds,
            availableProviders,
            defaultProvider: initialProvider,
            searchProvider: toCuratorProvider(currentSearchProvider) ?? "auto",
            summaryModels: summaryModelChoices.summaryModels,
            defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
          },
          {
            async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
              if (commandHandle && !isCommandActive()) {
                throw new Error("Curator session is no longer active.");
              }
              return generateSummaryForSelectedIndices(
                selectedQueryIndices,
                collected,
                summaryContext,
                summarizeSignal,
                model,
                feedback,
              );
            },
            onSubmit(payload) {
              if (commandHandle && !isCommandActive()) return;
              aborted = true;
              searchAbort.abort();
              const filtered =
                payload.selectedQueryIndices.length > 0
                  ? filterByQueryIndices(payload.selectedQueryIndices, collected)
                  : collectAllResultsAndUrls(collected);
              const base: SearchReturnOptions = {
                queryList: filtered.results.map((r) => r.query),
                results: filtered.results,
                urls: filtered.urls,
                includeContent: false,
                curated: true,
                curatedFrom: collected.size,
              };
              if (!payload.rawResults) {
                const resolvedSummary = resolveSummaryForSubmit(payload, collected);
                base.workflow = "summary-review";
                base.approvedSummary = resolvedSummary.approvedSummary;
                base.summaryMeta = resolvedSummary.summaryMeta;
              }
              sendFollowUpFromReturn(buildSearchReturn(base));
              closeCurator(commandCallId);
            },
            onCancel(reason) {
              if (commandHandle && !isCommandActive()) return;
              aborted = true;
              searchAbort.abort();
              if (reason === "timeout") {
                const all = collectAllResultsAndUrls(collected);
                const resolvedSummary = resolveSummaryForSubmit(
                  { selectedQueryIndices: [], summary: undefined, summaryMeta: undefined },
                  collected,
                );
                sendFollowUpFromReturn(
                  buildSearchReturn({
                    queryList: all.results.map((r) => r.query),
                    results: all.results,
                    urls: all.urls,
                    includeContent: false,
                    curated: true,
                    curatedFrom: collected.size,
                    workflow: "summary-review",
                    approvedSummary: resolvedSummary.approvedSummary,
                    summaryMeta: resolvedSummary.summaryMeta,
                  }),
                );
              }
              closeCurator(commandCallId);
            },
            onProviderChange(provider) {
              if (commandHandle && !isCommandActive()) return;
              const normalized = normalizeProviderInput(provider);
              if (!normalized || normalized === "auto" || Array.isArray(normalized)) return;
              currentSearchProvider = normalized;
              try {
                saveConfig({ provider: normalized });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Failed to persist default provider: ${message}`);
              }
            },
            async onAddSearch(query, provider) {
              if (commandHandle && !isCommandActive()) {
                throw new Error("Curator session is no longer active.");
              }
              const requestedProvider = resolveCuratorSearchProvider(
                provider,
                currentSearchProvider,
              );
              const response = publishAttributedReferences(
                await search(query, {
                  provider: requestedProvider,
                  signal: searchAbort.signal,
                  extensionContext: ctx,
                }),
              );
              if (commandHandle && !isCommandActive()) {
                throw new Error("Curator session is no longer active.");
              }
              return toCuratorSearchEntries(response);
            },
            onAddSearchResults(entries) {
              if (commandHandle && !isCommandActive()) return;
              for (const entry of entries) {
                collected.set(entry.queryIndex, indexedCuratorEntryToQueryResult(entry));
              }
            },
            async onRewriteQuery(query, rewriteSignal) {
              if (commandHandle && !isCommandActive()) {
                throw new Error("Curator session is no longer active.");
              }
              return rewriteSearchQuery(query, summaryContext, rewriteSignal);
            },
          },
        );

        commandHandle = handle;
        activeCurators.set(commandCallId, handle);
        let browserOpenError: string | null = null;
        if (shouldAutoOpenCuratorBrowser(loadConfig())) {
          const open = platform() === "darwin" ? await getGlimpseOpen() : null;
          if (open) {
            try {
              const win = openInGlimpse(open, handle.url, "Search Curator");
              glimpseWins.set(commandCallId, win);
              win.on("closed", () => {
                if (glimpseWins.get(commandCallId) === win) {
                  glimpseWins.delete(commandCallId);
                  closeCurator(commandCallId);
                }
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`Failed to open Glimpse curator window: ${message}`);
              glimpseWins.delete(commandCallId);
              try {
                await openInBrowser(pi, handle.url);
              } catch (browserErr) {
                browserOpenError =
                  browserErr instanceof Error ? browserErr.message : String(browserErr);
              }
            }
          } else {
            try {
              await openInBrowser(pi, handle.url);
            } catch (browserErr) {
              browserOpenError =
                browserErr instanceof Error ? browserErr.message : String(browserErr);
            }
          }
          if (browserOpenError) {
            console.error(`Failed to open curator UI: ${browserOpenError}`);
            ctx.ui.notify(
              `Search curator is running, but the browser did not open automatically. Open manually: ${handle.url}`,
              "info",
            );
          }
        } else {
          ctx.ui.notify(`Search curator is running. Open manually: ${handle.url}`, "info");
        }

        if (queries.length > 0) {
          (async () => {
            let nextResultIndex = queries.length;
            for (let qi = 0; qi < queries.length; qi++) {
              if (aborted || !isCommandActive()) break;
              const requestedProvider = currentSearchProvider;
              try {
                const response = publishAttributedReferences(
                  await search(queries[qi], {
                    provider: requestedProvider,
                    signal: searchAbort.signal,
                    extensionContext: ctx,
                  }),
                );
                if (aborted || !isCommandActive()) break;
                const entries = toCuratorSearchEntries(response);
                for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
                  const entry = entries[entryIndex];
                  const resultIndex = entryIndex === 0 ? qi : nextResultIndex++;
                  const indexedEntry: IndexedCuratorSearchEntry = {
                    ...entry,
                    queryIndex: resultIndex,
                    query: queries[qi],
                  };
                  collected.set(resultIndex, indexedCuratorEntryToQueryResult(indexedEntry));
                  if (entry.error) {
                    handle.pushError(resultIndex, entry.error, entry.provider, {
                      query: queries[qi],
                      slotIndex: qi,
                    });
                  } else {
                    handle.pushResult(resultIndex, {
                      ...entry,
                      query: queries[qi],
                      slotIndex: qi,
                    });
                  }
                }
              } catch (err) {
                if (aborted || !isCommandActive()) break;
                const message = err instanceof Error ? err.message : String(err);
                const failedProvider = toCuratorProvider(requestedProvider);
                const diagnostic = isSearchError(err) ? err : undefined;
                handle.pushError(qi, message, failedProvider, {
                  query: queries[qi],
                  slotIndex: qi,
                });
                collected.set(qi, {
                  query: queries[qi],
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
              }
            }
            if (!aborted && isCommandActive()) handle.searchesDone();
          })();
        } else if (isCommandActive()) handle.searchesDone();
      } catch (err) {
        closeCurator(commandCallId);
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to open curator: ${message}`, "error");
      }
    },
  });

  if (isCommandEnabled(initConfig, "curator"))
    pi.registerCommand("curator", {
      description: "Toggle or configure the search curator workflow",
      handler: async (args, ctx) => {
        const arg = args.trim().toLowerCase();

        let newWorkflow: WebSearchWorkflow;
        if (arg.length === 0) {
          const current = resolveWorkflow(loadConfigForExtensionInit().workflow, true);
          newWorkflow = current === "none" ? "summary-review" : "none";
        } else if (arg === "on") {
          newWorkflow = "summary-review";
        } else if (arg === "off") {
          newWorkflow = "none";
        } else if (arg === "none" || arg === "summary-review" || arg === "auto-summary") {
          newWorkflow = arg;
        } else {
          ctx.ui.notify(
            `Unknown option: ${arg}. Use on, off, summary-review, or auto-summary.`,
            "error",
          );
          return;
        }

        try {
          saveConfig({ workflow: newWorkflow });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to save config: ${message}`, "error");
          return;
        }

        const label =
          newWorkflow === "none"
            ? `Curator disabled — ${toolNames.webSearch} will return raw results`
            : newWorkflow === "auto-summary"
              ? `Auto-summary enabled — ${toolNames.webSearch} will generate a summary without opening the curator`
              : `Curator enabled — ${toolNames.webSearch} will open curator and auto-generate a summary draft`;
        pi.sendMessage(
          {
            customType: "curator-config",
            content: [{ type: "text", text: label }],
            display: true,
            details: { workflow: newWorkflow },
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      },
    });

  if (isCommandEnabled(initConfig, "search"))
    pi.registerCommand("search", {
      description: "Browse stored web search results",
      handler: async (_args, ctx) => {
        const results = getAllResults();

        if (results.length === 0) {
          ctx.ui.notify("No stored search results", "info");
          return;
        }

        const options = results.map((r) => {
          const age = Math.floor((Date.now() - r.timestamp) / 60000);
          const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
          if (r.type === "search" && r.queries) {
            const query = r.queries[0]?.query || "unknown";
            return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
          }
          if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
            return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
          }
          return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
        });

        const choice = await ctx.ui.select("Stored Search Results", options);
        if (!choice) return;

        const match = choice.match(/^\[([a-z0-9]+)\]/);
        if (!match) return;

        const selected = results.find((r) => r.id.startsWith(match[1]));
        if (!selected) return;

        const actions = ["View details", "Delete"];
        const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

        if (action === "Delete") {
          deleteResult(selected.id);
          ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
        } else if (action === "View details") {
          let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
          if (selected.type === "search" && selected.queries) {
            info += "Queries:\n";
            const queries = selected.queries.slice(0, 10);
            for (const q of queries) {
              info += `- "${q.query}" (${q.results.length} results)\n`;
            }
            if (selected.queries.length > 10) {
              info += `... and ${selected.queries.length - 10} more\n`;
            }
          }
          if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
            info += "URLs:\n";
            const urlItems = selected.urls ?? selected.urlMetadata ?? [];
            const urls = urlItems.slice(0, 10);
            for (const u of urls) {
              const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
              const contentLength = "content" in u ? u.content.length : u.contentLength;
              info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
            }
            if (urlItems.length > 10) {
              info += `... and ${urlItems.length - 10} more\n`;
            }
          }
          ctx.ui.notify(info, "info");
        }
      },
    });
}
