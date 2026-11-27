import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SearchReference, SearchRequest as UnifiedSearchRequest } from "./index.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { clearCloneCache } from "./github-extract.ts";
import type { AttributedSearchResponse } from "./gemini-search.ts";
import {
  clearResults,
  generateId,
  restoreFromSession,
  storeFetchedContentResult,
  storeResult,
  type QueryResultData,
  type ResultsResetReason,
  type StoredSearchData,
} from "./storage.ts";
import { activityMonitor } from "./activity.ts";
import type { SummaryGenerationContext, SummaryMeta } from "./summary-review.ts";
import {
  findModelWithProviderRouting,
  loadEnabledModelPatterns,
  modelMatchesEnabledPatterns,
  splitThinkingSuffix,
} from "./summary-model-scope.ts";
import { isStringValue } from "./value-guards.ts";
import {
  getConfiguredSummaryModel,
  stripThumbnails,
  type DetailObject,
  type SummaryWorkflow,
  type ToolNames,
} from "./extension-config.ts";
import {
  formatSearchDiagnostics,
  formatSearchSummary,
  hasFullInlineCoverage,
  searchDiagnosticDetails,
  updateWidget,
} from "./search-formatting.ts";

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
export async function fetchAllContent(
  urls: string[],
  signal?: AbortSignal,
  options?: ExtractOptions,
): Promise<ExtractedContent[]> {
  const extractModule = await (extractModulePromise ??= import("./extract.ts"));
  return extractModule.fetchAllContent(urls, signal, options);
}

export const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

export function abortPendingFetches(): void {
  for (const controller of pendingFetches.values()) {
    controller.abort();
  }
  pendingFetches.clear();
}

export function handleSessionChange(ctx: ExtensionContext, reason: ResultsResetReason): void {
  abortPendingFetches();
  clearCloneCache();
  sessionActive = true;
  restoreFromSession(ctx, reason);
  widgetUnsubscribe?.();
  widgetUnsubscribe = null;
  activityMonitor.clear();
  if (widgetVisible) {
    widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
    updateWidget(ctx);
  }
}

export function toggleActivityWidget(ctx: ExtensionContext): void {
  widgetVisible = !widgetVisible;
  if (widgetVisible) {
    widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
    updateWidget(ctx);
  } else {
    widgetUnsubscribe?.();
    widgetUnsubscribe = null;
    ctx.ui.setWidget("web-activity", undefined);
  }
}

export function shutdownSessionState(): void {
  sessionActive = false;
  abortPendingFetches();
  clearCloneCache();
  clearResults("shutdown");
  widgetUnsubscribe?.();
  widgetUnsubscribe = null;
  activityMonitor.clear();
  widgetVisible = false;
}

export interface SearchReturnOptions {
  queryList: string[];
  results: QueryResultData[];
  urls: string[];
  includeContent: boolean;
  inlineContent?: ExtractedContent[];
  workflow?: SummaryWorkflow;
  approvedSummary?: string;
  summaryMeta?: SummaryMeta;
  getSearchContentEnabled?: boolean;
}

export interface SummaryModelChoices {
  summaryModels: Array<{ value: string; label: string }>;
  defaultSummaryModel: string | null;
}

