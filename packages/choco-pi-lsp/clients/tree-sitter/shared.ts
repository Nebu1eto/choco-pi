/**
 * Tree-sitter client constants, structural node/parser types, parser counters, and web-tree-sitter load-failure classification.
 */
import {
  isBoolean,
  isFiniteNumber,
  isFunction,
  isNull,
  isObjectRecord,
  isString,
  isUndefined,
  type LspBoundaryValue,
} from "../runtime-guards.ts";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { LANGUAGE_TO_GRAMMAR } from "../grammar-source.ts";
import type { TreeCacheCounters, TreeCacheStats } from "../tree-sitter-cache.ts";
import type { TreeSitterQuery } from "../tree-sitter-query-loader.ts";

export type GetRuntimeStatsResultContract = {
  languagesLoaded: number;
  parsersLoaded: number;
  queryCacheSize: number;
  queryBatchCacheSize: number;
};
export type PatternToQueryResultContract = {
  query: string;
  metavars: string[];
  postFilter?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Post filter params
  postFilterParams?: any;
  queryDef?: TreeSitterQuery;
};
export type GetInlinePatternResultContract = {
  query: string;
  metavars: string[];
  postFilter?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Post filter params
  postFilterParams?: any;
};

export const _require = createRequire(import.meta.url);
export const GRAMMAR_BY_LANGUAGE = new Map<string, string>(Object.entries(LANGUAGE_TO_GRAMMAR));

// Hard cap on a single structural-search file walk. Bounds a misrooted scan so
// it can't enumerate an unbounded tree synchronously before result collection
// short-circuits (#262).
export const TREE_SITTER_MAX_SCAN_FILES = 20_000;

// Consecutive grammar-load failures after which a batch cache key gives up and
// caches null like any other deterministic failure. Bounds the retry loop when
// a grammar simply never loads, while still letting a transient loadLanguage()
// failure (offline lazy fetch, mid-scan load error) recover on a later scan
// instead of paying the 3.3x per-rule fallback for the process lifetime (#889).
export const QUERY_BATCH_MAX_LOAD_FAILURES = 3;

// Keep post-filter tree walks bounded. A malformed or unexpectedly huge tree
// must not stall the batched query walk; the filter fails open when this cap
// is reached so unrelated diagnostics and the current match are preserved.
export const NO_NESTED_ANCHOR_VISIT_CAP = 10_000;

export function describeQueryPredicateValue(value: any): string {
  if (isUndefined(value)) return "undefined";
  if (isNull(value)) return "object";
  if (isString(value)) return "string";
  if (isFiniteNumber(value)) return "number";
  if (isBoolean(value)) return "boolean";
  if (isFunction(value)) return "function";
  if (Array.isArray(value) || isObjectRecord(value)) return "object";
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

// --- Type Declarations (local, no import needed) ---

// biome-ignore lint/suspicious/noExplicitAny: Language from web-tree-sitter
export type TreeSitterLanguage = any;

export interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

export interface TreeSitterNode {
  type: string;
  text: string;
  children: TreeSitterNode[];
  parent?: TreeSitterNode | null;
  isNamed: boolean;
  childCount: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  /** web-tree-sitter field accessor — optional so mock nodes in tests
   * without field support still satisfy the interface. */
  childForFieldName?: (field: string) => TreeSitterNode | null;
}

export interface TreeSitterParserInstance {
  setLanguage: (lang: TreeSitterLanguage) => void;
  parse: (content: string) => TreeSitterTree;
}

// --- Types ---

export interface StructuralMatch {
  file: string;
  line: number;
  column: number;
  matchedText: string;
  /** Tree-sitter node type of the first capture (e.g. "call_expression") */
  nodeType?: string;
  captures: Record<string, string>;
}

export interface SearchPattern {
  pattern: string;
  language: string;
  metavars: string[];
}

export interface TreeSitterParserCounters {
  parserInvocations: number;
  parserDurationMs: number;
  parserFailures: number;
}

export interface TreeSitterParseCacheStats extends TreeCacheStats, TreeSitterParserCounters {}

export type ParseCacheMeasurement = TreeCacheCounters & TreeSitterParserCounters;

/**
 * Result of a cache-safe parse. `parsed: false` means the grammar/parse was
 * unavailable — distinct from a consumer that legitimately returned null.
 */
export type ParsedTreeOutcome<T> = { parsed: true; value: T } | { parsed: false };

export const NOT_PARSED: ParsedTreeOutcome<never> = { parsed: false };

export interface QueryBatchEntry {
  queryDef: TreeSitterQuery;
  metavars: string[];
  postFilter?: string;
  postFilterParams?: unknown;
}

export interface QueryBatch {
  // biome-ignore lint/suspicious/noExplicitAny: compiled web-tree-sitter Query
  query: any;
  entries: QueryBatchEntry[];
  /** patternIndex → index into `entries`. */
  ownerOfPattern: number[];
}

export function createParserCounters(): TreeSitterParserCounters {
  return {
    parserInvocations: 0,
    parserDurationMs: 0,
    parserFailures: 0,
  };
}

/**
 * `size:mtimeMs` identity for a grammar candidate, or undefined when the path
 * is absent or not a regular file. Doubles as the existence check on the
 * resolve path and as the invalidation key for the verified-preamble memo
 * (#1548) — `size` + `mtimeMs` is the codebase's standard cheap stamp.
 */
export function grammarFileStamp(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : undefined;
  } catch {
    return undefined;
  }
}

export function isTreeSitterWasmAbortError(error: LspBoundaryValue): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Aborted") || message.includes("abort()");
}

/**
 * Positively-identified RESOLUTION-failure codes for a dynamic `import()`:
 * the specifier couldn't be found/resolved, or a transient fs error hit
 * before `import()` got as far as evaluating the target module. All of
 * these recover once whatever was missing/busy appears — they say nothing
 * durable about the module itself (mirrors the errno allowlist in
 * clients/dispatch/runners/ast-grep-napi.ts's `classifyAstGrepLoadFailure`,
 * kept local here rather than shared because that file is owned by an
 * in-flight PR, #1701, at the time of writing).
 */
const RESOLUTION_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ENOENT",
  "EMFILE",
  "EBUSY",
  "EAGAIN",
  "EPERM",
  "ETXTBSY",
]);

/** Walk an error's `.cause` chain, collecting every `code` seen along the
 * way — a resolution failure's `code` can be wrapped in a cause rather than
 * sitting on the top-level thrown Error. */

function collectErrorCodes(err: LspBoundaryValue): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    const code = (current as Error & { code?: unknown }).code;

    if (isString(code)) codes.push(code);

    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    current = (current as Error & { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * Classify a `loadWebTreeSitter()` rejection (#1592). RESOLUTION failures
 * (a positively-identified code above) are recoverable: the module gets a
 * fresh `import()` attempt on the very next `init()` call, same as before
 * this fix, because whatever blocked resolution can plausibly clear on its
 * own. Everything else is treated as EVALUATION-shaped and latches — an
 * unrecognized error is far more likely to be the target module's own
 * top-level code throwing (which Node's ESM loader then memoizes as a
 * permanently-rejected module record for that URL) than an unclassified
 * resolution hiccup, so "unknown" defaults to the case a retry cannot fix.
 */

export function classifyWebTreeSitterLoadFailure(
  err: LspBoundaryValue,
): "resolution" | "evaluation" {
  const codes = collectErrorCodes(err);
  return codes.some((code) => RESOLUTION_ERROR_CODES.has(code)) ? "resolution" : "evaluation";
}
