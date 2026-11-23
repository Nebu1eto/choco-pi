import { isRuntimeString } from "../../../tools/runtime-values.ts";
import * as path from "node:path";
import { logLatency } from "../../latency-logger.ts";
import { normalizeFilePath, normalizeMapKey } from "../../path-utils.ts";
import {
  makeReviewGraphBuildMetadata,
  type ReviewGraphBuildMode,
  type ReviewGraphBuildMetadata,
} from "../../review-graph-logger.ts";
import { resolveGitIdentity } from "../git-identity.ts";
import type { ReviewGraph } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";
import { _sizeSkipVerdicts } from "./source-files.ts";
import {
  _buildCache,
  _workspaceCacheEpochs,
  _workspaceGraphCache,
  clearWorkspaceGraphTimer,
  touchWorkspaceGraph,
} from "./workspace-cache.ts";

export interface GraphSeqHint {
  projectSeq: () => number;
  getFilesChangedSince: (seq: number) => string[];
}

export const SEQ_FASTPATH_MAX_CHANGES = 32;
export const SEQ_FASTPATH_REVERIFY_MS = 5 * 60_000;
export const SEQ_FASTPATH_REVERIFY_EVERY = 20;

export type SeqFastpathFallback =
  | "no-seq"
  | "partial-base"
  | "too-many-changes"
  | "new-file"
  | "verify-due"
  | "removed-file"
  | "stat-error";

export type GraphBuildInfo = {
  reused: boolean;
  mode: "full" | "cached" | "incremental" | "skipped" | "seq-fastpath";
  skipReason?: string;
  sourceFileCount?: number;
  sourceFileCountTruncated?: boolean;
  maxFileCount?: number;
  persistReason?: string;
  seqFastpathFallback?: SeqFastpathFallback;
  graphChanged: boolean;
};

export function graphLogMetadata(
  graph: ReviewGraph,
  options: {
    buildId?: number;
    projectSeq?: number;
    seqHint?: boolean;
    mode?: ReviewGraphBuildMode;
    sourceFileCount?: number;
    sourceFileCountTruncated?: boolean;
  } = {},
): ReviewGraphBuildMetadata {
  return makeReviewGraphBuildMetadata(graph, options);
}

export function seqFastpathEnabled(): boolean {
  const raw = process.env.CHOCO_PI_LSP_GRAPH_SEQ_FASTPATH;
  return raw !== "0" && raw !== "false";
}

let _lastGraphBuildInfo: GraphBuildInfo = {
  reused: false,
  mode: "full",
  graphChanged: true,
};
const _graphBuildInfoByGraph = new WeakMap<ReviewGraph, GraphBuildInfo>();
let _anyGraphStamped = false;

export function setGraphBuildInfo(graph: ReviewGraph, info: GraphBuildInfo): void {
  _lastGraphBuildInfo = info;
  _graphBuildInfoByGraph.set(graph, info);
  _anyGraphStamped = true;
}

export function getGraphBuildInfoForGraph(graph: ReviewGraph): GraphBuildInfo {
  return _graphBuildInfoByGraph.get(graph) ?? _lastGraphBuildInfo;
}

export function graphBuildInfoIsTrustworthy(graph: ReviewGraph): boolean {
  return _graphBuildInfoByGraph.has(graph) || !_anyGraphStamped;
}

export function updateGraphBuildInfo(
  graph: ReviewGraph,
  patch: Partial<GraphBuildInfo>,
): GraphBuildInfo {
  const info = { ...getGraphBuildInfoForGraph(graph), ...patch };
  setGraphBuildInfo(graph, info);
  return info;
}

export function clearGraphCache(): void {
  _buildCache.clear();
}

