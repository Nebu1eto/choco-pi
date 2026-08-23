// Structured source checking and machine-readable research artifacts.
import { createHash } from "node:crypto";
import { generateId, getResult, storeResult } from "./storage.ts";
import type { SearchResult } from "./search-types.ts";
import type { ExtractedContent } from "./extract.ts";

export type SourceQuality =
  | "official_docs"
  | "vendor_docs"
  | "repo_issue"
  | "blog"
  | "forum"
  | "news"
  | "unknown";
export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";
export type RecencyFilter = "day" | "week" | "month" | "year";

export interface ResearchSource {
  rank: number;
  url: string;
  title: string;
  snippet?: string;
  fetch_timestamp?: number;
  content_hash?: string;
  quality: SourceQuality;
  fetched?: boolean;
  fetch_error?: string;
}

export interface ResearchPassage {
  passage_id: string;
  source_url: string;
  source_rank: number;
  text: string;
  extraction_span?: { start: number; end: number };
  content_hash?: string;
}

export interface ClaimAssessment {
  claim: string;
  status: ClaimStatus;
  supporting_passages: string[];
  contradicting_passages: string[];
  rationale: string;
  confidence: number;
}

export interface ResearchArtifact {
  id: string;
  type: "research";
  timestamp: number;
  query: string;
  sources: ResearchSource[];
  passages: ResearchPassage[];
  claims?: ClaimAssessment[];
  provider?: string;
  summary?: string;
  content_hash?: string;
  filters?: { recency?: RecencyFilter; domain_include?: string[]; domain_exclude?: string[] };
  errors?: Array<{ query: string; error: string }>;
}

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blogs?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS =
  /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(\/|$)/i;

export function classifySource(url: string): SourceQuality {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    return "unknown";
  }
  if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
  if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
  if (VENDOR_DOCS_PATHS.test(path)) return "vendor_docs";
  if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return "news";
  if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return "forum";
  if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return "blog";
  return "unknown";
}

export function hashContent(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Span {
  text: string;
  start: number;
  end: number;
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 3),
    ),
  ];
}

