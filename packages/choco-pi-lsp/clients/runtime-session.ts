import { assignOptionalProperties } from "./optional-properties.ts";
import { isFunction, isString } from "./runtime-guards.ts";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { AstGrepClient } from "./ast-grep-client.ts";
import type { BiomeClient } from "./biome-client.ts";
import { resetBoundedTelemetry } from "./bounded-telemetry.ts";
import type { CacheManager } from "./cache-manager.ts";
import { createDeadline, yieldIfOverBudget } from "./cooperative-budget.ts";
import { resetDegradationLedger } from "./degradation-ledger.ts";
import { getDiagnosticTracker } from "./diagnostic-tracker.ts";
import { resetPsScriptAnalyzerAvailability } from "./dispatch/runners/psscriptanalyzer.ts";
import { resetInstallRetryLatches } from "./dispatch/runners/utils/availability-policy.ts";
import { resetLazyInstallAttempts } from "./dispatch/runners/utils/lazy-installer.ts";
import { resetDispatchAvailabilityState } from "./dispatch/runners/utils/runner-helpers.ts";
import type { FileKind } from "./file-kinds.ts";
import { clearAllSessions as clearFileTimeSessions } from "./file-time.ts";
import { getGlobalPiLensDir, getProjectDataDir } from "./file-utils.ts";
import type { GoClient } from "./go-client.ts";
import { sweepAtomicWriteStages } from "./instance-reaper.ts";
import { canRunStartupHeavyScans } from "./language-policy.ts";
import { detectProjectLanguageProfile, getDefaultStartupTools } from "./language-profile.ts";
import { registerIdleTimerRelease } from "./idle-timer-release.ts";
import { logLatency } from "./latency-logger.ts";
import { runLogCleanup } from "./log-cleanup.ts";
import type { LSPShutdownOptions } from "./lsp/client.ts";
import { initLSPConfig, loadLSPConfig } from "./lsp/config.ts";
import { loadLspService } from "./lsp-lazy.ts";
import type { MetricsClient } from "./metrics-client.ts";
import type { OpengrepClient, OpengrepResult } from "./opengrep-client.ts";
import { resetManagedToolRefreshSession } from "./installer/managed-tool-refresh-session.ts";
import { _resetPackageManagerCache } from "./package-manager.ts";
import { isAtOrAboveHomeDir } from "./path-utils.ts";
import { isPrintMode } from "./print-mode.ts";
import {
  type ProjectSequenceBase,
  type ProjectSequenceIndex,
  readLatestProjectSequence,
  readLatestProjectSequenceAsync,
} from "./project-changes.ts";
import {
  getProjectSnapshotPath,
  hydrateRuntimeFromProjectSnapshot,
  isProjectSnapshotFresh,
  isProjectSnapshotMetaStale,
  loadProjectSnapshot,
  PROJECT_SNAPSHOT_VERSION,
  type ProjectSnapshot,
  readProjectSnapshotMeta,
  saveRuntimeProjectSnapshot,
} from "./project-snapshot.ts";
import { clearTsconfigPathsCache } from "./review-graph/tsconfig-paths.ts";
import type { RuffClient } from "./ruff-client.ts";
import { scanProjectRules } from "./rules-scanner.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import type { RustClient } from "./rust-client.ts";
import { resetSafeSpawnWindowsCommandCache } from "./safe-spawn.ts";
import { runLanguageServerPrewarm, shouldPrewarmLanguageServers } from "./session-warmup-config.ts";
import { getSlowFsVerdict, isSlowFs, slowFsDegradationNotice } from "./slow-fs.ts";
import {
  countRecentSmells,
  formatSmellsSessionStartLine,
  resetSmellsSessionState,
} from "./smells-rollup.ts";
import {
  findNearestProjectRoot,
  getStartupScanMaxEntries,
  isStartupScanVerdictFresh,
  resolveStartupScanContext,
  type StartupScanContext,
} from "./startup-scan.ts";
import {
  getSubagentIdentity,
  isSubagentSession,
  subagentLightModeNotice,
} from "./subagent-mode.ts";
import type { TestRunnerClient } from "./test-runner-client.ts";
import type { TodoScanner } from "./todo-scanner.ts";
import { isWarmAttached } from "./warm-attach.ts";
import { setSessionLanguages } from "./widget-state.ts";
import { logWordIndex } from "./word-index-logger.ts";
import { resetWorkspaceTopology } from "./workspace-topology.ts";
import { resetZizmorTokenAvailability } from "./zizmor-config.ts";

type LoadSnapshotBodyUnlessStaleResultContract = {
  snapshot: ProjectSnapshot | null;
  skippedStale: boolean;
};

interface SessionStartDeps {
  ctxCwd?: string;
  sessionStartFiredAt?: number;
  sessionReason?: string;
  handlerEnteredAt?: number;
  bootstrapClientsStartedAt?: number;
  bootstrapClientsDurationMs?: number;
  getFlag: (name: string) => boolean | string | undefined;
  notify: (msg: string, level: "info" | "warning" | "error") => void;
  dbg: (msg: string) => void;
  log: (msg: string) => void;
  startupModeOverride?: StartupMode;
  runtime: RuntimeCoordinator;
  metricsClient: MetricsClient;
  cacheManager: CacheManager;
  todoScanner: TodoScanner;
  astGrepClient: AstGrepClient;
  biomeClient: BiomeClient;
  ruffClient: RuffClient;
  opengrepClient: OpengrepClient;
  testRunnerClient: TestRunnerClient;
  goClient: GoClient;
  rustClient: RustClient;
  ensureTool: (name: string) => Promise<string | null | undefined>;
  cleanStaleTsBuildInfo: (cwd: string) => string[];
  resetDispatchBaselines: (cwd?: string) => void;
  resetLSPService: (options?: LSPShutdownOptions) => void;
}

type StartupMode = "full" | "minimal" | "quick";

function resolveSnapshotRoot(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const nearest = findNearestProjectRoot(resolvedCwd);
  if (!nearest || isAtOrAboveHomeDir(nearest)) {
    return resolvedCwd;
  }
  return nearest;
}

function snapshotSequenceBase(root: string): ProjectSequenceBase | undefined {
  const meta = readProjectSnapshotMeta(root);
  if (!meta || meta.version !== PROJECT_SNAPSHOT_VERSION) return undefined;
  const index = meta.sequenceIndex;
  if (!index) return undefined;
  return {
    projectSeq: index.projectSeq,
    fileSeqByPath: index.fileSeqByPath,
    sinceSeq: meta.seq,
  };
}

function loadSnapshotBodyUnlessStale(args: {
  root: string;
  currentProjectSeq: number;
  dbg: (msg: string) => void;
}): LoadSnapshotBodyUnlessStaleResultContract {
  const meta = readProjectSnapshotMeta(args.root);
  if (meta && isProjectSnapshotMetaStale(meta, args.currentProjectSeq)) {
    args.dbg(
      `project_snapshot: meta gate stale (metaSeq=${meta.seq} metaVersion=${meta.version} current=${args.currentProjectSeq}) — skipping body parse`,
    );

    return { snapshot: null, skippedStale: true };
  }

  return {
    snapshot: loadProjectSnapshot(args.root),
    skippedStale: false,
  };
}

function describeSnapshotMiss(snapshot: ProjectSnapshot | null, currentProjectSeq: number): string {
  if (!snapshot) return "missing";
  if (snapshot.seq !== currentProjectSeq) {
    return `stale(seq=${snapshot.seq}, current=${currentProjectSeq})`;
  }
  return "incompatible";
}

