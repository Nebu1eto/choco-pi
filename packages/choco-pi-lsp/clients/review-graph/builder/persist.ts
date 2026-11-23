/**
 * Stale stage-file sweep and the persistGraph entry point.
 */
import { includePropertiesWhen } from "../../optional-properties.ts";
import { isRuntimeFunction } from "../../../tools/runtime-values.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../../file-utils.ts";
import { realIsPidAlive } from "../../instance-reaper.ts";
import { logLatency } from "../../latency-logger.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import {
  logReviewGraph,
  type ReviewGraphBuildMode,
  type ReviewGraphPersistenceMetadata,
} from "../../review-graph-logger.ts";
import { resolveGitIdentity } from "../git-identity.ts";
import type { ReviewGraph } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";
import { graphLogMetadata } from "./build-info.ts";
import { GRAPH_CACHE_FILENAME } from "./persist-load.ts";
import {
  _pendingPersist,
  _persistGenerations,
  _persistTimers,
  capGraphForPersist,
  ensurePersistExitHook,
  graphCoverage,
  graphPersistDebounceMs,
  graphPersistMaxElements,
  persistObservability,
  writePending,
  type PendingPersist,
} from "./persist-worker-client.ts";

// #950 review F3: a process that dies between a worker's staged write and its
// promotion leaves review-graph.json.gz.stage-<pid>-<gen> (and the worker's
// <stage>.tmp-<pid>) behind forever — the exit hook can't run
// handleWorkerResult's rm. Sweep leftovers from PRIOR processes once per cache
// dir.
//
// #1206: `cacheDir` is the SHARED project cache dir (getProjectDataDir/cache)
// that every durable store stages into via writeFileAtomic's generic
// `<target>.tmp-<pid>`. The old predicate also matched that shape, so this
// sweep deleted OTHER modules' in-flight staging files in the window between
// their write and their rename — turning their rename into ENOENT (propagated
// out of markDisposition for bestEffort:false stores) or silently dropping the
// update. The sweep is therefore scoped to artifacts the review graph itself
// produces, all of which are `<review-graph.*>.stage-<pid>-<gen>`:
//   review-graph.json.gz.stage-<pid>-<gen>              (persistGraph, L1861)
//   review-graph.checkpoint.json.gz.stage-<pid>-<gen>   (checkpoint, L2259)
//   ...plus either's worker tmp `<stage>.tmp-<pid>`, which still carries both
//   the `review-graph.` prefix and the `.stage-` marker.
// (LEGACY_GRAPH_CACHE_FILENAME, `review-graph.json`, is never staged — it is
// only ever `rmSync`'d as a one-time migration cleanup — so it is not a
// producer here despite matching the prefix.)
// The bare `.tmp-<pid>` shape is never matched, which also makes this sweep
// independent of any change to atomic-write's staging name (#1205). Dropping
// that shape means the review-graph sweep is no longer the incidental GC for
// other stores' orphaned atomic-write temps; the generic `.tmp-*` namespace is
// now swept at session_start by instance-reaper (#1228), not by this graph
// artifact-specific pass.
//
// Liveness: an entry whose embedded stage pid is still alive belongs to a
// concurrent healthy owner (or to us) and is skipped, reusing the reaper's
// conservative `realIsPidAlive` (ESRCH-only-means-dead) rather than inventing
// a second liveness probe. A recycled pid can therefore leave one stale stage
// file behind instead of destroying a live one — deliberately the safe
// direction; a later process whose pid table has moved on sweeps it.
const _sweptStageDirs = new Set<string>();
const REVIEW_GRAPH_ARTIFACT_PREFIX = "review-graph.";
const STAGE_PID_PATTERN = /\.stage-(\d+)-/;

/** True only for a review-graph stage artifact left behind by a dead process. */
function isStaleReviewGraphStageFile(entry: string): boolean {
  if (!entry.startsWith(REVIEW_GRAPH_ARTIFACT_PREFIX)) return false;
  const match = STAGE_PID_PATTERN.exec(entry);
  if (!match) return false;
  const pid = Number(match[1]);
  if (pid === process.pid) return false; // our own live stage file
  return !realIsPidAlive(pid);
}

export function sweepStaleStageFiles(cacheDir: string): void {
  if (_sweptStageDirs.has(cacheDir)) return;
  _sweptStageDirs.add(cacheDir);
  fs.readdir(cacheDir, (err, entries) => {
    if (err) return;
    for (const entry of entries) {
      if (!isStaleReviewGraphStageFile(entry)) continue;
      fs.rm(path.join(cacheDir, entry), { force: true }, () => {});
    }
  });
}

/** Test seam: the sweep runs at most once per cache dir per process. */
export function _resetReviewGraphStageSweepForTests(): void {
  _sweptStageDirs.clear();
}

