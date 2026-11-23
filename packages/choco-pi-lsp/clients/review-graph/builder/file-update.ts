import { isRuntimeString } from "../../../tools/runtime-values.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../../dispatch/fact-store.ts";
import { featureHintMetadata } from "../../feature-hints.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { getOpenDocumentSymbols } from "../../lsp-document-symbols.ts";
import { normalizeMapKey, toProjectRelativePath } from "../../path-utils.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import type { ReviewGraph, ReviewGraphEdge } from "../types.ts";
import { getFreshReviewGraphFileIr, reviewGraphIrContentHash } from "../shared-extraction-ir.ts";
import { addEdge, addNode, rebuildIndexes } from "./graph-state.ts";
import { addJsTsFile, ensureReviewGraphFacts, upsertChangedSymbols } from "./js-ts-file.ts";
import {
  addLspFallbackSymbols,
  addTreeSitterFile,
  extractTreeSitterSymbols,
  mapKindToTreeSitterLanguage,
} from "./tree-sitter-file.ts";
import { MAIN_KINDS } from "./workspace-cache.ts";

export function ensureFileNode(
  graph: ReviewGraph,
  filePath: string,
  cwd: string,
  languageId: string,
): string {
  const normalized = normalizeMapKey(filePath);
  const hintPath = toProjectRelativePath(normalized, cwd);
  const existing = graph.fileNodes.get(normalized);
  if (existing) return existing;
  const fileNodeId = `file:${normalized}`;
  addNode(graph, {
    id: fileNodeId,
    kind: "file",
    language: languageId,
    filePath: normalized,
    metadata: featureHintMetadata(hintPath),
  });
  return fileNodeId;
}

function resolveCxxInclude(cwd: string, filePath: string, source: string): string | undefined {
  const candidates = [
    path.resolve(path.dirname(filePath), source),
    path.resolve(cwd, source),
    path.resolve(cwd, "include", source),
    path.resolve(cwd, "src", source),
  ];
  const root = path.resolve(cwd);
  for (const candidate of candidates) {
    if (!candidate.startsWith(root + path.sep) && candidate !== root) continue;
    if (fs.existsSync(candidate) && detectFileKind(candidate) === "cxx") {
      return normalizeMapKey(candidate);
    }
  }
  return undefined;
}

function parseLocalCxxInclude(line: string): string | undefined {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== "#") return undefined;
  i += 1;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (!line.startsWith("include", i)) return undefined;
  i += "include".length;
  if (i >= line.length || (line[i] !== " " && line[i] !== "\t")) {
    return undefined;
  }
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== '"') return undefined;
  i += 1;
  const start = i;
  while (i < line.length && line[i] !== '"') i += 1;
  if (i >= line.length || i === start) return undefined;
  return line.slice(start, i);
}

function addCxxIncludeEdges(
  graph: ReviewGraph,
  cwd: string,
  filePath: string,
  ignoredIds?: ReadonlySet<string>,
  contentOverride?: string | null,
): void {
  let content = contentOverride;
  if (content === undefined) {
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
  }
  if (content === null) return;
  const fromNode = ensureFileNode(graph, filePath, cwd, "cpp");
  for (const line of content.split(/\r?\n/)) {
    const source = parseLocalCxxInclude(line);
    if (!source) continue;
    const target = resolveCxxInclude(cwd, filePath, source);
    if (!target || ignoredIds?.has(target)) continue;
    const languageId = mapKindToTreeSitterLanguage("cxx", target) ?? "cpp";
    const toNode = ensureFileNode(graph, target, cwd, languageId);
    addEdge(graph, {
      from: fromNode,
      to: toNode,
      kind: "imports",
      metadata: { source },
    });
  }
}

export function removeFileOwnedGraphData(graph: ReviewGraph, filePath: string): ReviewGraphEdge[] {
  const normalized = normalizeMapKey(filePath);
  const fileNodeId = `file:${normalized}`;
  const removedIds = new Set<string>();
  const removedSymbolIds = new Set<string>();
  for (const [id, node] of graph.nodes) {
    if (node.filePath !== normalized) continue;
    removedIds.add(id);
    if (node.kind === "symbol") removedSymbolIds.add(id);
  }
  if (graph.nodes.has(fileNodeId)) removedIds.add(fileNodeId);

  const preservedIncomingSymbolEdges: ReviewGraphEdge[] = [];
  graph.edges = graph.edges.filter((edge) => {
    const fromRemoved = removedIds.has(edge.from);
    const toRemoved = removedIds.has(edge.to);
    if (fromRemoved) return false;
    if (removedSymbolIds.has(edge.to)) {
      preservedIncomingSymbolEdges.push({ ...edge });
      return false;
    }
    if (toRemoved && edge.to === fileNodeId) return true;
    return !toRemoved;
  });
  for (const id of removedIds) graph.nodes.delete(id);
  return preservedIncomingSymbolEdges;
}

