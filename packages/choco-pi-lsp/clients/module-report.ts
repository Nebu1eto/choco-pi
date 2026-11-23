import { assignOptionalProperties } from "./optional-properties.ts";
import { isFiniteNumber, type LspBoundaryValue } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectFileKind } from "./file-kinds.ts";
import { logLatency } from "./latency-logger.ts";
import { annotateMiddleMan } from "./middle-man-analysis.ts";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.ts";
import {
  loadCallGraph,
  type CallGraphCacheIdentity,
  type CallGraphEvidenceCoverage,
  type ResolvedCallEdge,
} from "./call-graph.ts";
import { resolveImportToFiles } from "./review-graph/import-resolvers.ts";
import { buildSymbolId } from "./review-graph/symbol-id.ts";
import type { ReviewGraph, ReviewGraphEdgeKind } from "./review-graph/types.ts";
import type { Symbol as ExtractedSymbol } from "./symbol-types.ts";
import { getSharedTreeSitterClient, resolveTreeSitterLanguage } from "./tree-sitter-shared.ts";
import { type ImportRef, TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.ts";

type ReadArgsForResultContract = { path: string; offset: number; limit: number };
type CollectImportsResultContract = { external: string[]; internal: string[] };
type ColdImportsResultContract = { external: string[]; internal: string[]; warnings: string[] };
type BlastReadArgsResultContract = { path: string; offset: number; limit: number };
type ClampSliceRangeResultContract = { startLine: number; endLine: number };

export const MAX_MODULE_REPORT_REFS = 100;

function normalizeMaxRefsPerSymbol(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10;
  return Math.min(MAX_MODULE_REPORT_REFS, Math.max(1, Math.floor(value)));
}

export interface ModuleReportOptions {
  maxRefsPerSymbol?: number;
  focus?: string;
  view?: "summary" | "default" | "compact";
  blastRadius?: boolean;
  blastRadiusDepth?: number;
  callGraph?: boolean;
  maxCallGraphEntries?: number;
}

export interface ModuleSymbolUsedBy {
  file: string;
  symbol: string;
  line: number;
  relation: ReviewGraphEdgeKind;
  provenance?: "ast" | "lsp";
  resolution?: "exact" | "import" | "receiver-type" | "name-only";
}

export interface ModuleSymbolEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  visibility?: "private" | "protected";
  signature?: string;
  doc?: string;
  decorators?: string[];
  fanout?: number;
  complexity?: number;
  flags?: string[];
  delegationRatio?: number;
  usedBy?: ModuleSymbolUsedBy[];
  members?: ModuleSymbolEntry[];
}

export interface RecommendedRead {
  reason: string;
  symbol?: string;
  startLine: number;
  endLine: number;
}

export interface ModuleCallbackEntry {
  name: string;
  kind: string;
  rawKind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  parentChain?: string[];
  flags?: string[];
}

export interface BlastRadiusFile {
  file: string;
  dependents: number;
  minDepth: number;
  relations: ReviewGraphEdgeKind[];
  read: { path: string; offset: number; limit: number };
}

export interface BlastRadius {
  truncated: boolean;
  maxDepth: number;
  files: BlastRadiusFile[];
}

export interface ModuleCallGraphRelation {
  symbolId: string;
  targetSymbolId: string;
  file: string;
  symbol?: string;
  kind?: string;
  line?: number;
  evidenceKind?: "calls" | "references" | "mixed";
  resolution?: "exact" | "import" | "receiver-type" | "name-only" | "unresolved";
  evidenceCount?: number;
  weight?: number;
}

export interface ModuleCallGraphCoverage {
  status: "complete" | "partial" | "unavailable";
  complete: boolean;
  totalEvidence?: number;
  callsEvidence?: number;
  referencesEvidence?: number;
  eligibleEvidence?: number;
  resolvedEvidence?: number;
  unresolvedEvidence?: number;
  typeOnlyEvidence?: number;
  unsupportedEvidence?: number;
  sameFileEvidence?: number;
  duplicateEvidence?: number;
  languages?: Record<string, "complete" | "partial" | "unavailable">;
}

export interface ModuleCallGraph {
  available: boolean;
  reason?:
    | "cache-missing"
    | "review-graph-missing"
    | "identity-missing"
    | "partial"
    | "stale"
    | "file-cap";
  callers: ModuleCallGraphRelation[];
  callees: ModuleCallGraphRelation[];
  truncated: boolean;
  coverage: ModuleCallGraphCoverage;
}

export interface ModuleReport {
  available: boolean;
  staleness: "fresh" | "unavailable";
  path: string;
  error?: string;
  warnings?: string[];
  language?: string;
  lineCount?: number;
  view?: "summary" | "compact";
  summary: { imports: number; exports: number; symbols: number };
  imports: { external: string[]; internal: string[] };
  api: ModuleSymbolEntry[];
  internal: ModuleSymbolEntry[];
  callbacks: ModuleCallbackEntry[];
  callbackSupport?: "tuned" | "generic";
  recommendedReads: RecommendedRead[];
  blastRadius?: BlastRadius;
  callGraph?: ModuleCallGraph;
  graphBuiltAt?: string;
  provenance?: {
    symbols: "syntax" | "none";
    imports: "cached-review-graph" | "syntax" | "none";
    usedBy: "cached-review-graph" | "unavailable:file-cap" | "none";
    callbacks: "heuristic-tree-sitter" | "none";
    blastRadius?: "cached-review-graph" | "unavailable:file-cap" | "none";
    callGraph?: "cached-call-graph" | "unavailable:file-cap" | "none";
  };
  semantic: {
    source: "review-graph" | "graph-lsp" | "unavailable:file-cap" | "none";
    references: boolean;
    implementations: boolean;
  };
}

export interface ReadSymbolResult {
  found: boolean;
  path: string;
  name: string;
  error?: string;
  warnings?: string[];
  kind?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  source?: string;
  suggestions?: string[];
  ambiguous?: { count: number; kinds: string[] };
}

export interface ReadSymbolOptions {
  kind?: string;
}

export interface ReadEnclosingOutlineItem {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  parentChain?: string[];
  read: { path: string; offset: number; limit: number };
}

export interface ReadEnclosingResult {
  found: boolean;
  path: string;
  line: number;
  name?: string;
  kind?: string;
  startLine?: number;
  endLine?: number;
  enclosingStartLine?: number;
  enclosingEndLine?: number;
  signature?: string;
  parentChain?: string[];
  partial?: boolean;
  selection?: {
    strategy: "range-containment" | "oversize-slice" | "oversize-outline";
    source: "tree-sitter";
    confidence: "high" | "medium";
  };
  outline?: ReadEnclosingOutlineItem[];
  error?: string;
  warnings?: string[];
  source?: string;
}

export interface ReadEnclosingOptions {
  kinds?: string[];
  maxLines?: number;
  onOversize?: "error" | "slice" | "outline";
  aroundLine?: number;
}

interface KINDTOTSLANGValues extends Record<string, string> {}
const KIND_TO_TS_LANG: KINDTOTSLANGValues = {
  python: "python",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  java: "java",
  kotlin: "kotlin",
  dart: "dart",
  elixir: "elixir",
  csharp: "csharp",
  php: "php",
  swift: "swift",
  lua: "lua",
  ocaml: "ocaml",
  zig: "zig",
  shell: "bash",
};

export function tsLangForFile(filePath: string, kind: string | undefined): string | undefined {
  if (kind === "jsts") {
    return resolveTreeSitterLanguage(filePath) ?? "typescript";
  }
  if (kind === "cxx") {
    return resolveTreeSitterLanguage(filePath) ?? "cpp";
  }
  return kind ? KIND_TO_TS_LANG[kind] : undefined;
}

const extractorCache = new Map<string, Promise<TreeSitterSymbolExtractor | null>>();

async function getExtractor(languageId: string): Promise<TreeSitterSymbolExtractor | null> {
  let cached = extractorCache.get(languageId);
  if (!cached) {
    cached = (async () => {
      const client = getSharedTreeSitterClient();
      if (!client) return null;
      const extractor = new TreeSitterSymbolExtractor(languageId, client);
      const ok = await extractor.init();
      return ok ? extractor : null;
    })().catch((err) => {
      extractorCache.delete(languageId);
      throw err;
    });
    extractorCache.set(languageId, cached);
  }
  return cached;
}

type ModuleReportNode = {
  type: string;
  text: string;
  children: ModuleReportNode[];
  parent?: ModuleReportNode | null;
  isNamed?: boolean;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};

function diagnosticMessage(err: LspBoundaryValue): string {
  return err instanceof Error ? err.message : String(err);
}

