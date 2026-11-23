/**
 * Mid-build checkpoints: writing, loading, and resuming a partial review-graph build.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "../../atomic-write.ts";
import { getProjectDataDir } from "../../file-utils.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import { resolveGitIdentity } from "../git-identity.ts";
import type {
  ReviewGraph,
  ReviewGraphEdge,
  ReviewGraphNode,
  ReviewGraphPersistCoverage,
} from "../types.ts";
import type { ReviewGraphPersistWorkerRequest } from "../persist-worker.ts";
import { reviewGraphBuilderState } from "./state.ts";
import { removeFileOwnedGraphData } from "./file-update.ts";
import { STAT_YIELD_EVERY, contentHashEntry, rebuildIndexes, yieldToLoop } from "./graph-state.ts";
import { GRAPH_CHECKPOINT_FILENAME } from "./persist-load.ts";
import {
  _checkpointGenerations,
  _checkpointWorkerRequests,
  countRetainedSourceFiles,
  ensurePersistExitHook,
  getPersistWorker,
} from "./persist-worker-client.ts";
import { sweepStaleStageFiles } from "./persist.ts";
import { REVIEW_GRAPH_VERSION } from "./workspace-cache.ts";

// --- Cross-session resumable full build (checkpointing, #936 limit 2) ---
// A full build walks + tree-sitter-parses every source file, then resolves
// cross-file edges once at the end. On a large repo with short-lived sessions
// that whole pass can be killed before it finishes and, with no checkpoint,
// the next session starts from scratch — so it may NEVER complete. During the
// full-build extraction loop we periodically snapshot the PRE-resolution graph
// plus the exact set of files already folded into it (with content hashes) to
// a dedicated checkpoint file. A later session resumes from that snapshot,
// re-walking only files that changed/appeared since, and finishes the build.
//
// Correctness (equivalence to a cold full build) rests on one property of the
// extraction: `addFileToGraph`'s per-file contribution (the nodes it adds and
// the edges it adds, with their metadata) depends ONLY on that file's content
// and the cwd — never on other files or on processing order, because ALL
// cross-file linking is deferred to `resolveDeferredSymbolEdges`, run once
// after every file is in. So the pre-resolution graph is the order-independent
// union of per-file contributions (shared placeholder / imported-file stub
// nodes are created idempotently by id). Resuming therefore reconstructs the
// identical pre-resolution graph as long as the reused files' contributions
// are still current — which the content-hash + ignored-id + git gates below
// enforce, failing open to a cold build on any doubt.

const GRAPH_CHECKPOINT_EVERY_FILES_DEFAULT = 250;
const GRAPH_CHECKPOINT_MIN_INTERVAL_MS_DEFAULT = 5_000;

export function graphCheckpointEveryFiles(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_GRAPH_CHECKPOINT_EVERY_FILES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GRAPH_CHECKPOINT_EVERY_FILES_DEFAULT;
}

export function graphCheckpointMinIntervalMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_GRAPH_CHECKPOINT_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : GRAPH_CHECKPOINT_MIN_INTERVAL_MS_DEFAULT;
}

interface ReviewGraphCheckpointData {
  version: string;
  builtAt: string;
  /**
   * Honesty marker (#936): this payload is a MID-BUILD snapshot, never a
   * complete graph. Only the resume path in `_doBuildGraph` ever reads it.
   */
  inProgress: true;
  /** Total files this build is walking toward — telemetry only. */
  targetFileCount: number;
  /** Files whose per-file contribution is already in `nodes`/`edges`, keyed to
   * the sha256 of the exact bytes extracted, so a later session can detect and
   * re-walk any that changed since. */
  processedFiles: Array<[string, string]>;
  /** Fingerprint of the untracked-AND-ignored id set (#694) used during
   * extraction. It steers import-edge target resolution, so a change would make
   * reused files' edges stale — resume fails open to a cold build on mismatch. */
  ignoredIdsHash: string;
  /** PRE-resolution nodes (resolveDeferredSymbolEdges has NOT run). */
  nodes: Array<[string, ReviewGraphNode]>;
  /** PRE-resolution edges (cross-file `calls`/`references` still point at
   * unresolved placeholder nodes). */
  edges: ReviewGraphEdge[];
  gitStamp?: { headCommit: string; worktreeRoot: string };
}

function reviewGraphCheckpointPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", GRAPH_CHECKPOINT_FILENAME);
}

/** Stable fingerprint of the untracked-ignored id set. `undefined` (fetch
 * degraded / not requested) hashes distinctly from an empty set, so a resume
 * only reuses a checkpoint built under the same ignore state. */