function logProjectSnapshotProbe(args: {
  dbg: (msg: string) => void;
  root: string;
  currentProjectSeq: number;
  snapshot: ProjectSnapshot | null;
}): void {
  args.dbg(
    `project_snapshot: probe root=${args.root} path=${getProjectSnapshotPath(args.root)} currentSeq=${args.currentProjectSeq}`,
  );
  if (isProjectSnapshotFresh(args.snapshot, args.currentProjectSeq)) {
    args.dbg(
      `project_snapshot: loaded seq=${args.snapshot.seq} exports=${args.snapshot.cachedExports.length} files=${Object.keys(args.snapshot.files ?? {}).length} reverseDeps=${Object.keys(args.snapshot.reverseDeps ?? {}).length} startupScan=${Boolean(args.snapshot.startupScan)} languageProfile=${Boolean(args.snapshot.languageProfile)}`,
    );
  } else {
    args.dbg(
      `project_snapshot: miss reason=${describeSnapshotMiss(args.snapshot, args.currentProjectSeq)}`,
    );
  }
}

function resolveStartupMode(): StartupMode {
  const envMode = (process.env.CHOCO_PI_LSP_STARTUP_MODE ?? "").trim().toLowerCase();
  if (envMode === "full" || envMode === "minimal" || envMode === "quick") {
    return envMode;
  }

  if (isPrintMode()) {
    return "quick";
  }

  return "full";
}

function sequenceReadBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_SEQUENCE_READ_BUDGET_MS ?? 250);
  return Number.isFinite(raw) && raw > 0 ? raw : 250;
}

const UNKNOWN_PROJECT_SEQ = -1;