export function clearReviewGraphWorkspaceCache(cwd?: string): void {
  if (cwd === undefined) {
    _buildCache.clear();
    for (const entry of _workspaceGraphCache.values()) clearWorkspaceGraphTimer(entry);
    _workspaceGraphCache.clear();
    reviewGraphBuilderState._workspaceCacheEpoch++;
    _sizeSkipVerdicts.clear();
  } else {
    const normalized = normalizeMapKey(cwd);
    for (const key of _buildCache.keys()) {
      if (normalizeMapKey(key).startsWith(`${normalized}|`)) {
        _buildCache.delete(key);
      }
    }
    const entry = _workspaceGraphCache.get(normalized);
    if (entry) clearWorkspaceGraphTimer(entry);
    _workspaceCacheEpochs.set(normalized, (_workspaceCacheEpochs.get(normalized) ?? 0) + 1);
    _workspaceGraphCache.delete(normalized);
    _sizeSkipVerdicts.delete(normalized);
  }
  _lastGraphBuildInfo = { reused: false, mode: "full", graphChanged: true };
  _anyGraphStamped = false;
}

export let _reviewGraphBuildGateForTests: (() => Promise<void>) | undefined;

export function _setReviewGraphBuildGateForTests(gate: (() => Promise<void>) | undefined): void {
  _reviewGraphBuildGateForTests = gate;
}

export interface ReviewGraphWorkspaceCacheSnapshot {
  cacheEntries: number;
  totalNodes: number;
  totalEdges: number;
}

export function getReviewGraphWorkspaceCacheSnapshot(): ReviewGraphWorkspaceCacheSnapshot {
  let totalNodes = 0;
  let totalEdges = 0;
  for (const entry of _workspaceGraphCache.values()) {
    totalNodes += entry.graph.nodes.size;
    totalEdges += entry.graph.edges.length;
  }
  return {
    cacheEntries: _workspaceGraphCache.size,
    totalNodes,
    totalEdges,
  };
}

export function _getReviewGraphWorkspaceCacheKeysForTests(): string[] {
  return [..._workspaceGraphCache.entries()]
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
    .map(([key]) => key);
}

export function _getReviewGraphCacheStateForTests(cwd: string):
  | {
      signature: string;
      fileSignatures: Map<string, string>;
      fileHashes?: Map<string, string>;
    }
  | undefined {
  const cached = _workspaceGraphCache.get(normalizeMapKey(cwd));
  if (!cached) return undefined;
  touchWorkspaceGraph(normalizeMapKey(cwd));
  return {
    signature: cached.signature,
    fileSignatures: new Map(cached.fileSignatures),
    fileHashes: cached.fileHashes ? new Map(cached.fileHashes) : undefined,
  };
}

export interface ReviewGraphCacheIdentity {
  version: string;
  signature: string;
}

export function getReviewGraphCacheIdentity(
  cwd: string,
  graph?: ReviewGraph,
): ReviewGraphCacheIdentity | undefined {
  const cached = _workspaceGraphCache.get(normalizeMapKey(cwd));
  if (!cached) return undefined;
  touchWorkspaceGraph(normalizeMapKey(cwd));
  if (graph) {
    if (cached.buildGeneration === undefined && graph.buildGeneration === undefined) {
      if (cached.graph !== graph) return undefined;
    } else if (cached.buildGeneration !== graph.buildGeneration) {
      return undefined;
    }
  }
  const version = graph?.version ?? cached.graph.version;
  if (!isRuntimeString(version) || version.length === 0 || !isRuntimeString(cached.signature)) {
    return undefined;
  }
  return { version, signature: cached.signature };
}

const _cwdWorktreeCheckedCwds = new Set<string>();

export function _resetCwdWorktreeMismatchLogForTests(): void {
  _cwdWorktreeCheckedCwds.clear();
}

export function logCwdWorktreeMismatchOnce(cwd: string): void {
  const key = normalizeMapKey(cwd);
  if (_cwdWorktreeCheckedCwds.has(key)) return;
  _cwdWorktreeCheckedCwds.add(key);
  const identity = resolveGitIdentity(cwd);
  if (!identity) return;
  if (identity.worktreeRoot === normalizeFilePath(path.resolve(cwd))) return;
  logLatency({
    type: "phase",
    phase: "review_graph_cwd_worktree_mismatch",
    filePath: cwd,
    durationMs: 0,
    metadata: { cwd, worktreeRoot: identity.worktreeRoot },
  });
}

export function getLastGraphBuildInfo(): GraphBuildInfo {
  return _lastGraphBuildInfo;
}

export function _setLastGraphBuildInfoForTests(info: GraphBuildInfo): void {
  _lastGraphBuildInfo = info;
}
