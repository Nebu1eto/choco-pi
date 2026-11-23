/**
 * Incremental rebuilds from the cached graph and the sequence-number fast path.
 */
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
  /** #459: generation of this entry's graph content — see ReviewGraph.buildGeneration. */
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
  /** #451: seq to stamp onto the freshly-built entry (undefined ⇒ no fast path later). */
  seqAtBuildStart?: number;
  /** #694: untracked-AND-ignored ids, fetched once per build — see `_doBuildGraph`. */
  ignoredIds?: ReadonlySet<string>;
  cacheEpoch?: number;
}

/**
 * #451: the freshness-provenance fields written onto a workspace cache entry by
 * any path that has just done (or reused a still-valid result of) the full
 * walk+stat sweep. Records the projectSeq CAPTURED AT BUILD START — not read at
 * stamp time — so a bump that interleaves during this build's awaits has
 * seq > stamp and is re-ingested by the next diff (a miss would be a silently
 * stale graph; a redundant re-extract is harmless). Also resets the
 * periodic-reverify clock/counter — this build IS the verify.
 */
export function verifiedCacheFields(seqAtBuildStart: number | undefined) {
  return {
    builtAtProjectSeq: seqAtBuildStart,
    lastFullVerifyMs: Date.now(),
    fastPathSinceVerify: 0,
  };
}

/**
 * #202: satisfy a build from a cached graph entry incrementally when the source
 * file set changed only by ADDITIONS and/or CONTENT changes (no removals).
 * Returns the query-ready graph, or undefined when an incremental update doesn't
 * apply (a file was removed, the cache has no signatures to diff, or nothing
 * actually changed) and the caller must fall through.
 *
 * This is the lever that keeps a burst of newly-created files off the
 * full-rebuild path. `updateGraphFiles` re-parses each target from disk and is a
 * remove-then-add that no-ops the remove for a not-yet-present file, so adding
 * the new files (plus any hash-confirmed content changes) incrementally is
 * correct regardless of whether the file was in this edit's changed set —
 * dropping the old `.every(in changedSet)` restriction that bailed to a full
 * rebuild for a sibling that changed on disk outside the current edit.
 */
