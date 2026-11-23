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
  inProgress: true;
  targetFileCount: number;
  processedFiles: Array<[string, string]>;
  ignoredIdsHash: string;
  nodes: Array<[string, ReviewGraphNode]>;
  edges: ReviewGraphEdge[];
  gitStamp?: { headCommit: string; worktreeRoot: string };
}

function reviewGraphCheckpointPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", GRAPH_CHECKPOINT_FILENAME);
}

function hashIgnoredIds(ignoredIds: ReadonlySet<string> | undefined): string {
  if (ignoredIds === undefined) return "unavailable";
  const joined = [...ignoredIds].sort((a, b) => a.localeCompare(b)).join("\u0000");
  return createHash("sha256").update(joined).digest("hex");
}

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
    return;
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
    logReviewGraph({
      cwd,
      phase: "checkpoint_write_failed",
      reason: "sync_write_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function deleteReviewGraphCheckpoint(cwd: string): void {
  _checkpointGenerations.set(cwd, (_checkpointGenerations.get(cwd) ?? 0) + 1);
  fs.rm(reviewGraphCheckpointPath(cwd), { force: true }, () => {});
}

interface LoadedReviewGraphCheckpoint {
  graph: ReviewGraph;
  processedHashes: Map<string, string>;
  ignoredIdsHash: string;
  targetFileCount: number;
}

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
