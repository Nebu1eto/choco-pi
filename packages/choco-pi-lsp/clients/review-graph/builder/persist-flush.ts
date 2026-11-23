import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { writeFileAtomic } from "../../atomic-write.ts";
import { getProjectDataDir } from "../../file-utils.ts";
import { logLatency } from "../../latency-logger.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import type { ReviewGraphPersistCoverage } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";
import { GRAPH_CACHE_FILENAME, LEGACY_GRAPH_CACHE_FILENAME } from "./persist-load.ts";
import {
  _checkpointGenerations,
  _checkpointWorkerRequests,
  _pendingPersist,
  _persistGenerations,
  _persistTimers,
  _workerRequests,
  persistObservability,
  persistedData,
  settleReviewGraphPersistQueue,
  writePendingOnMainThread,
  type PendingPersist,
} from "./persist-worker-client.ts";
import { recordPersistFailure } from "./source-files.ts";

export function flushReviewGraphPersistsForTests(): void {
  for (const key of Array.from(_pendingPersist.keys())) {
    const pending = _pendingPersist.get(key);
    if (!pending) continue;
    _pendingPersist.delete(key);
    const timer = _persistTimers.get(key);
    if (timer) clearTimeout(timer);
    _persistTimers.delete(key);
    writePendingOnMainThread(key, pending);
  }
  settleReviewGraphPersistQueue();
}

export async function waitForReviewGraphPersistsForTests(): Promise<void> {
  for (
    let attempts = 0;
    attempts < 200 && (_workerRequests.size > 0 || _checkpointWorkerRequests.size > 0);
    attempts++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function terminateReviewGraphPersistWorkerForTests(): Promise<void> {
  const worker = reviewGraphBuilderState._persistWorker;
  if (worker) await worker.terminate();
}

export function resetReviewGraphPersistWorkerForTests(): void {
  reviewGraphBuilderState._workerDisabled = false;
  reviewGraphBuilderState._persistWorkerUnavailableReason = undefined;
  reviewGraphBuilderState._lastWorkerFallbackReasonForTests = undefined;
  _checkpointWorkerRequests.clear();
  _checkpointGenerations.clear();
  reviewGraphBuilderState._checkpointOffloadCountForTests = 0;
  settleReviewGraphPersistQueue();
  reviewGraphBuilderState._persistWorker = undefined;
}

export function getCheckpointOffloadCountForTests(): number {
  return reviewGraphBuilderState._checkpointOffloadCountForTests;
}

export function getReviewGraphWorkerFallbackReasonForTests(): string | undefined {
  return reviewGraphBuilderState._lastWorkerFallbackReasonForTests;
}

export interface ReviewGraphPersistFlushResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  elements?: number;
  reason?: string;
  coverage?: ReviewGraphPersistCoverage;
}

export function reviewGraphCachePath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", GRAPH_CACHE_FILENAME);
}

export function flushReviewGraphPersist(
  cwd: string,
  source: "cli" | "exit_hook" = "cli",
): ReviewGraphPersistFlushResult {
  const result = flushReviewGraphPersistNow(cwd, source);
  settleReviewGraphPersistQueue();
  return result;
}

function flushReviewGraphPersistNow(
  cwd: string,
  source: "cli" | "exit_hook",
): ReviewGraphPersistFlushResult {
  const key = normalizeMapKey(cwd);
  let pending = _pendingPersist.get(key);
  const removedWorkerRequests: PendingPersist[] = [];
  let selectedWorkerRequest: PendingPersist | undefined;
  for (const [id, request] of Array.from(_workerRequests)) {
    if (request.key !== key) continue;
    _workerRequests.delete(id);
    removedWorkerRequests.push(request.pending);
    if (!pending || request.pending.generation > pending.generation) {
      pending = request.pending;
      selectedWorkerRequest = request.pending;
    }
  }
  for (const removed of removedWorkerRequests) {
    if (!pending || removed.generation === pending.generation) continue;
    logReviewGraph({
      cwd: key,
      phase: "persist_skipped",
      reason: "superseded",
      observability: persistObservability(removed, {
        status: "superseded",
        supersededByGeneration: pending.generation,
        reason: "forced_flush_newest_generation",
        workerStarted: true,
        workerCompleted: false,
      }),
    });
  }
  if (!pending) {
    return {
      ok: false,
      reason: "no graph snapshot was queued for persistence",
    };
  }
  _persistGenerations.set(key, Math.max(_persistGenerations.get(key) ?? 0, pending.generation) + 1);
  _pendingPersist.delete(key);
  const timer = _persistTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _persistTimers.delete(key);
  }

  const startedAt = performance.now();
  try {
    const serializeStarted = performance.now();
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
    const writeMs = performance.now() - writeStarted;
    logLatency({
      type: "phase",
      phase: "review_graph_persist",
      filePath: pending.cachePath,
      durationMs: performance.now() - startedAt,
      metadata: {
        elements: pending.elementCount,
        rawBytes,
        gzBytes: gzip.byteLength,
        serializeMs,
        writeMs,
        offloaded: false,
      },
    });
    logReviewGraph({
      cwd,
      phase: "persist_succeeded",
      elements: pending.elementCount,
      rawBytes,
      gzBytes: gzip.byteLength,
      serializeMs,
      writeMs,
      offloaded: false,
      observability: persistObservability(pending, {
        status: "succeeded",
        reason: source === "exit_hook" ? "exit_flush" : "forced_flush",
        workerStarted: selectedWorkerRequest !== undefined,
        workerCompleted: false,
      }),
    });
    return {
      ok: true,
      path: pending.cachePath,
      bytes: gzip.byteLength,
      elements: pending.elementCount,
      coverage: pending.graph.persistCoverage,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    recordPersistFailure(
      cwd,
      source === "exit_hook" ? "exit_flush_failed" : "forced_flush_failed",
      reason,
      pending,
      selectedWorkerRequest
        ? {
            started: true,
            completed: false,
            fallbackReason: "forced_flush_write_failed",
          }
        : undefined,
    );
    return { ok: false, reason };
  }
}
