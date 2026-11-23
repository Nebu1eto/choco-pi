import { isFiniteNumber, isFunction, type LspBoundaryValue } from "./runtime-guards.ts";
import * as path from "node:path";
import {
  appendActionableWarningsHistory,
  buildActionableWarningsReport,
  formatActionableWarningsAdvisory,
  writeActionableWarningsReport,
} from "./actionable-warnings.ts";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.ts";
import {
  appendCodeQualityWarningsHistory,
  buildCodeQualityWarningsReport,
  formatCodeQualityWarningsAdvisory,
  writeCodeQualityWarningsReport,
} from "./code-quality-warnings.ts";
import type { CacheManager } from "./cache-manager.ts";
import type { CascadeSkipReason } from "./cascade-types.ts";
import {
  clearGitGuardTestFailure,
  mergeGitGuardTestFailure,
  writeGitGuardRecord,
  type TurnEndFindingsCache,
} from "./git-guard.ts";
import { cascadeSettleWaitMs } from "./cascade-budget.ts";
import { logCascade } from "./cascade-logger.ts";
import { normalizeMapKey } from "./path-utils.ts";
import { resolveRunnerPath, toRunnerDisplayPath } from "./dispatch/runner-context.ts";
import {
  getFullScanWallClockMs,
  isWorkspaceSweepActive,
  runWhenWorkspaceSweepIdle,
  SWEEP_IDLE_SAFETY_MARGIN_MS,
} from "./lsp/workspace-sweep-hold.ts";
import { isTestRoleCollateral } from "./collateral-test-role.ts";
import { isSecretWarning, secretLocationKey } from "./secret-findings.ts";
import {
  PROJECT_DIAGNOSTICS_CACHE_VERSION,
  writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.ts";
import type { ProjectDiagnostic } from "./project-diagnostics/types.ts";
import { logLatency } from "./latency-logger.ts";
import { getLspBudgetIdleTimeoutMs, shouldShortenLspIdleTimeout } from "./lsp-budget.ts";
import { updateHeartbeat } from "./instance-registry.ts";
import { emitLensTurnFindings } from "./lsp-events.ts";
import { RUNTIME_CONFIG } from "./runtime-config.ts";
import { isSubagentSession } from "./subagent-mode.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import type { TurnStateOwner } from "./cache-manager.ts";
import { formatRunDurationMs } from "./run-duration.ts";
import type { TestResult, TestRunnerClient } from "./test-runner-client.ts";
import { MAX_ADVISORY_AFFECTED_FILES, snapshotAdvisoryProvenance } from "./advisory-provenance.ts";
import { sweepInlineBlockerFreshness } from "./blocker-freshness.ts";
import { sweepInlineBlockerPastEof } from "./blocker-past-eof.ts";
import { STALE_LINE_MARKER } from "./stale-marker.ts";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.ts";

interface TurnEndDeps {
  ctxCwd?: string;
  getFlag: (name: string) => boolean | string | undefined;
  dbg: (msg: string) => void;
  runtime: RuntimeCoordinator;
  cacheManager: CacheManager;
  testRunnerClient: TestRunnerClient;
  owner?: TurnStateOwner;
  resetLSPService: () => void;
  resetFormatService: () => void;
}

let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSweepRearm: { cancelled: boolean } | null = null;

function emitIdleResetReporterWarning(reportErr: LspBoundaryValue): void {
  try {
    process.emitWarning(`choco-pi-lsp LSP idle reset error reporter failed: ${reportErr}`, {
      code: "CHOCO_PI_LSP_LSP_IDLE_RESET_REPORTER_FAILED",
    });
  } catch {
    void reportErr;
  }
}

function reportIdleResetError(
  onError: ((err: LspBoundaryValue) => void) | undefined,
  err: LspBoundaryValue,
): void {
  try {
    onError?.(err);
  } catch (reportErr) {
    emitIdleResetReporterWarning(reportErr);
  }
}

function scheduleLSPIdleReset(
  resetFn: () => void,
  delayMs: number,
  options: {
    isCurrentSession?: () => boolean;

    onError?: (err: LspBoundaryValue) => void;
  } = {},
): void {
  if (lspIdleResetTimeout) {
    clearTimeout(lspIdleResetTimeout);
  }
  if (pendingSweepRearm) {
    pendingSweepRearm.cancelled = true;
    pendingSweepRearm = null;
  }
  lspIdleResetTimeout = setTimeout(() => {
    lspIdleResetTimeout = null;
    if (isWorkspaceSweepActive()) {
      const rearmToken = { cancelled: false };
      pendingSweepRearm = rearmToken;
      runWhenWorkspaceSweepIdle(() => {
        if (rearmToken.cancelled) return;
        if (pendingSweepRearm === rearmToken) pendingSweepRearm = null;
        scheduleLSPIdleReset(resetFn, delayMs, options);
      });
      return;
    }
    try {
      if (options.isCurrentSession && !options.isCurrentSession()) {
        return;
      }
      resetFn();
    } catch (err) {
      reportIdleResetError(options.onError, err);
    }
  }, delayMs);
  lspIdleResetTimeout.unref();
}

const DEFAULT_LSP_IDLE_RESET_MS = 240_000;

function sweepDerivedFloorMs(): number {
  return getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
}

function getBaseLspIdleResetMs(): number {
  return Math.max(DEFAULT_LSP_IDLE_RESET_MS, sweepDerivedFloorMs());
}

function getShortenedLspIdleResetMs(): number {
  return Math.max(getLspBudgetIdleTimeoutMs(), sweepDerivedFloorMs());
}

export function getEffectiveLspIdleResetMs(): number {
  return isSubagentSession() || shouldShortenLspIdleTimeout()
    ? getShortenedLspIdleResetMs()
    : getBaseLspIdleResetMs();
}

export function cancelLSPIdleReset(): void {
  if (lspIdleResetTimeout) {
    clearTimeout(lspIdleResetTimeout);
    lspIdleResetTimeout = null;
  }
  if (pendingSweepRearm) {
    pendingSweepRearm.cancelled = true;
    pendingSweepRearm = null;
  }
}

function capTurnEndMessage(content: string): string {
  const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
  const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

  let out = content;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
  }
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n... (truncated)`;
  }

  return out;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
  const {
    ctxCwd,
    getFlag,
    dbg,
    runtime,
    cacheManager,
    testRunnerClient,
    owner,
    resetLSPService,
    resetFormatService,
  } = deps;

  void updateHeartbeat().catch(() => {});

  const cwd = ctxCwd ?? process.cwd();
  let turnState = cacheManager.readTurnState(cwd);

  const currentOwner: TurnStateOwner = owner ?? {
    kind: "pi",
    id: runtime.telemetrySessionId,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };
  const access = cacheManager.getTurnStateAccess(cwd, currentOwner);
  const sameProcessPiSessionHandoff =
    access === "foreign-live" &&
    currentOwner.kind === "pi" &&
    turnState.owner?.kind === "pi" &&
    turnState.owner.pid === process.pid &&
    turnState.owner.id !== currentOwner.id;
  if (access === "foreign-live" && !sameProcessPiSessionHandoff) {
    dbg(
      `turn_end: foreign live owner retained (${turnState.owner?.kind ?? "legacy"}:${turnState.owner?.id ?? turnState.sessionId})`,
    );
    return;
  }
  if (access === "available" && (turnState.files || turnState.owner || turnState.sessionId)) {
    dbg("turn_end: evicting stale turn-state owner");
    cacheManager.clearTurnState(cwd, currentOwner);
    turnState = cacheManager.readTurnState(cwd);
  }

  const files = Object.keys(turnState.files);

  if (files.length === 0 && !runtime.hasCascadeRuns()) {
    if (getFlag("lens-guard") && !runtime.gitGuardHasBlockers) {
      const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
        "turn-end-findings",
        cwd,
      )?.data;
      if (
        guardRecord?.sessionId === runtime.telemetrySessionId &&
        guardRecord.testFailures !== true
      ) {
        cacheManager.clearCache("turn-end-findings", cwd);
      }
    }
    const idleResetMs = getEffectiveLspIdleResetMs();
    dbg(`turn_end: no modified files, scheduling LSP idle reset (${idleResetMs / 1000}s)`);
    if (!getFlag("no-lsp")) {
      const sessionGeneration = runtime.sessionGeneration;
      scheduleLSPIdleReset(resetLSPService, idleResetMs, {
        isCurrentSession: () => runtime.isCurrentSession(sessionGeneration),
        onError: (err) => dbg(`lsp idle reset failed: ${err}`),
      });
    }
    resetFormatService();
    return;
  }

  if (lspIdleResetTimeout || pendingSweepRearm) {
    cancelLSPIdleReset();
    dbg("turn_end: cancelled pending LSP idle reset (active editing)");
  }

  dbg(
    `turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
  );

  if (cacheManager.isMaxCyclesExceeded(cwd)) {
    dbg("turn_end: max cycles exceeded, clearing state and forcing through");
    cacheManager.clearTurnState(cwd, currentOwner);
    runtime.fixedThisTurn.clear();
    resetFormatService();
    return;
  }

  const turnEndStart = Date.now();
  const blockerParts: string[] = [];
  const staleSecretParts: string[] = [];
  const advisoryParts: string[] = [];
  const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
  const projectDiagnosticsSources = new Set<string>();

  const blockerPastEofStart = Date.now();
  const blockerPastEof = sweepInlineBlockerPastEof(runtime, cwd);
  logLatency({
    type: "phase",
    toolName: "turn_end",
    filePath: cwd,
    phase: "blocker_past_eof_sweep",
    durationMs: Date.now() - blockerPastEofStart,
    metadata: {
      total: blockerPastEof.total,
      checked: blockerPastEof.checked,
      demoted: blockerPastEof.demoted,
      healed: blockerPastEof.healed,
    },
  });

  const blockerFreshnessStart = Date.now();
  const blockerFreshness = await sweepInlineBlockerFreshness(runtime, cwd);
  logLatency({
    type: "phase",
    toolName: "turn_end",
    filePath: cwd,
    phase: "blocker_freshness_sweep",
    durationMs: Date.now() - blockerFreshnessStart,
    metadata: {
      total: blockerFreshness.total,
      kept: blockerFreshness.kept,
      revalidated: blockerFreshness.revalidated,
      alreadyStale: blockerFreshness.alreadyStale,
      truncatedImports: blockerFreshness.truncatedImports,
    },
  });

  const unresolvedBlockers = runtime.getInlineBlockersSnapshot();
  for (const { filePath: bPath, summary, stale } of unresolvedBlockers) {
    const displayPath = toRunnerDisplayPath(cwd, bPath);
    if (stale) {
      advisoryParts.push(`${STALE_LINE_MARKER} ${displayPath}:\n${summary}`);
    } else {
      blockerParts.push(`Unresolved from this turn — ${displayPath}:\n${summary}`);
    }
  }

  const cascadeSettleStart = Date.now();
  const { settled, timedOut } = await runtime.settleCascadeRuns(cascadeSettleWaitMs(), {
    trackTurnEndClock: true,
  });
  logLatency({
    type: "phase",
    toolName: "turn_end",
    filePath: cwd,
    phase: "cascade_settle_wait",
    durationMs: Date.now() - cascadeSettleStart,
    metadata: { settled, timedOut },
  });

  const t0 = Date.now();
  const cascadeRuns = runtime.consumeCascadeRuns().filter((run) => {
    const originSeq = run.origin?.projectSeq;
    const originTurn = run.origin?.turnSeq;
    if (originSeq !== undefined) {
      const changedSince = runtime.getFilesChangedSince(originSeq);
      if (changedSince.length > 0) {
        const changedSet = new Set(changedSince);
        const primaryKey = normalizeMapKey(path.resolve(run.filePath));
        const neighborKeys = [
          ...(run.result?.neighbors ?? []).map((n) => n.filePath),
          ...(run.selectedNeighborPaths ?? []),
        ].map((filePath) => normalizeMapKey(path.resolve(filePath)));
        const supersededByOwnFile =
          changedSet.has(primaryKey) || neighborKeys.some((k) => changedSet.has(k));
        if (supersededByOwnFile) {
          logCascade({
            phase: "cascade_carry_over_drop",
            filePath: run.filePath,
            neighborCount: run.neighborCount,
            diagnosticCount: run.diagnosticCount,
            reason: "superseded_by_later_write",
            metadata: {
              originProjectSeq: originSeq,
              projectSeq: runtime.projectSeq,
              originTurnSeq: originTurn,
              turnIndex: runtime.turnIndex,
              carriedTurns: run.carriedTurns,
              changedFiles: changedSince,
            },
          });
          return false;
        }
      }
    }
    return true;
  });
  const cascadeResults = cascadeRuns.flatMap((r) => (r.result ? [r.result] : []));
  const cascadeLogFilePath = cascadeResults[0]?.filePath ?? files[0] ?? cwd;
  if (cascadeResults.length > 0) {
    const seen = new Map<string, (typeof cascadeResults)[number]>();
    for (const result of cascadeResults) {
      seen.set(normalizeMapKey(result.filePath), result);
    }
    const neighborOwner = new Map<string, string>();
    for (const result of [...seen.values()].reverse()) {
      const pk = normalizeMapKey(result.filePath);
      for (const n of result.neighbors) {
        const nk = normalizeMapKey(n.filePath);
        if (!neighborOwner.has(nk)) neighborOwner.set(nk, pk);
      }
    }
    const parts: string[] = [];
    let injectedNeighborCount = 0;
    let injectedDiagnosticCount = 0;
    let suppressedByOwnership = 0;
    for (const result of seen.values()) {
      const pk = normalizeMapKey(result.filePath);
      const ownsAny = result.neighbors.some(
        (n) => neighborOwner.get(normalizeMapKey(n.filePath)) === pk,
      );
      if (ownsAny && result.formatted) {
        parts.push(result.formatted);
        injectedNeighborCount += result.neighbors.length;
        injectedDiagnosticCount += result.neighbors.reduce((s, n) => s + n.diagnostics.length, 0);
      } else if (!ownsAny && result.formatted) {
        suppressedByOwnership++;
      }
    }
    const neighborFilesWithErrors = cascadeResults
      .flatMap((r) => r.neighbors)
      .filter((n) => n.diagnostics.length > 0)
      .map((n) => n.filePath);
    const uniqueNeighborFiles = [...new Set(neighborFilesWithErrors)];
    let testSuggestionCount = 0;

    if (uniqueNeighborFiles.length > 0 && isFunction(testRunnerClient.suggestTestFiles)) {
      const testSuggestions = testRunnerClient.suggestTestFiles(uniqueNeighborFiles, cwd);
      testSuggestionCount = testSuggestions.length;
      logCascade({
        phase: "cascade_test_targets",
        filePath: cascadeLogFilePath,
        neighborCount: uniqueNeighborFiles.length,
        metadata: {
          neighborFiles: uniqueNeighborFiles.slice(0, 10),
          suggestedTestFiles: testSuggestions.slice(0, 10).map((s) => s.testFile),
          runner: testSuggestions[0]?.runner,
          truncated: testSuggestions.length > 10,
          zeroSuggestions: testSuggestions.length === 0,
        },
      });
      if (testSuggestions.length > 0) {
        const testLines = testSuggestions
          .slice(0, 5)
          .map((s) => `  ${toRunnerDisplayPath(cwd, s.testFile)} (${s.runner})`);
        let testSection = `🧪 Likely tests for affected neighbors:\n${testLines.join("\n")}`;
        if (testSuggestions.length > 5) {
          testSection += `\n  ... and ${testSuggestions.length - 5} more`;
        }
        parts.push(testSection);
      }
    }
    if (parts.length > 0) {
      const section = parts.join("\n\n");
      blockerParts.push(section);
      logCascade({
        phase: "cascade_injected",
        filePath: cascadeLogFilePath,
        neighborCount: injectedNeighborCount,
        diagnosticCount: injectedDiagnosticCount,
        metadata: {
          sectionChars: section.length,
          testSuggestionCount,
          suppressedByOwnership,
        },
      });
    }
    logCascade({
      phase: "cascade_turn_end",
      filePath: cascadeLogFilePath,
      neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
      diagnosticCount: cascadeResults.reduce(
        (s, r) => s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
        0,
      ),
      metadata: {
        fileCount: cascadeResults.length,
        mergedResults: seen.size,
      },
    });
  }
  const indeterminateRuns = cascadeRuns.filter((r) => r.indeterminate);
  if (indeterminateRuns.length > 0) {
    const buildAdvisory = (
      runs: typeof indeterminateRuns,
      frame: {
        lead: (fileCount: number, reasons: string) => string;
        fallbackDetail: (r: (typeof indeterminateRuns)[number]) => string;
      },
    ): string | undefined => {
      if (runs.length === 0) return undefined;
      const byDetail = new Map<string, string[]>();
      for (const r of runs) {
        const detail = r.indeterminate?.detail ?? frame.fallbackDetail(r);
        const files = byDetail.get(detail) ?? [];
        files.push(toRunnerDisplayPath(cwd, r.filePath));
        byDetail.set(detail, files);
      }
      const lines: string[] = [];
      for (const [detail, filesRaw] of byDetail) {
        const files = [...new Set(filesRaw)];
        const shown = files.slice(0, 5).join(", ");
        const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
        lines.push(`  • ${detail}: ${shown}${more}`);
      }
      const fileCount = new Set(runs.map((r) => normalizeMapKey(r.filePath))).size;
      const reasons = [...byDetail.keys()].join("; ");
      return `${frame.lead(fileCount, reasons)}\n${lines.join("\n")}`;
    };

    const graphRuns = indeterminateRuns.filter(
      (r) =>
        r.indeterminate?.reason !== "lsp_binding_rejected" &&
        r.indeterminate?.reason !== "excluded_by_role" &&
        r.indeterminate?.reason !== "budget_truncated" &&
        r.indeterminate?.budget === undefined,
    );
    const bindingRuns = indeterminateRuns.filter(
      (r) =>
        r.indeterminate?.reason === "lsp_binding_rejected" && r.indeterminate?.budget === undefined,
    );
    const budgetRuns = indeterminateRuns.filter(
      (r) =>
        r.indeterminate?.reason === "budget_truncated" || r.indeterminate?.budget !== undefined,
    );

    const graphAdvisory = buildAdvisory(graphRuns, {
      lead: (fileCount, reasons) =>
        `Cascade could not compute downstream impact for ${fileCount} edited file(s) this turn — ` +
        `the review graph was unavailable (${reasons}), so their dependents were not ` +
        `cascade-checked and a clean cascade result does not cover them.`,
      fallbackDetail: (r) =>
        r.indeterminate?.reason === "missing_node"
          ? "changed file not in the review graph"
          : "review graph unavailable",
    });
    if (graphAdvisory) advisoryParts.push(graphAdvisory);

    const bindingAdvisory = buildAdvisory(bindingRuns, {
      lead: (fileCount, reasons) =>
        `Cascade identified dependents for ${fileCount} edited file(s) this turn, but their ` +
        `diagnostics could not be freshly confirmed (${reasons}) and were withheld — a clean ` +
        `cascade result does not cover them.`,
      fallbackDetail: () => "cascade diagnostics withheld (binding rejected)",
    });
    if (bindingAdvisory) advisoryParts.push(bindingAdvisory);

    const budgetAdvisory = buildAdvisory(budgetRuns, {
      lead: (fileCount, reasons) =>
        `Cascade checked the selected neighbors for ${fileCount} edited file(s) this turn, ` +
        `but some eligible dependents were not checked because the cascade budget ` +
        `was exhausted (${reasons}); a clean cascade result does not cover them.`,
      fallbackDetail: (r) => {
        const budget = r.indeterminate?.budget;
        if (!budget) return "cascade budget omitted eligible dependents";
        const detail = `cascade budget checked ${budget.selectedCount} of ${budget.eligibleCount} eligible dependents (${budget.truncatedCount} omitted)`;
        return budget.transitiveTruncated
          ? `${detail}; transitive expansion was capped before all eligible dependents were enumerated`
          : detail;
      },
    });
    if (budgetAdvisory) advisoryParts.push(budgetAdvisory);

    const fileCount = new Set(indeterminateRuns.map((r) => normalizeMapKey(r.filePath))).size;
    const byFile = indeterminateRuns.map((r) => ({
      file: toRunnerDisplayPath(cwd, r.filePath),
      reason: r.indeterminate?.reason,
      ...(r.indeterminate?.detail && { detail: r.indeterminate.detail }),
      ...(r.indeterminate?.budget && { budget: { ...r.indeterminate.budget } }),
      ...(r.indeterminate?.diagnostic && {
        diagnostic: { ...r.indeterminate.diagnostic },
      }),
    }));
    logCascade({
      phase: "cascade_indeterminate",
      filePath: indeterminateRuns[0]?.filePath ?? files[0] ?? cwd,
      metadata: {
        fileCount,
        reasons: indeterminateRuns.map((r) => r.indeterminate?.reason),
        byFile: byFile.slice(0, 20),
        ...(byFile.length > 20 && { byFileTruncated: byFile.length - 20 }),
      },
    });
  }

  interface CascadeSkippedValues extends Record<CascadeSkipReason, number> {}
  const cascadeSkipped: CascadeSkippedValues = {
    blockers: 0,
    non_code: 0,
    no_neighbors: 0,
    clean: 0,
    indeterminate: 0,
    error: 0,
  };
  for (const r of cascadeRuns) {
    if (r.skipReason) cascadeSkipped[r.skipReason] = (cascadeSkipped[r.skipReason] ?? 0) + 1;
  }
  logLatency({
    type: "phase",
    toolName: "turn_end",
    filePath: cwd,
    phase: "cascade_merge",
    durationMs: Date.now() - t0,
    metadata: {
      runsTotal: cascadeRuns.length,
      resultCount: cascadeResults.length,
      neighborCount: cascadeRuns.reduce((s, r) => s + r.neighborCount, 0),
      diagnosticCount: cascadeRuns.reduce((s, r) => s + r.diagnosticCount, 0),
      skipped: cascadeSkipped,
    },
  });

  const secretBlockedLocations = new Set<string>();

  if (!getFlag("no-tests") && files.length > 0) {
    const seen = new Set<string>();
    const targets: NonNullable<ReturnType<TestRunnerClient["getTestRunTarget"]>>[] = [];

    const candidates: Array<{
      display: string;
      abs: string;
      isNeighbor: boolean;
    }> = [];
    const seenCandidateKeys = new Set<string>();
    for (const file of files) {
      const abs = resolveRunnerPath(cwd, file);
      const key = normalizeMapKey(abs);
      if (seenCandidateKeys.has(key)) continue;
      seenCandidateKeys.add(key);
      candidates.push({ display: file, abs, isNeighbor: false });
    }
    for (const result of cascadeResults) {
      for (const neighbor of result.neighbors) {
        const abs = path.isAbsolute(neighbor.filePath)
          ? neighbor.filePath
          : resolveRunnerPath(cwd, neighbor.filePath);
        const key = normalizeMapKey(abs);
        if (seenCandidateKeys.has(key)) continue;
        seenCandidateKeys.add(key);
        candidates.push({ display: neighbor.filePath, abs, isNeighbor: true });
      }
    }

    for (const { display, abs, isNeighbor } of candidates) {
      const target = testRunnerClient.getTestRunTarget(abs, cwd);
      if (target && !seen.has(target.testFile)) {
        seen.add(target.testFile);
        targets.push(target);
        dbg(
          `turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
        );
      } else if (!target) {
        dbg(`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`);
      }
    }
    if (targets.length > 0) {
      dbg(`turn_end: firing ${targets.length} test target(s) async (non-blocking)`);
      const firedAtTurn = runtime.turnIndex;
      const firedSessionId = runtime.telemetrySessionId;
      const priorTestCache = cacheManager.readCache<TestRunnerFindingsCache>(
        "test-runner-findings",
        cwd,
      )?.data;
      const testRunGeneration = (priorTestCache?.testRunGeneration ?? 0) + 1;
      const provenanceFiles = [
        ...candidates.map((candidate) => ({
          path: candidate.abs,
          role: "source" as const,
        })),
        ...targets.map((target) => ({
          path: target.testFile,
          role: "test" as const,
        })),
      ];
      const launchedFrom = snapshotAdvisoryProvenance({
        cwd,
        runtime,
        generation: testRunGeneration,
        files: provenanceFiles,
      });
      cacheManager.writeCache(
        "test-runner-findings",
        { ...(priorTestCache ?? { content: "" }), testRunGeneration },
        cwd,
      );
      Promise.allSettled(
        targets.map((t) => testRunnerClient.runTestFileAsync(t.testFile, cwd, t.runner, t.config)),
      )
        .then((results) => {
          const publishedAgainst = snapshotAdvisoryProvenance({
            cwd,
            runtime,
            generation: testRunGeneration,
            files: provenanceFiles,
          });
          const superseded =
            launchedFrom.revision.sessionId !== publishedAgainst.revision.sessionId ||
            launchedFrom.revision.projectSeq !== publishedAgainst.revision.projectSeq ||
            launchedFrom.revision.turnIndex !== publishedAgainst.revision.turnIndex ||
            launchedFrom.files.some(
              (file, index) =>
                publishedAgainst.files[index]?.sha256 !== file.sha256 ||
                publishedAgainst.files[index]?.path !== file.path,
            );
          const stale = runtime.turnIndex !== firedAtTurn;
          const failures: string[] = [];
          const resultValues: TestResult[] = [];
          for (const r of results) {
            if (r.status === "rejected") {
              dbg(`turn_end: test run rejected — ${r.reason}`);
              continue;
            }
            resultValues.push(r.value);
            const { file, runner, passed, failed, duration, error } = r.value;
            const shortFile = path.basename(file);
            const elapsed = formatRunDurationMs(duration);
            const verdict = failed > 0 ? "FAIL" : "PASS";
            const summary =
              error && passed === 0 && failed === 0
                ? `error: ${error}`
                : `${verdict} ${passed}p/${failed}f (${elapsed})`;
            dbg(`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`);
            if (failed > 0 || error) {
              const formatted = testRunnerClient.formatResult(r.value);
              if (formatted) failures.push(formatted);
            }
          }
          if (failures.length > 0) {
            const currentGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
              "test-runner-findings",
              cwd,
            )?.data?.testRunGeneration;
            if (currentGeneration !== undefined && currentGeneration > testRunGeneration) {
              dbg(
                `turn_end: test generation ${testRunGeneration} superseded by ${currentGeneration}`,
              );
              return;
            }
            const content = stale
              ? `[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]\n\n${failures.join("\n\n")}`
              : failures.join("\n\n");
            cacheManager.writeCache(
              "test-runner-findings",
              {
                content,
                stale,
                results: resultValues,
                testRunGeneration,
                launchedFrom,
                publishedAgainst,
                provenance: publishedAgainst,
                superseded,
              },
              cwd,
            );
            if (getFlag("lens-guard") && firedSessionId === runtime.telemetrySessionId) {
              const cleanFiles = resultValues
                .filter((value) => value.failed === 0 && !value.error)
                .map((value) => value.file);
              if (cleanFiles.length > 0) {
                clearGitGuardTestFailure(cacheManager, cwd, runtime, cleanFiles);
              }
              mergeGitGuardTestFailure(
                cacheManager,
                cwd,
                runtime,
                content,
                resultValues.filter((value) => value.failed > 0).map((value) => value.file),
              );
            }
            dbg(
              `turn_end: ${failures.length} test failure(s) cached for next context injection${stale ? " (stale — turn advanced while tests ran)" : ""}`,
            );
          } else if (results.length > 0) {
            if (getFlag("lens-guard") && firedSessionId === runtime.telemetrySessionId) {
              clearGitGuardTestFailure(
                cacheManager,
                cwd,
                runtime,
                resultValues.map((value) => value.file),
              );
            }
            dbg(
              `turn_end: all tests passed${stale ? " (stale — turn advanced while tests ran)" : ""}`,
            );
          }
        })
        .catch(() => {});
    }
  }

  if (runtime.errorDebtBaseline && files.length > 0) {
    dbg("turn_end: marking error debt check for next session");
    cacheManager.writeCache(
      "errorDebt",
      {
        pendingCheck: true,
        baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
      },
      cwd,
    );
  }

  if (runtime.callGraph && files.length > 0) {
    const coverage = runtime.callGraph.coverage;
    if (!coverage || coverage.complete !== true) {
      advisoryParts.push(
        "Call-graph impact was not emitted because call-graph extraction coverage is incomplete; " +
          "the affected files may have unreported callers.",
      );
    } else {
      try {
        const { impact, formatImpact, parseSymbolKey } = await import("./call-graph.ts");
        const { callGraphImpactToProjectDiagnostics } =
          await import("./project-diagnostics/runner-adapters/call-graph-impact.ts");
        const impactLines: string[] = [];
        const impactFindings: {
          calleeKey: string;
          results: ReturnType<typeof impact>;
        }[] = [];
        for (const filePath of files.slice(0, 5)) {
          const changedFileKey = normalizeMapKey(resolveRunnerPath(cwd, filePath));
          const fileCallerKeys = [...runtime.callGraph.callers.keys()].filter((k) => {
            const graphFilePath = parseSymbolKey(k).filePath;
            return normalizeMapKey(resolveRunnerPath(cwd, graphFilePath)) === changedFileKey;
          });
          for (const calleeKey of fileCallerKeys.slice(0, 3)) {
            const results = impact(runtime.callGraph, calleeKey).filter((r) => {
              const callerFile = parseSymbolKey(r.symbolKey).filePath;
              return !callerFile || !isTestRoleCollateral(resolveRunnerPath(cwd, callerFile));
            });
            if (results.length > 0) {
              impactFindings.push({ calleeKey, results });
              const summary = formatImpact(results, cwd);
              if (summary)
                impactLines.push(
                  `  ${parseSymbolKey(calleeKey).symbolName ?? calleeKey}: ${summary}`,
                );
            }
          }
        }
        if (impactLines.length > 0) {
          advisoryParts.push(
            `📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`,
          );
        }
        if (impactFindings.length > 0) {
          const impactDiagnostics = callGraphImpactToProjectDiagnostics(cwd, impactFindings);
          if (impactDiagnostics.length > 0) {
            projectDiagnosticsDelta.push(...impactDiagnostics);
            projectDiagnosticsSources.add("call-graph");
          }
        }
      } catch {}
    }
  }

  if (projectDiagnosticsDelta.length > 0) {
    writeProjectDiagnosticsDeltaReport(cwd, {
      version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
      cwd,
      generatedAt: new Date().toISOString(),
      sessionId: runtime.telemetrySessionId,
      turnIndex: runtime.turnIndex,
      projectSeqStart: runtime.turnStartProjectSeq,
      projectSeqEnd: runtime.projectSeq,
      diagnostics: projectDiagnosticsDelta,
      sources: [...projectDiagnosticsSources].sort((a, b) => a.localeCompare(b)),
    });
  }

  const t4 = Date.now();
  const modifiedRangesByFile = new Map(
    Object.entries(turnState.files).map(([file, state]) => [
      normalizeMapKey(resolveRunnerPath(cwd, file)),
      state.modifiedRanges,
    ]),
  );

  // SAFETY: The runtime dependency is the concrete RuntimeCoordinator; the optional member check immediately after this access preserves compatibility.
  const getFileSeq = (runtime as Partial<RuntimeCoordinator>).getFileSeq;
  const fileSeqByPath = new Map<string, number>();
  if (getFileSeq) {
    for (const file of files) {
      const filePath = normalizeMapKey(resolveRunnerPath(cwd, file));
      fileSeqByPath.set(filePath, getFileSeq.call(runtime, filePath));
    }
  }
  if (getFlag("lens-actionable-warnings")) {
    try {
      const report = await buildActionableWarningsReport({
        cwd,
        sessionId: runtime.telemetrySessionId,
        turnIndex: runtime.turnIndex,
        files,
        modifiedRangesByFile,
        dispatchWarnings: runtime
          .peekActionableWarnings()
          .filter(
            (w) =>
              !(
                isSecretWarning(w) &&
                isFiniteNumber(w.line) &&
                secretBlockedLocations.has(secretLocationKey(w.filePath, w.line))
              ),
          ),
        includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
        projectSeqStart: runtime.turnStartProjectSeq,
        projectSeqEnd: runtime.projectSeq,
        fileSeqByPath,
        deltaOnly: !getFlag("lens-actionable-warning-all"),
        dbg,
      });
      writeActionableWarningsReport(cacheManager, cwd, report);
      appendActionableWarningsHistory(cwd, report);
      const advisory = formatActionableWarningsAdvisory(report);
      if (advisory) advisoryParts.push(advisory);
      logActionableWarningsEvent({
        event: advisory ? "advisory_injected" : "advisory_skipped",
        sessionId: runtime.telemetrySessionId,
        metadata: {
          turnIndex: runtime.turnIndex,
          unsuppressed: report.summary.unsuppressed,
        },
      });
      logLatency({
        type: "phase",
        toolName: "turn_end",
        filePath: cwd,
        phase: "actionable_warnings_report",
        durationMs: Date.now() - t4,
        metadata: report.summary,
      });
    } catch (err) {
      dbg(`turn_end: actionable warning report failed: ${err}`);
      logLatency({
        type: "phase",
        toolName: "turn_end",
        filePath: cwd,
        phase: "actionable_warnings_report",
        durationMs: Date.now() - t4,
        metadata: {
          failed: true,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const t5 = Date.now();
  try {
    const qualityReport = buildCodeQualityWarningsReport({
      cwd,
      sessionId: runtime.telemetrySessionId,
      turnIndex: runtime.turnIndex,
      warnings: runtime.peekCodeQualityWarnings(),
      modifiedRangesByFile,
      projectSeqStart: runtime.turnStartProjectSeq,
      projectSeqEnd: runtime.projectSeq,
      fileSeqByPath,
    });
    writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
    appendCodeQualityWarningsHistory(cwd, qualityReport);
    const advisory = formatCodeQualityWarningsAdvisory(qualityReport);
    if (advisory) advisoryParts.push(advisory);
    logLatency({
      type: "phase",
      toolName: "turn_end",
      filePath: cwd,
      phase: "code_quality_warnings_report",
      durationMs: Date.now() - t5,
      metadata: qualityReport.summary,
    });
  } catch (err) {
    dbg(`turn_end: code quality warning report failed: ${err}`);
    logLatency({
      type: "phase",
      toolName: "turn_end",
      filePath: cwd,
      phase: "code_quality_warnings_report",
      durationMs: Date.now() - t5,
      metadata: {
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  cacheManager.incrementTurnCycle(cwd, currentOwner);

  const labeledAdvisoryParts = advisoryParts.map(
    (p) => `ℹ️ Advisory — no action required this turn:\n${p}`,
  );
  const findingParts = [...blockerParts, ...staleSecretParts, ...labeledAdvisoryParts];
  if (findingParts.length > 0) {
    dbg(
      `turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
    );
    const content = capTurnEndMessage(findingParts.join("\n\n"));
    const signature = `${files
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .join("|")}::${content}`;
    const last = cacheManager.readCache<{
      signature: string;
      sessionId: string;
    }>("turn-end-findings-last", cwd);
    if (
      last?.data?.signature === signature &&
      last?.data?.sessionId === runtime.telemetrySessionId
    ) {
      dbg("turn_end: duplicate findings detected (same session), suppressing re-prompt");
      if (getFlag("lens-guard")) {
        const existingGuard = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
          "turn-end-findings",
          cwd,
        )?.data;
        if (existingGuard) {
          writeGitGuardRecord(cacheManager, runtime, cwd, {
            // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
            ...(existingGuard as TurnEndFindingsCache),
            content,
            blockerContent:
              blockerParts.length > 0 ? capTurnEndMessage(blockerParts.join("\n\n")) : undefined,
            hasBlockers: blockerParts.length > 0 || existingGuard.testFailures === true,
            blockingFiles: blockerParts.length > 0 ? existingGuard.affectedFiles : undefined,
            projectSeqStart: runtime.turnStartProjectSeq,
            projectSeqEnd: runtime.projectSeq,
            fileSeqByPath: Object.fromEntries(
              runtime
                .getFileSeqEntries()
                .map(([filePath, seq]) => [normalizeMapKey(path.resolve(filePath)), seq]),
            ),
            fileContentHashes: {},
            consumed: false,
          });
        }
      }
      cacheManager.clearTurnState(cwd, currentOwner);
      runtime.fixedThisTurn.clear();
      resetFormatService();
      return;
    }
    const fileSeqByPath: Record<string, number> = {};
    for (const [filePath, seq] of runtime.getFileSeqEntries()) {
      fileSeqByPath[normalizeMapKey(path.resolve(filePath))] = seq;
    }
    if (getFlag("lens-guard")) {
      const existingGuard = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
        "turn-end-findings",
        cwd,
      )?.data;
      const blockingContent =
        blockerParts.length > 0 ? capTurnEndMessage(blockerParts.join("\n\n")) : undefined;
      const affectedFiles = [
        ...(existingGuard?.affectedFiles ?? []),
        ...files.map((file) => resolveRunnerPath(cwd, file)),
        ...cascadeResults.flatMap((result) =>
          result.neighbors
            .filter((neighbor) => neighbor.diagnostics.length > 0)
            .map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
        ),
      ];
      writeGitGuardRecord(cacheManager, runtime, cwd, {
        content: [content, existingGuard?.testFailureContent]
          .filter((value): value is string => !!value)
          .join("\n\n"),
        blockerContent: blockingContent,
        blockingFiles: blockerParts.length > 0 ? affectedFiles : undefined,
        hasBlockers: !!blockingContent || existingGuard?.testFailures === true,
        affectedFiles,
        sessionId: runtime.telemetrySessionId,
        projectSeqStart: runtime.turnStartProjectSeq,
        projectSeqEnd: runtime.projectSeq,
        fileSeqByPath,
        fileContentHashes: {},
        consumed: false,
        testFailures: existingGuard?.testFailures,
        testFailureContent: existingGuard?.testFailureContent,
        testFailureFiles: existingGuard?.testFailureFiles,
      });
    } else {
      const allAffectedFiles = [
        ...files.map((file) => resolveRunnerPath(cwd, file)),
        ...cascadeResults.flatMap((result) =>
          result.neighbors
            .filter((neighbor) => neighbor.diagnostics.length > 0)
            .map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
        ),
      ];
      const affectedFiles = [...new Set(allAffectedFiles)].slice(0, MAX_ADVISORY_AFFECTED_FILES);
      const affectedFilesTruncated = new Set(allAffectedFiles).size > affectedFiles.length;
      cacheManager.writeCache(
        "turn-end-findings",
        {
          content,
          affectedFiles,
          affectedFilesTruncated,
          provenance: snapshotAdvisoryProvenance({
            cwd,
            runtime,
            generation: 0,
            files: affectedFiles.map((file) => ({
              path: file,
              role: "affected" as const,
            })),
            truncated: affectedFilesTruncated,
          }),
        },
        cwd,
      );
    }
    cacheManager.writeCache(
      "turn-end-findings-last",
      {
        signature,
        sessionId: runtime.telemetrySessionId,
        projectSeqStart: runtime.turnStartProjectSeq,
        projectSeqEnd: runtime.projectSeq,
      },
      cwd,
    );
    emitLensTurnFindings({
      cwd,
      filePaths: files.map((file) => resolveRunnerPath(cwd, file)),
      sessionId: runtime.telemetrySessionId,
      turnIndex: runtime.turnIndex,
      blockerSections: blockerParts.length,
      advisorySections: advisoryParts.length,
      content,
    });
  }
  if (blockerParts.length === 0) {
    cacheManager.clearTurnState(cwd, currentOwner);
    if (
      getFlag("lens-guard") &&
      advisoryParts.length === 0 &&
      staleSecretParts.length === 0 &&
      !runtime.gitGuardHasBlockers
    ) {
      const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
        "turn-end-findings",
        cwd,
      )?.data;
      if (
        guardRecord?.sessionId === runtime.telemetrySessionId &&
        guardRecord.testFailures !== true
      ) {
        cacheManager.clearCache("turn-end-findings", cwd);
      }
    }
  }

  runtime.fixedThisTurn.clear();
  runtime.clearActionableWarnings();
  runtime.clearCodeQualityWarnings();
  logLatency({
    type: "tool_result",
    toolName: "turn_end",
    filePath: cwd,
    durationMs: Date.now() - turnEndStart,
    result:
      blockerParts.length > 0
        ? "blockers_found"
        : staleSecretParts.length > 0
          ? "stale_secrets_pending"
          : "clean",
    metadata: {
      fileCount: files.length,
      blockerSections: blockerParts.length,
      staleSecretSections: staleSecretParts.length,
      advisorySections: advisoryParts.length,
    },
  });
  resetFormatService();
}
