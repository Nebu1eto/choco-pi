import { detectFileRole } from "../file-role.ts";
import { normalizeMapKey } from "../path-utils.ts";
import type { ModuleGraph } from "./workspace-modules.ts";
import {
  findModuleForPath,
  getDownstreamModules,
  getModuleSourceFiles,
} from "./workspace-modules.ts";
import type {
  CascadeMissingNodeDiagnostic,
  ImpactCascadeResult,
  ReviewGraph,
  ReviewGraphEdge,
  ReviewGraphEdgeKind,
} from "./types.ts";

function dedupe(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function filePathFromNode(graph: ReviewGraph, nodeId: string): string | undefined {
  return graph.nodes.get(nodeId)?.filePath;
}

function collectIncomingEdges(
  graph: ReviewGraph,
  nodeIds: string[],
  kind: ReviewGraphEdge["kind"],
): ReviewGraphEdge[] {
  const edges: ReviewGraphEdge[] = [];
  for (const nodeId of nodeIds) {
    for (const edge of graph.edgesByTo.get(nodeId) ?? []) {
      if (edge.kind === kind) edges.push(edge);
    }
  }
  return edges;
}

export interface ImpactHit {
  symbol: string;
  file: string;
  depth: number;
  relation: ReviewGraphEdgeKind;
}

export interface TransitiveImpactResult {
  seedFile: string;
  hits: ImpactHit[];
  truncated: boolean;
  maxDepthReached: number;
}

const DEFAULT_IMPACT_RELATIONS: ReviewGraphEdgeKind[] = ["calls", "references", "imports"];

export function computeTransitiveImpact(
  graph: ReviewGraph,
  seedFile: string,
  options?: {
    maxDepth?: number;
    relations?: ReviewGraphEdgeKind[];
    maxHits?: number;
  },
): TransitiveImpactResult {
  const normalized = normalizeMapKey(seedFile);
  const maxDepth = Math.max(1, options?.maxDepth ?? 3);
  const maxHits = Math.max(1, options?.maxHits ?? 200);
  const relations = new Set(options?.relations ?? DEFAULT_IMPACT_RELATIONS);

  const seeds = [...(graph.symbolNodesByFile.get(normalized) ?? [])];
  const fileNodeId = graph.fileNodes.get(normalized);
  if (fileNodeId) seeds.push(fileNodeId);

  const visited = new Set<string>(seeds);
  let frontier = seeds.map((id) => ({ id, depth: 0 }));
  const hits: ImpactHit[] = [];
  let maxDepthReached = 0;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const node of frontier) {
      for (const edge of graph.edgesByTo.get(node.id) ?? []) {
        if (!relations.has(edge.kind)) continue;
        if (visited.has(edge.from)) continue;
        if (hits.length >= maxHits) {
          return {
            seedFile: normalized,
            hits,
            truncated: true,
            maxDepthReached,
          };
        }
        visited.add(edge.from);
        const dependent = graph.nodes.get(edge.from);
        const hitDepth = node.depth + 1;
        maxDepthReached = Math.max(maxDepthReached, hitDepth);
        hits.push({
          symbol: dependent?.symbolName ?? "",
          file: dependent?.filePath ?? "",
          depth: hitDepth,
          relation: edge.kind,
        });
        next.push({ id: edge.from, depth: hitDepth });
      }
    }
    frontier = next;
  }

  return { seedFile: normalized, hits, truncated: false, maxDepthReached };
}

function describeMissingNode(
  graph: ReviewGraph,
  normalizedFile: string,
): CascadeMissingNodeDiagnostic {
  const lastSlash = normalizedFile.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : normalizedFile.slice(0, lastSlash);
  const base = normalizedFile.slice(lastSlash + 1);
  const stem = base.replace(/\.[^./]*$/, "");

  let sameDirFileCount = 0;
  let sameDirSibling: string | undefined;
  let sameStemTwin: string | undefined;
  for (const known of graph.fileNodes.keys()) {
    const knownLastSlash = known.lastIndexOf("/");
    const knownDir = knownLastSlash === -1 ? "" : known.slice(0, knownLastSlash);
    const knownBase = known.slice(knownLastSlash + 1);
    if (knownDir === dir) {
      sameDirFileCount += 1;
      sameDirSibling ??= known;
      if (sameStemTwin === undefined && knownBase.replace(/\.[^./]*$/, "") === stem) {
        sameStemTwin = known;
      }
    }
  }

  return {
    soughtNodeId: `file:${normalizedFile}`,
    graphFileCount: graph.fileNodes.size,
    symbolNodeCount: graph.symbolNodesByFile.get(normalizedFile)?.length ?? 0,
    sameDirFileCount,
    nearestFile: sameStemTwin ?? sameDirSibling,
  };
}

