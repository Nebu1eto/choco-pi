/**
 * Graph build metadata (GraphBuildInfo), cache identity and snapshots, and test hooks for build gating.
 */
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

/**
 * RuntimeCoordinator sequence hint (#451). Threaded from the deferred cascade so
 * the builder can ask "which files changed since I last built?" and skip its
 * per-build O(project) walk+stat sweep. Optional end-to-end: absent ⇒ today's
 * behavior exactly.
 */
export interface GraphSeqHint {
  projectSeq: () => number;
  getFilesChangedSince: (seq: number) => string[];
}

/** Beyond this many seq-changed files, incremental re-extract nears sweep cost — just sweep (#451). */
export const SEQ_FASTPATH_MAX_CHANGES = 32;
/** Force a full walk+stat re-verify at least this often in wall time (external-edit safety valve, #451). */
export const SEQ_FASTPATH_REVERIFY_MS = 5 * 60_000;
/** ...and at least every Nth fast-path build per workspace. */
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
  /** Reason the graph was successfully built but persisted only partially. */
  persistReason?: string;
  /** When the seq fast path was attempted but fell back to the sweep (#451). */
  seqFastpathFallback?: SeqFastpathFallback;
  /**
   * #459: whether this build changed the graph content. `mode` alone is NOT
   * enough to tell — both "cached" and "seq-fastpath" cover a real no-op AND
   * (for seq-fastpath) a genuine incremental re-extract, depending on whether
   * any files actually needed re-parsing. INFORMATIONAL (logs) ONLY: this
   * lives in a single global slot that overlapping deferred cascades can
   * clobber between a build and its caller's read, so derived-data caches
   * must key invalidation off `ReviewGraph.buildGeneration` (which travels
   * with the returned instance), never off this flag.
   */
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
// The global slot above is retained for legacy status surfaces, but overlapping
// deferred builds need a per-result identity for lifecycle telemetry.
const _graphBuildInfoByGraph = new WeakMap<ReviewGraph, GraphBuildInfo>();
// #1179: true once ANY graph has been stamped since the last cache clear — i.e.
// `_lastGraphBuildInfo` may now hold a REAL build's info (a potential sibling)
// rather than the pristine `mode: "full"` default. Used only by the fail-closed
// safety read below to decide whether the global slot is safe to serve on a
// WeakMap identity miss.
let _anyGraphStamped = false;

export function setGraphBuildInfo(graph: ReviewGraph, info: GraphBuildInfo): void {
  _lastGraphBuildInfo = info;
  _graphBuildInfoByGraph.set(graph, info);
  _anyGraphStamped = true;
}

export function getGraphBuildInfoForGraph(graph: ReviewGraph): GraphBuildInfo {
  return _graphBuildInfoByGraph.get(graph) ?? _lastGraphBuildInfo;
}

/**
 * #1179 (fail-closed guard, latent P3 from the #1108/#1180 side-channel audit).
 * Whether `getGraphBuildInfoForGraph(graph)` can be TRUSTED to describe `graph`
 * itself — for a SAFETY gate that must never read a sibling graph's state.
 *
 * `getGraphBuildInfoForGraph` deliberately falls back to the global
 * `_lastGraphBuildInfo` slot on a WeakMap identity miss — fine for the telemetry
 * and `updateGraphBuildInfo` base-read callers, where a sibling build's `mode` is
 * only informational (and the first stamp of a graph legitimately bases off the
 * prior slot). But a gate that decides degraded-vs-clean must not read a DIFFERENT
 * graph's `mode: "cached"` (healthy) off that fallback, or it would mistake an
 * unstamped/rehydrated graph for a clean leaf and serve a silent all-clear (the
 * #533 false-clean trap). Such a caller reads THIS first and, when it returns
 * false, fails CLOSED (treats coverage as unknown/degraded) instead of trusting
 * the slot.
 *
 * Trustworthy iff EITHER the graph's own identity is present in the WeakMap (the
 * fallback is not even taken), OR nothing has been stamped since the last cache
 * clear (`_lastGraphBuildInfo` is still the pristine `mode: "full"` default, which
 * cannot be a sibling's real state). Only a miss AFTER some real build has stamped
 * — where the global slot could be a sibling's info — is untrustworthy.
 *
 * Live path: always trustworthy. Every `_doBuildGraph` return stamps the graph via
 * `setGraphBuildInfo` before returning it, so the cascade reads the freshly-stamped
 * same-identity instance (`has(graph)` true) and the miss branch is unreachable
 * today. This only hardens a future path that ever surfaces an unstamped graph.
 */
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
  // #1179: the global slot is back to the pristine default, so a subsequent
  // identity miss can safely serve it again (it cannot be a sibling's state).
  _anyGraphStamped = false;
}