function extractRelevantSpans(content: string, hint: string): Span[] {
  const sentences: Span[] = [];
  const sentencePattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  for (const match of content.matchAll(sentencePattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (text.length > 0 && text.length <= 400) {
      const start = (match.index ?? 0) + raw.indexOf(text);
      sentences.push({ text, start, end: start + text.length });
    }
  }
  const terms = tokenize(hint);
  if (terms.length === 0) return [];
  return sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: terms.filter((term) => sentence.text.toLowerCase().includes(term)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(({ sentence }) => sentence);
}

function passageId(sourceRank: number, index: number): string {
  return `p-${sourceRank}-${index}`;
}

export function buildPassages(
  sources: ResearchSource[],
  fetched: ExtractedContent[] = [],
  hint = "",
): ResearchPassage[] {
  const passages: ResearchPassage[] = [];
  const fetchedByUrl = new Map(fetched.map((item) => [item.url, item]));
  for (const source of sources) {
    if (source.snippet) {
      passages.push({
        passage_id: passageId(source.rank, 0),
        source_url: source.url,
        source_rank: source.rank,
        text: source.snippet,
        content_hash: hashContent(source.snippet),
      });
    }
    const page = fetchedByUrl.get(source.url);
    if (page && !page.error && page.content) {
      const passageHint = source.snippet?.trim() || hint;
      for (const [index, span] of extractRelevantSpans(page.content, passageHint).entries()) {
        passages.push({
          passage_id: passageId(source.rank, index + 1),
          source_url: source.url,
          source_rank: source.rank,
          text: span.text,
          extraction_span: { start: span.start, end: span.end },
          content_hash: hashContent(span.text),
        });
      }
    }
  }
  return passages;
}

const CONTRADICTION_MARKERS = [
  "not true",
  "false",
  "incorrect",
  "debunked",
  "retracted",
  "no longer",
  "never",
  "denied",
  "contrary",
  "misleading",
];
const SUPPORT_MARKERS = [
  "yes",
  "true",
  "correct",
  "confirmed",
  "according to",
  "shows that",
  "demonstrates",
  "reported",
  "verified",
  "established",
];

function containsPhrase(value: string, phrase: string): boolean {
  const escaped = phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(value);
}

function markerIsNegated(value: string, marker: string): boolean {
  const escaped = marker
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const markerPattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i");
  const match = markerPattern.exec(value);
  if (!match || match.index === undefined) return false;
  const matchedMarker = match[0].replace(/^[^a-z0-9]+/i, "");
  const beforeMarker = value.slice(0, match.index + match[0].length - matchedMarker.length);
  return /(?:^|[^a-z0-9])(?:not|no|never|without)\s+$/i.test(beforeMarker);
}

function hasPolarityMarker(value: string, markers: string[], allowNegated = false): boolean {
  return markers.some(
    (marker) => containsPhrase(value, marker) && (allowNegated || !markerIsNegated(value, marker)),
  );
}

export function assessClaim(claim: string, passages: ResearchPassage[]): ClaimAssessment {
  const terms = tokenize(claim);
  if (terms.length === 0 || passages.length === 0) {
    return {
      claim,
      status: "missing-evidence",
      supporting_passages: [],
      contradicting_passages: [],
      rationale: "No passages available that discuss the claim's terms.",
      confidence: 0.2,
    };
  }
  const supporting: string[] = [];
  const contradicting: string[] = [];
  for (const passage of passages) {
    const lower = passage.text.toLowerCase();
    const overlap = terms.filter((term) => containsPhrase(lower, term)).length;
    if (overlap < Math.max(2, Math.ceil(terms.length / 4))) continue;
    const contra = hasPolarityMarker(lower, CONTRADICTION_MARKERS);
    const support = hasPolarityMarker(lower, SUPPORT_MARKERS);
    if (contra && !support) contradicting.push(passage.passage_id);
    else if (support && !contra) supporting.push(passage.passage_id);
  }
  if (contradicting.length > 0 && supporting.length === 0) {
    return {
      claim,
      status: "contradicted",
      supporting_passages: [],
      contradicting_passages: contradicting,
      rationale: `${contradicting.length} passage(s) contradict the claim; none support it.`,
      confidence: Math.min(0.85, 0.5 + contradicting.length * 0.1),
    };
  }
  if (supporting.length > 0 && contradicting.length === 0) {
    return {
      claim,
      status: "supported",
      supporting_passages: supporting,
      contradicting_passages: [],
      rationale: `${supporting.length} passage(s) support the claim; none contradict it.`,
      confidence: Math.min(0.85, 0.5 + supporting.length * 0.1),
    };
  }
  if (supporting.length > 0 || contradicting.length > 0) {
    return {
      claim,
      status: "unclear",
      supporting_passages: supporting,
      contradicting_passages: contradicting,
      rationale: `${supporting.length} supporting and ${contradicting.length} contradicting passage(s); evidence is mixed.`,
      confidence: 0.4,
    };
  }
  return {
    claim,
    status: "unclear",
    supporting_passages: [],
    contradicting_passages: [],
    rationale:
      "Passages mention the claim's terms but contain no clear support or contradiction markers.",
    confidence: 0.3,
  };
}

interface RankedSearchResult extends SearchResult {
  rank?: number;
}

export interface BuildArtifactInput {
  query: string;
  provider?: string;
  summary?: string;
  results: RankedSearchResult[];
  fetched?: ExtractedContent[];
  recency?: RecencyFilter;
  domainFilter?: string[];
}

export function buildResearchArtifact(input: BuildArtifactInput): ResearchArtifact {
  const filters = input.domainFilter ?? [];
  const fetchedByUrl = new Map((input.fetched ?? []).map((page) => [page.url, page]));
  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const [index, result] of input.results.entries()) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const page = fetchedByUrl.get(result.url);
    const fetched = Boolean(page && !page.error);
    const source: ResearchSource = {
      rank: result.rank ?? index + 1,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      quality: classifySource(result.url),
      fetched,
    };
    if (page) source.fetch_timestamp = Date.now();
    if (page && !page.error) source.content_hash = hashContent(page.content);
    if (page?.error) source.fetch_error = page.error;
    sources.push(source);
  }
  const passages = buildPassages(sources, input.fetched, input.query);
  const domainInclude = filters.filter((domain) => !domain.startsWith("-"));
  const domainExclude = filters
    .filter((domain) => domain.startsWith("-"))
    .map((domain) => domain.slice(1));
  const filtersValue: NonNullable<ResearchArtifact["filters"]> = {
    domain_include: domainInclude,
    domain_exclude: domainExclude,
  };
  if (input.recency !== undefined) filtersValue.recency = input.recency;
  const artifact: ResearchArtifact = {
    id: generateId(),
    type: "research",
    timestamp: Date.now(),
    query: input.query,
    sources,
    passages,
    filters: filtersValue,
  };
  if (input.provider !== undefined) artifact.provider = input.provider;
  if (input.summary !== undefined) artifact.summary = input.summary;
  if (passages.length > 0)
    artifact.content_hash = hashContent(passages.map((passage) => passage.text).join("\n"));
  return artifact;
}

export function withClaimAssessment(
  artifact: ResearchArtifact,
  claims: string[],
): ResearchArtifact {
  return { ...artifact, claims: claims.map((claim) => assessClaim(claim, artifact.passages)) };
}

export function storeResearchArtifact(artifact: ResearchArtifact): void {
  if (!artifact.id) throw new Error("Research artifact id must not be empty");
  storeResult(artifact.id, {
    id: artifact.id,
    type: "research",
    timestamp: artifact.timestamp,
    artifact,
  });
}