async function readSequenceWithBudget(args: {
  snapshotRoot: string;
  base?: ProjectSequenceBase;
  cwd: string;
  runtime: RuntimeCoordinator;
  sessionGeneration: number;
  dbg: (msg: string) => void;
}): Promise<{ latestSeq: ProjectSequenceIndex; timedOut: boolean }> {
  const { snapshotRoot, base, cwd, runtime, sessionGeneration, dbg } = args;
  const readPromise = readLatestProjectSequenceAsync(snapshotRoot, base);

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), sequenceReadBudgetMs());
    timeoutHandle.unref();
  });

  const raced = await Promise.race([
    readPromise.then((latestSeq) => ({ timedOut: false as const, latestSeq })),
    timeoutPromise,
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (!raced.timedOut) {
    return { latestSeq: raced.latestSeq, timedOut: false };
  }

  dbg(
    `session_start: sequence read exceeded ${sequenceReadBudgetMs()}ms budget — falling back to cold-start sequence`,
  );

  if (!isPrintMode()) {
    readPromise
      .then((latestSeq) => {
        if (!runtime.isCurrentSession(sessionGeneration)) return;
        if (runtime.projectSeq > 0) {
          dbg(
            "session_start: deferred sequence read completed, but the session already advanced (in-window edit) — skipping reseed to avoid clobbering it",
          );
          return;
        }
        const reseedStartedAt = Date.now();
        runtime.seedProjectSequence?.(latestSeq.projectSeq, latestSeq.fileSeqByPath);
        logLatency({
          type: "phase",
          phase: "session_start_sequence_read_deferred_reseed",
          filePath: cwd,
          startedAt: new Date(reseedStartedAt).toISOString(),
          durationMs: Date.now() - reseedStartedAt,
          metadata: { entries: latestSeq.fileSeqByPath.size, deferred: true },
        });
        dbg(
          `session_start: deferred sequence read completed — reseeded projectSeq=${latestSeq.projectSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
        );
      })
      .catch((err) => {
        dbg(`session_start: deferred sequence read failed: ${err}`);
      });
  }

  return {
    latestSeq: { projectSeq: 0, fileSeqByPath: new Map<string, number>() },
    timedOut: true,
  };
}

async function igniteWarmFiles(
  cwd: string,
  warmFiles: string[],
  runtime: RuntimeCoordinator,
  sessionGeneration: number,
  dbg: (msg: string) => void,
): Promise<void> {
  try {
    dbg(`session_start lsp-warm: ${warmFiles.length} warm file(s) configured`);

    await initLSPConfig(cwd);
    if (!runtime.isCurrentSession(sessionGeneration)) return;

    const lspService = (await loadLspService()).getLSPService();
    const total = warmFiles.length;
    let loaded = 0;
    let errors = 0;

    for (const relPath of warmFiles) {
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      const filePath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
      if (!nodeFs.existsSync(filePath)) {
        dbg(`session_start lsp-warm: not found: ${relPath}`);
        errors++;
        continue;
      }
      try {
        const content = nodeFs.readFileSync(filePath, "utf-8");
        await lspService.touchFile(filePath, content, {
          diagnostics: "none",
          source: "startup-warm",
          clientScope: "primary",
          maxClientWaitMs: 2000,
        });
        loaded++;
      } catch (err) {
        dbg(`session_start lsp-warm: error ${relPath}: ${err}`);
        errors++;
      }
    }

    dbg(`session_start lsp-warm: ${loaded}/${total} opened (${errors} err)`);
  } catch (err) {
    dbg(`session_start lsp-warm: config/init error: ${err}`);
  }
}

async function igniteDominantLanguageWarm(
  cwd: string,
  runtime: RuntimeCoordinator,
  sessionGeneration: number,
  dbg: (msg: string) => void,
): Promise<void> {
  try {
    await initLSPConfig(cwd);
    if (!runtime.isCurrentSession(sessionGeneration)) return;

    const lspService = (await loadLspService()).getLSPService();
    const { collectSourceFilesAsync } = await import("./source-filter.ts");
    const { CODE_KINDS, detectFileKind } = await import("./file-kinds.ts");
    const files = await collectSourceFilesAsync(cwd, {
      inspectGeneratedHeaders: false,
    });
    if (!runtime.isCurrentSession(sessionGeneration)) return;

    const counts = new Map<FileKind, number>();
    for (const f of files) {
      const kind = detectFileKind(f);
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (counts.size === 0) {
      dbg("session_start lsp-warm: no detected languages to auto-warm");
      return;
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    const warmOrder = [
      ...ranked.filter(([kind]) => CODE_KINDS.has(kind)),
      ...ranked.filter(([kind]) => !CODE_KINDS.has(kind)),
    ];

    for (const [kind] of warmOrder) {
      const sample = files.find((f) => detectFileKind(f) === kind && lspService.supportsLSP(f));
      if (!sample) continue;
      const content = await nodeFs.promises.readFile(sample, "utf-8");
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      await lspService.touchFile(sample, content, {
        diagnostics: "none",
        source: "startup-warm-dominant",
        clientScope: "primary",
        maxClientWaitMs: 2000,
      });
      dbg(`session_start lsp-warm: dominant=${kind} via ${path.basename(sample)}`);
      return;
    }
    dbg("session_start lsp-warm: no dominant-language LSP file found to warm");
  } catch (err) {
    dbg(`session_start lsp-warm: dominant warm error: ${err}`);
  }
}

function firePreinstallDefaults(
  ensureTool: SessionStartDeps["ensureTool"],
  dbg: SessionStartDeps["dbg"],
  startupDefaults: string[],
): void {
  for (const tool of startupDefaults) {
    const startedAt = Date.now();
    dbg(`session_start preinstall ${tool}: start`);
    ensureTool(tool)
      .then((toolPath) => {
        if (toolPath) {
          dbg(`session_start: ${tool} ready at ${toolPath}`);
          dbg(`session_start preinstall ${tool}: success (${Date.now() - startedAt}ms)`);
        } else {
          dbg(`session_start: ${tool} installation unavailable`);
          dbg(`session_start preinstall ${tool}: unavailable (${Date.now() - startedAt}ms)`);
        }
      })
      .catch((err) => {
        dbg(`session_start: ${tool} pre-install error: ${err}`);
        dbg(`session_start preinstall ${tool}: error (${Date.now() - startedAt}ms)`);
      });
  }
}

const MANAGED_TOOL_REFRESH_DELAY_MS = 30_000;

let managedToolRefreshTimer: ReturnType<typeof setTimeout> | undefined;
registerIdleTimerRelease(() => {
  if (managedToolRefreshTimer !== undefined) clearTimeout(managedToolRefreshTimer);
  managedToolRefreshTimer = undefined;
});

function scheduleManagedToolRefresh(dbg: SessionStartDeps["dbg"]): void {
  if (managedToolRefreshTimer !== undefined) clearTimeout(managedToolRefreshTimer);
  const delayMs = Number(
    process.env.CHOCO_PI_LSP_TOOL_REFRESH_DELAY_MS ?? MANAGED_TOOL_REFRESH_DELAY_MS,
  );
  const timer = setTimeout(
    () => {
      if (managedToolRefreshTimer === timer) managedToolRefreshTimer = undefined;
      void (async () => {
        try {
          const refresh = await import("./installer/managed-tool-refresh.ts");
          const outcome = await refresh.runManagedToolRefresh();
          if (outcome.skipped) {
            dbg(`session_start tool-refresh: skipped (${outcome.skipped})`);
            return;
          }
          for (const result of outcome.refreshed) {
            dbg(
              `session_start tool-refresh: ${result.toolId} ${result.ok ? "ok" : "failed"}` +
                `${result.changed ? ` ${result.previousVersion ?? "unknown"} → ${result.currentVersion}` : " (unchanged)"}`,
            );
          }
        } catch (err) {
          dbg(`session_start tool-refresh: error ${err}`);
        }
      })();
    },
    Number.isFinite(delayMs) ? delayMs : MANAGED_TOOL_REFRESH_DELAY_MS,
  );
  timer.unref?.();
  managedToolRefreshTimer = timer;
}

async function probePrettierInstall(
  ensureTool: SessionStartDeps["ensureTool"],
  dbg: SessionStartDeps["dbg"],
  analysisRoot: string,
): Promise<void> {
  const pkgPath = path.join(analysisRoot, "package.json");
  try {
    const raw = await nodeFs.promises.readFile(pkgPath, "utf-8");

    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      prettier?: unknown;
    };
    const usesPrettier =
      !!pkg.devDependencies?.prettier || !!pkg.dependencies?.prettier || pkg.prettier !== undefined;
    if (usesPrettier) {
      dbg("session_start: project uses prettier, ensuring install...");
      ensureTool("prettier")
        .then((p) => {
          if (p) dbg(`session_start: prettier ready at ${p}`);
          else dbg("session_start: prettier install failed silently");
        })
        .catch((err) => dbg(`session_start: prettier install error: ${err}`));
    }
  } catch {}
}

type TodoScannerLike = {
  scanDirectory: (root: string) => { items: unknown[] };
  scanFile?: (filePath: string) => unknown[];
};

function scanOneTodoFile(scanner: TodoScannerLike, filePath: string, items: unknown[]): void {
  if (!isFunction(scanner.scanFile)) return;
  try {
    const result = scanner.scanFile(filePath);
    if (Array.isArray(result)) items.push(...result);
  } catch {}
}

async function collectTodoBaselineItems(
  scanner: TodoScannerLike,
  analysisRoot: string,
  stillCurrent: () => boolean,
): Promise<unknown[]> {
  const items: unknown[] = [];
  try {
    const { getSourceFilesAsync } = await import("./scan-utils.ts");
    const files = await getSourceFilesAsync(analysisRoot, true);
    if (!stillCurrent()) return items;
    const deadline = createDeadline(8);
    for (const file of files) {
      if (!stillCurrent()) return items;
      scanOneTodoFile(scanner, file, items);
      await yieldIfOverBudget(deadline);
    }
  } catch {
    const todoResult = scanner.scanDirectory(analysisRoot);
    items.push(...todoResult.items);
  }
  return items;
}

interface WordIndexWarmupResult {
  mode: "full" | "incremental";
  refreshed: number;
  dropped: number;
  skipped?: number;
  reused: number;
}

async function buildOrRefreshWordIndex(args: {
  runtime: RuntimeCoordinator;
  sessionGeneration: number;
  analysisRoot: string;
  snapshotRoot: string;
  dbg: (msg: string) => void;
}): Promise<WordIndexWarmupResult | undefined> {
  const { runtime, sessionGeneration, analysisRoot, snapshotRoot, dbg } = args;
  if (!runtime.isCurrentSession(sessionGeneration)) return;
  const startMs = Date.now();
  let rebuildPreflightFiles: import("./word-index.ts").WordIndexPreflightFiles | undefined;

  const latestSeq = readLatestProjectSequence(snapshotRoot, snapshotSequenceBase(snapshotRoot));
  const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
  const snapshotLoadStartMs = Date.now();
  const snapshot = loadProjectSnapshot(snapshotRoot);
  const snapshotLoadMs = Date.now() - snapshotLoadStartMs;
  if (snapshot?.wordIndex) {
    const { deserializeWordIndex, refreshWordIndexIncrementally } = await import("./word-index.ts");
    const deserializeStartMs = Date.now();
    const index = deserializeWordIndex(snapshot.wordIndex);
    const deserializeMs = Date.now() - deserializeStartMs;
    if (index) {
      try {
        const result = await refreshWordIndexIncrementally(index, analysisRoot, () =>
          runtime.isCurrentSession(sessionGeneration),
        );
        if (!runtime.isCurrentSession(sessionGeneration)) return;
        if (result.mode === "full-required") {
          rebuildPreflightFiles = result.preflightFiles;
          dbg(
            `session_start word-index: incremental preflight selected full rebuild (${result.reason})`,
          );
          logWordIndex({
            phase: "incremental_fallback",
            cwd: snapshotRoot,
            trigger: "session_start",
            reason: result.reason,
            phaseDurationsMs: {
              snapshotLoadMs,
              deserializeMs,
              ...result.timings,
            },
          });
        } else {
          runtime.wordIndex = index;
          let snapshotSaveSyncMs = 0;
          if (
            !isProjectSnapshotFresh(snapshot, effectiveSeq) ||
            result.refreshed > 0 ||
            result.dropped > 0 ||
            snapshot.wordIndex.truncated !== index.truncated
          ) {
            const serializeSaveEnqueueStartMs = Date.now();
            saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
            snapshotSaveSyncMs = Date.now() - serializeSaveEnqueueStartMs;
          }
          const phases =
            `snapshot-load=${snapshotLoadMs}ms, deserialize=${deserializeMs}ms, ` +
            `source-walk=${result.timings.sourceWalkMs}ms, stat-walk=${result.timings.statWalkMs}ms, ` +
            `refresh-reads=${result.timings.refreshReadsMs}ms, ` +
            `snapshot-save-sync=${snapshotSaveSyncMs}ms`;
          dbg(
            `session_start word-index: incremental (seq=${effectiveSeq}, refreshed=${result.refreshed}, dropped=${result.dropped}, skipped=${result.skipped}, reused=${result.reused}, ${Date.now() - startMs}ms, phases: ${phases})`,
          );
          logWordIndex({
            phase: "incremental_refresh",
            cwd: snapshotRoot,
            trigger: "session_start",
            durationMs: Date.now() - startMs,
            indexedFileCount: index.docCount,
            tokens: index.postings.size,
            truncated: index.truncated,
            phaseDurationsMs: {
              snapshotLoadMs,
              deserializeMs,
              ...result.timings,
              snapshotSaveSyncMs,
            },
            refreshed: result.refreshed,
            dropped: result.dropped,
            skipped: result.skipped,
            reused: result.reused,
          });
          return result;
        }
      } catch (err) {
        if (!runtime.isCurrentSession(sessionGeneration)) {
          dbg("session_start word-index: incremental refresh superseded");
          return;
        }
        dbg(
          `session_start word-index: incremental refresh failed; falling back to full rebuild (${err})`,
        );
        logWordIndex({
          phase: "incremental_fallback",
          cwd: snapshotRoot,
          trigger: "session_start",
          reason: err instanceof Error ? err.message : String(err),
          phaseDurationsMs: { snapshotLoadMs, deserializeMs },
        });
      }
    }
  }

  const { buildWordIndexAsync, collectWordIndexDocs } = await import("./word-index.ts");
  const docs = await collectWordIndexDocs(
    analysisRoot,
    () => runtime.isCurrentSession(sessionGeneration),
    rebuildPreflightFiles,
  );
  if (!runtime.isCurrentSession(sessionGeneration)) return;
  let rebuiltIndex: Awaited<ReturnType<typeof buildWordIndexAsync>>;
  try {
    rebuiltIndex = await buildWordIndexAsync(docs, () =>
      runtime.isCurrentSession(sessionGeneration),
    );
  } catch (err) {
    if (!runtime.isCurrentSession(sessionGeneration)) {
      dbg("session_start word-index: rebuild superseded");
      return;
    }
    throw err;
  }
  if (!runtime.isCurrentSession(sessionGeneration)) return;
  runtime.wordIndex = rebuiltIndex;
  saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
  dbg(
    `session_start word-index: rebuilt (absent/stale, seq=${effectiveSeq}) ` +
      `${runtime.wordIndex.docCount} files, ${runtime.wordIndex.postings.size} tokens (${Date.now() - startMs}ms)`,
  );
  logWordIndex({
    phase: "full_rebuild",
    cwd: snapshotRoot,
    trigger: "session_start",
    durationMs: Date.now() - startMs,
    indexedFileCount: runtime.wordIndex.docCount,
    tokens: runtime.wordIndex.postings.size,
    truncated: runtime.wordIndex.truncated,
    skipped: docs.skipped,
  });
  return {
    mode: "full",
    refreshed: runtime.wordIndex.docCount,
    dropped: 0,
    skipped: docs.skipped,
    reused: 0,
  };
}

function scheduleStartupScans(
  deps: SessionStartDeps,
  runtime: RuntimeCoordinator,
  sessionGeneration: number,
  analysisRoot: string,
  snapshotRoot: string,
  languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
  dbg: SessionStartDeps["dbg"],
): void {
  const { todoScanner, cacheManager, opengrepClient, astGrepClient } = deps;

  interface TaskDeferMsByNameValues extends Record<string, number> {}
  const taskDeferMsByName: TaskDeferMsByNameValues = {
    "call-graph": 5000,
    "codebase-model": 5200,
    "ast-grep exports": 5400,
    "project index": 5400,
  };
  const runTask = (name: string, task: () => Promise<void>): Promise<void> => {
    const queuedAt = Date.now();
    dbg(`session_start task ${name}: scheduled`);
    runtime.markStartupScanInFlight(name, sessionGeneration);
    const completion = new Promise<void>((resolve) => {
      const fire = (): void => {
        const startedAt = Date.now();
        dbg(`session_start task ${name}: start queuedMs=${startedAt - queuedAt}`);
        void task()
          .then(() => {
            dbg(
              `session_start task ${name}: success runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
            );
          })
          .catch((err) => {
            dbg(`session_start: ${name} background scan failed: ${err}`);
            dbg(
              `session_start task ${name}: failed runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
            );
          })
          .finally(() => {
            runtime.clearStartupScanInFlight(name, sessionGeneration);
            dbg(`session_start task ${name}: end`);
            resolve();
          });
      };
      const delay = taskDeferMsByName[name] ?? 0;
      if (delay > 0) {
        setTimeout(fire, delay).unref?.();
      } else {
        setImmediate(fire);
      }
    });
    return completion;
  };

  const canRunJsTsHeavyScans = canRunStartupHeavyScans(languageProfile, "jsts");
  const scanNames = ["todo"];
  if (canRunJsTsHeavyScans) {
    scanNames.push("ast-grep exports", "project index");
  }
  dbg(`session_start: launching background scans (${scanNames.join(", ")})`);

  runTask("todo", async () => {
    if (!runtime.isCurrentSession(sessionGeneration)) return;

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const items = await collectTodoBaselineItems(todoScanner as TodoScannerLike, analysisRoot, () =>
      runtime.isCurrentSession(sessionGeneration),
    );
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    dbg(`session_start TODO scan: ${items.length} items (baseline stored)`);
    cacheManager.writeCache("todo-baseline", { items }, analysisRoot);
  });

  if (!canRunJsTsHeavyScans) {
    dbg("session_start: skipping JS/TS startup scans (requires JS/TS language + project config)");
    return;
  }

  const isSubagent = isSubagentSession();
  const skipHeavyweightScans = isSlowFs(analysisRoot) || isSubagent;
  const runHeavyweightTask = (name: string, task: () => Promise<void>): void => {
    if (skipHeavyweightScans) return;
    runTask(name, task);
  };
  if (skipHeavyweightScans) {
    dbg(
      `session_start: skipping heavyweight background scans (opengrep) (${
        isSubagent ? "subagent" : "slow-fs"
      })`,
    );
    deps.notify(
      `⏭️ Skipped background code-quality scans (opengrep): ${
        isSubagent ? subagentLightModeNotice() : slowFsDegradationNotice()
      }`,
      "info",
    );
  }

  runHeavyweightTask("opengrep", async () => {
    if (!(await opengrepClient.ensureAvailable())) {
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      dbg("session_start opengrep: not available (install failed?)");
      return;
    }
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    const cached = cacheManager.readCache<OpengrepResult>("opengrep", analysisRoot);
    if (cached) {
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      dbg(`session_start opengrep: cache hit (${cached.data.findings.length} findings)`);
      return;
    }
    const startMs = Date.now();
    const result = await opengrepClient.scan(analysisRoot);
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    if (result.success) {
      cacheManager.writeCache("opengrep", result, analysisRoot, {
        scanDurationMs: Date.now() - startMs,
      });
    }
    dbg(`session_start opengrep: ${result.findings.length} findings (${Date.now() - startMs}ms)`);
  });

  let callGraphIdentity: { reviewGraphVersion: string; reviewGraphSignature: string } | undefined;
  const callGraphTask = runTask("call-graph", async () => {
    const { FactStore } = await import("./dispatch/fact-store.ts");
    const { buildOrUpdateGraph, extractSymbolsAndRefsFromGraph, getReviewGraphCacheIdentity } =
      await import("./review-graph/builder.ts");
    const { buildCallGraph, saveCallGraph, loadCallGraph } = await import("./call-graph.ts");
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    const startMs = Date.now();
    const sessionFacts = new FactStore();
    const graph = await buildOrUpdateGraph(analysisRoot, [], sessionFacts);
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    const identity = getReviewGraphCacheIdentity(analysisRoot, graph);
    if (!identity) {
      dbg("session_start call-graph: canonical review-graph identity unavailable");
      return;
    }
    callGraphIdentity = {
      reviewGraphVersion: identity.version,
      reviewGraphSignature: identity.signature,
    };
    const cached = loadCallGraph(snapshotRoot, {
      reviewGraphVersion: identity.version,
      reviewGraphSignature: identity.signature,
    });
    if (cached) {
      runtime.callGraph = cached.graph;
      dbg(
        `session_start call-graph: loaded from cache (${cached.graph.edges.length} edges, ${cached.graph.callers.size} callee entries, ${Date.now() - startMs}ms)`,
      );
      return;
    }
    const { allSymbols, allRefs, coverage } = extractSymbolsAndRefsFromGraph(graph);
    const callGraph = buildCallGraph(allSymbols, allRefs, coverage);
    runtime.callGraph = callGraph;
    saveCallGraph(snapshotRoot, callGraph, {
      reviewGraphVersion: identity.version,
      reviewGraphSignature: identity.signature,
    });
    dbg(
      `session_start call-graph: built ${callGraph.edges.length} edges, ${callGraph.callers.size} callee entries (${Date.now() - startMs}ms)`,
    );
  });

  runTask("codebase-model", async () => {
    await callGraphTask;
    if (!runtime.isCurrentSession(sessionGeneration)) return;
    if (!runtime.callGraph) return;
    const { buildCodebaseModel, saveCodebaseModel, DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET } =
      await import("./codebase-model.ts");
    if (!callGraphIdentity) return;
    const model = buildCodebaseModel(
      runtime.callGraph,
      analysisRoot,
      DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET,
      callGraphIdentity,
    );
    saveCodebaseModel(snapshotRoot, model);
    const top3 = model.entries
      .slice(0, 3)
      .map((e) => e.name)
      .join(", ");
    dbg(
      `session_start codebase-model: ${model.entries.length} entries, ` +
        `${model.totalTokens} tokens, top symbols: ${top3 || "(none)"}`,
    );
  });

  runTask("ast-grep-exports", async () => {
    if (await astGrepClient.ensureAvailable()) {
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      const exports = await astGrepClient.scanExports(analysisRoot, "typescript");
      if (!runtime.isCurrentSession(sessionGeneration)) return;
      dbg(`session_start exports scan: ${exports.size} functions found`);
      for (const [name, file] of exports) {
        runtime.cachedExports.set(name, file);
      }
      saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
    }
  });

  runTask("word-index", async () => {
    await buildOrRefreshWordIndex({
      runtime,
      sessionGeneration,
      analysisRoot,
      snapshotRoot,
      dbg,
    });
  });
}

function scheduleDeferredToolProbes(
  deps: SessionStartDeps,
  languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
  startupDefaults: string[],
  _startupScansWillRun: boolean,
  dbg: SessionStartDeps["dbg"],
): void {
  const { biomeClient, ruffClient } = deps;
  const defaultTools = new Set(startupDefaults);
  const probes: Array<[name: string, run: () => Promise<boolean>]> = [];

  if (languageProfile.present.jsts && !defaultTools.has("biome")) {
    probes.push(["biome", () => biomeClient.ensureAvailable()]);
  }
  if (languageProfile.present.python && !defaultTools.has("ruff")) {
    probes.push(["ruff", () => ruffClient.ensureAvailable()]);
  }

  if (probes.length === 0) {
    dbg("session_start tools: no deferred availability probes needed");
    return;
  }

  void (async () => {
    const warmStart = Date.now();
    const results = await Promise.all(
      probes.map(async ([name, run]) => {
        try {
          return [name, await run()] as const;
        } catch (err) {
          dbg(`session_start: ${name} availability check failed: ${err}`);
          return [name, false] as const;
        }
      }),
    );
    const summary = results.map(([name, ready]) => `${name}=${ready}`).join(" ");
    dbg(`session_start tools (deferred probes complete, ${Date.now() - warmStart}ms): ${summary}`);
  })();
}

export const SESSION_START_GUIDANCE: string[] = [
  "📌 choco-pi-lsp active — automated checks run on every edit/write; blocking errors (including pre-existing) show inline and must be fixed.\n" +
    "Key tools (see each tool's own description for args):\n" +
    "• diagnostics_report — session-wide diagnostic state; mode=all resurfaces stale blocking errors that dropped from turn context.\n" +
    "• symbol_search → module_report → read_symbol/read_enclosing — ranked identifier search, then navigable outline/callback handles + exact body reads; cheaper than reading a whole file before editing.\n" +
    "• lsp_diagnostics — probe LSP for errors in a file/folder/workspace.\n" +
    "• Situational (activate via lsp_activate_tools): lsp_navigation, ast_grep_search, ast_grep_replace, ast_grep_dump.",
];

export async function handleSessionStart(deps: SessionStartDeps): Promise<void> {
  resetDegradationLedger();
  resetBoundedTelemetry();
  const handlerEnteredAt = Date.now();
  const sessionStartMs = deps.sessionStartFiredAt ?? handlerEnteredAt;
  const cwdForTelemetry = deps.ctxCwd ?? process.cwd();
  if (
    deps.bootstrapClientsStartedAt !== undefined &&
    deps.bootstrapClientsDurationMs !== undefined
  ) {
    logLatency({
      type: "phase",
      filePath: cwdForTelemetry,
      phase: "bootstrap_clients_load",
      startedAt: new Date(deps.bootstrapClientsStartedAt).toISOString(),
      durationMs: deps.bootstrapClientsDurationMs,
      metadata: {
        parent: "session_start_prehandler",
        reason: deps.sessionReason,
      },
    });
  }
  if (deps.sessionStartFiredAt !== undefined) {
    logLatency({
      type: "phase",
      filePath: cwdForTelemetry,
      phase: "session_start_prehandler",
      startedAt: new Date(deps.sessionStartFiredAt).toISOString(),
      durationMs: (deps.handlerEnteredAt ?? handlerEnteredAt) - deps.sessionStartFiredAt,
      metadata: { reason: deps.sessionReason },
    });
  }
  let startupMode = resolveStartupMode();

  // SAFETY: These optional process-global fields are created and consumed only by this module.
  const processGlobals = globalThis as typeof globalThis & {
    __piLensFirstSessionDone?: boolean;
    __piLensWarmupScheduled?: boolean;
  };
  const isFirstSessionOfProcess = !processGlobals.__piLensFirstSessionDone;
  if (
    isFirstSessionOfProcess &&
    process.env.CHOCO_PI_LSP_COLD_START_QUICK !== "0" &&
    !process.env.CHOCO_PI_LSP_STARTUP_MODE
  ) {
    startupMode = deps.startupModeOverride ?? "quick";
  }
  processGlobals.__piLensFirstSessionDone = true;

  if (
    startupMode === "quick" &&
    !isPrintMode() &&
    process.env.CHOCO_PI_LSP_COLD_START_QUICK !== "0" &&
    !processGlobals.__piLensWarmupScheduled
  ) {
    processGlobals.__piLensWarmupScheduled = true;
    const warmupDelayMs = Number(process.env.CHOCO_PI_LSP_WARMUP_DELAY_MS ?? 2000);
    const warmupCwd = deps.ctxCwd ?? process.cwd();
    const warmupDbg = deps.dbg;
    const warmupTimer = setTimeout(() => {
      const warmupStartedAt = Date.now();
      void (async () => {
        try {
          warmupDbg("warmup: starting background warmup");
          const scanContextStartedAt = Date.now();
          const startupScanModule = await import("./startup-scan.ts");
          const languageProfileModule = await import("./language-profile.ts");
          const warmupSnapshotRoot = resolveSnapshotRoot(warmupCwd);

          const cachedSnapshot = loadProjectSnapshot(warmupSnapshotRoot);
          const cachedVerdict = cachedSnapshot?.startupScan;
          let scan: StartupScanContext;
          if (cachedVerdict && startupScanModule.isStartupScanVerdictFresh(cachedVerdict)) {
            scan = { ...cachedVerdict, cwd: path.resolve(warmupCwd) };
            warmupDbg(
              `warmup: scan-context reused from cache (canWarm=${scan.canWarmCaches}${scan.reason ? `, reason=${scan.reason}` : ""})`,
            );
          } else {
            scan = await startupScanModule.resolveStartupScanContextAsync(warmupCwd);
            logLatency({
              type: "phase",
              phase: "session_start_scan_context_compute",
              filePath: warmupCwd,
              startedAt: new Date(scanContextStartedAt).toISOString(),
              durationMs: Date.now() - scanContextStartedAt,
              metadata: { mode: "quick-background" },
            });
            warmupDbg(
              `warmup: scan-context done in ${Date.now() - warmupStartedAt}ms (canWarm=${scan.canWarmCaches})`,
            );
            saveRuntimeProjectSnapshot({
              cwd: warmupSnapshotRoot,
              runtime: deps.runtime,
              startupScan: scan,
              dbg: warmupDbg,
            });
          }
          logLatency({
            type: "phase",
            phase: "warmup_scan_context",
            filePath: warmupCwd,
            startedAt: new Date(scanContextStartedAt).toISOString(),
            durationMs: Date.now() - scanContextStartedAt,
          });
          const lspConfig = await loadLSPConfig(warmupCwd).catch(() => ({
            // SAFETY: This fallback preserves loadLSPConfig's warmFiles boundary shape.
            warmFiles: [] as string[],
          }));
          const warmFiles = lspConfig.warmFiles ?? [];
          if (!scan.canWarmCaches) {
            warmupDbg(
              `warmup: skipping language-profile (canWarm=false, reason=${scan.reason ?? "unknown"})`,
            );
            if (
              warmFiles.length > 0 &&
              !deps.getFlag("no-lsp") &&
              !isSubagentSession() &&
              !isWarmAttached()
            ) {
              await igniteWarmFiles(
                warmupCwd,
                warmFiles,
                deps.runtime,
                deps.runtime.sessionGeneration,
                warmupDbg,
              );
            }
            return;
          }
          const languageRoot = scan.projectRoot ?? warmupCwd;
          const languageProfileStartedAt = Date.now();
          await languageProfileModule.detectProjectLanguageProfileAsync(languageRoot);
          warmupDbg(`warmup: language-profile done in ${Date.now() - languageProfileStartedAt}ms`);
          logLatency({
            type: "phase",
            phase: "warmup_language_profile",
            filePath: warmupCwd,
            startedAt: new Date(languageProfileStartedAt).toISOString(),
            durationMs: Date.now() - languageProfileStartedAt,
          });
          const wordIndexStartedAt = Date.now();
          const wordIndexResult = await buildOrRefreshWordIndex({
            runtime: deps.runtime,
            sessionGeneration: deps.runtime.sessionGeneration,
            analysisRoot: languageRoot,
            snapshotRoot: warmupSnapshotRoot,
            dbg: warmupDbg,
          });
          warmupDbg(`warmup: word-index done in ${Date.now() - wordIndexStartedAt}ms`);
          logLatency({
            type: "phase",
            phase: "warmup_word_index",
            filePath: warmupCwd,
            startedAt: new Date(wordIndexStartedAt).toISOString(),
            durationMs: Date.now() - wordIndexStartedAt,
            metadata: wordIndexResult ? { ...wordIndexResult } : undefined,
          });
          const lspPrewarmStartedAt = Date.now();
          if (deps.getFlag("no-lsp")) {
            warmupDbg("warmup: skipping LSP pre-warm (no-lsp)");
          } else if (isSubagentSession()) {
            warmupDbg("warmup: skipping LSP pre-warm (subagent session)");
          } else if (isWarmAttached()) {
            warmupDbg("warmup: skipping LSP pre-warm (attached to incumbent)");
          } else {
            const prewarmResult = await runLanguageServerPrewarm({
              warmFiles,
              automaticWarmupEnabled: shouldPrewarmLanguageServers(deps.getFlag),
              warmConfiguredFiles: (configuredFiles) =>
                igniteWarmFiles(
                  warmupCwd,
                  configuredFiles,
                  deps.runtime,
                  deps.runtime.sessionGeneration,
                  warmupDbg,
                ),
              warmDominantLanguage: () =>
                igniteDominantLanguageWarm(
                  languageRoot,
                  deps.runtime,
                  deps.runtime.sessionGeneration,
                  warmupDbg,
                ),
            });
            if (prewarmResult === "disabled") {
              warmupDbg("warmup: skipping LSP pre-warm (warmup disabled)");
            }
            logLatency({
              type: "phase",
              phase: "warmup_lsp_prewarm",
              filePath: warmupCwd,
              startedAt: new Date(lspPrewarmStartedAt).toISOString(),
              durationMs: Date.now() - lspPrewarmStartedAt,
            });
            warmupDbg(`warmup: lsp-prewarm done in ${Date.now() - lspPrewarmStartedAt}ms`);
          }
          warmupDbg(`warmup: total ${Date.now() - warmupStartedAt}ms`);
        } catch (err) {
          warmupDbg(`warmup: error ${err}`);
          processGlobals.__piLensWarmupScheduled = false;
        } finally {
          logLatency({
            type: "phase",
            phase: "warmup_total",
            filePath: warmupCwd,
            startedAt: new Date(warmupStartedAt).toISOString(),
            durationMs: Date.now() - warmupStartedAt,
          });
        }
      })();
    }, warmupDelayMs);
    warmupTimer.unref?.();
  }

  const allowBootstrapTasks = startupMode === "full";
  const quickMode = startupMode === "quick";
  const {
    ctxCwd,
    getFlag,
    notify,
    dbg,
    log,
    runtime,
    metricsClient,
    cacheManager,
    testRunnerClient,
    goClient,
    rustClient,
    ensureTool,
    cleanStaleTsBuildInfo,
    resetDispatchBaselines,
    resetLSPService,
  } = deps;

  let _phaseT = Date.now();
  const phase = (name: string): void => {
    dbg(`session_start phase ${name}: ${Date.now() - _phaseT}ms`);
    _phaseT = Date.now();
  };

  metricsClient.reset();
  getDiagnosticTracker().reset();
  clearFileTimeSessions();
  runtime.complexityBaselines.clear();
  resetDispatchBaselines(ctxCwd);
  resetWorkspaceTopology();
  clearTsconfigPathsCache();
  resetSafeSpawnWindowsCommandCache();
  resetDispatchAvailabilityState();
  resetZizmorTokenAvailability();
  resetPsScriptAnalyzerAvailability();
  resetInstallRetryLatches();
  resetLazyInstallAttempts();
  _resetPackageManagerCache();
  resetManagedToolRefreshSession();
  resetSmellsSessionState();
  runtime.resetForSession(sessionStartMs);
  logLatency({
    type: "phase",
    phase: "session_start_runtime_reset",
    filePath: ctxCwd ?? process.cwd(),
    startedAt: new Date(handlerEnteredAt).toISOString(),
    durationMs: Date.now() - handlerEnteredAt,
    metadata: { mode: startupMode, reason: deps.sessionReason },
  });

  const cleanupCwd = ctxCwd ?? process.cwd();
  setImmediate(() => {
    const logCleanupStartedAt = Date.now();
    try {
      const logCleanup = runLogCleanup(dbg);
      logLatency({
        type: "phase",
        phase: "session_start_log_cleanup",
        filePath: cleanupCwd,
        startedAt: new Date(logCleanupStartedAt).toISOString(),
        durationMs: Date.now() - logCleanupStartedAt,
        metadata: {
          mode: startupMode,
          reason: deps.sessionReason,
          deferred: true,
        },
      });
      if (logCleanup.cleaned > 0 || logCleanup.rotated > 0) {
        notify(`🧹 ${logCleanup.report}`, "info");
      }
    } catch (err) {
      dbg(`session_start: deferred log cleanup failed: ${err}`);
    }
  });
  dbg(`session_start startup mode: ${startupMode}`);

  if (!getFlag("no-lsp")) {
    resetLSPService({ fast: true, reason: "session_start" });
    dbg("session_start: LSP service reset");
    dbg("session_start: phase0 workspace diagnostics observation enabled (capability probe only)");
  }

  const hasWorkspaceCwd = isString(ctxCwd) && ctxCwd.length > 0;
  const cwd = ctxCwd ?? process.cwd();
  const projectDataDir = getProjectDataDir(cwd);
  const globalDir = getGlobalPiLensDir();
  void sweepAtomicWriteStages([
    projectDataDir,
    path.join(projectDataDir, "cache"),
    path.join(projectDataDir, "sessions"),
    globalDir,
    path.join(globalDir, "bin"),
    path.join(globalDir, "tools"),
  ]).catch(() => {});
  if (quickMode) {
    runtime.projectRoot = cwd;
    const sequenceReadStartedAt = Date.now();
    const snapshotRoot = resolveSnapshotRoot(cwd);
    const { latestSeq, timedOut } = await readSequenceWithBudget({
      snapshotRoot,
      base: snapshotSequenceBase(snapshotRoot),
      cwd,
      runtime,
      sessionGeneration: runtime.sessionGeneration,
      dbg,
    });
    logLatency({
      type: "phase",
      phase: "session_start_sequence_read",
      filePath: cwd,
      startedAt: new Date(sequenceReadStartedAt).toISOString(),
      durationMs: Date.now() - sequenceReadStartedAt,
      metadata: { entries: latestSeq.fileSeqByPath.size, timedOut },
    });
    runtime.seedProjectSequence?.(latestSeq.projectSeq, latestSeq.fileSeqByPath);
    const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
    dbg(
      `session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
    );
    const freshnessSeq = timedOut ? UNKNOWN_PROJECT_SEQ : effectiveSeq;
    const snapshotLoadStartedAt = Date.now();
    const snapshotPath = getProjectSnapshotPath(snapshotRoot);
    let snapshotBytes = 0;
    try {
      snapshotBytes = nodeFs.statSync(snapshotPath).size;
    } catch {}
    const snapshotGate = loadSnapshotBodyUnlessStale({
      root: snapshotRoot,
      currentProjectSeq: freshnessSeq,
      dbg,
    });
    const snapshot = snapshotGate.snapshot;
    const snapshotFresh = isProjectSnapshotFresh(snapshot, freshnessSeq);
    logLatency({
      type: "phase",
      phase: "session_start_snapshot_load",
      filePath: cwd,
      startedAt: new Date(snapshotLoadStartedAt).toISOString(),
      durationMs: Date.now() - snapshotLoadStartedAt,
      metadata: assignOptionalProperties(
        assignOptionalProperties(
          { bytes: snapshotBytes, fresh: snapshotFresh, seq: snapshot?.seq ?? null },
          snapshotGate.skippedStale,
          () => ({ skippedStale: true }),
        ),
        timedOut,
        () => ({ sequenceUnknown: true }),
      ),
    });
    logProjectSnapshotProbe({
      dbg,
      root: snapshotRoot,
      currentProjectSeq: freshnessSeq,
      snapshot,
    });
    if (snapshotFresh) {
      hydrateRuntimeFromProjectSnapshot(runtime, snapshot);
    }
    const quickTools: string[] = [];
    if (!getFlag("no-lsp")) {
      quickTools.push("LSP Service");
    }
    log(`Active tools: ${quickTools.join(", ")}`);
    dbg(`session_start tools: ${quickTools.join(", ") || "deferred (quick mode)"}`);
    dbg(
      "session_start: quick mode active - skipping slow tool probes, language profiling, preinstall, scans, and error debt baseline",
    );
    const totalDurationMs = Date.now() - sessionStartMs;
    dbg(`session_start total: ${totalDurationMs}ms (interactive path)`);
    logLatency({
      type: "phase",
      phase: "session_start_total",
      filePath: cwd,
      startedAt: new Date(sessionStartMs).toISOString(),
      durationMs: totalDurationMs,
      metadata: { mode: startupMode, reason: deps.sessionReason },
    });
    emitSmellsSessionStartLine(dbg, sessionStartMs);
    return;
  }

  const tools: string[] = [];
  if (!getFlag("no-lsp")) tools.push("LSP Service");

  if (allowBootstrapTasks && !getFlag("no-lsp")) {
    const cleaned = cleanStaleTsBuildInfo(ctxCwd ?? process.cwd());
    if (cleaned.length > 0) {
      notify(
        `🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
        "warning",
      );
      dbg(`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`);
    }
  }

  const sessionGeneration = runtime.sessionGeneration;
  const sequenceReadStartedAt = Date.now();
  const snapshotRoot = resolveSnapshotRoot(cwd);
  const { latestSeq, timedOut } = await readSequenceWithBudget({
    snapshotRoot,
    base: snapshotSequenceBase(snapshotRoot),
    cwd,
    runtime,
    sessionGeneration,
    dbg,
  });
  logLatency({
    type: "phase",
    phase: "session_start_sequence_read",
    filePath: cwd,
    startedAt: new Date(sequenceReadStartedAt).toISOString(),
    durationMs: Date.now() - sequenceReadStartedAt,
    metadata: { entries: latestSeq.fileSeqByPath.size, timedOut },
  });
  runtime.seedProjectSequence?.(latestSeq.projectSeq, latestSeq.fileSeqByPath);
  const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
  dbg(
    `session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
  );
  const freshnessSeq = timedOut ? UNKNOWN_PROJECT_SEQ : effectiveSeq;

  const snapshotLoadStartedAt = Date.now();
  const snapshotPath = getProjectSnapshotPath(snapshotRoot);
  let snapshotBytes = 0;
  try {
    snapshotBytes = nodeFs.statSync(snapshotPath).size;
  } catch {}
  const snapshotGate = loadSnapshotBodyUnlessStale({
    root: snapshotRoot,
    currentProjectSeq: freshnessSeq,
    dbg,
  });
  const snapshot = snapshotGate.snapshot;
  const snapshotFresh = isProjectSnapshotFresh(snapshot, freshnessSeq);
  logLatency({
    type: "phase",
    phase: "session_start_snapshot_load",
    filePath: cwd,
    startedAt: new Date(snapshotLoadStartedAt).toISOString(),
    durationMs: Date.now() - snapshotLoadStartedAt,
    metadata: assignOptionalProperties(
      assignOptionalProperties(
        { bytes: snapshotBytes, fresh: snapshotFresh, seq: snapshot?.seq ?? null },
        snapshotGate.skippedStale,
        () => ({ skippedStale: true }),
      ),
      timedOut,
      () => ({ sequenceUnknown: true }),
    ),
  });
  logProjectSnapshotProbe({
    dbg,
    root: snapshotRoot,
    currentProjectSeq: freshnessSeq,
    snapshot,
  });
  const freshSnapshot = snapshotFresh ? snapshot : null;
  if (freshSnapshot) {
    hydrateRuntimeFromProjectSnapshot(runtime, freshSnapshot);
  }

  const cachedStartupScan =
    freshSnapshot?.startupScan && isStartupScanVerdictFresh(freshSnapshot.startupScan)
      ? freshSnapshot.startupScan
      : undefined;
  const startupScanSource = cachedStartupScan ? "snapshot" : "computed";
  let startupScan: StartupScanContext;
  if (cachedStartupScan) {
    startupScan = { ...cachedStartupScan, cwd: path.resolve(cwd) };
  } else {
    const scanContextStartedAt = Date.now();
    startupScan = resolveStartupScanContext(cwd);
    logLatency({
      type: "phase",
      phase: "session_start_scan_context_compute",
      filePath: cwd,
      startedAt: new Date(scanContextStartedAt).toISOString(),
      durationMs: Date.now() - scanContextStartedAt,
      metadata: { mode: startupMode },
    });
  }
  phase("scan-context");
  dbg(`session_start scan-context source=${startupScanSource}`);
  const scanRoot = startupScan.projectRoot ?? cwd;
  const useScanRootForSignals =
    startupScan.canWarmCaches ||
    startupScan.reason === "too-many-source-files" ||
    startupScan.reason === "too-many-entries";
  const analysisRoot = useScanRootForSignals ? scanRoot : cwd;
  runtime.projectRoot = cwd;
  const languageProfileSource = freshSnapshot?.languageProfile ? "snapshot" : "computed";
  const languageProfile = freshSnapshot?.languageProfile
    ? freshSnapshot.languageProfile
    : detectProjectLanguageProfile(analysisRoot, startupScan.canWarmCaches ? undefined : []);
  phase("language-profile");
  dbg(`session_start language-profile source=${languageProfileSource}`);
  dbg(`session_start cwd: ${cwd}`);
  dbg(
    `session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
  );
  dbg(`session_start analysis root: ${analysisRoot}`);
  dbg(`session_start workspace root: ${runtime.projectRoot}`);
  dbg(`session_start language profile: ${languageProfile.detectedKinds.join(", ") || "none"}`);
  dbg(
    `session_start language counts: ${JSON.stringify(languageProfile.counts)} configured=${JSON.stringify(languageProfile.configured)}`,
  );
  dbg(`session_start workspace cwd available: ${hasWorkspaceCwd}`);
  if (useScanRootForSignals && analysisRoot !== cwd) {
    dbg(`session_start: monorepo analysis root override -> ${analysisRoot}`);
  }

  const slowFsVerdict = getSlowFsVerdict(analysisRoot);
  logLatency({
    type: "phase",
    phase: "slow_fs_probe",
    filePath: analysisRoot,
    durationMs: 0,
    metadata: {
      slow: slowFsVerdict.slow,
      medianStatMicros: slowFsVerdict.medianStatMicros,
      samples: slowFsVerdict.samples,
    },
  });
  dbg(
    `session_start slow-fs probe: slow=${slowFsVerdict.slow} medianStatMicros=${slowFsVerdict.medianStatMicros.toFixed(1)} samples=${slowFsVerdict.samples}`,
  );
  if (slowFsVerdict.slow) {
    notify(
      `🐢 Slow filesystem detected (median ${slowFsVerdict.medianStatMicros.toFixed(0)}µs/stat) — reduced-scan mode engaged (set CHOCO_PI_LSP_ALLOW_SLOW_FS_SCAN=1 to override).`,
      "warning",
    );
  }

  const subagentSession = isSubagentSession();
  const warmAttached = isWarmAttached();
  if (warmAttached) {
    dbg("session_start lsp-warm: skipping pre-warm (attached to incumbent)");
  } else if (subagentSession) {
    const identity = getSubagentIdentity();
    logLatency({
      type: "phase",
      phase: "subagent_light_mode",
      filePath: analysisRoot,
      durationMs: 0,
      metadata: {
        runId: identity?.runId,
        agentName: identity?.agentName,
        marker: identity?.marker,
      },
    });
    dbg(
      `session_start subagent light mode: engaged (marker=${identity?.marker ?? "unknown"} runId=${identity?.runId ?? "unknown"} agentName=${identity?.agentName ?? "unknown"})`,
    );
  }

  const lensLspEnabled = !getFlag("no-lsp");
  const startupDefaults = getDefaultStartupTools(languageProfile).filter((tool) => {
    if ((tool === "typescript-language-server" || tool === "pyright") && !lensLspEnabled) {
      return false;
    }
    return true;
  });

  if (!allowBootstrapTasks) {
    dbg("session_start: skipping tool preinstall (startup mode)");
  } else if (startupDefaults.length > 0) {
    dbg(`session_start: pre-install defaults -> ${startupDefaults.join(", ")}`);
    firePreinstallDefaults(ensureTool, dbg, startupDefaults);
  } else {
    dbg("session_start: no language defaults selected for pre-install");
  }

  const startupScansWillRun = allowBootstrapTasks && startupScan.canWarmCaches;
  const jstsHeavyScansWillRun =
    startupScansWillRun && canRunStartupHeavyScans(languageProfile, "jsts");
  if (allowBootstrapTasks) {
    scheduleDeferredToolProbes(deps, languageProfile, startupDefaults, jstsHeavyScansWillRun, dbg);
    scheduleManagedToolRefresh(dbg);
  }

  if (allowBootstrapTasks) {
    void probePrettierInstall(ensureTool, dbg, analysisRoot);
  } else {
    dbg("session_start: skipping prettier preinstall probe (startup mode)");
  }

  const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
  phase("test-runner-detect");
  if (detectedRunner) tools.push(`Test runner (${detectedRunner.runner})`);
  if (await goClient.isGoAvailableAsync()) tools.push("Go (go vet)");
  if (await rustClient.isAvailableAsync()) tools.push("Rust (cargo)");
  log(`Active tools: ${tools.join(", ")}`);
  dbg(`session_start tools: ${tools.join(", ")}`);

  const agentStartupGuidance = SESSION_START_GUIDANCE;

  runtime.projectRulesScan = scanProjectRules(analysisRoot);
  saveRuntimeProjectSnapshot({
    cwd: snapshotRoot,
    runtime,
    startupScan,
    languageProfile,
    dbg,
  });
  phase("project-rules");
  if (runtime.projectRulesScan.hasCustomRules) {
    const ruleCount = runtime.projectRulesScan.rules.length;
    const sources = [...new Set(runtime.projectRulesScan.rules.map((r) => r.source))];
    dbg(`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`);
  } else {
    dbg("session_start: no project rules found");
  }

  cacheManager.writeCache(
    "session-start-guidance",
    { content: agentStartupGuidance.join("\n") },
    analysisRoot,
  );

  if (!allowBootstrapTasks) {
    dbg("session_start: skipping startup background scans (startup mode)");
  } else if (!startupScan.canWarmCaches) {
    dbg(`session_start: skipping heavy scans (${startupScan.reason ?? "unknown"})`);
    dbg(`session_start: skipping TODO scan (${startupScan.reason ?? "unknown"})`);
    if (
      startupScan.reason === "too-many-source-files" ||
      startupScan.reason === "too-many-entries"
    ) {
      const overrideHint =
        startupScan.reason === "too-many-entries"
          ? ` (set CHOCO_PI_LSP_STARTUP_SCAN_MAX_ENTRIES=<n> to override the ${getStartupScanMaxEntries()}-entry cap)`
          : "";
      notify(
        `📦 Project-size limits disabled background warm scans (heavy scans, TODO scan, LSP pre-warm)${overrideHint}.`,
        "warning",
      );
    }
  } else {
    scheduleStartupScans(
      deps,
      runtime,
      sessionGeneration,
      analysisRoot,
      snapshotRoot,
      languageProfile,
      dbg,
    );
  }

  if (warmAttached) {
  } else if (subagentSession) {
    dbg("session_start lsp-warm: skipping pre-warm (subagent session)");
  } else if (!getFlag("no-lsp") && allowBootstrapTasks) {
    setImmediate(() => {
      void loadLSPConfig(cwd)
        .then(async (lspConfig) => {
          const warmFiles = lspConfig.warmFiles ?? [];
          dbg(`session_start lsp-config: loaded (${warmFiles.length} warm file(s) configured)`);
          const automaticWarmupEnabled = shouldPrewarmLanguageServers(getFlag);
          if (automaticWarmupEnabled && !startupScan.canWarmCaches && warmFiles.length === 0) {
            dbg(
              `session_start lsp-warm: skipping dominant-language auto-warm (${startupScan.reason ?? "unknown"})`,
            );
            return;
          }
          const prewarmResult = await runLanguageServerPrewarm({
            warmFiles,
            automaticWarmupEnabled,
            warmConfiguredFiles: (configuredFiles) =>
              igniteWarmFiles(cwd, configuredFiles, runtime, sessionGeneration, dbg),
            warmDominantLanguage: () =>
              igniteDominantLanguageWarm(analysisRoot, runtime, sessionGeneration, dbg),
          });
          if (prewarmResult === "disabled") {
            dbg("session_start lsp-warm: skipping pre-warm (warmup disabled)");
          }
        })
        .catch((err) => dbg(`session_start lsp-warm: unhandled error: ${err}`));
    });
    phase("lsp-config");
  }

  setSessionLanguages(languageProfile.detectedKinds);

  const totalDurationMs = Date.now() - sessionStartMs;
  dbg(
    `session_start total: ${totalDurationMs}ms (interactive path; background tasks may continue)`,
  );
  logLatency({
    type: "phase",
    phase: "session_start_total",
    filePath: cwd,
    startedAt: new Date(sessionStartMs).toISOString(),
    durationMs: totalDurationMs,
    metadata: { mode: startupMode, reason: deps.sessionReason },
  });
  emitSmellsSessionStartLine(dbg, sessionStartMs);
}

function emitSmellsSessionStartLine(dbg: (msg: string) => void, sessionStartMs: number): void {
  try {
    const line = formatSmellsSessionStartLine(countRecentSmells(undefined, sessionStartMs));
    if (line) dbg(line);
  } catch {}
}
