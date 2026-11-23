import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  SearchReference,
  SearchRequest as UnifiedSearchRequest,
} from "../choco-pi-web-search/index.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { clearCloneCache } from "./github-extract.ts";
import { rewriteSearchQuery } from "./query-rewrite.ts";
import {
  search,
  type AttributedSearchResponse,
  type SearchProviderSelection,
} from "./gemini-search.ts";
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
import { startCuratorServer, type CuratorServerHandle } from "./curator-server.ts";
import {
  buildDeterministicSummary,
  generateSummaryDraft,
  type SummaryGenerationContext,
  type SummaryMeta,
} from "./summary-review.ts";
import {
  findModelWithProviderRouting,
  loadEnabledModelPatterns,
  modelMatchesEnabledPatterns,
  splitThinkingSuffix,
} from "./summary-model-scope.ts";
import { isNumberValue, isStringValue } from "./value-guards.ts";
import {
  getSummaryGenerationDeadlineMs,
  isDetailObject,
  loadConfig,
  normalizeProviderInput,
  resolveCuratorSearchProvider,
  saveConfig,
  shouldAutoOpenCuratorBrowser,
  stripThumbnails,
  toCuratorProvider,
  type CuratorProvider,
  type CuratorWorkflow,
  type DetailObject,
  type DetailValue,
  type ProviderAvailability,
  type SummaryWorkflow,
  type ToolNames,
} from "./extension-config.ts";
import {
  duplicateQuerySet,
  extractDomain,
  formatQueryHeader,
  formatSearchDiagnostics,
  formatSearchSummary,
  hasFullInlineCoverage,
  indexedCuratorEntryToQueryResult,
  searchDiagnosticDetails,
  searchOptionsForCanonicalRequest,
  toCuratorSearchEntries,
  updateWidget,
  type AttributedCuratorSearchEntry,
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
export const pendingCurates = new Map<string, PendingCurate>();
export const activeCurators = new Map<string, CuratorServerHandle>();
export const glimpseWins = new Map<string, GlimpseWindow>();

export interface PendingCurate {
  phase: "searching" | "curating";
  workflow: CuratorWorkflow;
  summaryContext: SummaryGenerationContext;
  searchResults: Map<number, QueryResultData>;
  resultSlots: Map<number, number>;
  allInlineContent: ExtractedContent[];
  queryList: string[];
  includeContent: boolean;
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  searchRequest: UnifiedSearchRequest;
  availableProviders: ProviderAvailability;
  defaultProvider: CuratorProvider;
  searchProvider: SearchProviderSelection;
  summaryModels: Array<{ value: string; label: string }>;
  defaultSummaryModel: string | null;
  timeoutSeconds: number;
  curatorUrl?: string;
  onUpdate:
    | ((update: { content: Array<{ type: string; text: string }>; details?: DetailObject }) => void)
    | undefined;
  signal: AbortSignal | undefined;
  abortSearches: () => void;
  finish: (value: AgentToolResult<DetailObject>) => void;
  cancel: (reason?: "user" | "stale") => void;
  browserPromise?: Promise<void>;
  browserOpenError?: string;
}

export function abortPendingFetches(): void {
  for (const controller of pendingFetches.values()) {
    controller.abort();
  }
  pendingFetches.clear();
}

export function closeCurator(callId?: string): void {
  if (callId !== undefined) {
    const win = glimpseWins.get(callId);
    glimpseWins.delete(callId);
    try {
      win?.close();
    } catch {}
    pendingCurates.get(callId)?.cancel("stale");
    pendingCurates.delete(callId);
    const curator = activeCurators.get(callId);
    activeCurators.delete(callId);
    try {
      curator?.close();
    } catch {}
    return;
  }

  for (const win of glimpseWins.values()) {
    try {
      win.close();
    } catch {}
  }
  glimpseWins.clear();
  for (const pc of pendingCurates.values()) {
    try {
      pc.cancel("stale");
    } catch {}
  }
  pendingCurates.clear();
  for (const curator of activeCurators.values()) {
    try {
      curator.close();
    } catch {}
  }
  activeCurators.clear();
}

export async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
  const plat = platform();
  if (plat !== "darwin" && plat !== "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      const timer = setTimeout(resolve, 100);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Failed to open browser (exit code ${code ?? "unknown"})`));
      });
      child.unref();
    });
    return;
  }
  const result =
    plat === "darwin"
      ? await pi.exec("open", [url])
      : await pi.exec("cmd", ["/c", "start", "", url]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

interface GlimpseWindow {
  on(event: "closed", handler: () => void): void;
  on(event: "message", handler: (data: DetailValue) => void): void;
  on(event: "ready", handler: (info: { screen?: { visibleHeight?: number } }) => void): void;
  close(): void;
  _write(obj: DetailObject): void;
}

interface GlimpseOptions extends DetailObject {
  width: number;
  height: number;
  title: string;
}

let glimpseOpen: ((html: string, opts: GlimpseOptions) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve("glimpseui");
  } catch {
    // Optional dependency.
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const entry = join(globalRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // npm may be unavailable.
  }
  return null;
}

export async function getGlimpseOpen() {
  if (glimpseOpen !== undefined) return glimpseOpen;
  const resolved = findGlimpseMjs();
  if (resolved) {
    try {
      glimpseOpen = (await import(resolved)).open;
      return glimpseOpen;
    } catch {}
  }
  glimpseOpen = null;
  return glimpseOpen;
}

export function openInGlimpse(
  open: (html: string, opts: GlimpseOptions) => GlimpseWindow,
  url: string,
  title: string,
): GlimpseWindow {
  const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  const win = open(shellHTML, {
    width: 800,
    height: 900,
    title,
  });

  let maxHeight = 1200;
  win.on("ready", (info) => {
    const visibleHeight = info?.screen?.visibleHeight;
    if (isNumberValue(visibleHeight) && visibleHeight > 0) {
      maxHeight = Math.floor(visibleHeight * 0.85);
    }
  });
  win.on("message", (data) => {
    if (!isDetailObject(data)) return;
    const msg = data;
    if (msg.type !== "resize" || !isNumberValue(msg.height)) return;
    const clamped = Math.max(400, Math.min(Math.round(msg.height), maxHeight));
    win._write({ type: "resize", width: 800, height: clamped });
  });

  return win;
}

export function handleSessionChange(ctx: ExtensionContext, reason: ResultsResetReason): void {
  abortPendingFetches();
  closeCurator();
  clearCloneCache();
  sessionActive = true;
  restoreFromSession(ctx, reason);
  // Unsubscribe before clear() to avoid callback with stale ctx
  widgetUnsubscribe?.();
  widgetUnsubscribe = null;
  activityMonitor.clear();
  if (widgetVisible) {
    // Re-subscribe with new ctx
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
  closeCurator();
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
  curated?: boolean;
  curatedFrom?: number;
  workflow?: SummaryWorkflow;
  approvedSummary?: string;
  summaryMeta?: SummaryMeta;
}

export function createSearchRuntime(pi: ExtensionAPI, _toolNames: ToolNames, curateKey: string) {
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

  function storeAndPublishSearch(results: QueryResultData[]): string {
    const id = generateId();
    const data: StoredSearchData = {
      id,
      type: "search",
      timestamp: Date.now(),
      queries: results,
    };
    storeResult(id, data);
    pi.appendEntry("web-search-results", data);
    return id;
  }

  function normalizeSummaryMeta(meta: SummaryMeta | undefined, summaryText: string): SummaryMeta {
    const normalizedText = summaryText.trim();
    if (!meta) {
      return {
        model: null,
        durationMs: 0,
        tokenEstimate:
          normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0,
        fallbackUsed: false,
        edited: false,
      };
    }

    return {
      model: meta.model,
      durationMs: Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
      tokenEstimate:
        Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0
          ? meta.tokenEstimate
          : normalizedText.length > 0
            ? Math.max(1, Math.ceil(normalizedText.length / 4))
            : 0,
      fallbackUsed: meta.fallbackUsed === true,
      fallbackReason: meta.fallbackReason,
      phase: meta.phase,
      edited: meta.edited === true,
    };
  }

  function buildCurationCancelledReturn(
    reason: "user" | "stale",
    partial?: {
      queries?: QueryResultData[];
      queryCount?: number;
      browserConnected?: boolean;
      lastHeartbeatAgeMs?: number | null;
      curatorUrl?: string;
      browserOpenError?: string;
    },
  ): AgentToolResult<DetailObject> {
    const message = `Search curation cancelled (${reason}).`;
    const cancelledQueries = partial?.queries?.length
      ? partial.queries.map((q) => ({
          query: q.query,
          provider: q.provider ?? null,
          error: q.error,
          resultCount: q.results?.length ?? 0,
        }))
      : undefined;
    const extraLines: string[] = [];
    if (partial?.curatorUrl) extraLines.push(`curator: ${partial.curatorUrl}`);
    if (partial?.browserOpenError)
      extraLines.push(`browser open error: ${partial.browserOpenError}`);
    return {
      content: [{ type: "text", text: message }],
      details: {
        error: message,
        cancelled: true,
        cancelReason: reason,
        browserConnected: partial?.browserConnected,
        lastHeartbeatAgeMs: partial?.lastHeartbeatAgeMs,
        queryCount: partial?.queryCount,
        cancelledQueries,
        extraLines: extraLines.length > 0 ? extraLines : undefined,
      },
    };
  }

  async function generateSummaryForSelectedIndices(
    selectedQueryIndices: number[],
    resultsByIndex: Map<number, QueryResultData>,
    summaryContext: SummaryGenerationContext,
    signal?: AbortSignal,
    modelOverride?: string,
    feedback?: string,
  ): Promise<{ summary: string; meta: SummaryMeta }> {
    const selectedResults: QueryResultData[] = [];
    for (const qi of selectedQueryIndices) {
      const result = resultsByIndex.get(qi);
      if (result) selectedResults.push(result);
    }
    if (selectedResults.length === 0) {
      throw new Error("No selected results available for summary generation");
    }
    try {
      return await generateSummaryDraft(
        selectedResults,
        summaryContext,
        signal,
        modelOverride,
        feedback,
        undefined,
        getSummaryGenerationDeadlineMs(),
      );
    } catch (err) {
      const isEmptyResponse =
        err instanceof Error && err.message.includes("Summary model returned empty response");
      if (!isEmptyResponse) throw err;
      const deterministic = buildDeterministicSummary(selectedResults);
      return {
        summary: deterministic.summary,
        meta: {
          ...deterministic.meta,
          fallbackReason: "summary-model-empty-response",
        },
      };
    }
  }

  async function loadSummaryModelChoices(summaryContext: SummaryGenerationContext): Promise<{
    summaryModels: Array<{ value: string; label: string }>;
    defaultSummaryModel: string | null;
  }> {
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

    const config = loadConfig();
    const configuredSummaryModel = isStringValue(config.summaryModel)
      ? config.summaryModel.trim()
      : "";
    const preferredDefaults = [
      { provider: "anthropic", id: "claude-haiku-5-5" },
      { provider: "openai", id: "gpt-6-luna" },
      { provider: "openai-codex", id: "gpt-6-luna" },
      { provider: "synthetic", id: "hf:deepseek-ai/DeepSeek-V4.1-Flash" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "openai", id: "gpt-5.6-luna" },
      { provider: "openai", id: "gpt-6.1-terra" },
      // Legacy ChatGPT-backend subscription provider.
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

  interface ResolvedSubmittedSummary {
    approvedSummary: string;
    summaryMeta: SummaryMeta;
  }

  function resolveSummaryForSubmit(
    payload: { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta },
    resultsByIndex: Map<number, QueryResultData>,
  ): ResolvedSubmittedSummary {
    const submittedSummary = isStringValue(payload.summary) ? payload.summary.trim() : "";
    if (submittedSummary.length > 0) {
      return {
        approvedSummary: submittedSummary,
        summaryMeta: normalizeSummaryMeta(payload.summaryMeta, submittedSummary),
      };
    }

    const selected = filterByQueryIndices(payload.selectedQueryIndices, resultsByIndex).results;
    const fallbackResults = selected.length > 0 ? selected : [...resultsByIndex.values()];
    const deterministic = buildDeterministicSummary(fallbackResults);
    return {
      approvedSummary: deterministic.summary,
      summaryMeta: deterministic.meta,
    };
  }

  function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<DetailObject> {
    const sc = opts.results.filter((r) => !r.error).length;
    const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

    const approvedSummary = isStringValue(opts.approvedSummary) ? opts.approvedSummary.trim() : "";
    const hasApprovedSummary = approvedSummary.length > 0;
    let output = "";
    if (hasApprovedSummary) {
      output = approvedSummary;
    } else {
      if (opts.curated) {
        output +=
          "[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
      }
      const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
      for (const queryData of opts.results) {
        const { query, error, provider } = queryData;
        if (opts.queryList.length > 1) {
          output += opts.curated
            ? formatQueryHeader(query, provider, duplicateQueries)
            : `## Query: "${query}"\n\n`;
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
      if (!hasApprovedSummary) {
        output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
      }
    } else if (opts.includeContent) {
      fetchId = startBackgroundFetch(opts.urls);
      if (fetchId && !hasApprovedSummary) {
        output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
      }
    }

    const searchId = storeAndPublishSearch(opts.results);
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
    if (opts.curated) {
      details.curated = true;
      details.curatedFrom = opts.curatedFrom;
      details.curatedQueries = opts.results.map((r) => ({
        query: r.query,
        provider: r.provider || null,
        answer: r.answer || null,
        sources: r.results.map((s) => ({ title: s.title, url: s.url })),
        error: r.error,
      }));
    }
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

  function filterByQueryIndices(
    selectedQueryIndices: number[],
    results: Map<number, QueryResultData>,
  ) {
    const filteredResults: QueryResultData[] = [];
    const filteredUrls: string[] = [];
    for (const qi of selectedQueryIndices) {
      const r = results.get(qi);
      if (r) {
        filteredResults.push(r);
        for (const res of r.results) {
          if (!filteredUrls.includes(res.url)) filteredUrls.push(res.url);
        }
      }
    }
    return { results: filteredResults, urls: filteredUrls };
  }

  function collectAllResultsAndUrls(resultsByIndex: Map<number, QueryResultData>) {
    const results = [...resultsByIndex.values()];
    const urls: string[] = [];
    for (const result of results) {
      for (const source of result.results) {
        if (!urls.includes(source.url)) urls.push(source.url);
      }
    }
    return { results, urls };
  }

  async function openCuratorBrowser(
    callId: string,
    pc: PendingCurate,
    ctx: ExtensionContext,
    searchesComplete = true,
  ): Promise<void> {
    if (pendingCurates.get(callId) !== pc) return;
    let handle: CuratorServerHandle | null = null;
    const sendCuratorFallbackUpdate = (message: string) => {
      if (!handle) return;
      pc.onUpdate?.({
        content: [{ type: "text", text: `${message}\nOpen manually: ${handle.url}` }],
        details: {
          phase: "curator-fallback",
          progress: searchesComplete ? 1 : 0.5,
          curatorUrl: handle.url,
          timeoutSeconds: pc.timeoutSeconds,
          shortcut: curateKey,
          browserOpenError: pc.browserOpenError,
        },
      });
    };
    try {
      pc.phase = "curating";

      const searchAbort = new AbortController();
      const addSearchSignal = pc.signal
        ? AbortSignal.any([pc.signal, searchAbort.signal])
        : searchAbort.signal;

      const sessionToken = randomUUID();
      handle = await startCuratorServer(
        {
          queries: pc.queryList,
          sessionToken,
          timeout: pc.timeoutSeconds,
          availableProviders: pc.availableProviders,
          defaultProvider: pc.defaultProvider,
          searchProvider: toCuratorProvider(pc.searchProvider) ?? "auto",
          summaryModels: pc.summaryModels,
          defaultSummaryModel: pc.defaultSummaryModel,
        },
        {
          async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
            if (pendingCurates.get(callId) !== pc)
              throw new Error("Curator session is no longer active.");
            pc.onUpdate?.({
              content: [{ type: "text", text: "Generating summary draft..." }],
              details: {
                phase: "generating-summary",
                progress: 0.9,
                curatorUrl: pc.curatorUrl,
                timeoutSeconds: pc.timeoutSeconds,
                shortcut: curateKey,
              },
            });
            const draft = await generateSummaryForSelectedIndices(
              selectedQueryIndices,
              pc.searchResults,
              pc.summaryContext,
              summarizeSignal,
              model,
              feedback,
            );
            if (pendingCurates.get(callId) !== pc)
              throw new Error("Curator session is no longer active.");
            pc.onUpdate?.({
              content: [{ type: "text", text: "Summary draft ready — waiting for approval..." }],
              details: {
                phase: "waiting-for-approval",
                progress: 1,
                curatorUrl: pc.curatorUrl,
                timeoutSeconds: pc.timeoutSeconds,
                shortcut: curateKey,
              },
            });
            return draft;
          },
          onSubmit(payload) {
            if (pendingCurates.get(callId) !== pc) return;
            searchAbort.abort();
            const filtered =
              payload.selectedQueryIndices.length > 0
                ? filterByQueryIndices(payload.selectedQueryIndices, pc.searchResults)
                : collectAllResultsAndUrls(pc.searchResults);
            const filteredInline = pc.allInlineContent.filter((c) => filtered.urls.includes(c.url));
            const base: SearchReturnOptions = {
              queryList: filtered.results.map((r) => r.query),
              results: filtered.results,
              urls: filtered.urls,
              includeContent: pc.includeContent,
              inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
              curated: true,
              curatedFrom: pc.searchResults.size,
            };
            if (!payload.rawResults) {
              const resolvedSummary = resolveSummaryForSubmit(payload, pc.searchResults);
              base.workflow = pc.workflow;
              base.approvedSummary = resolvedSummary.approvedSummary;
              base.summaryMeta = resolvedSummary.summaryMeta;
            }
            pc.finish(buildSearchReturn(base));
            closeCurator(callId);
          },
          onCancel(reason) {
            if (pendingCurates.get(callId) !== pc) return;
            searchAbort.abort();
            if (reason === "timeout") {
              const resolvedSummary = resolveSummaryForSubmit(
                { selectedQueryIndices: [], summary: undefined, summaryMeta: undefined },
                pc.searchResults,
              );
              const all = collectAllResultsAndUrls(pc.searchResults);
              const filteredInline = pc.allInlineContent.filter((c) => all.urls.includes(c.url));
              pc.finish(
                buildSearchReturn({
                  queryList: all.results.map((r) => r.query),
                  results: all.results,
                  urls: all.urls,
                  includeContent: pc.includeContent,
                  inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
                  curated: true,
                  curatedFrom: pc.searchResults.size,
                  workflow: pc.workflow,
                  approvedSummary: resolvedSummary.approvedSummary,
                  summaryMeta: resolvedSummary.summaryMeta,
                }),
              );
            } else {
              const conn = activeCurators.get(callId)?.getConnectionState();
              pc.finish(
                buildCurationCancelledReturn(reason, {
                  queries: Array.from(pc.searchResults.values()),
                  queryCount: pc.queryList.length,
                  browserConnected: conn?.browserConnected,
                  lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
                  curatorUrl: pc.curatorUrl,
                  browserOpenError: pc.browserOpenError,
                }),
              );
            }
            closeCurator(callId);
          },
          onProviderChange(provider) {
            if (pendingCurates.get(callId) !== pc) return;
            const normalized = normalizeProviderInput(provider);
            if (!normalized || normalized === "auto" || Array.isArray(normalized)) return;
            pc.defaultProvider = normalized;
            pc.searchProvider = normalized;
            try {
              saveConfig({ provider: normalized });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`Failed to persist default provider: ${message}`);
            }
          },
          async onAddSearch(query, provider) {
            if (pendingCurates.get(callId) !== pc)
              throw new Error("Curator session is no longer active.");
            const requestedProvider = resolveCuratorSearchProvider(provider, pc.searchProvider);
            const response = publishAttributedReferences(
              await search(
                query,
                searchOptionsForCanonicalRequest(
                  pc.searchRequest,
                  requestedProvider,
                  addSearchSignal,
                  ctx,
                ),
              ),
            );
            if (pendingCurates.get(callId) !== pc)
              throw new Error("Curator session is no longer active.");
            if (response.inlineContent) pc.allInlineContent.push(...response.inlineContent);
            return toCuratorSearchEntries(response);
          },
          onAddSearchResults(entries) {
            if (pendingCurates.get(callId) !== pc) return;
            for (const entry of entries) {
              pc.searchResults.set(entry.queryIndex, indexedCuratorEntryToQueryResult(entry));
            }
          },
          async onRewriteQuery(query, rewriteSignal) {
            if (pendingCurates.get(callId) !== pc)
              throw new Error("Curator session is no longer active.");
            return rewriteSearchQuery(query, pc.summaryContext, rewriteSignal);
          },
        },
      );

      if (pendingCurates.get(callId) !== pc) {
        handle.close();
        return;
      }

      activeCurators.set(callId, handle);
      pc.curatorUrl = handle.url;

      for (const [qi, data] of pc.searchResults) {
        const slotIndex = pc.resultSlots.get(qi);
        if (data.error) {
          handle.pushError(qi, data.error, data.provider, { query: data.query, slotIndex });
        } else {
          const curatorEntry: AttributedCuratorSearchEntry = {
            answer: data.answer,
            results: data.results.map((r) => ({ ...r, domain: extractDomain(r.url) })),
            provider: data.provider || pc.defaultProvider,
            backend: data.transport ?? data.backend,
            warnings: data.warnings,
            references: data.references,
            searchDiagnostics: {
              adapterId: data.adapterId,
              transport: data.transport ?? data.backend,
              billing: data.billing,
              attempts: data.attempts,
              providerErrors: data.providerErrors,
            },
          };
          handle.pushResult(qi, {
            ...curatorEntry,
            query: data.query,
            slotIndex,
          });
        }
      }
      if (searchesComplete) handle.searchesDone();

      pc.onUpdate?.({
        content: [
          {
            type: "text",
            text: searchesComplete
              ? "Waiting for summary approval in browser..."
              : "Searches streaming to browser...",
          },
        ],
        details: {
          phase: "curating",
          progress: searchesComplete ? 1 : 0.5,
          curatorUrl: handle.url,
          timeoutSeconds: pc.timeoutSeconds,
          shortcut: curateKey,
        },
      });

      if (!shouldAutoOpenCuratorBrowser(loadConfig())) {
        sendCuratorFallbackUpdate("Search curator is running. Open the curator URL manually.");
        return;
      }

      const open = platform() === "darwin" ? await getGlimpseOpen() : null;
      if (open) {
        try {
          const win = openInGlimpse(open, handle.url, "Search Curator");
          glimpseWins.set(callId, win);
          win.on("closed", () => {
            if (glimpseWins.get(callId) === win) {
              glimpseWins.delete(callId);
              closeCurator(callId);
            }
          });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to open Glimpse curator window: ${message}`);
          glimpseWins.delete(callId);
        }
      }
      await openInBrowser(pi, handle.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to open curator UI: ${message}`);
      if (handle && activeCurators.get(callId) === handle && pendingCurates.get(callId) === pc) {
        pc.browserOpenError = message;
        sendCuratorFallbackUpdate(
          "Search curator is running, but the browser did not open automatically.",
        );
      } else if (
        pendingCurates.get(callId) === pc ||
        (handle && activeCurators.get(callId) === handle)
      ) {
        closeCurator(callId);
      }
    }
  }

  return {
    clearPublishedReferences,
    publishReferences,
    publishAttributedReferences,
    resolveCoreReference,
    startBackgroundFetch,
    storeAndPublishSearch,
    normalizeSummaryMeta,
    buildCurationCancelledReturn,
    generateSummaryForSelectedIndices,
    loadSummaryModelChoices,
    resolveSummaryForSubmit,
    buildSearchReturn,
    filterByQueryIndices,
    collectAllResultsAndUrls,
    openCuratorBrowser,
  };
}

export type SearchRuntime = ReturnType<typeof createSearchRuntime>;
