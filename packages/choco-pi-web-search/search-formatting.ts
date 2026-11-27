import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Static } from "@earendil-works/pi-schema";
import {
  canonicalSearchParams,
  type SearchAttemptDiagnostic,
  type SearchCapability,
  type SearchReference,
  type SearchRequest as UnifiedSearchRequest,
} from "./index.ts";
import type { ExtractedContent } from "./extract.ts";
import type { FullSearchOptions, SearchProviderSelection } from "./gemini-search.ts";
import type { QueryResultData } from "./storage.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import type { SearchErrorPlan } from "./render-search-error.ts";
import type { ResearchArtifact } from "./source-check.ts";
import {
  DEFAULT_TOOL_NAMES,
  normalizeRecencyFilter,
  resolveRequestedProvider,
  type DetailObject,
  type ExtensionTheme,
} from "./extension-config.ts";

export function renderSearchErrorPlan(
  plan: SearchErrorPlan,
  expanded: boolean,
  theme: ExtensionTheme,
) {
  if (expanded) {
    return new Text(
      plan.expanded
        .map((l, i) => (i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l)))
        .join("\n"),
      0,
      0,
    );
  }
  const box = new Box(1, 0, (t) => theme.bg("toolErrorBg", t));
  box.addChild(new Text(theme.fg("error", plan.expanded[0]), 0, 0));
  for (const line of plan.collapsed) {
    box.addChild(new Text(theme.fg("dim", line), 0, 0));
  }
  if (plan.expandHint) {
    box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
  }
  return box;
}

export function canonicalRequestForQuery(
  params: Static<typeof canonicalSearchParams>,
  query?: string,
): UnifiedSearchRequest {
  const request: UnifiedSearchRequest = {};
  if (query !== undefined) request.query = query;
  else if (params.query !== undefined) request.query = params.query;
  if (
    params.action === "search" ||
    params.action === "image" ||
    params.action === "open" ||
    params.action === "click" ||
    params.action === "find"
  )
    request.action = params.action;
  if (params.imageQuery !== undefined) request.imageQuery = params.imageQuery;
  if (params.url !== undefined) request.url = params.url;
  if (params.lineno !== undefined) request.lineno = params.lineno;
  if (params.open !== undefined) request.open = params.open;
  if (params.click !== undefined) request.click = params.click;
  if (params.find !== undefined) request.find = params.find;
  if (params.reference !== undefined) request.reference = params.reference;
  if (
    params.responseLength === "short" ||
    params.responseLength === "medium" ||
    params.responseLength === "long"
  )
    request.responseLength = params.responseLength;
  if (params.numResults !== undefined) request.numResults = params.numResults;
  const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
  if (recencyFilter !== undefined) request.recencyFilter = recencyFilter;
  if (params.recencyDays !== undefined) request.recencyDays = params.recencyDays;
  if (params.domainFilter !== undefined) request.domainFilter = params.domainFilter;
  if (params.includeContent !== undefined) request.includeContent = params.includeContent;
  if (params.country !== undefined) request.country = params.country;
  if (params.language !== undefined) request.language = params.language;
  if (
    params.safesearch === "off" ||
    params.safesearch === "moderate" ||
    params.safesearch === "strict"
  )
    request.safesearch = params.safesearch;
  if (params.offset !== undefined) request.offset = params.offset;
  if (
    params.exaSearchType === "auto" ||
    params.exaSearchType === "fast" ||
    params.exaSearchType === "instant" ||
    params.exaSearchType === "deep-lite" ||
    params.exaSearchType === "deep" ||
    params.exaSearchType === "deep-reasoning"
  )
    request.exaSearchType = params.exaSearchType;
  if (
    params.answerMode === "answer" ||
    params.answerMode === "results" ||
    params.answerMode === "both"
  )
    request.answerMode = params.answerMode;
  if (
    params.searchContextSize === "low" ||
    params.searchContextSize === "medium" ||
    params.searchContextSize === "high"
  )
    request.searchContextSize = params.searchContextSize;
  if (params.requiredCapabilities !== undefined)
    request.requiredCapabilities = params.requiredCapabilities.filter(isSearchCapability);
  if (params.providerOptions !== undefined) request.providerOptions = params.providerOptions;
  request.provider = resolveRequestedProvider(params.provider);
  return request;
}

function isSearchCapability(value: string): value is SearchCapability {
  return (
    value === "url" ||
    value === "lineno" ||
    value === "numResults" ||
    value === "recencyFilter" ||
    value === "recencyDays" ||
    value === "domainFilter" ||
    value === "domainExclusions" ||
    value === "includeContent" ||
    value === "country" ||
    value === "language" ||
    value === "safesearch" ||
    value === "offset" ||
    value === "exaSearchType" ||
    value === "answerMode" ||
    value === "responseLength" ||
    value === "searchContextSize"
  );
}

