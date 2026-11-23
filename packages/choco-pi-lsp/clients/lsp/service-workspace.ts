import * as nodeFs from "node:fs";
import path from "node:path";
import { applyAuxiliarySuppressions } from "../dispatch/auxiliary-lsp.ts";
import { detectFileRole } from "../file-role.ts";
import { logLatency } from "../latency-logger.ts";
import { withDeadline } from "../deadline-utils.ts";
import { acquireWorkspaceSweepHold } from "./workspace-sweep-hold.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { touchCoverageGap } from "./diagnostic-binding.ts";
import { getLanguageId } from "./language.ts";
import {
  buildScopeKey,
  createWorkspaceDiagnosticsCacheContext,
} from "./workspace-diagnostics-cache.ts";
import { isWarmAttached, tryWarmAttachedDiagnostics } from "../warm-attach.ts";
import { checkDestroyed, demonstratedReadyKeyFor } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { auxNotifyBacklogAtCeiling, noteAuxNotifyIssued } from "./service-notify-pacing.ts";
import {
  getMaxWorkspaceDiagnosticFiles,
  WORKSPACE_DIAGNOSTICS_CONCURRENCY,
  WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
  WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE,
  workspacePullBudgetMs,
} from "./service-tunables.ts";
import type {
  LSPWorkspaceDiagnosticResult,
  LSPWorkspaceUnconfirmedReason,
} from "./service-types.ts";
import {
  collectWorkspaceDiagnosticFiles,
  createSweepIndexGate,
  groupFilesByPrimaryServer,
  runPerServerGroups,
} from "./service-workspace-files.ts";

export async function runWorkspaceDiagnostics(
  core: LSPServiceInternals,
  cwd: string,
  options: {
    maxFiles?: number;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
    onServerReady?: () => void;
    nextWriteIndex?: () => number;
    files?: string[];
  } = {},
): Promise<LSPWorkspaceDiagnosticResult[]> {
  const releaseSweepHold = acquireWorkspaceSweepHold();
  try {
    return await runWorkspaceDiagnosticsSwept(core, cwd, options);
  } finally {
    releaseSweepHold();
  }
}

