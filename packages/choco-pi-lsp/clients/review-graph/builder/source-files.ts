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

const DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS = 15 * 60_000;

const _sizeSkipTtl = lazyEnvNumber(
  "CHOCO_PI_LSP_REVIEW_GRAPH_SIZE_SKIP_TTL_MS",
  DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS,
);

export const _resetReviewGraphSizeSkipTtlForTests = _sizeSkipTtl._resetForTests;

export interface ReviewGraphSizeSkipVerdict {
  sourceFileCount: number;
  maxFileCount: number;
  sourceFileCountTruncated: true;
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
  sourceFileCount: number;
  maxFileCount: number;
  entryBudgetExceeded: boolean;
}

let _reviewGraphEntryBudgetForTests: number | undefined;
export function _setReviewGraphEntryBudgetForTests(maxScanEntries?: number): void {
  _reviewGraphEntryBudgetForTests = maxScanEntries;
}

let _reviewGraphEntryCounterForTests: (() => void) | undefined;
export function _setReviewGraphEntryCounterForTests(counter?: () => void): void {
  _reviewGraphEntryCounterForTests = counter;
}

export async function getGraphSourceFiles(cwd: string): Promise<GraphSourceFilesResult> {
  const maxGraphFiles = getReviewGraphMaxFiles(cwd);
  const { files: collected, entryBudgetExceeded } = await collectProjectSourceFilesWithBudgetAsync(
    cwd,
    {
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