export function computeImpactCascade(
  graph: ReviewGraph,
  changedFile: string,
  moduleGraph?: ModuleGraph | null,
): ImpactCascadeResult {
  const normalizedFile = normalizeMapKey(changedFile);
  const fileNodeId = graph.fileNodes.get(normalizedFile);
  if (!fileNodeId) {
    if (detectFileRole(normalizedFile) === "test") {
      return {
        filePath: normalizedFile,
        changedSymbols: [],
        directImporters: [],
        directCallers: [],
        neighborFiles: [],
        riskFlags: [],
        indeterminate: {
          reason: "excluded_by_role",
          detail: "test-role file — excluded from the review graph by design (#260)",
        },
      };
    }
    return {
      filePath: normalizedFile,
      changedSymbols: [],
      directImporters: [],
      directCallers: [],
      neighborFiles: [],
      riskFlags: [],
      indeterminate: {
        reason: "missing_node",
        diagnostic: describeMissingNode(graph, normalizedFile),
      },
    };
  }

  const changedSymbols = graph.changedSymbolsByFile.get(normalizedFile) ?? [];
  const symbolNodeIds = (graph.symbolNodesByFile.get(normalizedFile) ?? []).filter((nodeId) => {
    const symbolName = graph.nodes.get(nodeId)?.symbolName;
    return !changedSymbols.length || (symbolName && changedSymbols.includes(symbolName));
  });
  const effectiveSymbolNodeIds =
    symbolNodeIds.length > 0 ? symbolNodeIds : (graph.symbolNodesByFile.get(normalizedFile) ?? []);

  const importerFiles = dedupe(
    (graph.edgesByTo.get(fileNodeId) ?? [])
      .filter((edge) => edge.kind === "imports")
      .flatMap((edge) => filePathFromNode(graph, edge.from) ?? []),
  );

  let callerFiles = dedupe(
    collectIncomingEdges(graph, effectiveSymbolNodeIds, "calls").flatMap(
      (edge) => filePathFromNode(graph, edge.from) ?? [],
    ),
  );
  if (callerFiles.length === 0 && changedSymbols.length > 0 && importerFiles.length > 0) {
    callerFiles = importerFiles;
  }

  const referenceFiles = dedupe(
    collectIncomingEdges(graph, effectiveSymbolNodeIds, "references").flatMap(
      (edge) => filePathFromNode(graph, edge.from) ?? [],
    ),
  );

  let neighborFiles = dedupe([...importerFiles, ...callerFiles, ...referenceFiles]).filter(
    (candidate) => normalizeMapKey(candidate) !== normalizedFile,
  );

  const downstreamModuleFiles: string[] = [];
  if (moduleGraph) {
    const changedModule = findModuleForPath(moduleGraph, normalizedFile);
    if (changedModule) {
      const downstream = getDownstreamModules(moduleGraph, changedModule.name);
      for (const depName of downstream) {
        const depMod = moduleGraph.modules.get(depName);
        if (depMod) {
          downstreamModuleFiles.push(...getModuleSourceFiles(depMod.root));
        }
      }
    }
  }
  if (downstreamModuleFiles.length > 0) {
    neighborFiles = dedupe([...neighborFiles, ...downstreamModuleFiles]);
  }
  const directImports = dedupe(
    (graph.edgesByFrom.get(fileNodeId) ?? [])
      .filter((edge) => edge.kind === "imports")
      .flatMap((edge) => filePathFromNode(graph, edge.to) ?? []),
  );

  const riskFlags = new Set<string>();
  for (const nodeId of effectiveSymbolNodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    if (node.exported) riskFlags.add("exported symbol changed");
    const fanout = (graph.edgesByFrom.get(nodeId) ?? []).filter(
      (edge) => edge.kind === "calls",
    ).length;
    if (fanout >= 4) riskFlags.add("high fanout");
    const complexity = Number(node.metadata?.cyclomaticComplexity ?? 0);
    if (complexity >= 8) riskFlags.add("high complexity");
    if (node.metadata?.isBoundaryWrapper) riskFlags.add("boundary wrapper changed");
  }
  if (importerFiles.some((file) => directImports.includes(file))) {
    riskFlags.add("cycle-adjacent file");
  }

  const riskFlagList = dedupe(riskFlags);
  if (downstreamModuleFiles.length > 0) {
    riskFlagList.push(`${downstreamModuleFiles.length} downstream module file(s)`);
  }

  return {
    filePath: normalizedFile,
    changedSymbols,
    directImporters: importerFiles,
    directCallers: callerFiles,
    neighborFiles,
    riskFlags: riskFlagList,
  };
}