export async function runWorkspaceDiagnosticsSwept(
  core: LSPServiceInternals,
  cwd: string,
  options: {
    maxFiles?: number;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
    onServerReady?: () => void;
    nextWriteIndex?: () => number;
    files?: string[];
  } = {},
): Promise<LSPWorkspaceDiagnosticResult[]> {
  const startedAt = Date.now();
  const root = path.resolve(cwd);
  const { signal } = options;
  const maxFiles =
    options.maxFiles !== undefined && Number.isFinite(options.maxFiles) && options.maxFiles > 0
      ? Math.floor(options.maxFiles)
      : getMaxWorkspaceDiagnosticFiles();
  const files = options.files
    ? options.files.slice(0, maxFiles)
    : await collectWorkspaceDiagnosticFiles(root, maxFiles, signal);
  const perFileMs = (() => {
    const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PER_FILE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
  })();
  const results: LSPWorkspaceDiagnosticResult[] = [];
  let completed = 0;
  let timedOutFiles = 0;
  let lastHeartbeat = Date.now();

  const workspaceDiagnosticsCacheCtx = createWorkspaceDiagnosticsCacheContext(root);
  const workspaceSweepScopeKey = buildScopeKey("all", [...WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS]);
  const cachedResults: LSPWorkspaceDiagnosticResult[] = [];
  const filesToTouch: string[] = [];
  const writeIndexByPath = new Map<string, number | undefined>();
  for (const filePath of files) {
    writeIndexByPath.set(normalizeMapKey(filePath), options.nextWriteIndex?.());
    const cached = workspaceDiagnosticsCacheCtx.lookup(filePath, workspaceSweepScopeKey);
    if (cached && cached.binding.boundToCurrentDisk !== false) {
      cachedResults.push({
        filePath,
        diagnostics: cached.diagnostics,
        count: cached.count,
        observedAt: cached.scannedAt,
        contentHash: cached.binding.contentHash,
        boundToCurrentDisk: cached.binding.boundToCurrentDisk,
        writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
      });
    } else {
      filesToTouch.push(filePath);
    }
  }
  completed = cachedResults.length;
  if (cachedResults.length > 0) {
    options.onProgress?.(completed, files.length);
  }
  const scannedMtimeByFile = new Map<string, number>();

  const groups = groupFilesByPrimaryServer(filesToTouch);
  const sweepIndexGate = createSweepIndexGate();
  const workspacePullEnabled = process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PULL === "1";

  logLatency({
    type: "phase",
    phase: "lsp_workspace_diagnostics_start",
    filePath: root,
    durationMs: 0,
    metadata: {
      fileCount: files.length,
      cacheHits: cachedResults.length,
      filesToTouch: filesToTouch.length,
      maxFiles,
      perFileMs,
      serverGroups: groups.length,
    },
  });

  const contentCache = new Map<string, string>();
  const preOpenGroupFiles = async (groupFiles: readonly string[]): Promise<void> => {
    if (isWarmAttached()) return;
    for (const filePath of groupFiles) {
      if (signal?.aborted) return;
      let content: string;
      try {
        content = await nodeFs.promises.readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      contentCache.set(filePath, content);
      const languageId = getLanguageId(filePath) ?? "plaintext";
      const preOpenAttempt = withDeadline(
        (async () => {
          const { clients } = await core.service.getClientsForFile(
            filePath,
            WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
          );
          for (const entry of clients) {
            let auxKey: string | undefined;
            if (entry.info.role === "auxiliary") {
              auxKey = await demonstratedReadyKeyFor(core, entry.info, filePath);
              if (auxKey && auxNotifyBacklogAtCeiling(core, auxKey, entry)) {
                continue;
              }
            }
            try {
              await entry.client.notify.open(filePath, content, languageId);
              if (auxKey) noteAuxNotifyIssued(core, auxKey, entry.client);
            } catch {}
          }
        })(),
        { ms: perFileMs, onTimeout: "undefined" },
      );
      await (signal
        ? Promise.race([
            preOpenAttempt,
            new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }),
          ])
        : preOpenAttempt);
    }
  };

  const markServiceDestroyed = (remainingFiles: readonly string[]): void => {
    for (const filePath of remainingFiles) {
      results.push({
        filePath,
        diagnostics: [],
        count: 0,
        timedOut: true,
        unconfirmedReason: "service_destroyed",
        writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
      });
      timedOutFiles += 1;
      completed += 1;
    }
    options.onProgress?.(completed, files.length);
  };

  const processFile = async (filePath: string): Promise<void> => {
    try {
      const content =
        contentCache.get(filePath) ?? (await nodeFs.promises.readFile(filePath, "utf-8"));
      try {
        scannedMtimeByFile.set(filePath, nodeFs.statSync(filePath).mtimeMs);
      } catch {}
      const attached = isWarmAttached()
        ? await tryWarmAttachedDiagnostics(filePath, content, perFileMs, "sweep")
        : undefined;
      if (attached && !attached.available) {
        await core.service.ensureWarmForSweep(filePath, { signal });
      }
      const touchResult = attached?.available
        ? {
            diags: attached.response.diagnostics,
            ...(attached.response.unconfirmedServerIds !== undefined && {
              unconfirmedServerIds: attached.response.unconfirmedServerIds,
            }),
          }
        : await withDeadline(
            core.service.touchFile(filePath, content, {
              diagnostics: "document",
              collectDiagnostics: true,
              clientScope: "all",
              source: "lens_diagnostics_full",
              excludeServerIds: WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
              sweepIndexGate,
            }),
            { ms: perFileMs, onTimeout: "undefined" },
          );
      const diagnostics = touchResult?.diags;
      const inconclusive = touchResult?.inconclusive === true;
      const coverageGap = touchCoverageGap(touchResult).length > 0;
      const timedOut = touchResult === undefined || inconclusive || coverageGap;
      if (timedOut) timedOutFiles += 1;
      const unconfirmedReason: LSPWorkspaceUnconfirmedReason | undefined =
        touchResult === undefined
          ? "budget"
          : inconclusive
            ? "inconclusive"
            : coverageGap
              ? "coverage_gap"
              : undefined;
      const rawBinding = touchResult?.binding;
      const filteredDiagnostics = diagnostics
        ? applyAuxiliarySuppressions(diagnostics, content, {
            fileRole: detectFileRole(filePath, content),
          })
        : diagnostics;
      results.push({
        filePath,
        diagnostics: filteredDiagnostics ?? [],
        count: filteredDiagnostics?.length ?? 0,
        timedOut,
        unconfirmedReason,
        contentHash: rawBinding?.contentHash,
        boundToCurrentDisk: rawBinding?.boundToCurrentDisk,
        writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
      });
    } catch (err) {
      results.push({
        filePath,
        diagnostics: [],
        count: 0,
        error: err instanceof Error ? err.message : String(err),
        timedOut: true,
        unconfirmedReason: "error",
        writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
      });
    }
    completed += 1;
    options.onProgress?.(completed, files.length);
    if (Date.now() - lastHeartbeat >= 10_000) {
      lastHeartbeat = Date.now();
      logLatency({
        type: "phase",
        phase: "lsp_workspace_diagnostics_progress",
        filePath: root,
        durationMs: Date.now() - startedAt,
        metadata: {
          completed,
          total: files.length,
          timedOutFiles,
          aborted: signal?.aborted ?? false,
        },
      });
    }
  };

  const groupWorkers = Math.min(WORKSPACE_DIAGNOSTICS_CONCURRENCY, groups.length);
  await runPerServerGroups(
    groups,
    groupWorkers,
    async (group) => {
      if (signal?.aborted) return;
      if (checkDestroyed(core)) {
        markServiceDestroyed(group.files);
        return;
      }
      if (!isWarmAttached() && workspacePullEnabled && !group.multiServer) {
        const pulled = await tryWorkspacePull(core, group.files, perFileMs);
        if (pulled) {
          for (const result of pulled) {
            results.push({
              ...result,
              writeIndex: writeIndexByPath.get(normalizeMapKey(result.filePath)),
            });
            try {
              scannedMtimeByFile.set(result.filePath, nodeFs.statSync(result.filePath).mtimeMs);
            } catch {}
          }
          completed += group.files.length;
          options.onProgress?.(completed, files.length);
          return;
        }
      }
      const first = group.files[0];
      if (first && !isWarmAttached()) {
        const warmup = await core.service.ensureWarmForSweep(first, { signal });
        if (signal?.aborted) return;
        if (warmup.failedServerIds.length > 0) {
          logLatency({
            type: "phase",
            phase: "lsp_sweep_group_skipped_warmup",
            filePath: first,
            durationMs: 0,
            metadata: {
              failedServerIds: warmup.failedServerIds,
              skippedFromCache: warmup.skippedFromCache ?? false,
              skippedFiles: group.files.length,
            },
          });
          for (const filePath of group.files) {
            results.push({
              filePath,
              diagnostics: [],
              count: 0,
              timedOut: true,
              unconfirmedReason: "inconclusive",
              skippedWarmupFailure: true,
            });
            timedOutFiles += 1;
            completed += 1;
          }
          options.onProgress?.(completed, files.length);
          return;
        }
        if (warmup.performedWarmup) options.onServerReady?.();
      }
      for (
        let chunkStart = 0;
        chunkStart < group.files.length;
        chunkStart += WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE
      ) {
        if (signal?.aborted) return;
        if (checkDestroyed(core)) {
          markServiceDestroyed(group.files.slice(chunkStart));
          return;
        }
        const chunk = group.files.slice(
          chunkStart,
          chunkStart + WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE,
        );
        await preOpenGroupFiles(chunk);
        for (const filePath of chunk) {
          if (signal?.aborted) return;
          if (checkDestroyed(core)) {
            markServiceDestroyed(group.files.slice(group.files.indexOf(filePath)));
            return;
          }
          await processFile(filePath);
        }
      }
    },
    signal,
  );

  const unconfirmedByReason: Partial<Record<LSPWorkspaceUnconfirmedReason, number>> = {};
  for (const result of results) {
    if (!result.timedOut) continue;
    const reason = result.unconfirmedReason ?? "budget";
    unconfirmedByReason[reason] = (unconfirmedByReason[reason] ?? 0) + 1;
  }
  logLatency({
    type: "phase",
    phase: "lsp_workspace_diagnostics",
    filePath: root,
    durationMs: Date.now() - startedAt,
    metadata: {
      filesChecked: files.length,
      cacheHits: cachedResults.length,
      diagnosticCount: results.reduce((sum, result) => sum + (result?.count ?? 0), 0),
      serverGroups: groups.length,
      concurrency: groupWorkers,
      maxFiles,
      timedOutFiles,
      unconfirmedByReason,
      aborted: signal?.aborted ?? false,
    },
  });

  for (const result of results) {
    const scannedAt = scannedMtimeByFile.get(result.filePath);
    if (result.error || result.timedOut || scannedAt === undefined) continue;
    workspaceDiagnosticsCacheCtx.record(
      result.filePath,
      workspaceSweepScopeKey,
      result.diagnostics,
      scannedAt,
      result.contentHash,
    );
  }
  workspaceDiagnosticsCacheCtx.persist();

  return [...cachedResults, ...results].filter(Boolean);
}