function isObject<Value>(value: Value): value is Value & object {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber<Value>(value: Value): value is Value & number {
  return Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(value);
}

function isBoolean<Value>(value: Value): value is Value & boolean {
  return value === true || value === false;
}

function isStringArray<Value>(value: Value): value is Value & string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSourceQuality<Value>(value: Value): value is Value & SourceQuality {
  return (
    value === "official_docs" ||
    value === "vendor_docs" ||
    value === "repo_issue" ||
    value === "blog" ||
    value === "forum" ||
    value === "news" ||
    value === "unknown"
  );
}

function isClaimStatus<Value>(value: Value): value is Value & ClaimStatus {
  return (
    value === "supported" ||
    value === "contradicted" ||
    value === "unclear" ||
    value === "missing-evidence"
  );
}

function isRecencyFilter<Value>(value: Value): value is Value & RecencyFilter {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function isResearchSource<Value>(value: Value): value is Value & ResearchSource {
  return (
    isObject(value) &&
    "rank" in value &&
    isNumber(value.rank) &&
    "url" in value &&
    isString(value.url) &&
    "title" in value &&
    isString(value.title) &&
    "quality" in value &&
    isSourceQuality(value.quality) &&
    (!("snippet" in value) || isString(value.snippet)) &&
    (!("fetch_timestamp" in value) || isNumber(value.fetch_timestamp)) &&
    (!("content_hash" in value) || isString(value.content_hash)) &&
    (!("fetched" in value) || isBoolean(value.fetched)) &&
    (!("fetch_error" in value) || isString(value.fetch_error))
  );
}

function isExtractionSpan<Value>(value: Value): value is Value & { start: number; end: number } {
  return (
    isObject(value) &&
    "start" in value &&
    isNumber(value.start) &&
    "end" in value &&
    isNumber(value.end)
  );
}

function isResearchPassage<Value>(value: Value): value is Value & ResearchPassage {
  return (
    isObject(value) &&
    "passage_id" in value &&
    isString(value.passage_id) &&
    "source_url" in value &&
    isString(value.source_url) &&
    "source_rank" in value &&
    isNumber(value.source_rank) &&
    "text" in value &&
    isString(value.text) &&
    (!("extraction_span" in value) || isExtractionSpan(value.extraction_span)) &&
    (!("content_hash" in value) || isString(value.content_hash))
  );
}

function isClaimAssessment<Value>(value: Value): value is Value & ClaimAssessment {
  return (
    isObject(value) &&
    "claim" in value &&
    isString(value.claim) &&
    "status" in value &&
    isClaimStatus(value.status) &&
    "supporting_passages" in value &&
    isStringArray(value.supporting_passages) &&
    "contradicting_passages" in value &&
    isStringArray(value.contradicting_passages) &&
    "rationale" in value &&
    isString(value.rationale) &&
    "confidence" in value &&
    isNumber(value.confidence)
  );
}

function isResearchFilters<Value>(
  value: Value,
): value is Value & NonNullable<ResearchArtifact["filters"]> {
  return (
    isObject(value) &&
    (!("recency" in value) || isRecencyFilter(value.recency)) &&
    (!("domain_include" in value) || isStringArray(value.domain_include)) &&
    (!("domain_exclude" in value) || isStringArray(value.domain_exclude))
  );
}

function isResearchError<Value>(value: Value): value is Value & { query: string; error: string } {
  return (
    isObject(value) &&
    "query" in value &&
    isString(value.query) &&
    "error" in value &&
    isString(value.error)
  );
}

function isResearchArtifact<Value>(value: Value): value is Value & ResearchArtifact {
  return (
    isObject(value) &&
    "id" in value &&
    isString(value.id) &&
    "type" in value &&
    value.type === "research" &&
    "timestamp" in value &&
    isNumber(value.timestamp) &&
    "query" in value &&
    isString(value.query) &&
    "sources" in value &&
    Array.isArray(value.sources) &&
    value.sources.every(isResearchSource) &&
    "passages" in value &&
    Array.isArray(value.passages) &&
    value.passages.every(isResearchPassage) &&
    (!("claims" in value) ||
      (Array.isArray(value.claims) && value.claims.every(isClaimAssessment))) &&
    (!("provider" in value) || isString(value.provider)) &&
    (!("summary" in value) || isString(value.summary)) &&
    (!("content_hash" in value) || isString(value.content_hash)) &&
    (!("filters" in value) || isResearchFilters(value.filters)) &&
    (!("errors" in value) || (Array.isArray(value.errors) && value.errors.every(isResearchError)))
  );
}

export function getResearchArtifact(id: string): ResearchArtifact | null {
  const data = getResult(id);
  if (!data || data.type !== "research" || !isResearchArtifact(data.artifact)) return null;
  return data.artifact;
}