function hashIgnoredIds(ignoredIds: ReadonlySet<string> | undefined): string {
  if (ignoredIds === undefined) return "unavailable";
  const joined = [...ignoredIds].sort((a, b) => a.localeCompare(b)).join("\u0000");
  return createHash("sha256").update(joined).digest("hex");
}

/** Assemble the checkpoint DTO from the current PRE-resolution graph. Isolated
 * so both the offloaded and synchronous writers serialize identical bytes. */
export function buildReviewGraphCheckpointData(
  cwd: string,
  graph: ReviewGraph,
  processedHashes: Map<string, string>,
  targetFileCount: number,
  ignoredIds: ReadonlySet<string> | undefined,
): ReviewGraphCheckpointData {
  return {
    version: REVIEW_GRAPH_VERSION,
    builtAt: new Date().toISOString(),
    inProgress: true,
    targetFileCount,
    processedFiles: Array.from(processedHashes.entries()),
    ignoredIdsHash: hashIgnoredIds(ignoredIds),
    nodes: Array.from(graph.nodes.entries()),
    edges: graph.edges,
    gitStamp: resolveGitIdentity(cwd),
  };
}

/**
 * Write a mid-build checkpoint for `cwd`. Best-effort. `graph` MUST be
 * pre-resolution; `processedHashes` MUST contain exactly the files already
 * folded into it. The stringify+gzip is offloaded to the shared persist worker
 * (keeping the gzip of a growing graph off the event loop during a background
 * build), generation-gated so a slow write can't clobber a newer checkpoint or
 * resurrect one over a completed build; it falls back to a synchronous write
 * when the worker is unavailable. A lost checkpoint only costs a cold rebuild.
 */
