import { randomUUID } from "node:crypto";
import type { SearchRequest } from "../../../choco-pi-web-search/index.ts";
import type { JsonValue } from "../client/http.ts";

export const FALLBACK_WEB_SEARCH_MODEL_ID = "gemini-3.5-flash-lite";
const MAX_OUTPUT_TOKENS = 8192;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_FILTER_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u;

export function selectWebSearchModel(advertised: readonly string[]): string {
  return advertised.find((id) => MODEL_ID.test(id)) ?? FALLBACK_WEB_SEARCH_MODEL_ID;
}

export function searchQueries(request: SearchRequest): string[] {
  if (request.queries?.length) return request.queries;
  if (request.query) return [request.query];
  return [];
}

export type GoogleSearchTool = {
  includedDomains?: string[];
  excludeDomains?: string[];
  timeRangeFilter?: { startTime: string; endTime: string };
};

function recencyDays(request: SearchRequest): number | undefined {
  if (request.recencyDays !== undefined) return request.recencyDays;
  return request.recencyFilter ? RECENCY_FILTER_DAYS[request.recencyFilter] : undefined;
}

export function buildGoogleSearchTool(request: SearchRequest, now: number): GoogleSearchTool {
  const tool: GoogleSearchTool = {};
  const included: string[] = [];
  const excluded: string[] = [];
  for (const raw of request.domainFilter ?? []) {
    const negative = raw.startsWith("-");
    const domain = (negative ? raw.slice(1) : raw).toLowerCase();
    const target = negative ? excluded : included;
    if (!target.includes(domain)) target.push(domain);
  }
  if (included.length > 0) tool.includedDomains = included;
  if (excluded.length > 0) tool.excludeDomains = excluded;
  const days = recencyDays(request);
  if (days !== undefined) {
    tool.timeRangeFilter = {
      startTime: new Date(now - days * DAY_MS).toISOString(),
      endTime: new Date(now).toISOString(),
    };
  }
  return tool;
}

function promptFor(queries: readonly string[]): string {
  const head =
    "Run a Google Search before answering. Answer only from the search results, concisely and factually.";
  if (queries.length === 1) return `${head}\n\nQuery: ${queries[0] ?? ""}`;
  return `${head} Cover every query.\n\nQueries:\n${queries.map((query) => `- ${query}`).join("\n")}`;
}

function toolJson(tool: GoogleSearchTool): GoogleSearchTool {
  const json: GoogleSearchTool = {};
  if (tool.includedDomains) json.includedDomains = [...tool.includedDomains];
  if (tool.excludeDomains) json.excludeDomains = [...tool.excludeDomains];
  if (tool.timeRangeFilter) json.timeRangeFilter = { ...tool.timeRangeFilter };
  return json;
}

export interface GroundingRequestInput {
  projectId: string;
  model: string;
  queries: readonly string[];
  tool: GoogleSearchTool;
  now: number;
}

export function buildGroundingRequest(input: GroundingRequestInput): JsonValue {
  return {
    project: input.projectId,
    requestId: `agent/${randomUUID()}/${input.now}/${randomUUID()}/1`,
    model: input.model,
    userAgent: "antigravity",
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: promptFor(input.queries) }] }],
      tools: [{ googleSearch: toolJson(input.tool) }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
  };
}
