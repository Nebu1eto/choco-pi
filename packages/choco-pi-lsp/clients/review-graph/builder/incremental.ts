import { includePropertiesWhen } from "../../optional-properties.ts";
import * as fs from "node:fs";
import type { FactStore } from "../../dispatch/fact-store.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import type { ReviewGraphBuildMode } from "../../review-graph-logger.ts";
import type { ReviewGraph } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";
import {
  SEQ_FASTPATH_MAX_CHANGES,
  SEQ_FASTPATH_REVERIFY_EVERY,
  SEQ_FASTPATH_REVERIFY_MS,
  setGraphBuildInfo,
  type GraphSeqHint,
  type SeqFastpathFallback,
} from "./build-info.ts";
import {
  _graphImportChanges,
  updateGraphFiles,
  type GraphFileImportChange,
} from "./file-update.ts";
import {
  cloneGraph,
  confirmContentChanged,
  contentHashEntry,
  diffSignatureMaps,
  rebuildIndexes,
  refreshGraphBuiltAt,
  sourceSignatureEntry,
  sourceSignatureFromMap,
} from "./graph-state.ts";
import { upsertChangedSymbols } from "./js-ts-file.ts";
import { persistGraph } from "./persist.ts";
import { MAIN_KINDS, _workspaceGraphCache, setWorkspaceGraph } from "./workspace-cache.ts";

interface CachedGraphEntry {
  signature: string;
  fileSignatures: Map<string, string>;
  fileHashes?: Map<string, string>;
  graph: ReviewGraph;
  buildGeneration?: number;
}

interface IncrementalCtx {
  cwd: string;
  buildId?: number;
  seqHint?: boolean;
  mode?: ReviewGraphBuildMode;
  normalizedCwd: string;
  normalizedChanged: string[];
  fileSignatures: Map<string, string>;
  signature: string;
  facts: FactStore;
  seqAtBuildStart?: number;
  ignoredIds?: ReadonlySet<string>;
  cacheEpoch?: number;
}

export function verifiedCacheFields(seqAtBuildStart: number | undefined) {
  return {
    builtAtProjectSeq: seqAtBuildStart,
    lastFullVerifyMs: Date.now(),
    fastPathSinceVerify: 0,
  };
}

export async function tryIncrementalFromCache(
  cached: CachedGraphEntry,
  ctx: IncrementalCtx,
): Promise<ReviewGraph | undefined> {
  if (cached.fileSignatures.size === 0) return undefined;
  const { added, removed, changed } = diffSignatureMaps(cached.fileSignatures, ctx.fileSignatures);
  if (removed.length > 0) return undefined;
  if (added.length === 0 && changed.length === 0) return undefined;

  const { trulyChanged, hashes } = await confirmContentChanged(changed, cached.fileHashes);
  const filesToUpdate = [...added, ...trulyChanged];

  if (filesToUpdate.length === 0) {
    const generation = cached.buildGeneration ?? ++reviewGraphBuilderState._graphGenerationCounter;
    const graph = cloneGraph(cached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of ctx.normalizedChanged) {
      upsertChangedSymbols(graph, ctx.facts, file);
    }
    setWorkspaceGraph(
      ctx.normalizedCwd,
      {
        signature: ctx.signature,
        fileSignatures: new Map(ctx.fileSignatures),
        fileHashes: hashes,
        graph: cloneGraph(cached.graph),
        buildGeneration: generation,
        ...verifiedCacheFields(ctx.seqAtBuildStart),
      },
      ctx.cacheEpoch,
    );
    setGraphBuildInfo(graph, {
      reused: true,
      mode: "cached",
      graphChanged: false,
    });
    graph.buildGeneration = generation;
    ctx.facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }

  for (const file of added) {
    hashes.set(file, contentHashEntry(file));
  }

  const priorGeneration = cached.graph.buildGeneration;
  const graph = cloneGraph(cached.graph);
  const importChanges = await updateGraphFiles(
    graph,
    ctx.cwd,
    filesToUpdate,
    ctx.facts,
    ctx.ignoredIds,
  );
  refreshGraphBuiltAt(graph);
  const generation = ++reviewGraphBuilderState._graphGenerationCounter;
  graph.buildGeneration = generation;
  setWorkspaceGraph(
    ctx.normalizedCwd,
    {
      signature: ctx.signature,
      fileSignatures: new Map(ctx.fileSignatures),
      fileHashes: hashes,
      graph,
      buildGeneration: generation,
      ...verifiedCacheFields(ctx.seqAtBuildStart),
    },
    ctx.cacheEpoch,
  );
  const persistReason = persistGraph(ctx.cwd, ctx.signature, ctx.fileSignatures, hashes, graph, {
    buildId: ctx.buildId,
    projectSeq: ctx.seqAtBuildStart,
    seqHint: ctx.seqHint,
    mode: ctx.mode,
  });
  setGraphBuildInfo(graph, {
    reused: true,
    mode: "incremental",
    ...includePropertiesWhen(persistReason, () => ({ persistReason })),
    graphChanged: true,
  });
  _graphImportChanges.set(graph, {
    fromGeneration: priorGeneration,
    changes: importChanges,
  });
  ctx.facts.setSessionFact("session.reviewGraph", graph);
  return graph;
}

