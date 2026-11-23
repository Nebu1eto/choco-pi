/**
 * Full graph build (_doBuildGraph) and the buildOrUpdateGraph entry point.
 */
import { includePropertiesWhen } from "../../optional-properties.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../../dispatch/fact-store.ts";
import { collectUntrackedIgnoredIds } from "../../git-tracked-ignore.ts";
import { logLatency } from "../../latency-logger.ts";
import { isAtOrAboveHomeDir, normalizeMapKey } from "../../path-utils.ts";
import { logTreeSitterCacheStats } from "../../tree-sitter-logger.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import { getSharedTreeSitterClient } from "../../tree-sitter-shared.ts";
import type { ReviewGraph } from "../types.ts";
import { clearReviewGraphFileIr } from "../shared-extraction-ir.ts";
import { reviewGraphBuilderState } from "./state.ts";
import {
  _reviewGraphBuildGateForTests,
  getGraphBuildInfoForGraph,
  graphLogMetadata,
  logCwdWorktreeMismatchOnce,
  seqFastpathEnabled,
  setGraphBuildInfo,
  updateGraphBuildInfo,
  type GraphSeqHint,
  type SeqFastpathFallback,
} from "./build-info.ts";
import {
  buildReviewGraphCheckpointData,
  deleteReviewGraphCheckpoint,
  graphCheckpointEveryFiles,
  graphCheckpointMinIntervalMs,
  tryResumeFromCheckpoint,
  writeReviewGraphCheckpoint,
  writeReviewGraphCheckpointSync,
} from "./checkpoint.ts";
import { addFileToGraph, resolveDeferredSymbolEdges } from "./file-update.ts";
import {
  cloneGraph,
  createEmptyGraph,
  rebuildIndexes,
  sourceSignatureFromMap,
  sourceSignatureMapAsync,
} from "./graph-state.ts";
import { tryIncrementalFromCache, trySeqFastpath, verifiedCacheFields } from "./incremental.ts";
import { upsertChangedSymbols } from "./js-ts-file.ts";
import { loadPersistedGraph } from "./persist-load.ts";
import { graphCoverage, graphPersistMaxElements } from "./persist-worker-client.ts";
import { persistGraph } from "./persist.ts";
import {
  clearReviewGraphSizeSkip,
  getGraphSourceFiles,
  isReviewGraphSizeNearMiss,
  recordBuildAttempt,
  recordReviewGraphSizeSkip,
} from "./source-files.ts";
import {
  REVIEW_GRAPH_VERSION,
  _buildCache,
  _workspaceGraphCache,
  setWorkspaceGraph,
  touchWorkspaceGraph,
  workspaceCacheEpoch,
} from "./workspace-cache.ts";

