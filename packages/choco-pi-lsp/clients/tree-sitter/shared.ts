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
  postFilterParams?: any;
  queryDef?: TreeSitterQuery;
};
export type GetInlinePatternResultContract = {
  query: string;
  metavars: string[];
  postFilter?: string;
  postFilterParams?: any;
};

export const _require = createRequire(import.meta.url);
export const GRAMMAR_BY_LANGUAGE = new Map<string, string>(Object.entries(LANGUAGE_TO_GRAMMAR));

export const TREE_SITTER_MAX_SCAN_FILES = 20_000;

export const QUERY_BATCH_MAX_LOAD_FAILURES = 3;

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
  childForFieldName?: (field: string) => TreeSitterNode | null;
}

export interface TreeSitterParserInstance {
  setLanguage: (lang: TreeSitterLanguage) => void;
  parse: (content: string) => TreeSitterTree;
}

export interface StructuralMatch {
  file: string;
  line: number;
  column: number;
  matchedText: string;
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

export type ParsedTreeOutcome<T> = { parsed: true; value: T } | { parsed: false };

export const NOT_PARSED: ParsedTreeOutcome<never> = { parsed: false };

export interface QueryBatchEntry {
  queryDef: TreeSitterQuery;
  metavars: string[];
  postFilter?: string;
  postFilterParams?: unknown;
}

export interface QueryBatch {
  query: any;
  entries: QueryBatchEntry[];
  ownerOfPattern: number[];
}

export function createParserCounters(): TreeSitterParserCounters {
  return {
    parserInvocations: 0,
    parserDurationMs: 0,
    parserFailures: 0,
  };
}

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

export function classifyWebTreeSitterLoadFailure(
  err: LspBoundaryValue,
): "resolution" | "evaluation" {
  const codes = collectErrorCodes(err);
  return codes.some((code) => RESOLUTION_ERROR_CODES.has(code)) ? "resolution" : "evaluation";
}