export function persistGraph(
  cwd: string,
  signature: string,
  fileSignatures: Map<string, string>,
  fileHashes: Map<string, string> | undefined,
  graph: ReviewGraph,
  options: {
    buildId?: number;
    projectSeq?: number;
    seqHint?: boolean;
    mode?: ReviewGraphBuildMode;
    sourceFileCount?: number;
    sourceFilesTruncated?: boolean;
    sourceFilePaths?: Iterable<string>;
  } = {},
): string | undefined {
  const totalElementCount = graph.nodes.size + graph.edges.length;
  const cap = graphPersistMaxElements();
  const sourceFileCount = options.sourceFileCount ?? fileSignatures.size;
  const sourceFilePaths = options.sourceFilePaths ?? fileSignatures.keys();
  const persistedGraph =
    totalElementCount > cap
      ? capGraphForPersist(cwd, graph, cap, {
          sourceFileCount,
          sourceFilesTruncated: options.sourceFilesTruncated,
          sourceFilePaths,
        })
      : {
          ...graph,
          persistCoverage: graphCoverage(
            graph,
            cap,
            sourceFileCount,
            options.sourceFilesTruncated,
            sourceFilePaths,
          ),
        };
  const elementCount = persistedGraph.nodes.size + persistedGraph.edges.length;
  const sourceWalkPartial = persistedGraph.persistCoverage?.sourceFilesTruncated === true;
  let persistReason: string | undefined;
  if (totalElementCount > cap) {
    const coverage = persistedGraph.persistCoverage;
    if (!coverage) return;
    logLatency({
      type: "phase",
      phase: "review_graph_persist",
      filePath: cwd,
      durationMs: 0,
      metadata: {
        partial: true,
        totalElements: totalElementCount,
        persistedElements: elementCount,
        cap,
      },
    });
    persistReason =
      `persisted partial review graph (${elementCount}/${totalElementCount} elements; ` +
      `${coverage.persistedNodes}/${coverage.totalNodes} nodes, ` +
      `${coverage.persistedEdges}/${coverage.totalEdges} edges; ${cap} cap)`;
  } else if (sourceWalkPartial) {
    persistReason = "persisted partial review graph (source walk entry budget)";
  }
  const cacheDir = path.join(getProjectDataDir(cwd), "cache");
  const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
  sweepStaleStageFiles(cacheDir);
  // #300: resolve the git stamp fresh at persist time (HEAD changes on
  // commit/checkout, so it isn't cached like the gitdir location — but these
  // are plain fs reads, cheap even called per-persist). undefined for
  // non-git cwds, which serializes as `gitStamp: undefined` → omitted key.
  const gitStamp = resolveGitIdentity(cwd);
  // Retain the immutable snapshot inputs and build their O(graph) serializable
  // arrays only after the quiet window. Replacing a pending entry during an edit
  // burst now avoids both serialization and the pre-serialization full copies.
  const key = normalizeMapKey(cwd);
  const priorGeneration = _persistGenerations.get(key);
  const existingPending = _pendingPersist.get(key);
  const existingTimer = _persistTimers.get(key);
  const generation = (priorGeneration ?? 0) + 1;
  const attemptId = ++reviewGraphBuilderState._persistAttemptId;
  const coalesced = Boolean(existingPending || existingTimer);
  _persistGenerations.set(key, generation);
  const graphMetadata = graphLogMetadata(persistedGraph, {
    ...options,
    sourceFileCount,
    sourceFileCountTruncated: persistedGraph.persistCoverage?.sourceFilesTruncated === true,
  });
  const persistenceMetadata: ReviewGraphPersistenceMetadata = {
    generation,
    attemptId,
    status: "scheduled",
    ...includePropertiesWhen(!(priorGeneration === undefined), () => ({
      supersededGeneration: priorGeneration,
      coalesced,
      reason: coalesced ? "debounced_coalescing" : "in_flight_supersession",
    })),
  };
  const pending: PendingPersist = {
    cacheDir,
    cachePath,
    signature,
    fileSignatures,
    fileHashes,
    graph: persistedGraph,
    gitStamp,
    elementCount,
    generation,
    attemptId,
    graphMetadata,
    persistenceMetadata,
  };
  if (existingPending) {
    logReviewGraph({
      cwd: key,
      phase: "persist_skipped",
      reason: "superseded",
      observability: persistObservability(existingPending, {
        status: "superseded",
        supersededByGeneration: generation,
        reason: "newer_generation_scheduled",
        workerStarted: false,
        workerCompleted: false,
      }),
    });
  }
  _pendingPersist.set(key, pending);
  if (totalElementCount > cap || sourceWalkPartial) {
    logReviewGraph({
      cwd,
      phase: "persist_partial",
      reason: totalElementCount > cap ? "element_cap_exceeded" : "source_walk_entry_budget",
      elements: totalElementCount,
      persistedElements: elementCount,
      cap,
      observability: {
        graph: graphMetadata,
        persistence: persistenceMetadata,
      },
    });
  }
  logReviewGraph({
    cwd,
    phase: "persist_scheduled",
    elements: elementCount,
    cap,
    observability: {
      graph: graphMetadata,
      persistence: persistenceMetadata,
    },
  });
  ensurePersistExitHook();

  const debounce = graphPersistDebounceMs();
  const existing = _persistTimers.get(key);
  if (existing) clearTimeout(existing);
  if (debounce === 0) {
    writePending(key);
    return persistReason;
  }
  const timer = setTimeout(() => writePending(key), debounce);
  // Don't keep the event loop alive solely for a cache write.
  if (isRuntimeFunction(timer.unref)) timer.unref();
  _persistTimers.set(key, timer);
  return persistReason;
}