async function _doBuildGraph(
  cwd: string,
  changedFiles: string[],
  facts: FactStore,
  seqHint?: GraphSeqHint,
  buildId?: number,
): Promise<ReviewGraph> {
  const normalizedCwd = normalizeMapKey(cwd);
  const cacheEpoch = workspaceCacheEpoch(normalizedCwd);
  // `await undefined` still yields a microtask, which reorders overlapping
  // builds in production where no test gate is installed — only await a gate
  // that exists.
  if (_reviewGraphBuildGateForTests) await _reviewGraphBuildGateForTests();
  const normalizedChanged = changedFiles.map((file) => normalizeMapKey(file));
  const normalizedChangedSet = new Set(normalizedChanged);
  logCwdWorktreeMismatchOnce(cwd);

  // #622: reject a cwd that IS (or is an ancestor of) $HOME before any walk is
  // attempted. The 3 real per-edit callers (dispatch/integration.ts's
  // computeCascadeForFile, mcp/analyze.ts, tree-sitter.ts's
  // runBlastRadiusInBackground) pass their session/pipeline cwd straight
  // through on the assumption it's already a real project root — true when Pi
  // is launched inside a repo, false when Pi is launched from $HOME itself and
  // then edits an absolute-path file in some other repo. In that case
  // getGraphSourceFiles's maxGraphFiles cap (#250) only trips AFTER a full
  // unfiltered $HOME walk (206k+ files, ~500s of blocked event loop — #622),
  // because the cap counts post-filter *kept* files, not directory entries
  // visited. Bail before the walk starts instead, mirroring the same
  // isAtOrAboveHomeDir ceiling already used by startup-scan.ts,
  // dead-code-client.ts, knip-client.ts, and runtime-session.ts's
  // resolveSnapshotRoot for the identical class of escape (#253/#250). Unlike
  // those (which resolve a root by walking UP from an arbitrary start dir),
  // this checks cwd directly: buildOrUpdateGraph's contract is that cwd
  // already IS the project root, so there is no safe substitute root to fall
  // back to here — skip graph construction entirely (matching #622's own
  // stated expected behavior) rather than walking a directory the caller never
  // asked for.
  if (isAtOrAboveHomeDir(path.resolve(cwd))) {
    const graph = createEmptyGraph();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    setGraphBuildInfo(graph, {
      reused: false,
      mode: "skipped",
      skipReason: "unsafe_root",
      // #459: never persisted/reused, same as the too_many_files skip below —
      // treat as changed so dependents never trust stale derived state.
      graphChanged: true,
    });
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }

  // #451: capture the seq BEFORE any await — every builtAtProjectSeq stamp in
  // this build uses this value, so a bump that interleaves mid-build has
  // seq > stamp and is re-diffed next build (redundant re-extract, never a miss).
  const seqAtBuildStart = seqHint?.projectSeq();

  // #694: kick off the untracked-AND-ignored id fetch concurrently with the
  // walk below — it's independent of both. Memoized/time-bounded internally
  // (git-tracked-ignore.ts) so a hot per-edit rebuild loop shares one `git`
  // spawn instead of paying for one per file/per edit.
  const ignoredIdsPromise = collectUntrackedIgnoredIds(cwd);

  // #451: seq fast path — skip the O(project) walk+stat sweep when the
  // RuntimeCoordinator can tell us exactly which files changed. Any doubt inside
  // falls through to the full sweep below (which refreshes the verify clock). The
  // fallback reason is stamped onto whichever build-info the sweep records, so
  // cascade.log can watch the fast-path hit/miss rate.
  let seqFastpathFallback: SeqFastpathFallback | undefined;
  if (seqHint && seqAtBuildStart !== undefined && seqFastpathEnabled()) {
    const fast = await trySeqFastpath(
      cwd,
      buildId,
      normalizedCwd,
      normalizedChanged,
      facts,
      seqHint,
      seqAtBuildStart,
      await ignoredIdsPromise,
      cacheEpoch,
    );
    if ("graph" in fast) return fast.graph;
    seqFastpathFallback = fast.fallback;
  }

  const sourceCollection = await getGraphSourceFiles(cwd);
  const filesToBuild = sourceCollection.files;
  const sourceFileCount = sourceCollection.sourceFileCount;
  const sourceFilesTruncated = sourceCollection.entryBudgetExceeded;
  const ignoredIds = await ignoredIdsPromise;
  const maxGraphFiles = sourceCollection.maxFileCount;
  if (filesToBuild.length > maxGraphFiles) {
    const graph = createEmptyGraph();
    graph.version = REVIEW_GRAPH_VERSION;
    graph.builtAt = new Date().toISOString();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    // #782: record a TTL'd verdict so getCachedReviewGraph can stop serving
    // any graph cached/persisted from before the repo crossed the cap, and so
    // project_report can render an honest "disabled at N files" hint instead
    // of "retry shortly" — see getReviewGraphSizeSkipVerdict.
    recordReviewGraphSizeSkip(cwd, sourceFileCount, maxGraphFiles);
    // #775 R3: `_lastGraphBuildInfo`/the size-skip verdict above are only
    // SURFACED by callers that happen to read them (dispatch/integration.ts's
    // cascade path logs a `graph_build` phase; lsp-map.ts, project-report.ts,
    // mcp/analyze.ts, runtime-session.ts, and tree-sitter.ts's runner do not).
    // Log unconditionally here, at the one place every caller funnels through,
    // so a monorepo crossing the cap is never a SILENT truncation — no caller
    // wiring required (AGENTS.md: no silent caps).
    logLatency({
      type: "phase",
      phase: "review_graph_size_skip",
      filePath: cwd,
      durationMs: 0,
      metadata: {
        cwd,
        sourceFileCount,
        maxFileCount: maxGraphFiles,
        sourceFileCountLabel: `more than ${maxGraphFiles} files`,
        sourceFileCountTruncated: true,
      },
    });
    if (isReviewGraphSizeNearMiss(sourceFileCount, maxGraphFiles)) {
      logLatency({
        type: "phase",
        phase: "review_graph_size_near_miss",
        filePath: cwd,
        durationMs: 0,
        metadata: {
          cwd,
          maxFileCount: maxGraphFiles,
          sourceFileCount,
          sourceFileCountLabel: `more than ${maxGraphFiles} files`,
          sourceFileCountTruncated: true,
        },
      });
    }
    setGraphBuildInfo(graph, {
      reused: false,
      mode: "skipped",
      skipReason: "too_many_files",
      sourceFileCount,
      sourceFileCountTruncated: sourceFilesTruncated || filesToBuild.length > maxGraphFiles,
      maxFileCount: maxGraphFiles,
      seqFastpathFallback,
      // #459: a fresh empty graph is returned every call on this path (never
      // persisted/reused) — treat it as changed so dependents never trust stale
      // derived state across skip/unskip transitions. Deliberately NOT stamped
      // with a buildGeneration: absent ⇒ derived caches rebuild every time.
      graphChanged: true,
    });
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }
  // #782: the repo is within the cap on this build attempt — drop any
  // previously recorded size-skip verdict immediately (rather than waiting
  // out the TTL) so a shrink or a raised cap re-enables reads the moment a
  // build actually succeeds.
  if (!sourceFilesTruncated) clearReviewGraphSizeSkip(cwd);
  const fileSignatures = await sourceSignatureMapAsync(filesToBuild);
  const signature = sourceSignatureFromMap(fileSignatures);

  // Tier 1: in-memory cache (hot path — same process, already built this session)
  let memCached = sourceFilesTruncated ? undefined : _workspaceGraphCache.get(normalizedCwd);
  // A partial graph (hydrated from a capped snapshot for read-only orientation
  // via getCachedReviewGraph) can share this cache. It MUST NOT seed a build:
  // serving it silently drops the capped-away nodes/edges, and extending then
  // re-persisting it would launder partial coverage onto disk as a complete
  // snapshot (#936 review). Ignore it here — the disk tier rejects a partial
  // base too, so the build falls through to a full rebuild.
  if (memCached?.graph.persistCoverage?.partial) memCached = undefined;
  if (memCached?.signature === signature) {
    touchWorkspaceGraph(normalizedCwd);
    const graph = cloneGraph(memCached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    // #451: a signature-matching hit means the walk+stat just confirmed nothing
    // changed — a legitimate full verify. Refresh the clock/counter and seq so a
    // later fast path diffs from here and the periodic re-verify resets.
    Object.assign(memCached, verifiedCacheFields(seqAtBuildStart));
    // #459: content unchanged ⇒ carry the entry's generation forward.
    const generation = (memCached.buildGeneration ??=
      ++reviewGraphBuilderState._graphGenerationCounter);
    setGraphBuildInfo(graph, {
      reused: true,
      mode: "cached",
      seqFastpathFallback,
      graphChanged: false,
    });
    graph.buildGeneration = generation;
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }
  if (memCached) {
    const incremental = await tryIncrementalFromCache(memCached, {
      cwd,
      buildId,
      seqHint: seqHint !== undefined,
      mode: "incremental",
      normalizedCwd,
      normalizedChanged,
      fileSignatures,
      signature,
      facts,
      seqAtBuildStart,
      ignoredIds,
      cacheEpoch,
    });
    if (incremental) {
      updateGraphBuildInfo(incremental, { seqFastpathFallback });
      return incremental;
    }
  }

  // Tier 2: disk cache (cold start — files unchanged since last persist).
  // #300: deliberately does NOT verify the git stamp — the signature match /
  // #202 content-hash confirm below already content-verify the load, and
  // dropping on every HEAD move would force a full whole-repo rebuild after
  // each plain `git commit` (HEAD moves, files unchanged).
  const diskCached = sourceFilesTruncated ? null : loadPersistedGraph(cwd);
  if (diskCached?.signature === signature) {
    const graph = cloneGraph(diskCached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    // #459: disk-hydrated content is new to THIS process — fresh stamp (a prior
    // process's derived caches don't exist here; in-process derived caches from
    // before a workspace-cache clear must not match it).
    const generation = ++reviewGraphBuilderState._graphGenerationCounter;
    setWorkspaceGraph(
      normalizedCwd,
      {
        signature,
        fileSignatures: new Map(fileSignatures),
        fileHashes: diskCached.fileHashes,
        graph: cloneGraph(diskCached.graph),
        buildGeneration: generation,
        ...verifiedCacheFields(seqAtBuildStart),
      },
      cacheEpoch,
    );
    setGraphBuildInfo(graph, {
      reused: true,
      mode: "cached",
      seqFastpathFallback,
      graphChanged: false,
    });
    graph.buildGeneration = generation;
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }
  if (diskCached) {
    // #202: same incremental path as the in-memory tier. This is where it pays
    // off most — on cold start, git/checkout mtime drift or a burst of new
    // files since the last persist would otherwise force a full whole-repo
    // rebuild; the delta + content-hash confirm reuses the persisted graph.
    const incremental = await tryIncrementalFromCache(
      {
        signature: diskCached.signature,
        fileSignatures: diskCached.fileSignatures,
        fileHashes: diskCached.fileHashes,
        graph: diskCached.graph,
      },
      {
        cwd,
        buildId,
        seqHint: seqHint !== undefined,
        mode: "incremental",
        normalizedCwd,
        normalizedChanged,
        fileSignatures,
        signature,
        facts,
        seqAtBuildStart,
        ignoredIds,
      },
    );
    if (incremental) {
      updateGraphBuildInfo(incremental, { seqFastpathFallback });
      return incremental;
    }
  }

  // Tier 3: full build — resumed from a prior session's checkpoint when one is
  // present and still current (#936 limit 2), else cold from an empty graph.
  const resumed = sourceFilesTruncated
    ? null
    : await tryResumeFromCheckpoint(cwd, filesToBuild, ignoredIds);
  const graph = resumed?.graph ?? createEmptyGraph();
  const filesToExtract = resumed?.remaining ?? filesToBuild;
  const treeSitterClient = getSharedTreeSitterClient();
  const extractionStartedAt = Date.now();
  // Seeded with the reused files' hashes on resume so the completed snapshot
  // still records a hash for every file (needed by #202 incremental next time).
  const fileHashes = resumed?.fileHashes ?? new Map<string, string>();
  // #936: after each file, snapshot the PRE-resolution graph + processed-file
  // hashes so a killed session can resume. Gated by BOTH a file-count stride
  // and a min wall-time interval so a long build pays only a handful of writes.
  const checkpointEvery = graphCheckpointEveryFiles();
  const checkpointMinIntervalMs = graphCheckpointMinIntervalMs();
  const testStopAfter = Number(process.env.CHOCO_PI_LSP_GRAPH_CHECKPOINT_TEST_STOP_AFTER);
  let filesSinceCheckpoint = 0;
  let lastCheckpointMs = Date.now();
  let extractedCount = 0;
  const extractFiles = async (): Promise<void> => {
    for (const file of filesToExtract) {
      let content: string | null;
      try {
        const bytes = fs.readFileSync(file);
        content = bytes.toString("utf-8");
        fileHashes.set(file, createHash("sha256").update(bytes).digest("hex"));
      } catch {
        content = null;
        fileHashes.set(file, "missing");
      }
      await addFileToGraph(graph, cwd, file, facts, ignoredIds, content);
      if (normalizedChangedSet.has(file)) {
        upsertChangedSymbols(graph, facts, file);
      }
      extractedCount++;
      filesSinceCheckpoint++;
      // Test seam: simulate a session killed mid-build after N files, having
      // just written a checkpoint. Write SYNCHRONOUSLY so the checkpoint is
      // deterministically on disk before the abort throw — the offloaded path
      // would not have promoted yet. The next (un-stopped) build resumes it.
      if (Number.isFinite(testStopAfter) && testStopAfter > 0 && extractedCount >= testStopAfter) {
        writeReviewGraphCheckpointSync(
          cwd,
          buildReviewGraphCheckpointData(cwd, graph, fileHashes, filesToBuild.length, ignoredIds),
          {
            nodes: graph.nodes.size,
            edges: graph.edges.length,
            processed: fileHashes.size,
            target: filesToBuild.length,
          },
        );
        throw new Error("__review_graph_checkpoint_test_abort__");
      }
      const remainingAfter = filesToExtract.length - extractedCount;
      if (
        filesSinceCheckpoint >= checkpointEvery &&
        remainingAfter >= checkpointEvery &&
        Date.now() - lastCheckpointMs >= checkpointMinIntervalMs
      ) {
        writeReviewGraphCheckpoint(cwd, graph, fileHashes, filesToBuild.length, ignoredIds);
        filesSinceCheckpoint = 0;
        lastCheckpointMs = Date.now();
      }
    }
  };
  const extractAndDrainIr = async (): Promise<void> => {
    try {
      await extractFiles();
    } finally {
      // The build consumed every fresh entry (consume-once deletes them);
      // leftovers are stale/test/non-build files nothing will ever read.
      // Clearing here bounds the registry to the scan-to-build window
      // (#955 review — the #886 retention class).
      clearReviewGraphFileIr(cwd);
    }
  };
  if (treeSitterClient) {
    await treeSitterClient.withParseCacheMeasurement(extractAndDrainIr, (stats) => {
      logTreeSitterCacheStats({
        scope: "review_graph_full",
        filePath: cwd,
        fileCount: filesToBuild.length,
        durationMs: Date.now() - extractionStartedAt,
        stats,
      });
    });
  } else {
    await extractAndDrainIr();
  }

  // #936: a changed file that was REUSED from the checkpoint (unchanged content)
  // is never revisited by the extraction loop above, so run its changed-symbol
  // upsert here — matching what a cold build's inline pass would have done.
  if (resumed) {
    for (const file of normalizedChangedSet) {
      if (resumed.fileHashes.has(file)) {
        upsertChangedSymbols(graph, facts, file);
      }
    }
  }

  resolveDeferredSymbolEdges(graph);
  graph.version = REVIEW_GRAPH_VERSION;
  graph.builtAt = new Date().toISOString();
  // #936: the build is now complete over the full target set — drop the
  // in-progress/partial marker a resumed seed carried so the finished graph is
  // never mistaken for (or persisted as) a partial one, and retire the
  // checkpoint now that an authoritative snapshot supersedes it.
  graph.persistCoverage = sourceFilesTruncated
    ? graphCoverage(graph, graphPersistMaxElements(), sourceFileCount, true, filesToBuild)
    : undefined;
  deleteReviewGraphCheckpoint(cwd);
  // #202: the full-build pass hashes the same bytes it supplies to extraction,
  // so change detection does not reread every file after the graph is built.
  // #459: full rebuild ⇒ new generation.
  const generation = ++reviewGraphBuilderState._graphGenerationCounter;
  const graphSnapshot = cloneGraph(graph);
  rebuildIndexes(graphSnapshot);
  // Keep the content generation on the persisted snapshot instance too, so
  // scheduled persistence logs join the same graph identity as build success.
  graphSnapshot.buildGeneration = generation;
  setWorkspaceGraph(
    normalizedCwd,
    {
      signature,
      fileSignatures: new Map(fileSignatures),
      fileHashes,
      graph: graphSnapshot,
      buildGeneration: generation,
      ...verifiedCacheFields(seqAtBuildStart),
    },
    cacheEpoch,
  );
  const persistReason = persistGraph(cwd, signature, fileSignatures, fileHashes, graphSnapshot, {
    buildId,
    projectSeq: seqAtBuildStart,
    seqHint: seqHint !== undefined,
    mode: "full",
    sourceFileCount,
    sourceFilesTruncated,
  }); // fire-and-forget
  setGraphBuildInfo(graph, {
    reused: false,
    mode: "full",
    sourceFileCount,
    sourceFileCountTruncated: sourceFilesTruncated,
    seqFastpathFallback,
    ...includePropertiesWhen(persistReason, () => ({ persistReason })),
    graphChanged: true,
  });
  graph.buildGeneration = generation;
  facts.setSessionFact("session.reviewGraph", graph);
  return graph;
}

export function buildOrUpdateGraph(
  cwd: string,
  changedFiles: string[],
  facts: FactStore,
  seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
  const cacheKey = `${cwd}|${[...changedFiles].sort((a, b) => a.localeCompare(b)).join(",")}`;
  const cached = _buildCache.get(cacheKey);
  if (cached) return cached;

  const startedAt = Date.now();
  const buildId = ++reviewGraphBuilderState._buildIdCounter;
  recordBuildAttempt(cwd, "running", undefined, buildId);
  const startedProjectSeq = seqHint?.projectSeq();
  logReviewGraph({
    cwd,
    phase: "build_started",
    observability: {
      graph: {
        buildId,
        ...includePropertiesWhen(!(startedProjectSeq === undefined), () => ({
          projectSeq: startedProjectSeq,
        })),
        ...includePropertiesWhen(!(seqHint === undefined), () => ({ seqHint: true })),
        nodes: 0,
        edges: 0,
      },
    },
  });
  const promise = _doBuildGraph(cwd, changedFiles, facts, seqHint, buildId)
    .then((graph) => {
      const buildInfo = getGraphBuildInfoForGraph(graph);
      if (buildInfo.mode === "skipped") {
        const reason = buildInfo.skipReason ?? "skipped";
        recordBuildAttempt(cwd, "skipped", reason, buildId);
        logReviewGraph({
          cwd,
          phase: "build_skipped",
          reason,
          durationMs: Date.now() - startedAt,
          observability: {
            graph: graphLogMetadata(graph, {
              buildId,
              projectSeq: startedProjectSeq,
              seqHint: seqHint !== undefined,
              mode: buildInfo.mode,
              sourceFileCount: buildInfo.sourceFileCount,
              sourceFileCountTruncated: buildInfo.sourceFileCountTruncated,
            }),
          },
        });
      } else {
        const reason = buildInfo.persistReason;
        recordBuildAttempt(cwd, "succeeded", reason, buildId);
        logReviewGraph({
          cwd,
          phase: "build_succeeded",
          durationMs: Date.now() - startedAt,
          nodes: graph.nodes.size,
          edges: graph.edges.length,
          ...includePropertiesWhen(reason, () => ({ reason })),
          observability: {
            graph: graphLogMetadata(graph, {
              buildId,
              projectSeq: startedProjectSeq,
              seqHint: seqHint !== undefined,
              mode: buildInfo.mode,
              sourceFileCount: buildInfo.sourceFileCount,
              sourceFileCountTruncated: buildInfo.sourceFileCountTruncated,
            }),
          },
        });
      }
      return graph;
    })
    .catch((err) => {
      _buildCache.delete(cacheKey);
      const reason = err instanceof Error ? err.message : String(err);
      recordBuildAttempt(cwd, "failed", reason, buildId);
      logReviewGraph({
        cwd,
        phase: "build_failed",
        reason,
        durationMs: Date.now() - startedAt,
        error: reason,
        observability: {
          graph: {
            buildId,
            ...includePropertiesWhen(!(seqHint === undefined), () => ({ seqHint: true })),
            nodes: 0,
            edges: 0,
          },
        },
      });
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      throw err as Error;
    });
  _buildCache.set(cacheKey, promise);
  return promise;
}