async function extractFile(
  absPath: string,
  languageId: string,
  content: string,
): Promise<{
  symbols: ExtractedSymbol[];
  imports: ImportRef[];
  callbacks: ModuleCallbackEntry[];
  callbackError?: string;
  error?: string;
  warnings?: string[];
}> {
  try {
    const tsClient = getSharedTreeSitterClient();
    if (!tsClient) {
      return {
        symbols: [],
        imports: [],
        callbacks: [],
        error: "tree-sitter runtime unavailable (wasm aborted)",
      };
    }
    const initialized = await tsClient.init();
    if (!initialized) {
      return {
        symbols: [],
        imports: [],
        callbacks: [],
        error: "tree-sitter runtime failed to initialize",
      };
    }
    const extractor = await getExtractor(languageId);
    const extracted = await tsClient.withParsedTree(absPath, languageId, content, (tree) => {
      const warnings = extractor ? [] : [`Symbol extractor not available for ${languageId}`];
      const result = extractor
        ? extractor.extract(tree, absPath, content)
        : { symbols: [], imports: [] };
      const owners = result.symbols
        .filter((candidate) => !candidate.local)
        .map((candidate) => ({
          name: candidate.name,
          startLine: candidate.line,
          endLine: candidate.endLine ?? candidate.line,
        }));
      let callbacks: ModuleCallbackEntry[] = [];
      let callbackError: string | undefined;
      try {
        callbacks = extractCallbacks(tree.rootNode, owners, languageId, warnings);
      } catch (error) {
        callbackError = diagnosticMessage(error);
      }
      return {
        symbols: result.symbols,
        imports: result.imports,
        callbacks,
        callbackError,
        warnings,
      };
    });
    if (!extracted.parsed) {
      return {
        symbols: [],
        imports: [],
        callbacks: [],
        error: `tree-sitter failed to parse as ${languageId}`,
      };
    }
    return extracted.value;
  } catch (err) {
    const message = diagnosticMessage(err);
    logLatency({
      type: "phase",
      phase: "module_report_extract_error",
      filePath: absPath,
      durationMs: 0,
      metadata: { error: message },
    });
    return { symbols: [], imports: [], callbacks: [], error: message };
  }
}

function readArgsFor(
  filePath: string,
  startLine: number,
  endLine: number,
): ReadArgsForResultContract {
  const offset = Math.max(1, startLine);
  const limit = Math.max(1, endLine - startLine + 1);

  return { path: filePath, offset, limit };
}

