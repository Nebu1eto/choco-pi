import { arr, bool, compile, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import type { SearchResult } from "../../../choco-pi-web-search/index.ts";

// Shapes follow the aiplatform content.proto descriptors (GroundingMetadata, GroundingChunk.Web,
// GroundingSupport, Segment) in proto3 JSON. No live search response was captured; see
// docs/search.md.
const WebChunkSchema = obj(
  { uri: opt(str()), title: opt(str()), domain: opt(str()), text: opt(str()) },
  { open: true },
);
const GroundingChunkSchema = obj({ web: opt(WebChunkSchema) }, { open: true });
const SegmentSchema = obj(
  { partIndex: opt(num()), startIndex: opt(num()), endIndex: opt(num()), text: opt(str()) },
  { open: true },
);
const GroundingSupportSchema = obj(
  {
    segment: opt(SegmentSchema),
    groundingChunkIndices: opt(arr(num())),
    confidenceScores: opt(arr(num())),
  },
  { open: true },
);
const GroundingMetadataSchema = obj(
  {
    webSearchQueries: opt(arr(str())),
    groundingChunks: opt(arr(GroundingChunkSchema)),
    groundingSupports: opt(arr(GroundingSupportSchema)),
  },
  { open: true },
);
const PartSchema = obj({ text: opt(str()), thought: opt(bool()) }, { open: true });
const CandidateSchema = obj(
  {
    content: opt(obj({ parts: opt(arr(PartSchema)) }, { open: true })),
    finishReason: opt(str()),
    groundingMetadata: opt(GroundingMetadataSchema),
  },
  { open: true },
);
export const GroundingResponseSchema = obj(
  {
    response: obj(
      {
        candidates: opt(arr(CandidateSchema)),
        promptFeedback: opt(obj({ blockReason: opt(str()) }, { open: true })),
        modelVersion: opt(str()),
      },
      { open: true },
    ),
    traceId: opt(str()),
  },
  { open: true },
);
export type GroundingResponse = Static<typeof GroundingResponseSchema>;
export const groundingResponseValidator = compile(GroundingResponseSchema);

export interface GroundingCitation {
  /** The answer text the sources support. */
  text: string;
  /** One-based source numbers, matching the [n] markers and the Sources list. */
  sources: number[];
}

export interface NormalizedGrounding {
  answer: string;
  results: SearchResult[];
  citations: GroundingCitation[];
  webSearchQueries: string[];
  finishReason: string | undefined;
  /** True when the candidate carried no grounding metadata at all. */
  ungrounded: boolean;
}

export type GroundingFailure =
  | { kind: "blocked"; reason: string }
  | { kind: "empty"; finishReason: string | undefined };

const MAX_SNIPPET_CHARS = 300;

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS - 1)}…` : flat;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface Insertion {
  at: number;
  marker: string;
}

/**
 * Places [n] markers after each supported segment. Segment offsets are not trusted (their unit,
 * bytes or UTF-16, is unproven for this backend); the segment text is located in the answer.
 */
function annotate(answer: string, citations: readonly GroundingCitation[]): string {
  const insertions: Insertion[] = [];
  let cursor = 0;
  for (const citation of citations) {
    let index = answer.indexOf(citation.text, cursor);
    if (index < 0) index = answer.indexOf(citation.text);
    if (index < 0) continue;
    const end = index + citation.text.length;
    cursor = end;
    insertions.push({ at: end, marker: citation.sources.map((source) => `[${source}]`).join("") });
  }
  insertions.sort((left, right) => right.at - left.at);
  let annotated = answer;
  for (const { at, marker } of insertions) {
    annotated = `${annotated.slice(0, at)}${marker}${annotated.slice(at)}`;
  }
  return annotated;
}

/** Converts one validated generateContent response into an answer, sources and citations. */
export function normalizeGrounding(
  value: GroundingResponse,
): NormalizedGrounding | GroundingFailure {
  const candidate = value.response.candidates?.[0];
  if (!candidate) {
    const reason = value.response.promptFeedback?.blockReason;
    return reason ? { kind: "blocked", reason } : { kind: "empty", finishReason: undefined };
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => part.thought !== true && part.text)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  const metadata = candidate.groundingMetadata;

  const results: SearchResult[] = [];
  const numberByChunk = new Map<number, number>();
  const numberByUrl = new Map<string, number>();
  const snippets: string[][] = [];
  (metadata?.groundingChunks ?? []).forEach((chunk, index) => {
    const url = httpUrl(chunk.web?.uri);
    if (!url) return;
    let number = numberByUrl.get(url);
    if (number === undefined) {
      const title = chunk.web?.title?.trim() || chunk.web?.domain?.trim() || hostOf(url);
      results.push({ title, url, snippet: "" });
      number = results.length;
      numberByUrl.set(url, number);
      snippets.push(chunk.web?.text ? [chunk.web.text] : []);
    }
    numberByChunk.set(index, number);
  });

  const citations: GroundingCitation[] = [];
  for (const support of metadata?.groundingSupports ?? []) {
    const segment = support.segment?.text?.trim();
    if (!segment) continue;
    const sources: number[] = [];
    for (const index of support.groundingChunkIndices ?? []) {
      const number = numberByChunk.get(index);
      if (number !== undefined && !sources.includes(number)) sources.push(number);
    }
    if (sources.length === 0) continue;
    citations.push({ text: segment, sources });
    for (const number of sources) {
      const bucket = snippets[number - 1];
      if (bucket && !bucket.includes(segment)) bucket.push(segment);
    }
  }
  results.forEach((result, index) => {
    result.snippet = clip((snippets[index] ?? []).join(" "));
  });

  if (!text && results.length === 0) {
    return { kind: "empty", finishReason: candidate.finishReason };
  }
  let answer = annotate(text, citations);
  if (results.length > 0) {
    const sources = results.map((result, index) => `[${index + 1}] ${result.title}: ${result.url}`);
    answer = `${answer}\n\nSources:\n${sources.join("\n")}`.trim();
  }
  return {
    answer,
    results,
    citations,
    webSearchQueries: [...(metadata?.webSearchQueries ?? [])],
    finishReason: candidate.finishReason,
    ungrounded: metadata === undefined,
  };
}

export function isGroundingFailure(
  value: NormalizedGrounding | GroundingFailure,
): value is GroundingFailure {
  return "kind" in value;
}