export async function addFileToGraph(
  graph: ReviewGraph,
  cwd: string,
  file: string,
  facts: FactStore,
  ignoredIds?: ReadonlySet<string>,
  contentOverride?: string | null,
): Promise<void> {
  const kind = detectFileKind(file);
  if (!kind || !MAIN_KINDS.has(kind)) return;
  if (detectFileRole(file) === "test") return;
  const contentHash = isRuntimeString(contentOverride)
    ? reviewGraphIrContentHash(contentOverride)
    : undefined;
  const sharedIr = contentHash
    ? getFreshReviewGraphFileIr(cwd, file, contentHash)?.structural
    : undefined;
  if (kind === "jsts") {
    const dispatchOwnsContent =
      facts.getFileFact<string>(file, "file.content") !== undefined && contentOverride == null;
    try {
      if (sharedIr?.kind === "jsts") {
        facts.setFileFact(file, "file.content", contentOverride ?? "");
        facts.setFileFact(file, "file.imports", sharedIr.imports);
        facts.setFileFact(file, "file.reexports", sharedIr.reexports);
        facts.setFileFact(file, "file.functionSummaries", sharedIr.functionSummaries);
        facts.setFileFact(file, "file.functionFactsCoverage", sharedIr.coverage.calls);
        facts.setFileFact(file, "file.importFactsCoverage", sharedIr.coverage.imports);
      } else {
        await ensureReviewGraphFacts(file, cwd, facts, contentOverride);
      }
      addJsTsFile(graph, cwd, file, facts, ignoredIds);
    } finally {
      if (!dispatchOwnsContent) facts.deleteFileFact(file, "file.content");
    }
    return;
  }
  const languageId = mapKindToTreeSitterLanguage(kind, file);
  if (!languageId) return;
  const irExtracted =
    sharedIr?.kind === "tree-sitter" && sharedIr.languageId === languageId
      ? sharedIr.extracted
      : undefined;
  const extracted =
    irExtracted ?? (await extractTreeSitterSymbols(file, languageId, contentOverride));
  addTreeSitterFile(graph, cwd, file, languageId, extracted, ignoredIds);
  if (extracted.symbols.length === 0) {
    const lspSymbols = await getOpenDocumentSymbols(file);
    const added = lspSymbols ? addLspFallbackSymbols(graph, file, languageId, lspSymbols) : 0;
    logReviewGraph({
      phase: "lsp_symbol_fallback",
      cwd,
      reason: lspSymbols ? (added > 0 ? "added" : "empty-response") : "unavailable-or-failed",
      nodes: added,
    });
  }
  if (kind === "cxx") {
    addCxxIncludeEdges(graph, cwd, file, ignoredIds, contentOverride);
  }
}

function restoreValidIncomingEdges(graph: ReviewGraph, edges: ReviewGraphEdge[]): void {
  const existing = new Set(
    graph.edges.map(
      (edge) =>
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`,
    ),
  );
  for (const edge of edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`;
    if (existing.has(key)) continue;
    graph.edges.push(edge);
    existing.add(key);
  }
}

export interface GraphFileImportChange {
  filePath: string;
  existedBefore: boolean;
  existsAfter: boolean;
  priorTargets: string[];
  newTargets: string[];
}

export interface GraphImportDelta {
  fromGeneration: number | undefined;
  changes: GraphFileImportChange[];
}

export const _graphImportChanges = new WeakMap<ReviewGraph, GraphImportDelta>();

export function getGraphImportChanges(graph: ReviewGraph): GraphImportDelta | undefined {
  return _graphImportChanges.get(graph);
}

function importTargetsForFile(graph: ReviewGraph, filePath: string): string[] {
  const normalized = normalizeMapKey(filePath);
  const fileNodeId = graph.fileNodes.get(normalized) ?? `file:${normalized}`;
  const targets = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from !== fileNodeId) continue;
    if (edge.kind !== "imports") continue;
    const target = graph.nodes.get(edge.to)?.filePath;
    if (target) targets.add(normalizeMapKey(target));
  }
  return [...targets].sort((a, b) => a.localeCompare(b));
}

export async function updateGraphFiles(
  graph: ReviewGraph,
  cwd: string,
  files: string[],
  facts: FactStore,
  ignoredIds?: ReadonlySet<string>,
): Promise<GraphFileImportChange[]> {
  const prior = files.map((file) => ({
    filePath: normalizeMapKey(file),
    existedBefore: graph.fileNodes.has(normalizeMapKey(file)),
    priorTargets: importTargetsForFile(graph, file),
  }));
  const preservedIncoming: ReviewGraphEdge[] = [];
  for (const file of files) {
    preservedIncoming.push(...removeFileOwnedGraphData(graph, file));
    await addFileToGraph(graph, cwd, file, facts, ignoredIds);
  }
  restoreValidIncomingEdges(graph, preservedIncoming);
  resolveDeferredSymbolEdges(graph, false);
  rebuildIndexes(graph);
  graph.changedSymbolsByFile.clear();
  for (const file of files) {
    upsertChangedSymbols(graph, facts, file);
  }
  return prior.map(({ filePath, existedBefore, priorTargets }) => ({
    filePath,
    existedBefore,
    existsAfter: graph.fileNodes.has(filePath),
    priorTargets,
    newTargets: importTargetsForFile(graph, filePath),
  }));
}

export function resolveDeferredSymbolEdges(graph: ReviewGraph, rebuild = true): void {
  const symbolNameToIds = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== "symbol" || !node.symbolName) continue;
    if (node.metadata?.unresolvedName) continue;
    const ids = symbolNameToIds.get(node.symbolName) ?? [];
    ids.push(node.id);
    symbolNameToIds.set(node.symbolName, ids);
  }

  graph.edges = graph.edges.map((edge) => {
    const targetNode = graph.nodes.get(edge.to);
    if (!targetNode?.metadata?.unresolvedName) return edge;
    const candidates = symbolNameToIds.get(targetNode.symbolName ?? "") ?? [];
    // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
    const importHintFile = edge.metadata?.importHintFile as string | undefined;
    if (importHintFile) {
      const scoped = candidates.filter((id) => graph.nodes.get(id)?.filePath === importHintFile);
      if (scoped.length === 1) {
        return { ...edge, to: scoped[0], resolution: "import" };
      }
    }
    if (candidates.length === 1) {
      return { ...edge, to: candidates[0], resolution: "exact" };
    }
    return edge;
  });
  if (rebuild) rebuildIndexes(graph);
}