export function searchOptionsForCanonicalRequest(
  request: UnifiedSearchRequest,
  provider: SearchProviderSelection,
  signal: AbortSignal | undefined,
  extensionContext: ExtensionContext | undefined,
): FullSearchOptions {
  return {
    provider,
    numResults: request.numResults,
    recencyFilter: request.recencyFilter,
    recencyDays: request.recencyDays,
    domainFilter: request.domainFilter,
    includeContent: request.includeContent,
    country: request.country,
    language: request.language,
    safesearch: request.safesearch,
    offset: request.offset,
    exaSearchType: request.exaSearchType,
    answerMode: request.answerMode,
    responseLength: request.responseLength,
    searchContextSize: request.searchContextSize,
    requiredCapabilities: request.requiredCapabilities,
    providerOptions: request.providerOptions,
    signal,
    extensionContext,
  };
}

export function formatOwnedReferences(references: SearchReference[] | undefined): string[] {
  if (!references?.length) return [];
  return references.map(
    (reference) =>
      `Reference (${reference.kind}): ${reference.id} [${reference.adapterId}/${reference.transport}]`,
  );
}

export function formatSearchSummary(queryData: QueryResultData): string {
  const { results, answer, references } = queryData;
  const referenceLines = formatOwnedReferences(references);
  if (results.length === 0) {
    let output = answer
      ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.`
      : "No results found.";
    if (referenceLines.length > 0) output += `\n\n**References:**\n${referenceLines.join("\n")}`;
    const diagnostics = formatSearchDiagnostics(queryData);
    if (diagnostics.length > 0) output += `\n\n**Search diagnostics:**\n${diagnostics.join("\n")}`;
    return output;
  }
  let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
  output += results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
      const snippet = formatSearchSnippet(result.snippet);
      if (snippet) lines.push(`   ${snippet.replaceAll("\n", "\n   ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
  if (referenceLines.length > 0) output += `\n\n**References:**\n${referenceLines.join("\n")}`;
  const diagnostics = formatSearchDiagnostics(queryData);
  if (diagnostics.length > 0) output += `\n\n**Search diagnostics:**\n${diagnostics.join("\n")}`;
  return output;
}

const MAX_SEARCH_SNIPPET_CHARS = 1_200;
const MAX_SEARCH_DIAGNOSTIC_CHARS = 800;

function boundedSearchText(value: string, maxChars: number): string {
  const normalized = value.trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function formatSearchSnippet(snippet: string): string {
  return boundedSearchText(snippet, MAX_SEARCH_SNIPPET_CHARS);
}

function formatAttemptDiagnostic(attempt: SearchAttemptDiagnostic): string {
  const identity = `${attempt.family} via ${attempt.adapterId} (${attempt.transport})`;
  const reason = attempt.reason
    ? `: ${boundedSearchText(attempt.reason, MAX_SEARCH_DIAGNOSTIC_CHARS)}`
    : "";
  if (attempt.outcome === "error")
    return `- Fallback attempt: ${identity} failed${attempt.errorKind ? ` [${attempt.errorKind}]` : ""}${reason}`;
  return `- Fallback attempt: ${identity} was ${attempt.outcome}${reason}`;
}

export function formatSearchDiagnostics(queryData: QueryResultData): string[] {
  const lines: string[] = [];
  if (queryData.provider || queryData.adapterId || queryData.transport || queryData.backend) {
    const provider = queryData.provider ?? "unknown provider";
    const adapter = queryData.adapterId ? ` via ${queryData.adapterId}` : "";
    const transport = queryData.transport ?? queryData.backend;
    const transportText = transport ? ` (${transport})` : "";
    const billing = queryData.billing ? `, ${queryData.billing} billing` : "";
    lines.push(`- Backend: ${provider}${adapter}${transportText}${billing}`);
  }
  const attempts = queryData.attempts ?? [];
  const successIndex = attempts.findIndex((attempt) => attempt.outcome === "success");
  const fallbackAttempts = successIndex >= 0 ? attempts.slice(0, successIndex) : attempts;
  for (const attempt of fallbackAttempts) {
    if (attempt.outcome !== "success") lines.push(formatAttemptDiagnostic(attempt));
  }
  for (const warning of queryData.warnings ?? []) {
    lines.push(`- Warning: ${boundedSearchText(warning, MAX_SEARCH_DIAGNOSTIC_CHARS)}`);
  }
  for (const failure of queryData.providerErrors ?? []) {
    const kind = failure.kind ? ` [${failure.kind}]` : "";
    lines.push(
      `- Partial provider failure: ${failure.provider}${kind}: ${boundedSearchText(failure.error, MAX_SEARCH_DIAGNOSTIC_CHARS)}`,
    );
  }
  return lines;
}

export function searchDiagnosticDetails(result: QueryResultData): DetailObject {
  return {
    query: result.query,
    provider: result.provider,
    adapterId: result.adapterId,
    transport: result.transport ?? result.backend,
    billing: result.billing,
    warnings: result.warnings,
    attempts: result.attempts?.map((attempt) => ({ ...attempt })),
    providerErrors: result.providerErrors?.map((failure) => ({ ...failure })),
  };
}

export function formatSourceCheckResult(
  artifact: ResearchArtifact,
  getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent,
): string {
  const assessment = artifact.claims?.[0];
  const lines = [`# Source check: ${artifact.query}`, ""];
  if (assessment) {
    lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
    lines.push(`**Rationale:** ${assessment.rationale}`);
    if (assessment.supporting_passages.length > 0)
      lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
    if (assessment.contradicting_passages.length > 0)
      lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
    lines.push("");
  }
  if (artifact.sources.length > 0) {
    lines.push("## Sources");
    for (const source of artifact.sources)
      lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
    lines.push("");
  }
  if (artifact.errors?.length)
    lines.push(
      `Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`,
    );
  lines.push(
    getSearchContentTool
      ? `Artifact response_id: ${artifact.id} (retrievable via ${getSearchContentTool}).`
      : `Artifact response_id: ${artifact.id}. Content retrieval is not registered.`,
  );
  return lines.join("\n");
}

export function duplicateQuerySet(results: QueryResultData[]): Set<string> {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [query, count] of counts) {
    if (count > 1) duplicates.add(query);
  }
  return duplicates;
}

export function formatQueryHeader(
  query: string,
  provider: string | undefined,
  duplicateQueries: Set<string>,
): string {
  const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
  return `## Query: "${query}"${suffix}\n\n`;
}

export function hasFullInlineCoverage(
  urls: string[],
  inlineContent: ExtractedContent[] | undefined,
): boolean {
  if (!inlineContent || inlineContent.length === 0) return false;
  const coveredUrls = new Set(inlineContent.map((c) => c.url));
  return urls.every((url) => coveredUrls.has(url));
}

export function formatFullResults(queryData: QueryResultData): string {
  let output = `## Results for: "${queryData.query}"\n\n`;
  if (queryData.answer) {
    output += `${queryData.answer}\n\n---\n\n`;
  }
  for (const r of queryData.results) {
    output += `### ${r.title}\n${r.url}\n`;
    const snippet = formatSearchSnippet(r.snippet);
    if (snippet) output += `${snippet}\n`;
    output += "\n";
  }
  const referenceLines = formatOwnedReferences(queryData.references);
  if (referenceLines.length > 0) output += `**References:**\n${referenceLines.join("\n")}\n\n`;
  const diagnostics = formatSearchDiagnostics(queryData);
  if (diagnostics.length > 0) output += `**Search diagnostics:**\n${diagnostics.join("\n")}\n\n`;
  return output;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function updateWidget(ctx: ExtensionContext): void {
  const theme = ctx.ui.theme;
  const entries = activityMonitor.getEntries();
  const lines: string[] = [];

  lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

  if (entries.length === 0) {
    lines.push(theme.fg("muted", "  No activity yet"));
  } else {
    for (const e of entries) {
      lines.push("  " + formatEntryLine(e, theme));
    }
  }

  lines.push(theme.fg("accent", "─".repeat(60)));

  const rateInfo = activityMonitor.getRateLimitInfo();
  const resetMs = rateInfo.oldestTimestamp
    ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now())
    : 0;
  const resetSec = Math.ceil(resetMs / 1000);
  lines.push(
    theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
      (resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
  );

  ctx.ui.setWidget("web-activity", lines);
}

function formatEntryLine(entry: ActivityEntry, theme: ExtensionTheme): string {
  const typeStr = entry.type === "api" ? "API" : "GET";
  const target =
    entry.type === "api"
      ? `"${truncateToWidth(entry.query || "", 28, "")}"`
      : truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

  const duration = entry.endTime
    ? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
    : `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

  let statusStr: string;
  let indicator: string;
  if (entry.error) {
    statusStr = "err";
    indicator = theme.fg("error", "✗");
  } else if (entry.status === null) {
    statusStr = "...";
    indicator = theme.fg("warning", "⋯");
  } else if (entry.status === 0) {
    statusStr = "abort";
    indicator = theme.fg("muted", "○");
  } else {
    statusStr = String(entry.status);
    indicator =
      entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
  }

  return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}
