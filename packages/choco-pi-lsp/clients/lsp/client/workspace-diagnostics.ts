import { readFile } from "node:fs/promises";
import { emitBounded } from "../../bounded-telemetry.ts";
import { withTimeout } from "../../deadline-utils.ts";
import { incrementDegradationCount } from "../../degradation-ledger.ts";
import { hashDiagnosticContent } from "../diagnostic-binding.ts";
import { normalizeMapKey, uriToPath } from "../../path-utils.ts";
import { getStrategy } from "../wait-policy/index.ts";
import {
  PULL_DIAGNOSTICS_RETRY_INTERVAL_MS,
  PULL_MIN_USABLE_BUDGET_MS,
  WORKSPACE_PULL_RESULT_CACHE_MAX,
  WORKSPACE_PULL_SCOPE,
} from "./constants.ts";
import {
  diagnosticsVersionForPath,
  getMergedDiagnosticsForPath,
  logTypeScriptPullSettle,
  normalizeLspDiagnostics,
} from "./diagnostics-store.ts";
import { isClientAlive } from "./process.ts";
import {
  armLateAnswerTelemetry,
  clientRequestPullDiagnostics,
  isPullTimeoutError,
  recordPullFailure,
  recordPullTimeoutTelemetry,
} from "./pull-diagnostics.ts";
import { safeSendRequest } from "./transport.ts";
import type { LSPClientState, LSPDiagnostic } from "./types.ts";

export async function clientRequestWorkspaceDiagnostics(
  state: LSPClientState,
  budgetMs: number,
): Promise<
  | Array<{
      filePath: string;
      diagnostics: LSPDiagnostic[];
      contentHash?: string;
    }>
  | undefined
> {
  if (!isClientAlive(state)) return undefined;
  if (!state.workspaceDiagnosticsSupport.workspaceDiagnostics) return undefined;
  const previousResultIds = Array.from(state.workspacePullResultCache.values()).map((entry) => ({
    uri: entry.uri,
    value: entry.resultId,
  }));
  if (budgetMs < PULL_MIN_USABLE_BUDGET_MS) {
    emitBounded(
      "lsp_pull_skipped_budget_exhausted",
      `${state.serverId}::${WORKSPACE_PULL_SCOPE}`,
      {
        type: "phase",
        filePath: WORKSPACE_PULL_SCOPE,
        durationMs: 0,
        metadata: {
          identifier: "bare",
          remainingBudgetMs: budgetMs,
          server: state.serverId,
        },
      },
      {
        ledgerKind: "lsp-pull-skipped-budget-exhausted",
        reason: `workspace pull skipped on ${state.serverId}: budget already exhausted (${budgetMs}ms remaining)`,
      },
    );
    return undefined;
  }
  const workspacePullStartedAt = Date.now();
  const workspacePullTimeoutMs = Math.max(1, budgetMs);
  const workspaceRequestPromise = safeSendRequest<{
    items?: Array<{
      uri?: string;
      kind?: string;
      resultId?: string;
      items?: LSPDiagnostic[];
    }>;
  }>(state.connection, "workspace/diagnostic", { previousResultIds });
  try {
    const report = await withTimeout(workspaceRequestPromise, workspacePullTimeoutMs);
    if (!report || !Array.isArray(report.items)) return undefined;
    const out: Array<{
      filePath: string;
      diagnostics: LSPDiagnostic[];
      contentHash?: string;
    }> = [];
    const fallbackPullDeadline = Date.now() + Math.max(1, budgetMs);
    for (const item of report.items) {
      if (!item?.uri) continue;
      const filePath = uriToPath(item.uri);
      const normalizedPath = normalizeMapKey(filePath);
      if (item.kind === "unchanged") {
        const prior = state.workspacePullResultCache.get(normalizedPath);
        if (!prior) {
          const remainingMs = fallbackPullDeadline - Date.now();
          if (remainingMs <= 0) {
            incrementDegradationCount({
              kind: "lsp-pull-unconfirmed",
              subject: state.serverId,
              reason:
                "unchanged report with no workspacePullResultCache basis; the shared fallback-pull deadline was already exhausted by earlier files this sweep",
            });
            continue;
          }
          const outcome = await clientRequestPullDiagnostics(state, filePath, remainingMs);
          if (outcome.status === "found") {
            out.push({
              filePath,
              diagnostics: state.documentPullDiagnostics.get(normalizedPath) ?? [],
              contentHash: state.diagnosticBindings.get(normalizedPath)?.contentHash,
            });
          } else if (outcome.status === "unavailable") {
            incrementDegradationCount({
              kind: "lsp-pull-unconfirmed",
              subject: state.serverId,
              reason:
                "unchanged report with no workspacePullResultCache basis, and the per-file fallback pull was unavailable",
            });
          }
          continue;
        }
        if (item.resultId !== undefined) {
          state.workspacePullResultCache.set(normalizedPath, {
            ...prior,
            resultId: item.resultId,
          });
        }
        out.push({
          filePath,
          diagnostics: prior.diagnostics,
          contentHash: prior.contentHash,
        });
        continue;
      }
      const diagnostics = normalizeLspDiagnostics(item.items ?? []);
      let contentHash: string | undefined;
      try {
        contentHash = hashDiagnosticContent(await readFile(filePath, "utf-8"));
      } catch {
        contentHash = undefined;
      }
      if (item.resultId !== undefined) {
        if (state.workspacePullResultCache.size >= WORKSPACE_PULL_RESULT_CACHE_MAX) {
          state.workspacePullResultCache.clear();
        }
        state.workspacePullResultCache.set(normalizedPath, {
          uri: item.uri,
          resultId: item.resultId,
          diagnostics,
          contentHash,
        });
      } else {
        state.workspacePullResultCache.delete(normalizedPath);
      }
      out.push({ filePath, diagnostics, contentHash });
    }
    return out;
  } catch (err) {
    if (isPullTimeoutError(err, workspacePullTimeoutMs)) {
      recordPullTimeoutTelemetry({
        scope: WORKSPACE_PULL_SCOPE,
        identifier: undefined,
        effectiveBudgetMs: workspacePullTimeoutMs,
        hadPreviousResultId: previousResultIds.length > 0,
        elapsedMs: Date.now() - workspacePullStartedAt,
        server: state.serverId,
      });
      armLateAnswerTelemetry({
        requestPromise: workspaceRequestPromise,
        scope: WORKSPACE_PULL_SCOPE,
        identifier: undefined,
        subject: WORKSPACE_PULL_SCOPE,
        requestStartedAt: workspacePullStartedAt,
        server: state.serverId,
      });
    }
    recordPullFailure(state, "workspace/diagnostic", err);
    return undefined;
  }
}

