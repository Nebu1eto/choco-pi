import { includePropertiesWhen } from "../../optional-properties.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../atomic-write.ts";
import { logLatency } from "../../latency-logger.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import {
  buildReverseDependencyIndexFromGraph,
  rankFilesByReverseDependencyCentrality,
} from "../../reverse-deps.ts";
import {
  flushReviewGraphLogSync,
  logReviewGraph,
  type ReviewGraphBuildMetadata,
  type ReviewGraphPersistenceMetadata,
} from "../../review-graph-logger.ts";
import type { ReviewGraph, ReviewGraphPersistCoverage } from "../types.ts";
import type {
  ReviewGraphPersistWorkerRequest,
  ReviewGraphPersistWorkerResult,
} from "../persist-worker.ts";
import { reviewGraphBuilderState } from "./state.ts";
import { rebuildIndexes } from "./graph-state.ts";
import { flushReviewGraphPersist } from "./persist-flush.ts";
import { LEGACY_GRAPH_CACHE_FILENAME, type PersistedGraphData } from "./persist-load.ts";
import { recordPersistFailure } from "./source-files.ts";

const GRAPH_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;
export const GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT = 500_000;

export function graphPersistDebounceMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_GRAPH_PERSIST_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : GRAPH_PERSIST_DEBOUNCE_MS_DEFAULT;
}

export function graphPersistMaxElements(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_GRAPH_PERSIST_MAX_ELEMENTS);
  return Number.isFinite(raw) && raw > 0 ? raw : GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT;
}

export interface PendingPersist {
  cacheDir: string;
  cachePath: string;
  signature: string;
  fileSignatures: Map<string, string>;
  fileHashes?: Map<string, string>;
  graph: ReviewGraph;
  gitStamp?: { headCommit: string; worktreeRoot: string };
  elementCount: number;
  generation: number;
  attemptId: number;
  graphMetadata: ReviewGraphBuildMetadata;
  persistenceMetadata: ReviewGraphPersistenceMetadata;
}
export const _pendingPersist = new Map<string, PendingPersist>();
export const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const _persistGenerations = new Map<string, number>();
export const _workerRequests = new Map<number, { key: string; pending: PendingPersist }>();
const _retiredPersistWorkers = new WeakSet<Worker>();

interface PendingCheckpointWrite {
  cwd: string;
  generation: number;
  checkpointPath: string;
  stagePath: string;
  nodes: number;
  edges: number;
  processed: number;
  target: number;
}
export const _checkpointGenerations = new Map<string, number>();
export const _checkpointWorkerRequests = new Map<number, PendingCheckpointWrite>();

export function persistedData(pending: PendingPersist): PersistedGraphData {
  return {
    version: pending.graph.version,
    builtAt: pending.graph.builtAt,
    signature: pending.signature,
    fileSignatures: Array.from(pending.fileSignatures.entries()),
    fileHashes: pending.fileHashes ? Array.from(pending.fileHashes.entries()) : undefined,
    nodes: Array.from(pending.graph.nodes.entries()),
    edges: pending.graph.edges,
    coverage: pending.graph.persistCoverage,
    gitStamp: pending.gitStamp,
  };
}

export function countRetainedSourceFiles(
  graph: ReviewGraph,
  sourceFilePaths?: Iterable<string>,
): number {
  if (sourceFilePaths === undefined) return graph.fileNodes.size;
  const sourceKeys = new Set<string>();
  for (const filePath of sourceFilePaths) {
    sourceKeys.add(normalizeMapKey(filePath));
  }
  let retained = 0;
  for (const filePath of sourceKeys) {
    if (graph.fileNodes.has(filePath)) retained++;
  }
  return retained;
}

