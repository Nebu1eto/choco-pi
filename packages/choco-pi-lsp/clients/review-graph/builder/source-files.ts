/**
 * Review-graph source-file enumeration with file-count and file-size limits, size-skip verdicts, and build-attempt records.
 */
import { includePropertiesWhen } from "../../optional-properties.ts";
import * as fs from "node:fs";
import { lazyEnvNumber } from "../../env-utils.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { logLatency } from "../../latency-logger.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { collectProjectSourceFilesWithBudgetAsync } from "../../project-scan-policy.ts";
import { getReviewGraphMaxFilesDerived } from "../../project-scale.ts";
import { RUNTIME_CONFIG } from "../../runtime-config.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import { STAT_YIELD_EVERY, yieldToLoop } from "./graph-state.ts";
import { persistObservability, type PendingPersist } from "./persist-worker-client.ts";
import { MAIN_KINDS, MAIN_KIND_EXTENSIONS } from "./workspace-cache.ts";

// #776: `CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILES` (the existing per-subsystem env
// override) still wins outright; below it, the derived `maxProjectFiles`
// scale-knob value (see `project-scale.ts`) replaces the old hardcoded
// `RUNTIME_CONFIG.reviewGraph.maxFiles` constant as the fallback — the ratio
// table reproduces that same 1,000-file default at the default base, so this
// is behavior-neutral when nothing is configured.
export function getReviewGraphMaxFiles(cwd?: string): number {
  const override = Number.parseInt(process.env.CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILES ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : getReviewGraphMaxFilesDerived(cwd);
}

function getReviewGraphMaxFileBytes(): number {
  const override = Number.parseInt(process.env.CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILE_BYTES ?? "", 10);
  return Number.isFinite(override) && override > 0
    ? override
    : RUNTIME_CONFIG.reviewGraph.maxFileBytes;
}

function isWithinReviewGraphSizeLimit(file: string): boolean {
  try {
    return fs.statSync(file).size <= getReviewGraphMaxFileBytes();
  } catch {
    return false;
  }
}

// #782: a size-skipped build (too_many_files below) is otherwise
// indistinguishable, at the read layer, from an ordinary cold cache — and a
// graph cached/persisted BEFORE the repo crossed the cap kept being served by
// getCachedReviewGraph forever. Recording a TTL'd "size-skip verdict" per cwd
// fixes both: getCachedReviewGraph consults it below to stop serving a
// pre-cap graph while the repo is confirmed over cap, and consumers
// (project_report) can read it to render an honest "disabled, not cold" hint
// instead of "retry shortly".
//
// In-memory only, per cwd, mirroring `_workspaceGraphCache` — not persisted
// to disk. Every real caller either rebuilds within a session (the edit
// pipeline, project_report's background trigger) or restarts the process (a
// fresh in-memory verdict is recomputed on the very next build attempt), so
// there's no cross-process staleness gap worth the extra persistence
// machinery `too-many-source-files` needed (that verdict is cached across
// process starts specifically to skip a slow walk — this one is a cheap
// flag alongside a walk that already ran).
//
// TTL default matches project-report.ts's STALE_THRESHOLD_MS (15 minutes):
// long enough that a single flag isn't thrashed by back-to-back builds, short
// enough that a repo shrink or a `.choco-pi-lsp.json`/env cap raise is noticed
// without restarting the process.
const DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS = 15 * 60_000;

const _sizeSkipTtl = lazyEnvNumber(
  "CHOCO_PI_LSP_REVIEW_GRAPH_SIZE_SKIP_TTL_MS",
  DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS,
);

/** Test-only: clears the memoized TTL so a subsequent call re-reads the env var. */
export const _resetReviewGraphSizeSkipTtlForTests = _sizeSkipTtl._resetForTests;

export interface ReviewGraphSizeSkipVerdict {
  /**
   * Graph-relevant source files observed before the capped walk stopped.
   * This is the maxFileCount+1 sentinel, NOT the project's exact file count.
   */
  sourceFileCount: number;
  /** The cap (derived `maxProjectFiles` or `CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILES`) that was exceeded. */
  maxFileCount: number;
  /** `sourceFileCount` is maxFileCount+1 sentinel data, not an exact total. */
  sourceFileCountTruncated: true;
  /** Wall-clock (`Date.now()`) the skip was recorded — see {@link getReviewGraphSizeSkipVerdict}. */
  skippedAt: number;
}

export interface ReviewGraphBuildAttempt {
  when: string;
  outcome: "running" | "succeeded" | "skipped" | "failed";
  buildId?: number;
  reason?: string;
}

const _buildAttempts = new Map<string, ReviewGraphBuildAttempt>();

export function getLastReviewGraphBuildAttempt(cwd: string): ReviewGraphBuildAttempt | undefined {
  return _buildAttempts.get(normalizeMapKey(cwd));
}

export function _resetReviewGraphBuildAttemptsForTests(): void {
  _buildAttempts.clear();
}

export function recordBuildAttempt(
  cwd: string,
  outcome: ReviewGraphBuildAttempt["outcome"],
  reason?: string,
  buildId?: number,
): void {
  const key = normalizeMapKey(cwd);
  const prior = _buildAttempts.get(key);
  // Build IDs are assigned at start, so a terminal event from an older
  // overlapping build must never overwrite the newest build's status/reason.
  // Keep the newest started attempt as the project-report truth source.
  if (prior?.buildId !== undefined && (buildId === undefined || buildId < prior.buildId)) {
    return;
  }
  _buildAttempts.set(key, {
    when: new Date().toISOString(),
    outcome,
    ...includePropertiesWhen(!(buildId === undefined), () => ({ buildId })),
    ...includePropertiesWhen(reason, () => ({ reason })),
  });
}

export function recordPersistFailure(
  cwd: string,
  reason: string,
  error: string,
  pending?: PendingPersist,
  workerState?: {
    started: boolean;
    completed: boolean;
    fallbackReason?: string;
  },
): void {
  // A debounced persist can fail AFTER a newer build already recorded
  // "failed" or "running" for this cwd — don't relabel a dead/in-flight
  // build as succeeded; only annotate a record that says succeeded.
  const prior = _buildAttempts.get(normalizeMapKey(cwd));
  const pendingBuildId = pending?.graphMetadata.buildId;
  const belongsToCurrentBuild = pendingBuildId === undefined || prior?.buildId === pendingBuildId;
  if (belongsToCurrentBuild && (prior === undefined || prior.outcome === "succeeded")) {
    recordBuildAttempt(
      cwd,
      "succeeded",
      `graph built but persistence failed: ${error}`,
      pendingBuildId,
    );
  }
  logReviewGraph({
    cwd,
    phase: "persist_failed",
    reason,
    error,
    ...includePropertiesWhen(Boolean(pending), () => ({
      observability: persistObservability(pending!, {
        status: "failed",
        reason: workerState?.fallbackReason ?? reason,
        workerStarted: workerState?.started,
        workerCompleted: workerState?.completed,
        ...includePropertiesWhen(workerState?.fallbackReason, () => ({ workerFallback: true })),
      }),
    })),
  });
}

export const _sizeSkipVerdicts = new Map<string, ReviewGraphSizeSkipVerdict>();

/** Test-only: clears every recorded size-skip verdict. */
export function _resetReviewGraphSizeSkipVerdictsForTests(): void {
  _sizeSkipVerdicts.clear();
}

export function recordReviewGraphSizeSkip(
  cwd: string,
  sourceFileCount: number,
  maxFileCount: number,
): void {
  _sizeSkipVerdicts.set(normalizeMapKey(cwd), {
    sourceFileCount,
    maxFileCount,
    sourceFileCountTruncated: true,
    skippedAt: Date.now(),
  });
}

export function clearReviewGraphSizeSkip(cwd: string): void {
  _sizeSkipVerdicts.delete(normalizeMapKey(cwd));
}

const REVIEW_GRAPH_SIZE_NEAR_MISS_RATIO = 0.05;

export function isReviewGraphSizeNearMiss(sourceFileCount: number, maxFileCount: number): boolean {
  return (
    sourceFileCount > maxFileCount &&
    sourceFileCount <= maxFileCount * (1 + REVIEW_GRAPH_SIZE_NEAR_MISS_RATIO)
  );
}

/**
 * The most recent size-skip verdict for `cwd`, if one was recorded and it's
 * still within its TTL — undefined once expired (a shrink or a raised cap
 * gets re-checked on the next build attempt) or if no skip has ever been
 * recorded. Consumers (project_report) use this to tell "graph disabled
 * because the repo is over the file cap" apart from "cold cache, build in
 * progress".
 */
export function getReviewGraphSizeSkipVerdict(
  cwd: string,
  now: number = Date.now(),
): ReviewGraphSizeSkipVerdict | undefined {
  const key = normalizeMapKey(cwd);
  const verdict = _sizeSkipVerdicts.get(key);
  if (!verdict) return undefined;
  if (now - verdict.skippedAt >= _sizeSkipTtl.get()) {
    _sizeSkipVerdicts.delete(key);
    return undefined;
  }
  return verdict;
}

interface GraphSourceFilesResult {
  files: string[];
  /** Number of source files represented by this walk; a lower bound when truncated. */
  sourceFileCount: number;
  /** Per-build file cap captured before the asynchronous walk begins. */
  maxFileCount: number;
  entryBudgetExceeded: boolean;
}

// Test-only override so the entry-budget propagation contract can be exercised
// without constructing a 200k-entry fixture tree.
let _reviewGraphEntryBudgetForTests: number | undefined;
export function _setReviewGraphEntryBudgetForTests(maxScanEntries?: number): void {
  _reviewGraphEntryBudgetForTests = maxScanEntries;
}

let _reviewGraphEntryCounterForTests: (() => void) | undefined;
export function _setReviewGraphEntryCounterForTests(counter?: () => void): void {
  _reviewGraphEntryCounterForTests = counter;
}

export async function getGraphSourceFiles(cwd: string): Promise<GraphSourceFilesResult> {
  // Async, chunked-yield walk (identical output to the sync collector) so the
  // per-edit cascade graph rebuild doesn't block the event loop on a large repo.
  //
  // Cap the walk at maxGraphFiles+1: an over-limit repo (or a root that climbed
  // to $HOME) short-circuits collection instead of enumerating the entire tree
  // and paying a statSync per file before the caller bails on count (#250). When
  // the cap is hit the caller skips the build on count alone, so the unfiltered
  // over-limit list is all it needs — see _doBuildGraph's too_many_files branch.
  const maxGraphFiles = getReviewGraphMaxFiles(cwd);
  // #760: the maxFiles cap bounds results FOUND, not entries VISITED. A mixed
  // tree with few source files among a huge pile of non-source files can trip the
  // entry budget first. That result is a useful partial graph, but its lower-bound
  // count MUST travel with the graph and persistence metadata; it is never clean.
  const { files: collected, entryBudgetExceeded } = await collectProjectSourceFilesWithBudgetAsync(
    cwd,
    {
      // Only walk graph-relevant extensions so the cap counts what the graph
      // keeps (post-filter), not JSON/YAML/MD noise it would discard anyway.
      extensions: MAIN_KIND_EXTENSIONS,
      maxFiles: maxGraphFiles + 1,
      ...includePropertiesWhen(!(_reviewGraphEntryBudgetForTests === undefined), () => ({
        maxScanEntries: _reviewGraphEntryBudgetForTests,
      })),
      ...includePropertiesWhen(!(_reviewGraphEntryCounterForTests === undefined), () => ({
        onEntryVisited: _reviewGraphEntryCounterForTests,
      })),
    },
  );
  if (entryBudgetExceeded) {
    logLatency({
      type: "phase",
      phase: "review_graph_source_walk_entry_budget",
      filePath: cwd,
      durationMs: 0,
      metadata: { cwd, collectedFiles: collected.length },
    });
  }
  if (collected.length > maxGraphFiles) {
    // Contents are unused by the too_many_files branch; return the capped list
    // so the caller's `length > maxGraphFiles` check still trips.
    return {
      files: collected,
      sourceFileCount: collected.length,
      maxFileCount: maxGraphFiles,
      entryBudgetExceeded,
    };
  }
  const result: string[] = [];
  let sinceYield = 0;
  for (const raw of collected) {
    const file = normalizeMapKey(raw);
    const kind = detectFileKind(file);
    // isWithinReviewGraphSizeLimit does a statSync per file — yield periodically
    // so the size-limit filter (one stat each) can't hold the loop in one burst.
    // #260: test files are NOT graph-relevant (a heavily-tested repo was ~56%
    // tests, bloating the graph + every build/clone/serialize). The role check
    // is pure string work, so it also short-circuits the per-file statSync.
    if (
      !!kind &&
      MAIN_KINDS.has(kind) &&
      detectFileRole(file) !== "test" &&
      isWithinReviewGraphSizeLimit(file)
    ) {
      result.push(file);
    }
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  return {
    files: result,
    sourceFileCount: result.length,
    maxFileCount: maxGraphFiles,
    entryBudgetExceeded,
  };
}