export async function tryIncrementalFromCache(
  cached: CachedGraphEntry,
  ctx: IncrementalCtx,
): Promise<ReviewGraph | undefined> {
  if (cached.fileSignatures.size === 0) return undefined;
  const { added, removed, changed } = diffSignatureMaps(cached.fileSignatures, ctx.fileSignatures);
  // A removal must prune nodes/edges and can dangle incoming edges; that's rare
  // on an edit burst — fall through to a correct full rebuild.
  if (removed.length > 0) return undefined;
  if (added.length === 0 && changed.length === 0) return undefined;

  // Confirm size/mtime-changed EXISTING files by content hash so pure drift
  // (formatter no-op, git checkout, re-save) neither reparses nor forces a full
  // build. Added files are genuinely new — no prior hash to compare.
  const { trulyChanged, hashes } = await confirmContentChanged(changed, cached.fileHashes);
  const filesToUpdate = [...added, ...trulyChanged];

  if (filesToUpdate.length === 0) {
    // Pure drift on existing files only — reuse the cached graph as-is.
    // #459: content unchanged ⇒ carry the entry's generation forward (a legacy
    // or disk-hydrated entry without one gets a fresh stamp — conservative:
    // derived caches see it as new and rebuild once).
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
    // #260: pure drift leaves the graph unchanged — don't rewrite the disk blob.
    setGraphBuildInfo(graph, {
      reused: true,
      mode: "cached",
      graphChanged: false,
    });
    graph.buildGeneration = generation;
    ctx.facts.setSessionFact("session.reviewGraph", graph);
    return graph;
  }

  // Record content hashes for the newly-added files too, so the next run can
  // tell their future drift from a real change (otherwise they would re-confirm
  // as changed on every build until the next full rebuild).
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
  // #459: real re-extract ⇒ new generation.
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

/**
 * #451: satisfy a build WITHOUT the O(project) walk+stat sweep, using the
 * RuntimeCoordinator's seq state to enumerate exactly which files changed since
 * this workspace graph was last built. On success sets `_lastGraphBuildInfo` and
 * returns `{ graph }`; on any doubt returns `{ fallback }` WITHOUT touching
 * `_lastGraphBuildInfo` (the caller's full sweep sets the mode and stamps the
 * fallback reason). Correctness bar is HIGH: any doubt ⇒ fall back.
 */
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
  // Condition 2: need an in-process complete entry that recorded a build seq.
  // A capped or entry-budget-truncated graph is read-only orientation data, not
  // a safe incremental base; force the next build through a complete walk.
  if (cached?.graph.persistCoverage?.partial) {
    return { fallback: "partial-base" };
  }
  if (!cached || cached.builtAtProjectSeq === undefined) {
    return { fallback: "no-seq" };
  }

  // Condition 5: periodic full re-verify safety valve (external edits — IDE, git
  // checkout — never bump projectSeq). Age OR count triggers a sweep.
  const now = Date.now();
  const ageMs =
    cached.lastFullVerifyMs === undefined
      ? Number.POSITIVE_INFINITY
      : now - cached.lastFullVerifyMs;
  const sinceVerify = cached.fastPathSinceVerify ?? 0;
  if (ageMs > SEQ_FASTPATH_REVERIFY_MS || sinceVerify >= SEQ_FASTPATH_REVERIFY_EVERY) {
    return { fallback: "verify-due" };
  }

  // Condition 3: bounded change set. changed ∪ changedFiles(param), normalized.
  const changedSet = new Set(
    seqHint.getFilesChangedSince(cached.builtAtProjectSeq).map((file) => normalizeMapKey(file)),
  );
  for (const file of normalizedChanged) changedSet.add(file);
  const changed = [...changedSet];
  if (changed.length > SEQ_FASTPATH_MAX_CHANGES) {
    return { fallback: "too-many-changes" };
  }

  // Condition 4 + removal check. A file already known to the graph is safe. A
  // file NOT in fileSignatures must exist on disk with a graph-kind extension
  // (a genuine new file — updateGraphFiles' remove-then-add handles the add). A
  // changed file that no longer exists on disk is a DELETION: incremental has no
  // node-removal here, so fall back to the sweep (simple + correct).
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
      // Known-but-now-missing = deletion; unknown-and-missing = irrelevant
      // (e.g. a non-source path). Either way, be safe: known deletions need the
      // sweep; unknown missing files we can just ignore.
      if (known) {
        return { fallback: "removed-file" };
      }
      continue;
    }
    if (!known) {
      // New file: only ingest if it's a graph-relevant kind; a changed
      // non-source sibling (config, doc) is simply not graph material.
      if (!hasGraphKindExtension(file)) continue;
    }
    candidateFiles.push(file);
  }

  // A pi-observed write can advance projectSeq without changing bytes (format
  // no-op, save, or an idempotent edit). Confirm content before re-extracting so
  // the seq fast path does not refresh builtAt or claim graphChanged for drift.
  const { trulyChanged, hashes } = await confirmContentChanged(candidateFiles, cached.fileHashes);
  if (trulyChanged.length === 0) {
    // Nothing graph-relevant actually changed. Reuse the cached graph as-is,
    // refresh changed-symbol annotations, bump the fast-path counter.
    const graph = cloneGraph(cached.graph);
    rebuildIndexes(graph);
    graph.changedSymbolsByFile.clear();
    for (const file of normalizedChanged) {
      upsertChangedSymbols(graph, facts, file);
    }
    // Stamp the seq captured at BUILD START — a bump that raced in during this
    // build has seq > stamp and is re-diffed next build, never missed.
    const nextSignatures = new Map(cached.fileSignatures);
    for (const file of candidateFiles) {
      nextSignatures.set(file, sourceSignatureEntry(file));
    }
    cached.signature = sourceSignatureFromMap(nextSignatures);
    cached.fileSignatures = nextSignatures;
    cached.fileHashes = hashes;
    cached.builtAtProjectSeq = seqAtBuildStart;
    cached.fastPathSinceVerify = sinceVerify + 1;
    // #459: nothing graph-relevant changed — this is a genuine no-op reuse.
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

  // Incremental re-extract over exactly the content-changed files. Reuses the
  // SAME machinery as the signature-diff incremental path (updateGraphFiles), so
  // there's no second incremental implementation.
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

  // Update fileSignatures/fileHashes for ONLY the touched files (stat/hash just
  // those — the whole point of the fast path). Recompute the aggregate signature
  // the same way the incremental branch does (sourceSignatureFromMap).
  const nextSignatures = new Map(cached.fileSignatures);
  for (const file of candidateFiles) {
    nextSignatures.set(file, sourceSignatureEntry(file));
  }
  const nextSignature = sourceSignatureFromMap(nextSignatures);

  // #459: real re-extract ⇒ new generation.
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
      // Build-start seq, not stamp-time: see verifiedCacheFields — a bump that
      // interleaved during updateGraphFiles' awaits must be re-diffed next build.
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
  // #459: filesToUpdate was non-empty — this fastpath re-extracted real files,
  // so (unlike the no-op branch above) the graph object did change.
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
