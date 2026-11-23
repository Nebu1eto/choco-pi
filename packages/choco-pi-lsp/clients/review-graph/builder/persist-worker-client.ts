/**
 * Debounced graph persistence: pending-persist queue, persist worker lifecycle, main-thread fallback writes, and the exit flush hook.
 */
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

// --- Throttled, size-guarded graph persistence (circuit-breaker, #260) ---
// The whole graph is serialized as one blob. Doing that synchronously on every
// edit turn — `JSON.stringify` of a multi-MB graph plus number formatting for
// every line/complexity/fanout — spiked the host into a `Fatal ... Zone` OOM,
// especially when it overlapped the next build or the host's tsc. Two guards:
//   1. Coalesce: a burst of edits schedules ONE write after a quiet window,
//      instead of one full serialize per turn (the spike multiplier).
//   2. Ceiling: serialize only a centrality-ranked subgraph above the element
//      cap. Its coverage marker stays honest without risking the full-graph OOM
//      that introduced this guard.
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
// Workers retired because every queue drained; their late error/exit events
// must not disable or reroute a successor worker.
const _retiredPersistWorkers = new WeakSet<Worker>();

// #936/#958 follow-up: the mid-build resume checkpoint offloads its stringify+
// gzip to the SAME shared persist worker (keeping the gzip of a growing graph
// off the event loop during a background build). Tracked in a disjoint id/
// generation space so handleWorkerResult routes a checkpoint promotion — a
// distinct target path — without touching the authoritative-persist path. A
// checkpoint write is best-effort: a lost one only costs a cold rebuild, so a
// worker failure/death just drops it (the prior stride's checkpoint stays on
// disk) rather than falling back like the authoritative persist does.
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

/**
 * Keep whole per-file node groups in reverse-dependency-centrality order, then
 * retain as many induced edges as fit. The node budget mirrors the source
 * graph's node/edge ratio so symbol-dense and edge-dense repositories both
 * retain a useful mix instead of allowing either side to consume the cap.
 */
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
      // The persist SUCCEEDED via fallback — log the degradation under its
      // own phase, not persist_failed (#950 review F7: a success followed
      // by persist_failed read as contradiction in telemetry).
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
    // #1333: recordPersistFailure already emits `phase: "persist_failed"` to
    // review-graph.log with this same message — the console.error was a
    // duplicate RAW write into pi's frame, not a second destination.
  }
}

function handleWorkerResult(result: ReviewGraphPersistWorkerResult): void {
  // Checkpoint offloads share this worker but promote to a different target;
  // route them out before the authoritative-persist path (disjoint id space,
  // so a checkpoint id is never also an authoritative one).
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
    // Removing the request makes completion observable to test/CLI waiters.
    // Reap our completed loser synchronously first so "no requests in flight"
    // also means its stage namespace is clean (#1318). Caught (#1361 review):
    // force suppresses ENOENT but not EBUSY/EPERM (Windows AV/backup can
    // briefly hold the handle) -- a failed reap must never abort this
    // callback, or the WINNING generation's completion is lost with it. The
    // startup sweep reclaims anything a failed unlink leaves behind.
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
  // Best-effort: a failed offload just means no checkpoint for this stride —
  // the prior stride's checkpoint is still on disk and the next stride retries.
  // Still surface it: a SYSTEMIC failure (disk full, perms, worker crash-loop)
  // makes resume silently never work, and `checkpoint_written` just stops.
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
  // Generation gate: a newer checkpoint stride, or build completion / a
  // discarded resume (deleteReviewGraphCheckpoint bumps the generation before
  // removing the file), supersedes this write — discard the stale stage rather
  // than resurrect a checkpoint over a fresher one or a completed build.
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
  // Best-effort checkpoints don't fall back (no retained DTO to pin heap); drop
  // their in-flight requests and clean up any stage files they may have left.
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
  // esbuild's dist bundle does NOT rewrite new URL(...) asset refs, so from
  // the bundled dist/index.js a sibling ./persist-worker.js resolves beside
  // the BUNDLE where nothing exists (#950 review F1 — the worker silently
  // never ran in production). Try the compiled-sibling layout first (source
  // checkout / unbundled dist/clients tree), then the dist-tree path
  // relative to the bundle entry.
  const candidates = [
    new URL("../persist-worker.js", import.meta.url),
    new URL("../clients/review-graph/persist-worker.js", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const resolved = fileURLToPath(url);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* try next layout */
    }
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
        // Clean exit with no pending work (unref'd worker at teardown, or host
        // recycling): drop the stale reference so a later persist respawns
        // instead of posting into a dead worker (#950 review F7).
        reviewGraphBuilderState._persistWorker = undefined;
      }
      settleReviewGraphPersistQueue();
    });
    // #1148: adding a message listener refs the Worker's public MessagePort.
    // Unref only after every listener is installed so it stays background-only.
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

// Flush any pending writes synchronously at process teardown so a debounced
// snapshot isn't lost. Sync writes only (no child spawn — see the teardown
// libuv hazard); best-effort. The synchronous gzip/write is deliberate: an
// `exit` listener cannot await.
//
// Lifetime: Pi may evaluate this module more than once per process (in-process
// sessions with another cwd re-evaluate extensions without a module cache). A
// permanently installed listener pinned every evaluation's module graph, so the
// listener is registered only while this evaluation has debounced or in-flight
// work and is removed once every queue drains. Drained workers are terminated
// for the same reason: a live worker's listeners pin the module.
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
    // Shared with the CLI's forced flush — same persistedData DTO, same
    // atomic writer (#762), distinct failure label per source.
    flushReviewGraphPersist(key, "exit_hook");
  }
  // The review-graph logger's shared process-exit flusher was registered
  // before this hook. Flush again after emitting exit-hook outcomes so a
  // successful forced write cannot leave its lifecycle event buffered.
  flushReviewGraphLogSync();
  void reviewGraphBuilderState._persistWorker?.terminate();
}

/** Test-only seam for the exit-hook ordering/durability contract. */
export function flushReviewGraphPersistsForExitForTests(): void {
  flushPendingReviewGraphPersistsAtExit();
}

export function ensurePersistExitHook(): void {
  if (_persistExitHookRegistered) return;
  _persistExitHookRegistered = true;
  process.once("exit", flushPendingReviewGraphPersistsAtExit);
}

/** Drop the exit hook and the worker once no persist/checkpoint work remains. */
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

/** Test-only: observe this evaluation's persist lifetime resources. */
export function getReviewGraphPersistLifetimeForTests() {
  return {
    workerAlive: reviewGraphBuilderState._persistWorker !== undefined,
    exitHookRegistered: _persistExitHookRegistered,
    pendingPersists: _pendingPersist.size,
    inFlightRequests: _workerRequests.size + _checkpointWorkerRequests.size,
  };
}