export function createSearchRuntime(pi: ExtensionAPI, toolNames: ToolNames) {
  const coreReferenceIds = new Map<string, string>();
  const publicReferenceIds = new Map<string, string>();

  function clearPublishedReferences(): void {
    coreReferenceIds.clear();
    publicReferenceIds.clear();
  }

  function publishReferences(
    references: SearchReference[] | undefined,
  ): SearchReference[] | undefined {
    if (!references?.length) return undefined;
    return references.map((reference) => {
      let publicId = publicReferenceIds.get(reference.id);
      if (!publicId) {
        publicId = `webref:${randomUUID()}`;
        publicReferenceIds.set(reference.id, publicId);
        coreReferenceIds.set(publicId, reference.id);
      }
      return { ...reference, id: publicId };
    });
  }

  function publishAttributedReferences(
    response: AttributedSearchResponse,
  ): AttributedSearchResponse {
    const published = { ...response, references: publishReferences(response.references) };
    if (response.providerResponses) {
      published.providerResponses = response.providerResponses.map((providerResponse) => ({
        ...providerResponse,
        references: publishReferences(providerResponse.references),
      }));
    }
    return published;
  }

  function resolveCoreReference(request: UnifiedSearchRequest): void {
    if (!request.reference) return;
    const coreId = coreReferenceIds.get(request.reference.id);
    if (!coreId) throw new Error("Search reference does not belong to this live session");
    request.reference = { id: coreId };
  }

  function startBackgroundFetch(urls: string[]): string | null {
    if (urls.length === 0) return null;
    const fetchId = generateId();
    const controller = new AbortController();
    pendingFetches.set(fetchId, controller);
    fetchAllContent(urls, controller.signal)
      .then((fetched) => {
        if (!sessionActive || !pendingFetches.has(fetchId)) return;
        const data = {
          id: fetchId,
          type: "fetch",
          timestamp: Date.now(),
          urls: stripThumbnails(fetched),
        } satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
        pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
        const ok = fetched.filter((f) => !f.error).length;
        const availability =
          ok === fetched.length
            ? "Full page content now available."
            : ok > 0
              ? "Partial page content now available."
              : "No page content was fetched. Stored fetch diagnostics are available.";
        pi.sendMessage(
          {
            customType: "web-search-content-ready",
            content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
            display: true,
          },
          { triggerTurn: true },
        );
      })
      .catch((err) => {
        if (!sessionActive || !pendingFetches.has(fetchId)) return;
        const message = err instanceof Error ? err.message : String(err);
        const isAbort =
          (err instanceof Error && err.name === "AbortError") ||
          message.toLowerCase().includes("abort");
        if (!isAbort) {
          pi.sendMessage(
            {
              customType: "web-search-error",
              content: `Content fetch failed [${fetchId}]: ${message}`,
              display: true,
            },
            { triggerTurn: false },
          );
        }
      })
      .finally(() => {
        pendingFetches.delete(fetchId);
      });
    return fetchId;
  }

  function storeAndPublishSearch(
    results: QueryResultData[],
    summary?: string,
    summaryMeta?: SummaryMeta,
  ): string {
    const id = generateId();
    const data: StoredSearchData = {
      id,
      type: "search",
      timestamp: Date.now(),
      queries: results,
    };
    if (summary !== undefined && summary.length > 0) data.summary = summary;
    if (summaryMeta !== undefined) data.summaryMeta = summaryMeta;
    storeResult(id, data);
    pi.appendEntry("web-search-results", data);
    return id;
  }

  async function loadSummaryModelChoices(
    summaryContext: SummaryGenerationContext,
  ): Promise<SummaryModelChoices> {
    const summaryModels: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();
    const availableValues = new Set<string>();

    const addModel = (provider: string, id: string) => {
      const value = `${provider}/${id}`;
      if (seen.has(value)) return;
      seen.add(value);
      summaryModels.push({ value, label: value });
    };

    let enabledModelPatterns: string[] | null = null;
    let scopeLoaded = true;
    try {
      enabledModelPatterns = loadEnabledModelPatterns(summaryContext);
      const availableModels = summaryContext.modelRegistry.getAvailable();
      for (const model of availableModels) {
        if (!modelMatchesEnabledPatterns(model, enabledModelPatterns)) continue;
        const value = `${model.provider}/${model.id}`;
        availableValues.add(value);
        addModel(model.provider, model.id);
      }
    } catch (err) {
      scopeLoaded = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load summary models: ${message}`);
    }

    const currentModelValue = summaryContext.model
      ? `${summaryContext.model.provider}/${summaryContext.model.id}`
      : null;
    if (
      scopeLoaded &&
      summaryContext.model &&
      currentModelValue &&
      !seen.has(currentModelValue) &&
      modelMatchesEnabledPatterns(summaryContext.model, enabledModelPatterns)
    ) {
      addModel(summaryContext.model.provider, summaryContext.model.id);
    }

    const configuredSummaryModel = getConfiguredSummaryModel() ?? "";
    const preferredDefaults = [
      { provider: "anthropic", id: "claude-haiku-5-5" },
      { provider: "openai", id: "gpt-6-luna" },
      { provider: "openai-codex", id: "gpt-6-luna" },
      { provider: "synthetic", id: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "openai", id: "gpt-5.6-luna" },
      { provider: "openai", id: "gpt-6.1-terra" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "openai-codex", id: "gpt-6.1-terra" },
      { provider: "google", id: "gemini-3.6-flash" },
      { provider: "openai", id: "gpt-5-mini" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
    ];

    const resolveAvailableModelValue = (selector: string): string | null => {
      const parsed = splitThinkingSuffix(selector);
      const slashIndex = parsed.value.indexOf("/");
      if (slashIndex <= 0 || slashIndex >= parsed.value.length - 1) return null;
      const model = findModelWithProviderRouting(
        summaryContext.modelRegistry,
        parsed.value.slice(0, slashIndex),
        parsed.value.slice(slashIndex + 1),
      );
      if (!model) return null;
      const value = `${model.provider}/${model.id}`;
      if (!availableValues.has(value)) return null;
      if (selector !== value && !seen.has(selector)) {
        seen.add(selector);
        summaryModels.push({ value: selector, label: selector });
      }
      return selector;
    };

    let defaultSummaryModel: string | null = null;
    if (scopeLoaded && configuredSummaryModel.length > 0) {
      defaultSummaryModel = availableValues.has(configuredSummaryModel)
        ? configuredSummaryModel
        : resolveAvailableModelValue(configuredSummaryModel);
    }
    if (scopeLoaded && !defaultSummaryModel) {
      for (const preferred of preferredDefaults) {
        const model = findModelWithProviderRouting(
          summaryContext.modelRegistry,
          preferred.provider,
          preferred.id,
        );
        const value = model ? `${model.provider}/${model.id}` : null;
        if (value && availableValues.has(value)) {
          defaultSummaryModel = value;
          break;
        }
      }
    }
    return { summaryModels, defaultSummaryModel };
  }

  function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<DetailObject> {
    const sc = opts.results.filter((r) => !r.error).length;
    const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

    const approvedSummary = isStringValue(opts.approvedSummary) ? opts.approvedSummary.trim() : "";
    const hasApprovedSummary = approvedSummary.length > 0;
    const searchId = storeAndPublishSearch(
      opts.results,
      hasApprovedSummary ? approvedSummary : undefined,
      hasApprovedSummary ? opts.summaryMeta : undefined,
    );

    let output = "";
    if (hasApprovedSummary) {
      output = approvedSummary;
    } else {
      for (const queryData of opts.results) {
        const { query, error } = queryData;
        if (opts.queryList.length > 1) {
          output += `## Query: "${query}"\n\n`;
        }
        if (error) {
          output += `Error: ${error}\n`;
          const diagnostics = formatSearchDiagnostics(queryData);
          if (diagnostics.length > 0)
            output += `\n**Search diagnostics:**\n${diagnostics.join("\n")}\n`;
          output += "\n";
        } else output += formatSearchSummary(queryData) + "\n\n";
      }
    }

    const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
    let fetchId: string | null = null;
    if (hasInlineReady && opts.inlineContent) {
      fetchId = generateId();
      const data = {
        id: fetchId,
        type: "fetch",
        timestamp: Date.now(),
        urls: opts.inlineContent,
      } satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
      pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
      output += `\n\n---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
    } else if (opts.includeContent) {
      fetchId = startBackgroundFetch(opts.urls);
      if (fetchId) {
        output += `\n\n---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
      }
    }

    if (hasApprovedSummary && opts.getSearchContentEnabled !== false) {
      const queryHint =
        opts.results.length > 1
          ? `query_index=0..${opts.results.length - 1} or find_text="..."`
          : `query_index=0 or find_text="..."`;
      output += `\n\n---\nFull raw search results stored [response_id: ${searchId}]. Call ${toolNames.getSearchContent}({ response_id: "${searchId}" }) (${queryHint}) if the summary is not enough.`;
    }

    const isBackgroundFetch = fetchId !== null && !hasInlineReady;

    const details: DetailObject = {};
    Object.assign(details, {
      queries: opts.queryList,
      queryCount: opts.queryList.length,
      successfulQueries: sc,
      totalResults: tr,
      includeContent: opts.includeContent,
      fetchId,
      fetchUrls: isBackgroundFetch ? opts.urls : undefined,
      searchId,
      searchDiagnostics: opts.results.map(searchDiagnosticDetails),
    });
    if (opts.workflow && hasApprovedSummary) {
      details.summary = {
        text: approvedSummary,
        workflow: opts.workflow,
        model: opts.summaryMeta?.model ?? null,
        durationMs: opts.summaryMeta?.durationMs ?? 0,
        tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
        fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
        fallbackReason: opts.summaryMeta?.fallbackReason,
        phase: opts.summaryMeta?.phase,
        edited: opts.summaryMeta?.edited === true,
      };
    }
    return {
      content: [{ type: "text", text: output.trim() }],
      details,
    };
  }

  return {
    clearPublishedReferences,
    publishReferences,
    publishAttributedReferences,
    resolveCoreReference,
    loadSummaryModelChoices,
    buildSearchReturn,
  };
}

export type SearchRuntime = ReturnType<typeof createSearchRuntime>;