export function graphCoverage(
  graph: ReviewGraph,
  cap: number,
  sourceFileCount = graph.persistCoverage?.totalFiles ?? graph.fileNodes.size,
  sourceFilesTruncated = graph.persistCoverage?.sourceFilesTruncated === true,
  sourceFilePaths?: Iterable<string>,
): ReviewGraphPersistCoverage {
  const inherited = graph.persistCoverage;
  return {
    partial: inherited?.partial === true || sourceFilesTruncated,
    cap,
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    persistedNodes: graph.nodes.size,
    persistedEdges: graph.edges.length,
    totalFiles: sourceFileCount,
    persistedFiles: countRetainedSourceFiles(graph, sourceFilePaths),
    ...includePropertiesWhen(sourceFilesTruncated, () => ({ sourceFilesTruncated: true })),
    ...includePropertiesWhen(inherited?.inProgress, () => ({ inProgress: true })),
  };
}

export function capGraphForPersist(
  cwd: string,
  graph: ReviewGraph,
  cap: number,
  options: {
    sourceFileCount?: number;
    sourceFilesTruncated?: boolean;
    sourceFilePaths?: Iterable<string>;
  } = {},
): ReviewGraph {
  const totalElements = graph.nodes.size + graph.edges.length;
  const nodeBudget = Math.max(1, Math.floor((cap * graph.nodes.size) / totalElements));
  const reverseDeps = buildReverseDependencyIndexFromGraph({ cwd, graph });
  const rankedFiles = rankFilesByReverseDependencyCentrality(reverseDeps);
  const nodeIdsByFile = new Map<string, string[]>();
  for (const [id, node] of graph.nodes) {
    if (!node.filePath) continue;
    const ids = nodeIdsByFile.get(node.filePath) ?? [];
    ids.push(id);
    nodeIdsByFile.set(node.filePath, ids);
  }

  const keptIds = new Set<string>();
  for (const filePath of rankedFiles) {
    const ids = nodeIdsByFile.get(filePath) ?? [];
    if (ids.length === 0) continue;
    const effectiveNodeBudget =
      keptIds.size === 0 ? Math.max(nodeBudget, Math.min(cap, ids.length)) : nodeBudget;
    if (keptIds.size + ids.length > effectiveNodeBudget) continue;
    for (const id of ids) keptIds.add(id);
  }
  const nodes = new Map([...graph.nodes].filter(([id]) => keptIds.has(id)));
  const edgeBudget = Math.max(0, cap - nodes.size);
  const edges = graph.edges
    .filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to))
    .slice(0, edgeBudget);
  const coverage: ReviewGraphPersistCoverage = {
    partial: true,
    cap,
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    persistedNodes: nodes.size,
    persistedEdges: edges.length,
    totalFiles:
      options.sourceFileCount ?? graph.persistCoverage?.totalFiles ?? graph.fileNodes.size,
    persistedFiles: 0,
    ...includePropertiesWhen(
      options.sourceFilesTruncated || graph.persistCoverage?.sourceFilesTruncated,
      () => ({ sourceFilesTruncated: true as const }),
    ),
    ...includePropertiesWhen(graph.persistCoverage?.inProgress, () => ({
      inProgress: true as const,
    })),
  };
  const capped: ReviewGraph = {
    ...graph,
    nodes,
    edges,
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(),
    persistCoverage: undefined,
  };
  rebuildIndexes(capped);
  coverage.persistedFiles = countRetainedSourceFiles(capped, options.sourceFilePaths);
  capped.persistCoverage = coverage;
  return capped;
}

export function persistObservability(
  pending: PendingPersist,
  patch: Partial<ReviewGraphPersistenceMetadata>,
) {
  return {
    graph: pending.graphMetadata,
    persistence: { ...pending.persistenceMetadata, ...patch },
  };
}

function logPersistSuccess(
  key: string,
  pending: PendingPersist,
  stats: {
    rawBytes: number;
    gzBytes: number;
    serializeMs: number;
    writeMs: number;
    offloaded: boolean;
  },
  workerState: {
    started: boolean;
    completed: boolean;
    fallback?: boolean;
  } = { started: false, completed: false },
): void {
  logLatency({
    type: "phase",
    phase: "review_graph_persist",
    filePath: pending.cachePath,
    durationMs: stats.serializeMs + stats.writeMs,
    metadata: { elements: pending.elementCount, ...stats },
  });
  logReviewGraph({
    cwd: key,
    phase: "persist_succeeded",
    elements: pending.elementCount,
    ...stats,
    observability: persistObservability(pending, {
      status: "succeeded",
      workerStarted: workerState.started,
      workerCompleted: workerState.completed,
      ...includePropertiesWhen(workerState.fallback, () => ({ workerFallback: true })),
    }),
  });
}