export async function clientWaitForDiagnostics(
  state: LSPClientState,
  filePath: string,
  timeoutMs: number,
  options: {
    minVersion?: number;
    pullOnly?: boolean;
    pullSettleSource?: "pull" | "pull-warmup";
  } = {},
): Promise<void> {
  const normalizedPath = normalizeMapKey(filePath);
  const minVersion = options.minVersion;
  const pullSettleSource = options.pullSettleSource ?? "pull";
  const hasFreshDiagnostics = (): boolean =>
    minVersion === undefined || diagnosticsVersionForPath(state, normalizedPath) > minVersion;

  const isVersionStale = (): boolean => {
    const cachedVersion = state.diagnosticDocVersions?.get(normalizedPath);
    if (cachedVersion === undefined) return false;
    const currentVersion = state.documentVersions?.get(normalizedPath);
    return currentVersion !== undefined && cachedVersion < currentVersion;
  };

  if (state.workspaceDiagnosticsSupport.mode === "pull") {
    const pullSettleStartedAt = Date.now();
    let outcome = await clientRequestPullDiagnostics(state, filePath, timeoutMs);
    if (outcome.status === "found") {
      logTypeScriptPullSettle(
        state,
        normalizedPath,
        Date.now() - pullSettleStartedAt,
        pullSettleSource,
      );
      return;
    }
    let sawClean = outcome.status === "clean";

    const strategy = getStrategy(state.serverId, state.launchVariant);
    const retryBudgetMs =
      strategy.pullRetryBudgetMs > 0 ? Math.min(timeoutMs, strategy.pullRetryBudgetMs) : 0;
    const startedAt = Date.now();

    while (outcome.status !== "found" && Date.now() - startedAt < retryBudgetMs) {
      await new Promise((resolve) => setTimeout(resolve, PULL_DIAGNOSTICS_RETRY_INTERVAL_MS));
      outcome = await clientRequestPullDiagnostics(
        state,
        filePath,
        Math.max(0, retryBudgetMs - (Date.now() - startedAt)),
      );
      if (outcome.status === "clean") sawClean = true;
    }
    if (options.pullOnly) {
      if (outcome.status === "found" || sawClean) {
        logTypeScriptPullSettle(
          state,
          normalizedPath,
          Date.now() - pullSettleStartedAt,
          pullSettleSource,
        );
      }
      return;
    }
    if (outcome.status === "found" || sawClean) {
      logTypeScriptPullSettle(
        state,
        normalizedPath,
        Date.now() - pullSettleStartedAt,
        pullSettleSource,
      );
      return;
    }
  }

  if (
    hasFreshDiagnostics() &&
    !isVersionStale() &&
    getMergedDiagnosticsForPath(state, normalizedPath).length > 0
  ) {
    return;
  }

  return new Promise<void>((resolve) => {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const onDiagnostics = (fp: string) => {
      if (normalizeMapKey(fp) !== normalizedPath) return;
      if (!hasFreshDiagnostics() || isVersionStale()) return;
      if (debounceTimer) clearTimeout(debounceTimer);

      const strategy = getStrategy(state.serverId, state.launchVariant);
      const hit = state.pushDiagnosticTimestamps.get(normalizedPath);
      const timeSincePush = hit ? Date.now() - hit : Infinity;
      const remaining = Math.max(0, strategy.debounceMs - timeSincePush);

      debounceTimer = setTimeout(() => {
        state.diagnosticEmitter.off("diagnostics", onDiagnostics);
        clearTimeout(timeout);
        resolve();
      }, remaining);
    };

    state.diagnosticEmitter.on("diagnostics", onDiagnostics);

    const timeout = setTimeout(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      state.diagnosticEmitter.off("diagnostics", onDiagnostics);
      resolve();
    }, timeoutMs);
  });
}