export function writeReviewGraphCheckpoint(
  cwd: string,
  graph: ReviewGraph,
  processedHashes: Map<string, string>,
  targetFileCount: number,
  ignoredIds: ReadonlySet<string> | undefined,
): void {
  const generation = (_checkpointGenerations.get(cwd) ?? 0) + 1;
  _checkpointGenerations.set(cwd, generation);
  let data: ReviewGraphCheckpointData;
  try {
    data = buildReviewGraphCheckpointData(cwd, graph, processedHashes, targetFileCount, ignoredIds);
  } catch {
    return; // best-effort — building the DTO failed, skip this stride
  }
  const worker = reviewGraphBuilderState._workerDisabled ? undefined : getPersistWorker();
  if (!worker) {
    writeReviewGraphCheckpointSync(cwd, data, {
      nodes: graph.nodes.size,
      edges: graph.edges.length,
      processed: processedHashes.size,
      target: targetFileCount,
    });
    return;
  }
  const checkpointPath = reviewGraphCheckpointPath(cwd);
  const cacheDir = path.dirname(checkpointPath);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    // Can't stage — skip this stride (best-effort), but surface it.
    logReviewGraph({
      cwd,
      phase: "checkpoint_write_failed",
      reason: "mkdir_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  sweepStaleStageFiles(cacheDir);
  ensurePersistExitHook();
  const id = ++reviewGraphBuilderState._persistWorkerRequestId;
  const stagePath = `${checkpointPath}.stage-${process.pid}-${generation}`;
  _checkpointWorkerRequests.set(id, {
    cwd,
    generation,
    checkpointPath,
    stagePath,
    nodes: graph.nodes.size,
    edges: graph.edges.length,
    processed: processedHashes.size,
    target: targetFileCount,
  });
  const request: ReviewGraphPersistWorkerRequest = {
    id,
    cwd,
    generation,
    stagePath,
    data,
    elements: graph.nodes.size + graph.edges.length,
    testDelayMs:
      process.env.NODE_ENV === "test"
        ? Number(process.env.CHOCO_PI_LSP_TEST_PERSIST_WORKER_DELAY_MS) || undefined
        : undefined,
  };
  worker.postMessage(request);
  reviewGraphBuilderState._checkpointOffloadCountForTests++;
}

/** Synchronous checkpoint write — the worker-unavailable fallback and the
 * teardown/test-seam path where an async promotion couldn't land in time. */
export function writeReviewGraphCheckpointSync(
  cwd: string,
  data: ReviewGraphCheckpointData,
  counts: { nodes: number; edges: number; processed: number; target: number },
): void {
  try {
    const gzip = gzipSync(JSON.stringify(data));
    fs.mkdirSync(path.dirname(reviewGraphCheckpointPath(cwd)), {
      recursive: true,
    });
    writeFileAtomic(reviewGraphCheckpointPath(cwd), gzip, { bestEffort: true });
    logReviewGraph({
      cwd,
      phase: "checkpoint_written",
      nodes: counts.nodes,
      edges: counts.edges,
      processed: counts.processed,
      target: counts.target,
    });
  } catch (err) {
    // Best-effort: a failed checkpoint just means no resume next session —
    // but surface it so a persistent write failure isn't invisible.
    logReviewGraph({
      cwd,
      phase: "checkpoint_write_failed",
      reason: "sync_write_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove the checkpoint once a complete authoritative graph exists (or when a
 * stale checkpoint is discarded). Best-effort. Bumps the checkpoint generation
 * first so any still-in-flight offloaded write for `cwd` is gated out and can
 * never re-create the file after this delete. */
export function deleteReviewGraphCheckpoint(cwd: string): void {
  _checkpointGenerations.set(cwd, (_checkpointGenerations.get(cwd) ?? 0) + 1);
  fs.rm(reviewGraphCheckpointPath(cwd), { force: true }, () => {});
}

interface LoadedReviewGraphCheckpoint {
  /** Hydrated PRE-resolution graph, marked partial + inProgress. */
  graph: ReviewGraph;
  processedHashes: Map<string, string>;
  ignoredIdsHash: string;
  targetFileCount: number;
}

/**
 * Read back a checkpoint for `cwd`, gated on the graph version (single source of
 * truth: {@link REVIEW_GRAPH_VERSION}) and, when both stamps resolve, the git
 * identity — the same drop-on-mismatch guard `loadPersistedGraph` uses. Returns
 * null (and best-effort deletes an unusable file) when absent/stale/corrupt.
 * The returned graph carries `persistCoverage.inProgress` so it can never be
 * mistaken for a complete graph if it escapes the resume path.
 */
function loadReviewGraphCheckpoint(cwd: string): LoadedReviewGraphCheckpoint | null {
  const checkpointPath = reviewGraphCheckpointPath(cwd);
  let data: ReviewGraphCheckpointData;
  try {
    if (!fs.existsSync(checkpointPath)) return null;
    // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
    data = JSON.parse(
      gunzipSync(fs.readFileSync(checkpointPath)).toString("utf-8"),
    ) as ReviewGraphCheckpointData;
  } catch {
    // A checkpoint file was present but unreadable — the operator would
    // otherwise see a full cold rebuild with no hint the checkpoint existed.
    logReviewGraph({ cwd, phase: "checkpoint_discarded", reason: "corrupt" });
    deleteReviewGraphCheckpoint(cwd);
    return null;
  }
  if (data.version !== REVIEW_GRAPH_VERSION || data.inProgress !== true) {
    logReviewGraph({
      cwd,
      phase: "checkpoint_discarded",
      reason: data.version !== REVIEW_GRAPH_VERSION ? "version_mismatch" : "not_in_progress",
    });
    deleteReviewGraphCheckpoint(cwd);
    return null;
  }
  if (data.gitStamp) {
    const current = resolveGitIdentity(cwd);
    if (
      current &&
      (current.headCommit !== data.gitStamp.headCommit ||
        current.worktreeRoot !== data.gitStamp.worktreeRoot)
    ) {
      logReviewGraph({
        cwd,
        phase: "checkpoint_discarded",
        reason: "git_stamp_mismatch",
      });
      deleteReviewGraphCheckpoint(cwd);
      return null;
    }
  }
  const totalNodes = data.nodes.length;
  const totalEdges = data.edges.length;
  const graph: ReviewGraph = {
    version: data.version,
    builtAt: data.builtAt,
    nodes: new Map(data.nodes),
    edges: data.edges,
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(),
    persistCoverage: {
      partial: true,
      inProgress: true,
      cap: 0,
      totalNodes,
      totalEdges,
      persistedNodes: totalNodes,
      persistedEdges: totalEdges,
      totalFiles: data.targetFileCount,
      persistedFiles: 0,
    },
  };
  rebuildIndexes(graph);
  if (graph.persistCoverage) {
    graph.persistCoverage.persistedFiles = countRetainedSourceFiles(
      graph,
      data.processedFiles.map(([filePath]) => filePath),
    );
  }
  return {
    graph,
    processedHashes: new Map(data.processedFiles),
    ignoredIdsHash: data.ignoredIdsHash,
    targetFileCount: data.targetFileCount,
  };
}

/**
 * Drop nodes with no `filePath` (shared placeholder / imported-file-stub /
 * external / module nodes) that no edge references after a stale-file eviction.
 * A cold full build's pre-resolution graph never contains such zero-edge
 * placeholders (each is created immediately before an edge to it, and the full
 * path removes no edges), so pruning them makes a reconciled resume graph
 * node-for-node identical to a cold build BEFORE `resolveDeferredSymbolEdges`
 * runs. Must be called only on a pre-resolution graph.
 */
function pruneOrphanNonFileNodes(graph: ReviewGraph): void {
  const referenced = new Set<string>();
  for (const edge of graph.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const [id, node] of graph.nodes) {
    if (!node.filePath && !referenced.has(id)) graph.nodes.delete(id);
  }
}

interface ResumedBuild {
  graph: ReviewGraph;
  fileHashes: Map<string, string>;
  remaining: string[];
}

/**
 * Attempt to resume a full build for `cwd` from a prior session's checkpoint.
 * Returns a seed graph (the reconciled pre-resolution checkpoint), the content
 * hashes of the files it reuses, and the list of files still to extract; or
 * null when there is no usable checkpoint (caller does a cold full build).
 *
 * Reconciliation vs. the CURRENT target file set (`filesToBuild`):
 *  - A processed file no longer in the target set (deleted/renamed/now-excluded)
 *    can invalidate OTHER kept files' import edges, which this pass does not
 *    rebuild — so ANY such removal fails open to a cold build (correctness over
 *    reuse, per #936).
 *  - A processed file still present but whose content changed is evicted and
 *    re-walked (its contribution is self-contained; cross-file links re-resolve
 *    globally at the end).
 *  - The ignored-id fingerprint must match (import-edge resolution depends on
 *    it), else fail open.
 */
export async function tryResumeFromCheckpoint(
  cwd: string,
  filesToBuild: string[],
  ignoredIds: ReadonlySet<string> | undefined,
): Promise<ResumedBuild | null> {
  const loaded = loadReviewGraphCheckpoint(cwd);
  if (!loaded) return null;
  if (loaded.ignoredIdsHash !== hashIgnoredIds(ignoredIds)) {
    logReviewGraph({
      cwd,
      phase: "checkpoint_discarded",
      reason: "ignored_ids_mismatch",
      processed: loaded.processedHashes.size,
      target: filesToBuild.length,
    });
    deleteReviewGraphCheckpoint(cwd);
    return null;
  }
  const targetSet = new Set(filesToBuild);
  // Removed-file guard: a processed file gone from the target set can leave a
  // kept importer's edges stale — fail open rather than serve a wrong graph.
  for (const file of loaded.processedHashes.keys()) {
    if (!targetSet.has(file)) {
      logReviewGraph({
        cwd,
        phase: "checkpoint_discarded",
        reason: "removed_file",
        processed: loaded.processedHashes.size,
        target: filesToBuild.length,
      });
      deleteReviewGraphCheckpoint(cwd);
      return null;
    }
  }
  // Detect content changes among processed files (chunked stat/hash sweep).
  const reusableHashes = new Map<string, string>();
  const stale: string[] = [];
  let sinceYield = 0;
  for (const [file, priorHash] of loaded.processedHashes) {
    const currentHash = contentHashEntry(file);
    if (currentHash === priorHash) reusableHashes.set(file, currentHash);
    else stale.push(file);
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  if (reusableHashes.size === 0) {
    // Nothing survivable — no benefit over a cold build; discard.
    logReviewGraph({
      cwd,
      phase: "checkpoint_discarded",
      reason: "all_stale",
      stale: stale.length,
      target: filesToBuild.length,
    });
    deleteReviewGraphCheckpoint(cwd);
    return null;
  }
  const graph = loaded.graph;
  // Evict every stale (content-changed) processed file so its outdated
  // contribution is replaced by a fresh walk below.
  for (const file of stale) removeFileOwnedGraphData(graph, file);
  pruneOrphanNonFileNodes(graph);
  graph.changedSymbolsByFile = new Map();
  const remaining = filesToBuild.filter((file) => !reusableHashes.has(file));
  logReviewGraph({
    cwd,
    phase: "checkpoint_resumed",
    reused: reusableHashes.size,
    stale: stale.length,
    remaining: remaining.length,
    target: filesToBuild.length,
  });
  return { graph, fileHashes: reusableHashes, remaining };
}

/** Test-only: inspect the on-disk resume checkpoint for `cwd` (raw payload),
 * or null when none is present. Lets tests assert the honesty marker and the
 * recorded processed-file set without exporting the whole checkpoint machinery. */
export function _readReviewGraphCheckpointForTests(cwd: string): {
  inProgress: boolean;
  processedFiles: string[];
  nodeCount: number;
  edgeCount: number;
  persistCoverage: ReviewGraphPersistCoverage | undefined;
} | null {
  const loaded = loadReviewGraphCheckpoint(cwd);
  if (!loaded) return null;
  return {
    inProgress: loaded.graph.persistCoverage?.inProgress === true,
    processedFiles: [...loaded.processedHashes.keys()],
    nodeCount: loaded.graph.nodes.size,
    edgeCount: loaded.graph.edges.length,
    persistCoverage: loaded.graph.persistCoverage,
  };
}