export function writePendingOnMainThread(
  key: string,
  pending: PendingPersist,
  reason?: string,
  workerState: {
    started: boolean;
    completed: boolean;
    fallbackReason?: string;
  } = { started: false, completed: false },
): void {
  const serializeStarted = performance.now();
  try {
    const json = JSON.stringify(persistedData(pending));
    const serializeMs = performance.now() - serializeStarted;
    const rawBytes = Buffer.byteLength(json);
    const writeStarted = performance.now();
    const gzip = gzipSync(json);
    fs.mkdirSync(pending.cacheDir, { recursive: true });
    writeFileAtomic(pending.cachePath, gzip, { bestEffort: false });
    fs.rmSync(path.join(pending.cacheDir, LEGACY_GRAPH_CACHE_FILENAME), {
      force: true,
    });
    logPersistSuccess(
      key,
      pending,
      {
        rawBytes,
        gzBytes: gzip.byteLength,
        serializeMs,
        writeMs: performance.now() - writeStarted,
        offloaded: false,
      },
      {
        started: workerState.started,
        completed: workerState.completed,
        fallback: Boolean(reason),
      },
    );
    if (reason) {
      reviewGraphBuilderState._lastWorkerFallbackReasonForTests = reason;
      logReviewGraph({
        cwd: key,
        phase: "worker_fallback",
        reason: "worker_fallback",
        error: reason,
        offloaded: false,
        observability: persistObservability(pending, {
          status: "fallback",
          workerStarted: workerState.started,
          workerCompleted: workerState.completed,
          workerFallback: true,
          reason: workerState.fallbackReason ?? "worker_fallback",
        }),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPersistFailure(key, "cache_write_failed", message, pending, workerState);
  }
}

function handleWorkerResult(result: ReviewGraphPersistWorkerResult): void {
  const checkpoint = _checkpointWorkerRequests.get(result.id);
  if (checkpoint) {
    handleCheckpointWorkerResult(checkpoint, result);
    return;
  }
  const request = _workerRequests.get(result.id);
  if (!request) {
    fs.rm(result.stagePath, { force: true }, () => {});
    return;
  }
  _workerRequests.delete(result.id);
  const { key, pending } = request;
  const currentGeneration = _persistGenerations.get(key);
  if (currentGeneration !== result.generation) {
    try {
      fs.rmSync(result.stagePath, { force: true });
    } catch (reapErr) {
      logReviewGraph({
        cwd: key,
        phase: "persist_failed",
        reason: `superseded-stage reap failed: ${String(reapErr)}`,
      });
    }
    logReviewGraph({
      cwd: key,
      phase: "persist_skipped",
      reason: "superseded",
      observability: persistObservability(pending, {
        status: "superseded",
        supersededByGeneration: currentGeneration,
        reason: "newer_generation_scheduled",
        workerStarted: true,
        workerCompleted: true,
      }),
    });
    return;
  }
  if (
    result.error ||
    result.rawBytes === undefined ||
    result.gzBytes === undefined ||
    result.serializeMs === undefined ||
    result.writeMs === undefined
  ) {
    fs.rm(result.stagePath, { force: true }, () => {});
    writePendingOnMainThread(key, pending, result.error ?? "invalid worker result", {
      started: true,
      completed: true,
      fallbackReason: result.error ? "worker_error" : "invalid_worker_result",
    });
    return;
  }
  try {
    fs.renameSync(result.stagePath, pending.cachePath);
    fs.rmSync(path.join(pending.cacheDir, LEGACY_GRAPH_CACHE_FILENAME), {
      force: true,
    });
    logPersistSuccess(
      key,
      pending,
      {
        rawBytes: result.rawBytes,
        gzBytes: result.gzBytes,
        serializeMs: result.serializeMs,
        writeMs: result.writeMs,
        offloaded: true,
      },
      { started: true, completed: true },
    );
  } catch (err) {
    fs.rm(result.stagePath, { force: true }, () => {});
    writePendingOnMainThread(key, pending, err instanceof Error ? err.message : String(err), {
      started: true,
      completed: true,
      fallbackReason: "promotion_failed",
    });
  }
}

function handleCheckpointWorkerResult(
  cp: PendingCheckpointWrite,
  result: ReviewGraphPersistWorkerResult,
): void {
  _checkpointWorkerRequests.delete(result.id);
  if (result.error || result.gzBytes === undefined) {
    logReviewGraph({
      cwd: cp.cwd,
      phase: "checkpoint_write_failed",
      reason: "worker_error",
      error: result.error ?? "worker returned no gz metrics",
    });
    fs.rm(result.stagePath, { force: true }, () => {});
    return;
  }
  if (_checkpointGenerations.get(cp.cwd) !== cp.generation) {
    fs.rm(result.stagePath, { force: true }, () => {});
    return;
  }
  try {
    fs.renameSync(result.stagePath, cp.checkpointPath);
    logReviewGraph({
      cwd: cp.cwd,
      phase: "checkpoint_written",
      nodes: cp.nodes,
      edges: cp.edges,
      processed: cp.processed,
      target: cp.target,
      offloaded: true,
    });
  } catch (err) {
    logReviewGraph({
      cwd: cp.cwd,
      phase: "checkpoint_write_failed",
      reason: "promote_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    fs.rm(result.stagePath, { force: true }, () => {});
  }
}

function handleWorkerDeath(reason: string): void {
  reviewGraphBuilderState._persistWorkerUnavailableReason = reason;
  reviewGraphBuilderState._persistWorker = undefined;
  reviewGraphBuilderState._workerDisabled = true;
  const requests = [..._workerRequests.values()];
  _workerRequests.clear();
  for (const { key, pending } of requests) {
    if (_persistGenerations.get(key) !== pending.generation) {
      logReviewGraph({
        cwd: key,
        phase: "persist_skipped",
        reason: "superseded",
        observability: persistObservability(pending, {
          status: "superseded",
          supersededByGeneration: _persistGenerations.get(key),
          reason: "worker_death_after_newer_generation",
          workerStarted: true,
          workerCompleted: false,
        }),
      });
      continue;
    }
    writePendingOnMainThread(key, pending, reason, {
      started: true,
      completed: false,
      fallbackReason: "worker_death",
    });
  }
  const checkpoints = [..._checkpointWorkerRequests.values()];
  _checkpointWorkerRequests.clear();
  for (const cp of checkpoints) {
    logReviewGraph({
      cwd: cp.cwd,
      phase: "checkpoint_write_failed",
      reason: "worker_death",
      error: reason,
    });
    fs.rm(cp.stagePath, { force: true }, () => {});
  }
}

function resolvePersistWorkerPath(): string | undefined {
  const candidates = [
    new URL("../persist-worker.js", import.meta.url),
    new URL("../clients/review-graph/persist-worker.js", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const resolved = fileURLToPath(url);
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }
  return undefined;
}

export function getPersistWorker(): Worker | undefined {
  if (reviewGraphBuilderState._workerDisabled) return undefined;
  if (reviewGraphBuilderState._persistWorker) return reviewGraphBuilderState._persistWorker;
  try {
    const workerPath = resolvePersistWorkerPath();
    if (workerPath === undefined) {
      handleWorkerDeath("persist worker script not found in any layout");
      return undefined;
    }
    const worker = new Worker(workerPath);
    worker.on("message", (result: ReviewGraphPersistWorkerResult) => {
      handleWorkerResult(result);
      settleReviewGraphPersistQueue();
    });
    worker.on("error", (err: Error) => {
      if (_retiredPersistWorkers.has(worker)) return;
      handleWorkerDeath(err.message);
      settleReviewGraphPersistQueue();
    });
    worker.on("exit", (code) => {
      if (reviewGraphBuilderState._persistWorker !== worker) return;
      const hasPendingRequests = _workerRequests.size > 0 || _checkpointWorkerRequests.size > 0;
      if (code !== 0 || hasPendingRequests) {
        handleWorkerDeath(
          code !== 0
            ? `persist worker exited with code ${code}`
            : "persist worker exited with pending requests",
        );
      } else {
        reviewGraphBuilderState._persistWorker = undefined;
      }
      settleReviewGraphPersistQueue();
    });
    worker.unref();
    reviewGraphBuilderState._persistWorker = worker;
    return worker;
  } catch (err) {
    handleWorkerDeath(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export function writePending(key: string): void {
  const pending = _pendingPersist.get(key);
  if (!pending) return;
  _pendingPersist.delete(key);
  const timer = _persistTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _persistTimers.delete(key);
  }
  const worker = getPersistWorker();
  if (!worker) {
    const unavailableReason =
      reviewGraphBuilderState._persistWorkerUnavailableReason ?? "persist worker unavailable";
    writePendingOnMainThread(key, pending, unavailableReason, {
      started: false,
      completed: false,
      fallbackReason: unavailableReason,
    });
    settleReviewGraphPersistQueue();
    return;
  }
  const id = ++reviewGraphBuilderState._persistWorkerRequestId;
  const stagePath = `${pending.cachePath}.stage-${process.pid}-${pending.generation}`;
  const request: ReviewGraphPersistWorkerRequest = {
    id,
    cwd: key,
    generation: pending.generation,
    stagePath,
    data: persistedData(pending),
    elements: pending.elementCount,
    testDelayMs:
      process.env.NODE_ENV === "test"
        ? Number(process.env.CHOCO_PI_LSP_TEST_PERSIST_WORKER_DELAY_MS) || undefined
        : undefined,
  };
  _workerRequests.set(id, { key, pending });
  worker.postMessage(request);
}

let _persistExitHookRegistered = false;
function flushPendingReviewGraphPersistsAtExit(): void {
  if (_persistExitHookRegistered) {
    _persistExitHookRegistered = false;
    process.off("exit", flushPendingReviewGraphPersistsAtExit);
  }
  const keys = new Set([
    ..._pendingPersist.keys(),
    ...[..._workerRequests.values()].map((request) => request.key),
  ]);
  for (const key of keys) {
    flushReviewGraphPersist(key, "exit_hook");
  }
  flushReviewGraphLogSync();
  void reviewGraphBuilderState._persistWorker?.terminate();
}

export function flushReviewGraphPersistsForExitForTests(): void {
  flushPendingReviewGraphPersistsAtExit();
}

export function ensurePersistExitHook(): void {
  if (_persistExitHookRegistered) return;
  _persistExitHookRegistered = true;
  process.once("exit", flushPendingReviewGraphPersistsAtExit);
}

export function settleReviewGraphPersistQueue(): void {
  if (_pendingPersist.size > 0 || _workerRequests.size > 0 || _checkpointWorkerRequests.size > 0) {
    return;
  }
  if (_persistExitHookRegistered) {
    _persistExitHookRegistered = false;
    process.off("exit", flushPendingReviewGraphPersistsAtExit);
  }
  const worker = reviewGraphBuilderState._persistWorker;
  if (!worker) return;
  reviewGraphBuilderState._persistWorker = undefined;
  _retiredPersistWorkers.add(worker);
  void worker.terminate();
}

export function getReviewGraphPersistLifetimeForTests() {
  return {
    workerAlive: reviewGraphBuilderState._persistWorker !== undefined,
    exitHookRegistered: _persistExitHookRegistered,
    pendingPersists: _pendingPersist.size,
    inFlightRequests: _workerRequests.size + _checkpointWorkerRequests.size,
  };
}