function hasGraphKindExtension(file: string): boolean {
  const kind = detectFileKind(file);
  return !!kind && MAIN_KINDS.has(kind) && detectFileRole(file) !== "test";
}

type SeqFastpathResult = { graph: ReviewGraph } | { fallback: SeqFastpathFallback };

export async function trySeqFastpath(
  cwd: string,
  buildId: number | undefined,
  normalizedCwd: string,
  normalizedChanged: string[],
  facts: FactStore,
  seqHint: GraphSeqHint,
  seqAtBuildStart: number,
  ignoredIds?: ReadonlySet<string>,
  cacheEpoch?: number,
): Promise<SeqFastpathResult> {
  const cached = _workspaceGraphCache.get(normalizedCwd);
  if (cached?.graph.persistCoverage?.partial) {
    return { fallback: "partial-base" };
  }
  if (!cached || cached.builtAtProjectSeq === undefined) {
    return { fallback: "no-seq" };
  }

  const now = Date.now();
  const ageMs =
    cached.lastFullVerifyMs === undefined
      ? Number.POSITIVE_INFINITY
      : now - cached.lastFullVerifyMs;
  const sinceVerify = cached.fastPathSinceVerify ?? 0;
  if (ageMs > SEQ_FASTPATH_REVERIFY_MS || sinceVerify >= SEQ_FASTPATH_REVERIFY_EVERY) {
    return { fallback: "verify-due" };
  }

  const changedSet = new Set(
    seqHint.getFilesChangedSince(cached.builtAtProjectSeq).map((file) => normalizeMapKey(file)),
  );
  for (const file of normalizedChanged) changedSet.add(file);
  const changed = [...changedSet];
  if (changed.length > SEQ_FASTPATH_MAX_CHANGES) {
    return { fallback: "too-many-changes" };
  }

  const candidateFiles: string[] = [];
  for (const file of changed) {
    const known = cached.fileSignatures.has(file);
    let existsOnDisk = false;
    try {
      existsOnDisk = fs.statSync(file).isFile();
    } catch {
      existsOnDisk = false;
    }
    if (!existsOnDisk) {
      if (known) {
        return { fallback: "removed-file" };
      }
      continue;
    }
    if (!known) {
      if (!hasGraphKindExtension(file)) continue;
    }
    candidateFiles.push(file);
  }

  const { trulyChanged, hashes } = await confirmContentChanged(candidateFiles, cached.fileHashes);
  if (trulyChanged.length === 0) {
    const graph = cloneGraph(cached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    const nextSignatures = new Map(cached.fileSignatures);
    for (const file of candidateFiles) {
      nextSignatures.set(file, sourceSignatureEntry(file));
    }
    cached.signature = sourceSignatureFromMap(nextSignatures);
    cached.fileSignatures = nextSignatures;
    cached.fileHashes = hashes;
    cached.builtAtProjectSeq = seqAtBuildStart;
    cached.fastPathSinceVerify = sinceVerify + 1;
    const generation = (cached.buildGeneration ??=
      ++reviewGraphBuilderState._graphGenerationCounter);
    setGraphBuildInfo(graph, {
      reused: true,
      mode: "seq-fastpath",
      graphChanged: false,
    });
    graph.buildGeneration = generation;
    facts.setSessionFact("session.reviewGraph", graph);
    return { graph };
  }

  const filesToUpdate = trulyChanged;
  const priorGeneration = cached.graph.buildGeneration;
  const graph = cloneGraph(cached.graph);
  let importChanges: GraphFileImportChange[];
  try {
    importChanges = await updateGraphFiles(graph, cwd, filesToUpdate, facts, ignoredIds);
  } catch {
    return { fallback: "stat-error" };
  }
  refreshGraphBuiltAt(graph);

  const nextSignatures = new Map(cached.fileSignatures);
  for (const file of candidateFiles) {
    nextSignatures.set(file, sourceSignatureEntry(file));
  }
  const nextSignature = sourceSignatureFromMap(nextSignatures);

  const generation = ++reviewGraphBuilderState._graphGenerationCounter;
  graph.buildGeneration = generation;
  setWorkspaceGraph(
    normalizedCwd,
    {
      signature: nextSignature,
      fileSignatures: nextSignatures,
      fileHashes: hashes,
      graph,
      buildGeneration: generation,
      builtAtProjectSeq: seqAtBuildStart,
      lastFullVerifyMs: cached.lastFullVerifyMs,
      fastPathSinceVerify: sinceVerify + 1,
    },
    cacheEpoch,
  );
  const persistReason = persistGraph(cwd, nextSignature, nextSignatures, hashes, graph, {
    buildId,
    projectSeq: seqAtBuildStart,
    seqHint: true,
    mode: "seq-fastpath",
  });
  setGraphBuildInfo(graph, {
    reused: true,
    mode: "seq-fastpath",
    ...includePropertiesWhen(persistReason, () => ({ persistReason })),
    graphChanged: true,
  });
  _graphImportChanges.set(graph, {
    fromGeneration: priorGeneration,
    changes: importChanges,
  });
  facts.setSessionFact("session.reviewGraph", graph);
  return { graph };
}
