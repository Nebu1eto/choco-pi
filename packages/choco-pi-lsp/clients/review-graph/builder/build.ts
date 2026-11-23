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
  if (_reviewGraphBuildGateForTests) await _reviewGraphBuildGateForTests();
  const normalizedChanged = changedFiles.map((file) => normalizeMapKey(file));
  const normalizedChangedSet = new Set(normalizedChanged);
  logCwdWorktreeMismatchOnce(cwd);

  if (isAtOrAboveHomeDir(path.resolve(cwd))) {
    const graph = createEmptyGraph();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    setGraphBuildInfo(graph, {
      reused: false,
      mode: "skipped",
      skipReason: "unsafe_root",
      graphChanged: true,
    });
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }

  const seqAtBuildStart = seqHint?.projectSeq();

  const ignoredIdsPromise = collectUntrackedIgnoredIds(cwd);

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
    recordReviewGraphSizeSkip(cwd, sourceFileCount, maxGraphFiles);
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
      graphChanged: true,
    });
    facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }
  if (!sourceFilesTruncated) clearReviewGraphSizeSkip(cwd);
  const fileSignatures = await sourceSignatureMapAsync(filesToBuild);
  const signature = sourceSignatureFromMap(fileSignatures);

  let memCached = sourceFilesTruncated ? undefined : _workspaceGraphCache.get(normalizedCwd);
  if (memCached?.graph.persistCoverage?.partial) memCached = undefined;
  if (memCached?.signature === signature) {
    touchWorkspaceGraph(normalizedCwd);
    const graph = cloneGraph(memCached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    Object.assign(memCached, verifiedCacheFields(seqAtBuildStart));
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

  const diskCached = sourceFilesTruncated ? null : loadPersistedGraph(cwd);
  if (diskCached?.signature === signature) {
    const graph = cloneGraph(diskCached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
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

  const resumed = sourceFilesTruncated
    ? null
    : await tryResumeFromCheckpoint(cwd, filesToBuild, ignoredIds);
  const graph = resumed?.graph ?? createEmptyGraph();
  const filesToExtract = resumed?.remaining ?? filesToBuild;
  const treeSitterClient = getSharedTreeSitterClient();
  const extractionStartedAt = Date.now();
  const fileHashes = resumed?.fileHashes ?? new Map<string, string>();
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
  graph.persistCoverage = sourceFilesTruncated
    ? graphCoverage(graph, graphPersistMaxElements(), sourceFileCount, true, filesToBuild)
    : undefined;
  deleteReviewGraphCheckpoint(cwd);
  const generation = ++reviewGraphBuilderState._graphGenerationCounter;
  const graphSnapshot = cloneGraph(graph);
  rebuildIndexes(graphSnapshot);
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
  });
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