export let _reviewGraphBuildGateForTests: (() => Promise<void>) | undefined;

/** Test seam for deterministically interleaving a build with cache eviction. */
export function _setReviewGraphBuildGateForTests(gate: (() => Promise<void>) | undefined): void {
  _reviewGraphBuildGateForTests = gate;
}

export interface ReviewGraphWorkspaceCacheSnapshot {
  /** Resident entries in `_workspaceGraphCache` — one per distinct cwd this
   *  process has built a graph for (#1123 item 2 memory attribution). */
  cacheEntries: number;
  /** Sum of `graph.nodes.size` across every resident entry. */
  totalNodes: number;
  /** Sum of `graph.edges.length` across every resident entry. */
  totalEdges: number;
}

/**
 * O(cache-entries) snapshot of the resident workspace graph cache — NOT
 * O(nodes)/O(edges): only `.size`/`.length` are read per entry, never the
 * graph contents themselves (#1123 item 2 memory-attribution sample). Cache
 * entries are per-cwd and normally number 1 (a session_start clears the
 * cache), so this is cheap enough for a per-N-turn sample.
 */
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

/** Test-only cache keys, including the LRU order from oldest to newest. */
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

/**
 * Identity of the canonical review-graph cache used by derived projections.
 * This is deliberately read-only: callers get the cache's source signature and
 * graph schema version, never the source-file map or graph itself.
 *
 * The workspace entry is populated by both the in-memory build path and the
 * persisted-snapshot hydration path, so consumers do not need a second source
 * walk (or an independent mtime policy) to validate derived data.
 */
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
  // #1088: `version` is the constant schema tag ("v8" today) — identical for
  // every live graph, so comparing it can never detect that `graph` is a
  // stale instance the workspace cache has since replaced (e.g. a concurrent
  // build racing between this caller's projection snapshot and its identity
  // lookup). Compare the ENTRY's generation stamp (#459), not the stored
  // graph object's: reuse paths store an unstamped `cloneGraph` copy and
  // stamp only the returned instance, so `cached.graph.buildGeneration` is
  // undefined on every drift-reuse / disk-hit entry while the caller's graph
  // carries the entry's generation. The both-undefined case is legitimate
  // only for the tier-3 hydration entry, where the caller holds the exact
  // stored instance — anything else unstamped must not resolve an identity
  // (e.g. the size-skip empty graph racing a hydrated entry).
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

// #300 Edge 2: the review-graph's cross-worktree isolation is INCIDENTAL to
// the cwd-derived data-dir slug (getProjectDataDir) — it holds only because
// every process is launched with its own worktree as cwd. If a host ever
// passes the main repo root as cwd while editing worktree files by absolute
// path, that assumption silently breaks. This doesn't hard-fail (the issue
// is explicit: log-once observability is enough) — it just makes the
// assumption visible. The Set records every cwd whose check has RUN (not just
// mismatches), so resolveGitIdentity's fs reads happen once per cwd per
// process — zero per-build cost after the first, mismatch or not.
const _cwdWorktreeCheckedCwds = new Set<string>();

export function _resetCwdWorktreeMismatchLogForTests(): void {
  _cwdWorktreeCheckedCwds.clear();
}

export function logCwdWorktreeMismatchOnce(cwd: string): void {
  const key = normalizeMapKey(cwd);
  if (_cwdWorktreeCheckedCwds.has(key)) return;
  _cwdWorktreeCheckedCwds.add(key);
  const identity = resolveGitIdentity(cwd);
  if (!identity) return; // not a git repo — nothing to compare against
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

/**
 * Test-only: force the last-build-info slot (e.g. to simulate a `too_many_files`
 * size-skip without walking a real over-cap repo). #1023 degraded-path coverage.
 */
export function _setLastGraphBuildInfoForTests(info: GraphBuildInfo): void {
  _lastGraphBuildInfo = info;
}