export async function tryWorkspacePull(
  core: LSPServiceInternals,
  groupFiles: string[],
  perFileMs: number,
): Promise<LSPWorkspaceDiagnosticResult[] | undefined> {
  try {
    const first = groupFiles[0];
    if (!first) return undefined;
    const spawned = await core.service.getClientForFile(first, perFileMs);
    if (!spawned) return undefined;
    if (!spawned.client.getWorkspaceDiagnosticsSupport().workspaceDiagnostics) {
      return undefined;
    }
    const report = await spawned.client.requestWorkspaceDiagnostics(
      Math.max(perFileMs, workspacePullBudgetMs()),
    );
    if (!report) return undefined;
    const byPath = new Map<
      string,
      {
        diagnostics: import("./client.ts").LSPDiagnostic[];
        contentHash?: string;
      }
    >();
    for (const entry of report) {
      byPath.set(normalizeMapKey(entry.filePath), entry);
    }
    return groupFiles.map((filePath) => {
      const entry = byPath.get(normalizeMapKey(filePath));
      const diagnostics = entry?.diagnostics ?? [];
      return {
        filePath,
        diagnostics,
        count: diagnostics.length,
        timedOut: false,
        contentHash: entry?.contentHash,
      };
    });
  } catch {
    return undefined;
  }
}
