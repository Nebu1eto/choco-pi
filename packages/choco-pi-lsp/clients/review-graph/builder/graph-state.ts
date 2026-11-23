import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { FactStore } from "../../dispatch/fact-store.ts";
import type { DispatchContext } from "../../dispatch/types.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import type { ReviewGraph, ReviewGraphEdge, ReviewGraphNode } from "../types.ts";
import { loadPersistedGraph } from "./persist-load.ts";
import { getReviewGraphSizeSkipVerdict } from "./source-files.ts";
import {
  REVIEW_GRAPH_VERSION,
  _workspaceGraphCache,
  setWorkspaceGraph,
  touchWorkspaceGraph,
} from "./workspace-cache.ts";

function ensureIndexed(graph: ReviewGraph): void {
  if (graph.edges.length > 0 && graph.edgesByFrom.size === 0) {
    rebuildIndexes(graph);
  }
}

export function getCachedReviewGraph(cwd: string): ReviewGraph | undefined {
  const key = normalizeMapKey(cwd);
  if (getReviewGraphSizeSkipVerdict(cwd)) return undefined;
  const cached = _workspaceGraphCache.get(key);
  if (cached) {
    touchWorkspaceGraph(key);
    ensureIndexed(cached.graph);
    return cached.graph;
  }
  const disk = loadPersistedGraph(cwd, {
    verifyGitStamp: true,
    allowPartial: true,
  });
  if (!disk) return undefined;
  setWorkspaceGraph(key, {
    signature: disk.signature,
    fileSignatures: disk.fileSignatures,
    fileHashes: disk.fileHashes,
    graph: disk.graph,
  });
  return disk.graph;
}

export function makeCtx(filePath: string, cwd: string, facts: FactStore): DispatchContext {
  return {
    filePath,
    cwd,
    kind: detectFileKind(filePath),
    fileRole: detectFileRole(filePath),
    pi: { getFlag: () => undefined },
    autofix: false,
    deltaMode: false,
    facts,
    blockingOnly: false,
    modifiedRanges: undefined,
    hasTool: async () => false,
    log: () => {},
  };
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createEmptyGraph(): ReviewGraph {
  return {
    version: REVIEW_GRAPH_VERSION,
    builtAt: new Date().toISOString(),
    nodes: new Map(),
    edges: [],
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(),
  };
}

export function cloneGraph(graph: ReviewGraph): ReviewGraph {
  return {
    version: graph.version,
    builtAt: graph.builtAt,
    nodes: new Map(graph.nodes),
    edges: [...graph.edges],
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(graph.changedSymbolsByFile),
    persistCoverage: graph.persistCoverage,
  };
}

export function refreshGraphBuiltAt(graph: ReviewGraph): void {
  graph.builtAt = new Date().toISOString();
}

export function sourceSignatureEntry(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export const STAT_YIELD_EVERY = 100;

export const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

export async function sourceSignatureMapAsync(files: string[]): Promise<Map<string, string>> {
  const signatures = new Map<string, string>();
  let sinceYield = 0;
  for (const file of files) {
    signatures.set(file, sourceSignatureEntry(file));
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  return signatures;
}

export function sourceSignatureFromMap(signatures: Map<string, string>): string {
  return [...signatures.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, signature]) => `${file}:${signature}`)
    .join("|");
}

export function contentHashEntry(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

export async function confirmContentChanged(
  candidates: string[],
  previousHashes: Map<string, string> | undefined,
): Promise<{ trulyChanged: string[]; hashes: Map<string, string> }> {
  const prior = previousHashes ?? new Map<string, string>();
  const hashes = new Map(prior);
  const trulyChanged: string[] = [];
  let sinceYield = 0;
  for (const file of candidates) {
    const hash = contentHashEntry(file);
    hashes.set(file, hash);
    if (prior.get(file) !== hash) trulyChanged.push(file);
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  return { trulyChanged, hashes };
}

interface SignatureDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffSignatureMaps(
  previous: Map<string, string>,
  next: Map<string, string>,
): SignatureDelta {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [file, signature] of next) {
    const oldSignature = previous.get(file);
    if (oldSignature === undefined) added.push(file);
    else if (oldSignature !== signature) changed.push(file);
  }
  const removed: string[] = [];
  for (const file of previous.keys()) {
    if (!next.has(file)) removed.push(file);
  }
  return { added, removed, changed };
}

export function addNode(graph: ReviewGraph, node: ReviewGraphNode): void {
  graph.nodes.set(node.id, node);
  if (node.kind === "file" && node.filePath) {
    graph.fileNodes.set(node.filePath, node.id);
  }
}

export function addEdge(graph: ReviewGraph, edge: ReviewGraphEdge): void {
  graph.edges.push(edge);
  const from = graph.edgesByFrom.get(edge.from) ?? [];
  from.push(edge);
  graph.edgesByFrom.set(edge.from, from);
  const to = graph.edgesByTo.get(edge.to) ?? [];
  to.push(edge);
  graph.edgesByTo.set(edge.to, to);
}

export function rebuildIndexes(graph: ReviewGraph): void {
  graph.edgesByFrom = new Map();
  graph.edgesByTo = new Map();
  graph.fileNodes = new Map();
  graph.symbolNodesByFile = new Map();
  for (const node of graph.nodes.values()) {
    if (node.kind === "file" && node.filePath) {
      graph.fileNodes.set(node.filePath, node.id);
    }
    if (node.kind === "symbol" && node.filePath) {
      const ids = graph.symbolNodesByFile.get(node.filePath) ?? [];
      ids.push(node.id);
      graph.symbolNodesByFile.set(node.filePath, ids);
    }
  }
  for (const edge of graph.edges) {
    const from = graph.edgesByFrom.get(edge.from) ?? [];
    from.push(edge);
    graph.edgesByFrom.set(edge.from, from);
    const to = graph.edgesByTo.get(edge.to) ?? [];
    to.push(edge);
    graph.edgesByTo.set(edge.to, to);
  }
}