function resolveUsedBy(
  graph: ReviewGraph,
  symbolNodeId: string,
  cap: number,
  projectRoot: string,
): ModuleSymbolUsedBy[] {
  const out: ModuleSymbolUsedBy[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edgesByTo.get(symbolNodeId) ?? []) {
    if (edge.kind !== "calls" && edge.kind !== "references") continue;
    const from = graph.nodes.get(edge.from);
    const rawFile =
      from?.filePath ?? (edge.from.startsWith("file:") ? edge.from.slice("file:".length) : "");
    if (!rawFile) continue;
    const file = toDisplayPath(rawFile, projectRoot);
    const symbol = from?.qualifiedName ?? from?.symbolName ?? "";
    const line =
      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      (isFiniteNumber(from?.metadata?.line) ? (from.metadata.line as number) : undefined) ??
      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      (isFiniteNumber(edge.metadata?.line) ? (edge.metadata.line as number) : 0);
    const key = `${file} ${symbol} ${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const usedByEntry: ModuleSymbolUsedBy = { file, symbol, line, relation: edge.kind };
    if (edge.resolution && edge.resolution !== "unresolved") {
      usedByEntry.resolution = edge.resolution;
    }
    out.push(usedByEntry);
    if (out.length >= cap) break;
  }
  return out;
}

function toDisplayPath(p: string, projectRoot: string): string {
  return toProjectRelativePath(p, projectRoot);
}

function collectImports(
  graph: ReviewGraph,
  normalizedPath: string,
  projectRoot: string,
): CollectImportsResultContract {
  const fileNodeId = graph.fileNodes.get(normalizedPath);
  const external = new Set<string>();
  const internal = new Set<string>();
  if (fileNodeId) {
    for (const edge of graph.edgesByFrom.get(fileNodeId) ?? []) {
      if (edge.kind !== "imports") continue;
      const target = graph.nodes.get(edge.to);
      if (!target) continue;
      if (target.kind === "external") {
        external.add(String(target.metadata?.source ?? edge.to));
      } else if (target.filePath) {
        internal.add(toDisplayPath(target.filePath, projectRoot));
      } else {
        internal.add(String(target.metadata?.source ?? edge.to));
      }
    }
  }

  return {
    external: [...external].sort((a, b) => a.localeCompare(b)),
    internal: [...internal].sort((a, b) => a.localeCompare(b)),
  };
}

function looksInternal(source: string, languageId: string): boolean {
  if (languageId === "c" || languageId === "cpp") {
    return !source.startsWith("<");
  }
  return (
    source.startsWith(".") ||
    source.startsWith("crate::") ||
    source.startsWith("super::") ||
    source.startsWith("self::")
  );
}

function coldImports(
  imports: ImportRef[],
  languageId: string,
  absPath: string,
  projectRoot: string,
): ColdImportsResultContract {
  const external = new Set<string>();
  const internal = new Set<string>();
  const warnings: string[] = [];
  for (const imp of imports) {
    let files: string[] = [];
    try {
      files = resolveImportToFiles(projectRoot, absPath, languageId, imp.source);
    } catch (err) {
      const message = diagnosticMessage(err);
      warnings.push(`Failed to resolve import "${imp.source}": ${message}`);
      logLatency({
        type: "phase",
        phase: "module_report_import_resolve_error",
        filePath: absPath,
        durationMs: 0,
        metadata: {
          import: imp.source,
          error: message,
        },
      });
    }
    if (files.length > 0) {
      for (const f of files) internal.add(toDisplayPath(f, projectRoot));
    } else if (looksInternal(imp.source, languageId)) {
      internal.add(imp.source);
    } else {
      external.add(imp.source);
    }
  }

  return {
    external: [...external].sort((a, b) => a.localeCompare(b)),
    internal: [...internal].sort((a, b) => a.localeCompare(b)),
    warnings,
  };
}

function toEntry(
  sym: ExtractedSymbol,
  normalizedPath: string,
  graph: ReviewGraph | undefined,
  maxRefs: number,
  projectRoot: string,
  fileKind: string | undefined,
): ModuleSymbolEntry {
  const startLine = sym.line;
  const endLine = sym.endLine ?? sym.line;
  const idKind = fileKind === "jsts" ? "function" : sym.kind;
  const symbolNodeId = buildSymbolId(normalizedPath, sym.name, idKind, sym.line);
  const node = graph?.nodes.get(symbolNodeId);
  const metadata = node?.metadata ?? {};

  const complexity = isFiniteNumber(metadata.cyclomaticComplexity)
    ? metadata.cyclomaticComplexity
    : undefined;
  const fanout = graph
    ? (graph.edgesByFrom.get(symbolNodeId) ?? []).filter((edge) => edge.kind === "calls").length
    : undefined;

  const nonPublic = sym.visibility === "private" || sym.visibility === "protected";
  const exported = (sym.isExported || !!node?.exported) && !nonPublic;
  const flags: string[] = [];
  if (sym.isAsync) flags.push("async");
  if (fanout !== undefined && fanout >= 4) flags.push("high fanout");
  if (complexity !== undefined && complexity >= 8) flags.push("high complexity");
  if (metadata.isBoundaryWrapper) flags.push("boundary wrapper");

  const usedBy = graph ? resolveUsedBy(graph, symbolNodeId, maxRefs, projectRoot) : undefined;

  return Object.assign(
    assignOptionalProperties(
      Object.assign(
        assignOptionalProperties(
          assignOptionalProperties(
            { name: sym.name, kind: sym.kind, startLine, endLine, exported },
            sym.visibility,
            () => ({ visibility: sym.visibility }),
          ),
          sym.decorators?.length,
          () => ({ decorators: sym.decorators }),
        ),
        {
          signature: sym.signature,
          doc: sym.doc,
          fanout: fanout && fanout > 0 ? fanout : undefined,
          complexity,
        },
      ),
      flags.length > 0,
      () => ({ flags }),
    ),
    { usedBy: usedBy && usedBy.length > 0 ? usedBy : undefined },
  );
}

function nestEntries(entries: ModuleSymbolEntry[]): ModuleSymbolEntry[] {
  const span = (e: ModuleSymbolEntry) => e.endLine - e.startLine;
  const containerOf = new Map<ModuleSymbolEntry, ModuleSymbolEntry | undefined>();
  for (const e of entries) {
    let best: ModuleSymbolEntry | undefined;
    for (const c of entries) {
      if (c === e) continue;
      const contains = c.startLine <= e.startLine && c.endLine >= e.endLine && span(c) > span(e);
      if (!contains) continue;
      if (!best || span(c) < span(best)) best = c;
    }
    containerOf.set(e, best);
  }
  for (const e of entries) {
    const parent = containerOf.get(e);
    if (!parent) continue;
    if (!parent.members) parent.members = [];
    parent.members.push(e);
  }
  for (const e of entries) {
    if (e.members) e.members.sort((a, b) => a.startLine - b.startLine);
  }
  return entries.filter((e) => !containerOf.get(e));
}

function summarizeEntries(entries: ModuleSymbolEntry[]): ModuleSymbolEntry[] {
  return entries.map((entry) =>
    assignOptionalProperties(
      assignOptionalProperties(
        assignOptionalProperties(
          assignOptionalProperties(
            assignOptionalProperties(
              {
                name: entry.name,
                kind: entry.kind,
                startLine: entry.startLine,
                endLine: entry.endLine,
                exported: entry.exported,
              },
              entry.visibility,
              () => ({ visibility: entry.visibility }),
            ),
            entry.signature,
            () => ({ signature: entry.signature }),
          ),
          entry.doc,
          () => ({ doc: entry.doc }),
        ),
        entry.flags,
        () => ({ flags: entry.flags }),
      ),
      entry.members,
      (includedMembers) => ({
        members: includedMembers.map((member) =>
          assignOptionalProperties(
            assignOptionalProperties(
              assignOptionalProperties(
                {
                  name: member.name,
                  kind: member.kind,
                  startLine: member.startLine,
                  endLine: member.endLine,
                  exported: member.exported,
                },
                member.visibility,
                () => ({ visibility: member.visibility }),
              ),
              member.signature,
              () => ({ signature: member.signature }),
            ),
            member.doc,
            () => ({ doc: member.doc }),
          ),
        ),
      }),
    ),
  );
}

function normalizeFocus(focus: string | undefined): string[] {
  return (focus ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 8);
}

function focusScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 6 : 0), 0);
}

function rankRecommendedReads(
  entries: ModuleSymbolEntry[],
  callbacks: ModuleCallbackEntry[] = [],
  limit = 5,
  focus?: string,
): RecommendedRead[] {
  const focusTerms = normalizeFocus(focus);
  const scoredSymbols = entries.map((entry) => {
    const refs = entry.usedBy?.length ?? 0;
    const focus = focusScore(
      [entry.name, entry.kind, entry.signature ?? "", entry.flags?.join(" ") ?? ""].join(" "),
      focusTerms,
    );
    const score =
      refs * 2 +
      (entry.complexity ?? 0) +
      (entry.exported ? 2 : 0) +
      (entry.flags?.includes("high complexity") ? 3 : 0) +
      focus;
    return { kind: "symbol" as const, entry, score, refs, focus };
  });
  const scoredCallbacks = callbacks.map((callback) => {
    const flags = callback.flags ?? [];
    const focus = focusScore(
      [callback.name, callback.kind, callback.signature ?? "", flags.join(" ")].join(" "),
      focusTerms,
    );
    const score =
      (flags.includes("captures ctx.ui") ? 8 : 0) +
      (flags.includes("captures ctx") ? 5 : 0) +
      (flags.includes("detached timer") ? 4 : 0) +
      (flags.includes("lifecycle") ? 3 : 0) +
      (callback.kind === "object_property_callback" ? 2 : 0) +
      (callback.kind === "assigned_callback" ? 1 : 0) +
      focus;
    return { kind: "callback" as const, callback, score, focus };
  });
  const scored = [...scoredSymbols, ...scoredCallbacks].filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => {
    if (item.kind === "symbol") {
      const { entry, refs } = item;
      const reasons: string[] = [];
      if (item.focus > 0) reasons.push("matches focus");
      if (entry.exported) reasons.push("exported");
      if (refs > 0) reasons.push(`used by ${refs}`);
      if (entry.complexity !== undefined && entry.complexity >= 8) {
        reasons.push(`complexity ${entry.complexity}`);
      }
      return {
        reason: reasons.join(", ") || "public surface",
        symbol: entry.name,
        startLine: entry.startLine,
        endLine: entry.endLine,
      };
    }
    const reasons: string[] = [];
    if (item.focus > 0) reasons.push("matches focus");
    if (item.callback.flags?.length) reasons.push(...item.callback.flags);
    if (item.callback.kind === "object_property_callback") {
      reasons.push("callback property");
    }
    if (item.callback.kind === "assigned_callback") {
      reasons.push("assigned callback");
    }
    return {
      reason: reasons.join(", ") || item.callback.kind,
      symbol: item.callback.name,
      startLine: item.callback.startLine,
      endLine: item.callback.endLine,
    };
  });
}

const BLAST_RADIUS_FILE_CAP = 12;
const BLAST_RADIUS_DEFAULT_READ_LIMIT = 400;

function blastReadArgs(graph: ReviewGraph, normalizedFile: string): BlastReadArgsResultContract {
  const fileNodeId = graph.fileNodes.get(normalizedFile);
  const lineCount = fileNodeId ? graph.nodes.get(fileNodeId)?.metadata?.lineCount : undefined;
  const limit =
    isFiniteNumber(lineCount) && lineCount > 0 ? lineCount : BLAST_RADIUS_DEFAULT_READ_LIMIT;

  return { path: normalizedFile, offset: 1, limit };
}

async function computeBlastRadius(
  graph: ReviewGraph,
  normalizedPath: string,
  projectRoot: string,
  maxDepth: number,
): Promise<BlastRadius | undefined> {
  const { computeTransitiveImpact } = await import("./review-graph/query.ts");
  const result = computeTransitiveImpact(graph, normalizedPath, { maxDepth });
  const byFile = new Map<
    string,
    {
      dependents: number;
      minDepth: number;
      relations: Set<ReviewGraphEdgeKind>;
    }
  >();
  for (const hit of result.hits) {
    if (!hit.file) continue;
    const key = normalizeMapKey(hit.file);
    if (key === normalizedPath) continue;
    const cur = byFile.get(key) ?? {
      dependents: 0,
      minDepth: Number.POSITIVE_INFINITY,
      relations: new Set<ReviewGraphEdgeKind>(),
    };
    cur.dependents += 1;
    cur.minDepth = Math.min(cur.minDepth, hit.depth);
    cur.relations.add(hit.relation);
    byFile.set(key, cur);
  }
  if (byFile.size === 0) return undefined;
  const files: BlastRadiusFile[] = [...byFile.entries()]
    .map(([key, v]) => ({
      file: toDisplayPath(key, projectRoot),
      dependents: v.dependents,
      minDepth: v.minDepth,
      relations: [...v.relations].sort((a, b) => a.localeCompare(b)),
      read: blastReadArgs(graph, key),
    }))
    .sort(
      (a, b) =>
        a.minDepth - b.minDepth || b.dependents - a.dependents || a.file.localeCompare(b.file),
    )
    .slice(0, BLAST_RADIUS_FILE_CAP);
  return {
    truncated: result.truncated,
    maxDepth: result.maxDepthReached,
    files,
  };
}

function nodeLine(node: ModuleReportNode): number {
  return node.startPosition.row + 1;
}

function nodeEndLine(node: ModuleReportNode): number {
  return node.endPosition.row + 1;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

type CallbackOwner = Pick<ModuleSymbolEntry, "name" | "startLine" | "endLine">;

function findNearestSymbolName(
  entries: CallbackOwner[],
  startLine: number,
  endLine: number,
): string | undefined {
  let best: CallbackOwner | undefined;
  for (const entry of entries) {
    if (entry.startLine > startLine || entry.endLine < endLine) continue;
    if (!best || entry.endLine - entry.startLine < best.endLine - best.startLine) {
      best = entry;
    }
  }
  return best?.name;
}

const INLINE_EXECUTABLE_NODE_KINDS = new Set([
  "arrow_function",
  "function_expression",
  "lambda",
  "func_literal",
  "closure_expression",
  "lambda_literal",
  "lambda_expression",
  "anonymous_function",
]);

const ARGUMENT_CONTAINER_NODE_KINDS = new Set([
  "arguments",
  "argument_list",
  "argument_list_expression",
]);

const CALL_NODE_KINDS = new Set(["call_expression", "call"]);

function callNameForCallback(node: ModuleReportNode): string | undefined {
  const parent = node.parent;
  const call = ARGUMENT_CONTAINER_NODE_KINDS.has(parent?.type ?? "")
    ? parent?.parent
    : CALL_NODE_KINDS.has(parent?.type ?? "")
      ? parent
      : undefined;
  if (!call || !CALL_NODE_KINDS.has(call.type)) return undefined;
  const callee = call.children.find((child) => !ARGUMENT_CONTAINER_NODE_KINDS.has(child.type));
  return callee?.text;
}

function eventNameForCallback(node: ModuleReportNode): string | undefined {
  const args = node.parent;
  if (args?.type !== "arguments") return undefined;
  const first = args.children.find(
    (child) => child.type === "string" && nodeLine(child) <= nodeLine(node),
  );
  return first?.text;
}

function propertyNameForCallback(node: ModuleReportNode): string | undefined {
  const parent = node.parent;
  if (parent?.type !== "pair" && parent?.type !== "key_value_pair") {
    return undefined;
  }
  const key = parent.children.find((child) => child !== node);
  return key?.text;
}

function assignedNameForCallback(node: ModuleReportNode): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (parent.type === "let_declaration" || parent.type === "variable_declarator") {
    return parent.children.find((child) => child.type === "identifier")?.text;
  }
  if (parent.type === "expression_list") {
    const declaration = parent.parent;
    if (declaration?.type !== "short_var_declaration") return undefined;
    const nameList = declaration.children.find((child) => child !== parent);
    return nameList?.children.find((child) => child.type === "identifier")?.text;
  }
  if (parent.type === "assignment") {
    return parent.children.find((child) => child.type === "identifier")?.text;
  }
  return undefined;
}

type CallbackContext = {
  node: ModuleReportNode;
  callName: string | undefined;
  eventName: string | undefined;
  propertyName: string | undefined;
  assignedName: string | undefined;
};

type CallbackClassification = {
  kind: string;
  flags?: string[];
  include: boolean;
  nameBase?: string;
};

type CallbackLanguageRules = {
  classify(ctx: CallbackContext, owner: string | undefined): CallbackClassification;
};

function ancestorOfType(
  node: ModuleReportNode,
  types: Set<string>,
  maxHops = 6,
): ModuleReportNode | undefined {
  let current = node.parent;
  let hops = 0;
  while (current && hops < maxHops) {
    if (types.has(current.type)) return current;
    current = current.parent;
    hops += 1;
  }
  return undefined;
}

function descendantOfType(
  node: ModuleReportNode,
  type: string,
  maxDepth = 2,
): ModuleReportNode | undefined {
  if (maxDepth < 0) return undefined;
  for (const child of node.children ?? []) {
    if (child.type === type) return child;
    const found = descendantOfType(child, type, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function classifyGenericCallback(ctx: CallbackContext): CallbackClassification {
  const { node, callName, propertyName, assignedName } = ctx;
  let kind: string;
  if (callName === "setTimeout" || callName === "setInterval" || callName === "setImmediate") {
    kind = "timer_callback";
  } else if (callName === "pi.on" || callName?.endsWith(".on")) {
    kind = "event_handler";
  } else if (
    callName?.endsWith(".then") ||
    callName?.endsWith(".catch") ||
    callName?.endsWith(".finally")
  ) {
    kind = "promise_callback";
  } else if (propertyName) {
    kind = "object_property_callback";
  } else if (assignedName) {
    kind = "assigned_callback";
  } else {
    kind = "callback";
  }
  const flags: string[] = [];
  if (node.text.trimStart().startsWith("async")) flags.push("async");
  if (/\bctx\s*\.\s*ui\b/.test(node.text)) flags.push("captures ctx.ui");
  else if (/\bctx\b/.test(node.text)) flags.push("captures ctx");
  if (kind === "timer_callback") flags.push("detached timer");
  if (kind === "event_handler") flags.push("lifecycle");
  const include =
    kind !== "callback" ||
    !!propertyName ||
    !!assignedName ||
    flags.some((flag) => flag.startsWith("captures "));

  return Object.assign(
    assignOptionalProperties({ kind }, flags.length > 0, () => ({ flags })),
    { include },
  );
}

const jstsCallbackRules: CallbackLanguageRules = {
  classify: (ctx) => classifyGenericCallback(ctx),
};

const GO_GOROUTINE_KINDS = new Set(["go_statement"]);
const GO_DEFER_KINDS = new Set(["defer_statement"]);

const goCallbackRules: CallbackLanguageRules = {
  classify(ctx, owner) {
    if (ancestorOfType(ctx.node, GO_GOROUTINE_KINDS, 3)) {
      return {
        kind: "goroutine",
        flags: ["goroutine"],
        include: true,
        nameBase: owner ? `${owner}.goroutine` : "goroutine",
      };
    }
    if (ancestorOfType(ctx.node, GO_DEFER_KINDS, 3)) {
      return {
        kind: "deferred_callback",
        flags: ["deferred"],
        include: true,
        nameBase: owner ? `${owner}.defer` : "defer",
      };
    }
    return classifyGenericCallback(ctx);
  },
};

function withFlag(flags: string[] | undefined, flag: string): string[] {
  const next = flags ? [...flags] : [];
  if (!next.includes(flag)) next.push(flag);
  return next;
}

const pythonCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const callName = ctx.callName ?? "";
    if (
      /(?:^|\.)(?:call_later|call_soon|call_at)$/.test(callName) ||
      /(?:^|\.)Timer$/.test(callName)
    ) {
      return {
        kind: "timer_callback",
        flags: withFlag(base.flags, "detached timer"),
        include: true,
      };
    }
    if (callName.endsWith(".add_done_callback")) {
      return {
        kind: "future_callback",
        flags: withFlag(base.flags, "future completion"),
        include: true,
      };
    }
    return base;
  },
};

const rustCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const isMove = /^\s*(?:async\s+)?move\b/.test(ctx.node.text);
    const flags = isMove ? withFlag(base.flags, "move") : base.flags;
    const callName = ctx.callName ?? "";
    if (/(?:^|::|\.)spawn$/.test(callName)) {
      return {
        kind: "task",
        flags: withFlag(flags, "spawned"),
        include: true,
      };
    }
    return Object.assign(
      assignOptionalProperties(Object.assign({}, base), flags, () => ({ flags })),
      {
        include: base.include || isMove,
      },
    );
  },
};

const swiftCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const node = ctx.node;
    const captureList = descendantOfType(node, "capture_list", 2);
    let weakSelf = false;
    if (captureList) {
      for (const item of captureList.children ?? []) {
        if (item.type !== "capture_list_item") continue;
        const own = item.children?.find((c) => c.type === "ownership_modifier");
        if (own && /\bself\b/.test(item.text)) weakSelf = true;
      }
    }
    const refsSelf = /\bself\b/.test(node.text);
    let flags = base.flags;
    let include = base.include;
    if (weakSelf) {
      flags = withFlag(flags, "weak self");
      include = true;
    } else if (refsSelf) {
      flags = withFlag(flags, "captures self");
      include = true;
    }

    return Object.assign(
      assignOptionalProperties(Object.assign({}, base), flags, () => ({ flags })),
      {
        include,
      },
    );
  },
};

const cppCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const capture = descendantOfType(ctx.node, "lambda_capture_specifier", 2);
    let flags = base.flags;
    let byRef = false;
    if (capture) {
      const def = capture.children?.find((c) => c.type === "lambda_default_capture");
      if (def?.text.includes("&")) {
        flags = withFlag(flags, "captures by reference");
        byRef = true;
      }
    }
    const callName = ctx.callName ?? "";
    if (/(?:^|::)(?:thread|async)$/.test(callName)) {
      return {
        kind: "task",
        flags: withFlag(flags, "spawned"),
        include: true,
      };
    }
    return Object.assign(
      assignOptionalProperties(Object.assign({}, base), flags, () => ({ flags })),
      {
        include: base.include || byRef,
      },
    );
  },
};

function lastCalleeSegment(text: string | undefined): string {
  const m = String(text ?? "")
    .trim()
    .match(/([A-Za-z_$][\w$]*)\s*$/);
  return m ? m[1] : "";
}

const KOTLIN_COROUTINE_BUILDERS = new Set([
  "launch",
  "async",
  "withContext",
  "runBlocking",
  "coroutineScope",
  "supervisorScope",
]);
const kotlinCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const call = ancestorOfType(ctx.node, new Set(["call_expression"]), 4);
    const callee = call?.children?.find(
      (c) => c.type === "navigation_expression" || c.type === "simple_identifier",
    );
    const name = lastCalleeSegment(callee?.text);
    if (KOTLIN_COROUTINE_BUILDERS.has(name)) {
      return {
        kind: "coroutine",
        flags: withFlag(base.flags, "coroutine"),
        include: true,
        nameBase: name,
      };
    }
    return base;
  },
};

const JAVA_TASK_METHODS =
  /^(?:submit|execute|schedule|scheduleAtFixedRate|scheduleWithFixedDelay|invokeLater|invokeAndWait)$/;
const JAVA_LISTENER_METHODS = /^(?:add\w*Listener|set\w*Listener|subscribe|addCallback|then\w*)$/;
const javaCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const obj = ancestorOfType(ctx.node, new Set(["object_creation_expression"]), 3);
    const created = obj?.children?.find((c) => c.type === "type_identifier");
    if (created && created.text.endsWith("Thread")) {
      return {
        kind: "task",
        flags: withFlag(base.flags, "thread"),
        include: true,
        nameBase: `new ${created.text}`,
      };
    }
    const inv = ancestorOfType(ctx.node, new Set(["method_invocation"]), 3);
    if (inv) {
      const named = (inv.children ?? []).filter((c) => c.isNamed);
      const argIdx = named.findIndex((c) => c.type === "argument_list");
      const nameNode = argIdx > 0 ? named[argIdx - 1] : undefined;
      const name = nameNode?.type === "identifier" ? nameNode.text : "";
      if (JAVA_TASK_METHODS.test(name)) {
        return {
          kind: "task",
          flags: withFlag(base.flags, "submitted"),
          include: true,
          nameBase: name,
        };
      }
      if (JAVA_LISTENER_METHODS.test(name)) {
        return {
          kind: "event_handler",
          flags: withFlag(base.flags, "listener"),
          include: true,
          nameBase: name,
        };
      }
    }
    return base;
  },
};

const csharpCallbackRules: CallbackLanguageRules = {
  classify(ctx) {
    const base = classifyGenericCallback(ctx);
    const parent = ctx.node.parent;
    if (parent?.type === "assignment_expression" && /\+=/.test(parent.text)) {
      return {
        kind: "event_handler",
        flags: withFlag(base.flags, "event +="),
        include: true,
      };
    }
    const inv = ancestorOfType(ctx.node, new Set(["invocation_expression"]), 4);
    if (inv) {
      const callee = inv.children?.find(
        (c) => c.type === "member_access_expression" || c.type === "identifier",
      );
      const name = lastCalleeSegment(callee?.text);
      if (/^(?:Run|StartNew|Start)$/.test(name)) {
        return {
          kind: "task",
          flags: withFlag(base.flags, "task"),
          include: true,
          nameBase: name,
        };
      }
    }
    if (/^\s*async\b/.test(ctx.node.text)) {
      return {
        ...base,
        flags: withFlag(base.flags, "async"),
        include: true,
      };
    }
    return base;
  },
};

interface CALLBACKRULESValues extends Record<string, CallbackLanguageRules> {}
const CALLBACK_RULES: CALLBACKRULESValues = {
  typescript: jstsCallbackRules,
  tsx: jstsCallbackRules,
  javascript: jstsCallbackRules,
  go: goCallbackRules,
  python: pythonCallbackRules,
  rust: rustCallbackRules,
  swift: swiftCallbackRules,
  cpp: cppCallbackRules,
  kotlin: kotlinCallbackRules,
  java: javaCallbackRules,
  csharp: csharpCallbackRules,
};

function callbackRulesFor(languageId: string | undefined): CallbackLanguageRules {
  return (languageId ? CALLBACK_RULES[languageId] : undefined) ?? jstsCallbackRules;
}

function callbackSupportFor(languageId: string | undefined): "tuned" | "generic" {
  return languageId && CALLBACK_RULES[languageId] ? "tuned" : "generic";
}

function extractCallbacks(
  root: ModuleReportNode | undefined,
  entries: CallbackOwner[],
  languageId: string | undefined,
  warnings?: string[],
): ModuleCallbackEntry[] {
  if (!root) return [];
  const rules = callbackRulesFor(languageId);
  const callbacks: ModuleCallbackEntry[] = [];
  const maxDepth = 1000;
  let depthTruncated = false;
  const visit = (node: ModuleReportNode, depth = 0): void => {
    if (depth > maxDepth) {
      depthTruncated = true;
      return;
    }
    if (INLINE_EXECUTABLE_NODE_KINDS.has(node.type)) {
      const startLine = nodeLine(node);
      const endLine = nodeEndLine(node);
      const callName = callNameForCallback(node);
      const eventName = eventNameForCallback(node);
      const propertyName = propertyNameForCallback(node);
      const assignedName = assignedNameForCallback(node);
      const owner = findNearestSymbolName(entries, startLine, endLine);
      const cls = rules.classify({ node, callName, eventName, propertyName, assignedName }, owner);
      if (cls.include) {
        const base =
          cls.nameBase ??
          (propertyName
            ? owner
              ? `${owner}.${propertyName}`
              : propertyName
            : assignedName
              ? owner
                ? `${owner}.${assignedName}`
                : assignedName
              : eventName && callName
                ? `${callName}(${eventName})`
                : (callName ?? "callback"));
        callbacks.push(
          assignOptionalProperties(
            assignOptionalProperties(
              {
                name: `${base}@${startLine}`,
                kind: cls.kind,
                rawKind: node.type,
                startLine,
                endLine,
                signature: firstLine(node.text),
              },
              owner,
              (includedOwner) => ({ parentChain: [includedOwner] }),
            ),
            cls.flags,
            (includedFlags) => ({ flags: includedFlags }),
          ),
        );
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root);
  if (depthTruncated) {
    warnings?.push(`Callback extraction stopped at AST depth ${maxDepth}`);
  }
  const callbackCap = 25;
  if (callbacks.length > callbackCap) {
    warnings?.push(`Callback list truncated to ${callbackCap} of ${callbacks.length} entries`);
  }
  return callbacks.slice(0, callbackCap);
}

const CALL_GRAPH_DEFAULT_ENTRY_CAP = 20;
const CALL_GRAPH_MAX_ENTRY_CAP = 100;

function unavailableCallGraph(reason: ModuleCallGraph["reason"]): ModuleCallGraph {
  return {
    available: false,
    reason,
    callers: [],
    callees: [],
    truncated: false,
    coverage: { status: "unavailable", complete: false },
  };
}

function callGraphCoverage(coverage: CallGraphEvidenceCoverage): ModuleCallGraphCoverage {
  const languages = coverage.languages;
  const complete =
    coverage.complete && Object.values(languages ?? {}).every((status) => status === "complete");
  return assignOptionalProperties(
    {
      status: complete ? "complete" : "partial",
      complete,
      totalEvidence: coverage.totalEvidence,
      callsEvidence: coverage.callsEvidence,
      referencesEvidence: coverage.referencesEvidence,
      eligibleEvidence: coverage.eligibleEvidence,
      resolvedEvidence: coverage.resolvedEvidence,
      unresolvedEvidence: coverage.unresolvedEvidence,
      typeOnlyEvidence: coverage.typeOnlyEvidence,
      unsupportedEvidence: coverage.unsupportedEvidence,
      sameFileEvidence: coverage.sameFileEvidence,
      duplicateEvidence: coverage.duplicateEvidence,
    },
    languages,
    () => ({ languages }),
  );
}

function callGraphRelation(
  edge: ResolvedCallEdge,
  kind: "caller" | "callee",
  projectRoot: string,
): ModuleCallGraphRelation {
  const caller = kind === "caller";
  return assignOptionalProperties(
    assignOptionalProperties(
      assignOptionalProperties(
        assignOptionalProperties(
          Object.assign(
            {
              symbolId: caller ? edge.callerKey : edge.calleeKey,
              targetSymbolId: caller ? edge.calleeKey : edge.callerKey,
              file: toDisplayPath(caller ? edge.callerFile : edge.calleeFile, projectRoot),
            },
            caller
              ? {
                  symbol: edge.callerSymbol,
                  kind: edge.callerKind,
                  line: edge.callerLine,
                }
              : {
                  symbol: edge.calleeSymbol,
                  kind: edge.calleeKind,
                  line: edge.calleeLine,
                },
          ),
          edge.evidenceKind,
          () => ({ evidenceKind: edge.evidenceKind }),
        ),
        edge.resolution,
        () => ({ resolution: edge.resolution }),
      ),
      edge.evidenceCount && edge.evidenceCount > 1,
      () => ({ evidenceCount: edge.evidenceCount }),
    ),
    edge.weight !== 1,
    () => ({ weight: edge.weight }),
  );
}

function readCallGraph(
  projectRoot: string,
  normalizedPath: string,
  maxEntries: number,
  graphFileCap: number | undefined,
  identity: CallGraphCacheIdentity | undefined,
  reviewGraph: ReviewGraph | undefined,
): ModuleCallGraph {
  if (graphFileCap !== undefined) return unavailableCallGraph("file-cap");
  if (!reviewGraph) return unavailableCallGraph("review-graph-missing");
  if (reviewGraph.persistCoverage?.partial || reviewGraph.persistCoverage?.inProgress) {
    return unavailableCallGraph("partial");
  }
  if (!identity) return unavailableCallGraph("identity-missing");
  if (!reviewGraph.fileNodes.has(normalizedPath)) return unavailableCallGraph("stale");
  const cached = loadCallGraph(projectRoot, identity);
  if (!cached) return unavailableCallGraph("stale");

  const callers: ModuleCallGraphRelation[] = [];
  const callees: ModuleCallGraphRelation[] = [];
  for (const edge of cached.graph.edges) {
    if (normalizeMapKey(edge.calleeFile) === normalizedPath) {
      callers.push(callGraphRelation(edge, "caller", projectRoot));
    }
    if (normalizeMapKey(edge.callerFile) === normalizedPath) {
      callees.push(callGraphRelation(edge, "callee", projectRoot));
    }
  }
  const stable = (left: ModuleCallGraphRelation, right: ModuleCallGraphRelation) =>
    left.targetSymbolId.localeCompare(right.targetSymbolId) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.symbolId.localeCompare(right.symbolId);
  callers.sort(stable);
  callees.sort(stable);
  return {
    available: true,
    callers: callers.slice(0, maxEntries),
    callees: callees.slice(0, maxEntries),
    truncated: callers.length > maxEntries || callees.length > maxEntries,
    coverage: callGraphCoverage(
      cached.graph.coverage ?? {
        totalEvidence: cached.graph.totalRefs,
        callsEvidence: cached.graph.totalRefs,
        referencesEvidence: 0,
        eligibleEvidence: cached.graph.totalRefs,
        resolvedEvidence: cached.graph.totalRefs,
        unresolvedEvidence: cached.graph.unresolvedRefs,
        typeOnlyEvidence: 0,
        unsupportedEvidence: 0,
        sameFileEvidence: 0,
        duplicateEvidence: 0,
        complete: false,
      },
    ),
  };
}

function unavailableReport(displayPath: string, error?: string): ModuleReport {
  return Object.assign(
    assignOptionalProperties(
      { available: false as const, staleness: "unavailable" as const, path: displayPath },
      error,
      (includedError) => ({ error: includedError }),
    ),
    {
      summary: { imports: 0, exports: 0, symbols: 0 },
      imports: { external: [], internal: [] },
      api: [],
      internal: [],
      callbacks: [],
      recommendedReads: [],
      semantic: { source: "none" as const, references: false, implementations: false },
    },
  );
}

export async function moduleReport(
  file: string,
  cwd: string,
  options?: ModuleReportOptions,
): Promise<ModuleReport> {
  const startedAt = Date.now();
  const maxRefs = normalizeMaxRefsPerSymbol(options?.maxRefsPerSymbol);
  const maxCallGraphEntries = Math.min(
    CALL_GRAPH_MAX_ENTRY_CAP,
    Math.max(1, Math.floor(options?.maxCallGraphEntries ?? CALL_GRAPH_DEFAULT_ENTRY_CAP)),
  );
  const absPath = path.resolve(cwd, file);
  const normalizedPath = normalizeMapKey(absPath);

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return unavailableReport(toDisplayPath(absPath, cwd));
  }

  const kind = detectFileKind(absPath);
  const languageId = tsLangForFile(absPath, kind);
  const lineCount = content.split(/\r?\n/).length;

  const {
    symbols: extracted,
    imports: extractedImports,
    callbacks,
    callbackError,
    error: extractionError,
    warnings: extractionWarnings,
  } = languageId
    ? await extractFile(absPath, languageId, content)
    : {
        symbols: [],
        imports: [],
        callbacks: [],
        callbackError: undefined,
        error: undefined,
        warnings: undefined,
      };
  if (extractionError) {
    return unavailableReport(toDisplayPath(absPath, cwd), extractionError);
  }

  let graph: ReviewGraph | undefined;
  let graphFileCap: number | undefined;
  let callGraphIdentity: CallGraphCacheIdentity | undefined;
  try {
    const { getCachedReviewGraph, getReviewGraphCacheIdentity, getReviewGraphSizeSkipVerdict } =
      await import("./review-graph/builder.ts");
    graph = getCachedReviewGraph(cwd);
    graphFileCap = getReviewGraphSizeSkipVerdict(cwd)?.maxFileCount;
    callGraphIdentity = graph
      ? (() => {
          const identity = getReviewGraphCacheIdentity(cwd, graph);
          return identity
            ? {
                reviewGraphVersion: identity.version,
                reviewGraphSignature: identity.signature,
              }
            : undefined;
        })()
      : undefined;
  } catch {
    graph = undefined;
    callGraphIdentity = undefined;
  }

  const outlineSymbols = extracted.filter((sym) => !sym.local);

  const entries = outlineSymbols.map((sym) =>
    toEntry(sym, normalizedPath, graph, maxRefs, cwd, kind),
  );
  const topLevel = nestEntries(entries);

  annotateMiddleMan(entries, content, languageId);

  const api = topLevel.filter((entry) => entry.exported);
  const internal = topLevel.filter((entry) => !entry.exported);
  const warnings: string[] = [...(extractionWarnings ?? [])];
  if (callbackError) {
    warnings.push(`Failed to extract callbacks: ${callbackError}`);
    logLatency({
      type: "phase",
      phase: "module_report_callback_extract_error",
      filePath: absPath,
      durationMs: 0,
      metadata: { error: callbackError },
    });
  }
  if (graphFileCap !== undefined) {
    warnings.push(
      `who-uses-this is unavailable: review graph disabled because the project ` +
        `has more than ${graphFileCap} files (cap ${graphFileCap}) — raise ` +
        "maxProjectFiles in .choco-pi-lsp.json or set " +
        "CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILES; for CI/cron, run npx choco-pi-lsp " +
        "build-graph after configuring the cap",
    );
  }

  const warmImports = graph
    ? collectImports(graph, normalizedPath, cwd)
    : { external: [], internal: [] };
  const coldImportResult =
    warmImports.external.length + warmImports.internal.length > 0 || !languageId
      ? undefined
      : coldImports(extractedImports, languageId, absPath, cwd);
  if (coldImportResult?.warnings.length) warnings.push(...coldImportResult.warnings);
  const imports = coldImportResult
    ? {
        external: coldImportResult.external,
        internal: coldImportResult.internal,
      }
    : warmImports;

  const hasGraphNode = graph?.fileNodes.has(normalizedPath) ?? false;

  if (graph && !hasGraphNode) {
    warnings.push(
      "who-uses-this is unavailable for this file: the cached review graph " +
        "exists but has no node for it (likely added/changed after the graph " +
        "was last built). Run pilens_rebuild to refresh it.",
    );
  }

  const blastRadius =
    options?.blastRadius && graph && hasGraphNode
      ? await computeBlastRadius(
          graph,
          normalizedPath,
          cwd,
          Math.max(1, options.blastRadiusDepth ?? 3),
        )
      : undefined;
  const callGraph = options?.callGraph
    ? readCallGraph(
        cwd,
        normalizedPath,
        maxCallGraphEntries,
        graphFileCap,
        callGraphIdentity,
        graph,
      )
    : undefined;

  const view = options?.view ?? "default";
  const summaryView = view === "summary";
  const compactView = view === "compact";
  let importsProvenance: NonNullable<ModuleReport["provenance"]>["imports"] = "none";
  if (coldImportResult) {
    importsProvenance = "syntax";
  } else if (graph) {
    importsProvenance = "cached-review-graph";
  }
  const unavailableGraphProvenance = graphFileCap !== undefined ? "unavailable:file-cap" : "none";
  const blastRadiusProvenance = blastRadius ? "cached-review-graph" : unavailableGraphProvenance;
  const callGraphProvenance = callGraph?.available
    ? "cached-call-graph"
    : callGraph?.reason === "file-cap"
      ? "unavailable:file-cap"
      : "none";
  const provenance: NonNullable<ModuleReport["provenance"]> = {
    symbols: languageId ? "syntax" : "none",
    imports: importsProvenance,
    usedBy: hasGraphNode ? "cached-review-graph" : unavailableGraphProvenance,
    callbacks: languageId && !summaryView ? "heuristic-tree-sitter" : "none",
  };
  if (options?.blastRadius) provenance.blastRadius = blastRadiusProvenance;
  if (options?.callGraph) provenance.callGraph = callGraphProvenance;

  const reportBase: Omit<ModuleReport, "provenance" | "semantic"> = {
    available: entries.length > 0 || hasGraphNode,
    staleness: entries.length === 0 && !hasGraphNode ? "unavailable" : "fresh",
    path: toDisplayPath(absPath, cwd),
    language: kind ?? undefined,
    lineCount,
    summary: {
      imports: imports.external.length + imports.internal.length,
      exports: api.length,
      symbols: entries.length,
    },
    imports,
    api: summaryView ? summarizeEntries(api) : api,
    internal: summaryView ? summarizeEntries(internal) : internal,
    callbacks: summaryView ? [] : callbacks,
    callbackSupport: callbackSupportFor(languageId),
    recommendedReads: rankRecommendedReads(entries, callbacks, 5, options?.focus),
  };
  if (warnings.length > 0) reportBase.warnings = warnings;
  if (summaryView) reportBase.view = "summary";
  if (compactView) reportBase.view = "compact";
  if (blastRadius && !summaryView) reportBase.blastRadius = blastRadius;
  if (callGraph) reportBase.callGraph = callGraph;
  if (graph) reportBase.graphBuiltAt = graph.builtAt;
  const semantic: ModuleReport["semantic"] = {
    source: hasGraphNode ? "review-graph" : unavailableGraphProvenance,
    references: hasGraphNode,
    implementations: false,
  };
  const report: ModuleReport = Object.assign(reportBase, { provenance, semantic });

  logLatency({
    type: "phase",
    phase: "module_report",
    filePath: absPath,
    durationMs: Date.now() - startedAt,
    metadata: {
      graph: graph ? "cached" : "cold",
      symbols: entries.length,
      exported: api.length,
    },
  });

  return report;
}

function padRange(startLine: number, endLine: number, width: number): string {
  return `${startLine}-${endLine}`.padEnd(width);
}

interface KINDABBREVValues extends Record<string, string> {}
const KIND_ABBREV: KINDABBREVValues = {
  function: "fn",
  method: "fn",
  class: "class",
  interface: "iface",
  type: "type",
  variable: "var",
  property: "prop",
};

function compactKind(kind: string): string {
  return KIND_ABBREV[kind] ?? kind;
}

function compactUsedBySuffix(usedBy: ModuleSymbolUsedBy[] | undefined): string {
  if (!usedBy || usedBy.length === 0) return "";
  const counts = new Map<string, number>();
  for (const u of usedBy) counts.set(u.file, (counts.get(u.file) ?? 0) + 1);
  const parts = [...counts.entries()].map(([file, n]) => (n > 1 ? `${file}×${n}` : file));
  return `  used-by: ${parts.join(", ")}`;
}

function compactEntryLine(entry: ModuleSymbolEntry, width: number): string {
  const range = padRange(entry.startLine, entry.endLine, width);
  const kind = compactKind(entry.kind).padEnd(6);
  const sig = entry.signature ? `${entry.name}${entry.signature}` : entry.name;
  const flagsSuffix = entry.flags && entry.flags.length > 0 ? `  [${entry.flags.join(", ")}]` : "";
  const docSuffix = entry.doc ? `  — ${entry.doc}` : "";
  const usedBySuffix = compactUsedBySuffix(entry.usedBy);
  return `  ${range}${kind}${sig}${flagsSuffix}${usedBySuffix}${docSuffix}`;
}

function compactMemberLines(entry: ModuleSymbolEntry, width: number, indent: string): string[] {
  if (!entry.members || entry.members.length === 0) return [];
  return entry.members.map((m) => `${indent}${compactEntryLine(m, width).slice(2)}`);
}

function compactCallbackLine(callback: ModuleCallbackEntry, width: number): string {
  const range = padRange(callback.startLine, callback.endLine, width);
  const kind = callback.kind.padEnd(20);
  const flagsSuffix =
    callback.flags && callback.flags.length > 0 ? `  [${callback.flags.join(", ")}]` : "";
  const ownerSuffix = callback.parentChain?.length
    ? `  (in ${callback.parentChain.join(".")})`
    : "";
  return `  ${range}${kind}${callback.name}${flagsSuffix}${ownerSuffix}`;
}

export function renderCompactModuleReport(report: ModuleReport): string {
  if (!report.available) {
    return `${report.path} — unavailable${report.error ? `: ${report.error}` : ""}`;
  }
  const allEntries = [...report.api, ...report.internal];
  const allRanges = allEntries.flatMap((e) => [e, ...(e.members ?? [])]);
  const width =
    Math.max(
      5,
      ...allRanges.map((e) => `${e.startLine}-${e.endLine}`.length),
      ...report.callbacks.map((c) => `${c.startLine}-${c.endLine}`.length),
    ) + 2;

  const importsList = [...report.imports.internal, ...report.imports.external];
  const importsSuffix =
    importsList.length > 0
      ? ` | imports: ${importsList
          .slice(0, 6)
          .map((i) => baseNameNoExt(i))
          .join(", ")}${importsList.length > 6 ? ", …" : ""}`
      : "";
  const lines: string[] = [
    `${report.path} ${report.language ?? "?"} ${report.lineCount ?? "?"}L — ` +
      `${report.summary.symbols} symbols, ${report.summary.exports} exported${importsSuffix}`,
  ];
  for (const warning of report.warnings ?? []) {
    lines.push(`WARNING: ${warning}`);
  }

  if (report.api.length > 0) {
    lines.push("API:");
    for (const entry of report.api) {
      lines.push(compactEntryLine(entry, width));
      lines.push(...compactMemberLines(entry, width, "    "));
    }
  }
  if (report.internal.length > 0) {
    lines.push("INTERNAL:");
    for (const entry of report.internal) {
      lines.push(compactEntryLine(entry, width));
      lines.push(...compactMemberLines(entry, width, "    "));
    }
  }
  if (report.callbacks.length > 0) {
    lines.push("CALLBACKS:");
    for (const callback of report.callbacks) {
      lines.push(compactCallbackLine(callback, width));
    }
  }
  if (report.callGraph) {
    const callGraph = report.callGraph;
    const suffix = callGraph.truncated ? " (truncated)" : "";
    lines.push("CALL GRAPH:");
    if (!callGraph.available) {
      lines.push(`  unavailable (${callGraph.reason ?? "unknown"})`);
    } else {
      lines.push(
        `  callers: ${callGraph.callers.length} · callees: ${callGraph.callees.length}` +
          ` · coverage: ${callGraph.coverage.status}${suffix}`,
      );
    }
  }
  if (report.recommendedReads.length > 0) {
    lines.push("RECOMMENDED:");
    for (const r of report.recommendedReads) {
      lines.push(`  ${padRange(r.startLine, r.endLine, width)}${r.symbol ?? ""}  — ${r.reason}`);
    }
  }
  return lines.join("\n");
}

function baseNameNoExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.[^./\\]+$/, "");
}

interface SymbolSelection {
  match?: ExtractedSymbol;
  ambiguous?: { count: number; kinds: string[] };
}

function selectMatch(candidates: ExtractedSymbol[], kind: string | undefined): SymbolSelection {
  if (candidates.length === 0) return {};
  const filtered = kind ? candidates.filter((c) => c.kind === kind) : candidates;
  const pool = filtered.length > 0 ? filtered : candidates;
  const match = pool[0];
  if (pool.length <= 1) return { match };
  return {
    match,
    ambiguous: {
      count: pool.length,
      kinds: [...new Set(pool.map((c) => c.kind))],
    },
  };
}

function resolveQualifiedMatch(
  symbols: ExtractedSymbol[],
  qualifiedName: string,
  kind: string | undefined,
): SymbolSelection | undefined {
  const dotIdx = qualifiedName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === qualifiedName.length - 1) return undefined;
  const parentName = qualifiedName.slice(0, dotIdx);
  const memberName = qualifiedName.slice(dotIdx + 1);
  const parent = symbols.find((candidate) => candidate.name === parentName);
  if (!parent) return undefined;
  const parentStart = parent.line;
  const parentEnd = parent.endLine ?? parent.line;
  const members = symbols.filter(
    (candidate) =>
      candidate !== parent &&
      candidate.name === memberName &&
      candidate.line >= parentStart &&
      (candidate.endLine ?? candidate.line) <= parentEnd,
  );
  if (members.length === 0) return undefined;
  return selectMatch(members, kind);
}

function levenshteinDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = Array<number>(bl + 1);

  let curr = Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

const SIMILAR_NAME_MIN_SCORE = 0.45;
const SIMILAR_NAME_MAX_SUGGESTIONS = 3;

function suggestSimilarNames(candidates: string[], target: string): string[] {
  const unique = [...new Set(candidates)].filter((name) => name !== target);
  return unique
    .map((name) => ({ name, score: nameSimilarity(target, name) }))
    .filter((entry) => entry.score >= SIMILAR_NAME_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, SIMILAR_NAME_MAX_SUGGESTIONS)
    .map((entry) => entry.name);
}

export async function readSymbol(
  file: string,
  symbolName: string,
  cwd: string,
  options: ReadSymbolOptions = {},
): Promise<ReadSymbolResult> {
  const { kind: symbolKindFilter } = options;
  const startedAt = Date.now();
  const absPath = path.resolve(cwd, file);
  const log = (found: boolean): void => {
    logLatency({
      type: "phase",
      phase: "read_symbol",
      filePath: absPath,
      durationMs: Date.now() - startedAt,
      metadata: { symbol: symbolName, found },
    });
  };

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    log(false);
    return { found: false, path: absPath, name: symbolName };
  }

  const kind = detectFileKind(absPath);
  const languageId = tsLangForFile(absPath, kind);
  if (!languageId) {
    log(false);
    return { found: false, path: absPath, name: symbolName };
  }

  const {
    symbols,
    callbacks: allCallbacks,
    callbackError,
    error: extractionError,
    warnings: extractionWarnings,
  } = await extractFile(absPath, languageId, content);
  if (extractionError) {
    log(false);
    return {
      found: false,
      path: absPath,
      name: symbolName,
      error: extractionError,
    };
  }
  const lines = content.split(/\r?\n/);

  const qualified = resolveQualifiedMatch(symbols, symbolName, symbolKindFilter);
  const unqualifiedMatches = symbols.filter((candidate) => candidate.name === symbolName);
  const selection = qualified ?? selectMatch(unqualifiedMatches, symbolKindFilter);

  if (selection.match) {
    const sym = selection.match;
    const startLine = sym.docStartLine ?? sym.line;
    const endLine = sym.endLine ?? sym.line;
    const source = lines.slice(startLine - 1, endLine).join("\n");

    log(true);
    return assignOptionalProperties(
      {
        found: true,
        path: absPath,
        name: sym.name,
        kind: sym.kind,
        startLine,
        endLine,
        signature: sym.signature,
        source,
      },
      selection.ambiguous,
      () => ({ ambiguous: selection.ambiguous }),
    );
  }

  if (callbackError) {
    const message = `Callback extraction failed: ${callbackError}`;
    logLatency({
      type: "phase",
      phase: "read_symbol_callback_extract_error",
      filePath: absPath,
      durationMs: Date.now() - startedAt,
      metadata: { symbol: symbolName, error: message },
    });
    log(false);
    return { found: false, path: absPath, name: symbolName, error: message };
  }
  const callbackWarnings = [...(extractionWarnings ?? [])];
  const callback = allCallbacks.find((candidate) => candidate.name === symbolName);
  if (!callback) {
    log(false);
    const corpus = [
      ...symbols.filter((candidate) => !candidate.local).map((c) => c.name),
      ...allCallbacks.map((c) => c.name),
    ];
    const suggestions = suggestSimilarNames(corpus, symbolName);
    return assignOptionalProperties(
      assignOptionalProperties(
        { found: false, path: absPath, name: symbolName },
        callbackWarnings.length > 0,
        () => ({ warnings: callbackWarnings }),
      ),
      suggestions.length > 0,
      () => ({ suggestions }),
    );
  }
  const source = lines.slice(callback.startLine - 1, callback.endLine).join("\n");
  log(true);
  return {
    found: true,
    path: absPath,
    name: callback.name,
    kind: callback.kind,
    startLine: callback.startLine,
    endLine: callback.endLine,
    signature: callback.signature,
    source,
  };
}

type EnclosingCandidate = {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  parentChain?: string[];
  priority: number;
};

function symbolMatchesKind(kind: string, filters: Set<string>): boolean {
  if (filters.size === 0) return true;
  const normalized = kind.toLowerCase();
  if (filters.has(normalized)) return true;
  if (filters.has("function") && normalized.includes("function")) return true;
  if (filters.has("method") && normalized.includes("method")) return true;
  if (
    filters.has("type") &&
    ["class", "interface", "struct", "enum", "trait", "type"].includes(normalized)
  ) {
    return true;
  }
  return false;
}

function callbackMatchesKind(kind: string, filters: Set<string>): boolean {
  if (filters.size === 0) return true;
  const normalized = kind.toLowerCase();
  return (
    filters.has(normalized) ||
    filters.has("callback") ||
    filters.has("closure") ||
    filters.has("lambda") ||
    (normalized.includes("callback") && filters.has("function"))
  );
}

function symbolParentChain(
  symbol: ExtractedSymbol,
  symbols: ExtractedSymbol[],
): string[] | undefined {
  const chain = symbols
    .filter((candidate) => {
      if (candidate === symbol) return false;
      const start = candidate.line;
      const end = candidate.endLine ?? candidate.line;
      const symEnd = symbol.endLine ?? symbol.line;
      return start <= symbol.line && end >= symEnd && end - start > symEnd - symbol.line;
    })
    .sort(
      (a, b) =>
        a.line - b.line || (b.endLine ?? b.line) - b.line - ((a.endLine ?? a.line) - a.line),
    )
    .map((candidate) => candidate.name);
  return chain.length > 0 ? chain : undefined;
}

function clampSliceRange(
  targetLine: number,
  startLine: number,
  endLine: number,
  limit: number,
): ClampSliceRangeResultContract {
  const boundedLimit = Math.max(1, Math.min(endLine - startLine + 1, limit));
  let sliceStart = targetLine - Math.floor(boundedLimit / 2);
  sliceStart = Math.max(startLine, Math.min(sliceStart, endLine - boundedLimit + 1));

  return { startLine: sliceStart, endLine: sliceStart + boundedLimit - 1 };
}

function enclosingOutline(
  selected: EnclosingCandidate,
  symbols: ExtractedSymbol[],
  callbacks: ModuleCallbackEntry[],
  filters: Set<string>,
  filePath: string,
): ReadEnclosingOutlineItem[] {
  const items: ReadEnclosingOutlineItem[] = [];
  for (const sym of symbols) {
    const startLine = sym.line;
    const endLine = sym.endLine ?? sym.line;
    if (startLine === selected.startLine && endLine === selected.endLine) continue;
    if (startLine < selected.startLine || endLine > selected.endLine) continue;
    if (!symbolMatchesKind(sym.kind, filters)) continue;
    items.push({
      name: sym.name,
      kind: sym.kind,
      startLine,
      endLine,
      signature: sym.signature,
      parentChain: symbolParentChain(sym, symbols),
      read: readArgsFor(filePath, startLine, endLine),
    });
  }
  for (const callback of callbacks) {
    if (callback.startLine < selected.startLine || callback.endLine > selected.endLine) continue;
    if (!callbackMatchesKind(callback.kind, filters)) continue;
    items.push({
      name: callback.name,
      kind: callback.kind,
      startLine: callback.startLine,
      endLine: callback.endLine,
      signature: callback.signature,
      parentChain: callback.parentChain,
      read: readArgsFor(filePath, callback.startLine, callback.endLine),
    });
  }
  return items
    .sort(
      (a, b) => a.startLine - b.startLine || a.endLine - a.startLine - (b.endLine - b.startLine),
    )
    .slice(0, 25);
}

export async function readEnclosing(
  file: string,
  line: number,
  cwd: string,
  options?: ReadEnclosingOptions,
): Promise<ReadEnclosingResult> {
  const startedAt = Date.now();
  const absPath = path.resolve(cwd, file);
  const targetLine = Math.max(1, Math.floor(line));
  const log = (found: boolean): void => {
    logLatency({
      type: "phase",
      phase: "read_enclosing",
      filePath: absPath,
      durationMs: Date.now() - startedAt,
      metadata: { line: targetLine, found },
    });
  };

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    log(false);
    return { found: false, path: absPath, line: targetLine };
  }

  const kind = detectFileKind(absPath);
  const languageId = tsLangForFile(absPath, kind);
  if (!languageId) {
    log(false);
    return { found: false, path: absPath, line: targetLine };
  }

  const {
    symbols,
    callbacks,
    callbackError,
    error: extractionError,
    warnings: extractionWarnings,
  } = await extractFile(absPath, languageId, content);
  if (extractionError) {
    log(false);
    return {
      found: false,
      path: absPath,
      line: targetLine,
      error: extractionError,
    };
  }

  const filters = new Set((options?.kinds ?? []).map((value) => value.toLowerCase()));
  const warnings = [...(extractionWarnings ?? [])];
  if (callbackError) {
    const message = `Callback extraction failed: ${callbackError}`;
    warnings.push(message);
    logLatency({
      type: "phase",
      phase: "read_enclosing_callback_extract_error",
      filePath: absPath,
      durationMs: Date.now() - startedAt,
      metadata: { line: targetLine, error: message },
    });
  }

  const candidates: EnclosingCandidate[] = [];
  for (const sym of symbols.filter((candidate) => !candidate.local)) {
    const startLine = sym.line;
    const endLine = sym.endLine ?? sym.line;
    if (targetLine < startLine || targetLine > endLine) continue;
    if (!symbolMatchesKind(sym.kind, filters)) continue;
    candidates.push({
      name: sym.name,
      kind: sym.kind,
      startLine,
      endLine,
      signature: sym.signature,
      parentChain: symbolParentChain(sym, symbols),
      priority: 1,
    });
  }
  for (const callback of callbacks) {
    if (targetLine < callback.startLine || targetLine > callback.endLine) continue;
    if (!callbackMatchesKind(callback.kind, filters)) continue;
    candidates.push({
      name: callback.name,
      kind: callback.kind,
      startLine: callback.startLine,
      endLine: callback.endLine,
      signature: callback.signature,
      parentChain: callback.parentChain,
      priority: 0,
    });
  }

  candidates.sort((a, b) => {
    const span = a.endLine - a.startLine - (b.endLine - b.startLine);
    return span || a.priority - b.priority || a.startLine - b.startLine;
  });
  const selected = candidates[0];
  if (!selected) {
    log(false);
    return assignOptionalProperties(
      { found: false, path: absPath, line: targetLine },
      warnings.length > 0,
      () => ({ warnings }),
    );
  }

  const lines = content.split(/\r?\n/);
  const limit = selected.endLine - selected.startLine + 1;
  if (options?.maxLines && limit > options.maxLines) {
    const oversize = options.onOversize ?? "error";
    const base = assignOptionalProperties(
      {
        path: absPath,
        line: targetLine,
        name: selected.name,
        kind: selected.kind,
        startLine: selected.startLine,
        endLine: selected.endLine,
        signature: selected.signature,
        parentChain: selected.parentChain,
        enclosingStartLine: selected.startLine,
        enclosingEndLine: selected.endLine,
      },
      warnings.length > 0,
      () => ({ warnings }),
    );
    if (oversize === "slice") {
      const sliceLimit = Math.max(1, Math.floor(options.aroundLine ?? options.maxLines ?? 80));
      const slice = clampSliceRange(targetLine, selected.startLine, selected.endLine, sliceLimit);
      const source = lines.slice(slice.startLine - 1, slice.endLine).join("\n");
      log(true);
      return {
        ...base,
        found: true,
        startLine: slice.startLine,
        endLine: slice.endLine,
        partial: true,
        selection: {
          strategy: "oversize-slice",
          source: "tree-sitter",
          confidence: "medium",
        },
        source,
      };
    }
    if (oversize === "outline") {
      log(false);
      return {
        ...base,
        found: false,
        selection: {
          strategy: "oversize-outline",
          source: "tree-sitter",
          confidence: "medium",
        },
        outline: enclosingOutline(selected, symbols, callbacks, filters, absPath),
        error: `Enclosing ${selected.kind} spans ${limit} lines, above max_lines ${options.maxLines}`,
      };
    }
    log(false);
    return {
      ...base,
      found: false,
      error: `Enclosing ${selected.kind} spans ${limit} lines, above max_lines ${options.maxLines}`,
    };
  }
  const source = lines.slice(selected.startLine - 1, selected.endLine).join("\n");
  log(true);
  return Object.assign(
    assignOptionalProperties(
      {
        found: true as const,
        path: absPath,
        line: targetLine,
        name: selected.name,
        kind: selected.kind,
        startLine: selected.startLine,
        endLine: selected.endLine,
        enclosingStartLine: selected.startLine,
        enclosingEndLine: selected.endLine,
        signature: selected.signature,
        parentChain: selected.parentChain,
        selection: {
          strategy: "range-containment" as const,
          source: "tree-sitter" as const,
          confidence: "high" as const,
        },
      },
      warnings.length > 0,
      () => ({ warnings }),
    ),
    { source },
  );
}
