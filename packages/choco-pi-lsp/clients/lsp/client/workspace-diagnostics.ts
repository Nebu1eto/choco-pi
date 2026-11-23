/**
 * workspace/diagnostic requests and waiting for a file's diagnostics.
 */
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

/**
 * One project-wide `workspace/diagnostic` pull — a single request that returns
 * diagnostics for every document the server knows, instead of opening N files.
 * Returns per-file reports, or `undefined` on unsupported/dead/timeout/malformed
 * (caller falls back to the per-file path). `unchanged`-kind items carry no
 * diagnostics and are skipped, so a file absent from the result is "clean".
 */
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
  // #1104: echo every resultId we hold from a PRIOR pull so the server can
  // answer `kind: "unchanged"` for files it hasn't recomputed, instead of
  // resending (and us re-hashing) every file on every sweep.
  const previousResultIds = Array.from(state.workspacePullResultCache.values()).map((entry) => ({
    uri: entry.uri,
    value: entry.resultId,
  }));
  // #1773: same floor as `pullDiagnosticSource` — an exhausted budget here is
  // the SAME clamp-then-dispatch defect via a second entry point. Observed
  // live in the 2026-08-20 plegma dogfood session via
  // `lsp_workspace_diagnostics_start` (not just the `lens_diagnostics_full`
  // fan-out `pullDiagnosticSource` covers), so this call site needs its own
  // skip, not just a shared helper the caller happens to hit.
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
  // #1713: declared OUTSIDE the try so the catch below can still reach them —
  // same shape as `pullDiagnosticSource` above. Captured outside `withTimeout`
  // so a timeout still holds a live handle on the request for the late-answer
  // watch.
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
    // #1669 review N1: ONE deadline, shared across every "unchanged, no
    // cached basis" fallback pull this call makes — not a fresh `budgetMs`
    // grant handed to EACH one. A refresh clears `workspacePullResultCache`,
    // so the very next sweep after a refresh can route every item down this
    // path; granting each one the full budget serially turned a bounded call
    // unbounded (measured: 6 files x 300ms budget = 1844ms; worst case is
    // the normal case — 2000 files x 30s). Mirrors the shared-budget shape
    // `runWorkspaceDiagnosticsSwept`'s `perFileMs` bounds each file to,
    // scoped to fallback pulls made from within THIS one call.
    const fallbackPullDeadline = Date.now() + Math.max(1, budgetMs);
    for (const item of report.items) {
      if (!item?.uri) continue;
      const filePath = uriToPath(item.uri);
      const normalizedPath = normalizeMapKey(filePath);
      if (item.kind === "unchanged") {
        // #1104: inherit the prior pull's diagnostics + content binding for
        // the SAME resultId basis — an "unchanged" report never carries
        // `items`, so without this a file the server confirmed unchanged
        // would silently drop out of the sweep result entirely.
        const prior = state.workspacePullResultCache.get(normalizedPath);
        if (!prior) {
          // #1669 review F4: no earlier basis to inherit (e.g. right after a
          // `workspace/diagnostic/refresh` cleared `workspacePullResultCache`)
          // — the server is answering "unchanged" against a resultId basis we
          // no longer hold, so there is nothing honest to report for this
          // file from THIS response. `continue`-ing here would make the file
          // silently absent from `out`, which the caller reads as "clean" —
          // a false clean for a file the server just told us it hasn't even
          // looked at freshly. Treat it as needs-full-pull: request the
          // per-file diagnostic directly instead.
          const remainingMs = fallbackPullDeadline - Date.now();
          if (remainingMs <= 0) {
            // #1669 review N1: the shared fallback-pull deadline is already
            // exhausted by earlier files in this same loop — bail WITHOUT
            // attempting a request (never fabricate clean; this file was
            // never actually asked about) and surface it as unavailable via
            // the same degradation ledger path as a real unavailable pull.
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
            // Genuinely unconfirmed — never fabricate a clean result. Recorded
            // via the shared degradation ledger (AGENTS.md: repeated
            // degradations use incrementDegradationCount, not a hand-rolled
            // counter) so a server that keeps racing refresh against sweeps
            // is visible in aggregate instead of silently absorbed per-file.
            incrementDegradationCount({
              kind: "lsp-pull-unconfirmed",
              subject: state.serverId,
              reason:
                "unchanged report with no workspacePullResultCache basis, and the per-file fallback pull was unavailable",
            });
          }
          // "clean": genuinely clean, correctly absent from `out`.
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
      // "full" (or a non-conforming server omitting `kind`, per the LSP
      // default) — recompute and re-fingerprint.
      const diagnostics = normalizeLspDiagnostics(item.items ?? []);
      // #1104: fingerprint the file bytes active AT REQUEST TIME. Best-effort —
      // a read failure (deleted/unreadable mid-sweep) just leaves contentHash
      // undefined, so the binding reads honestly "unknown", never fabricated.
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
  // #1531: the freshness gate is PER PATH. `minVersion` is a reading of the
  // client-global counter, and `diagnosticsVersionsByPath` stores that same
  // counter's value at each store — the two are on one axis, so comparing them
  // asks "has a publication landed for THIS file since the baseline?" instead of
  // "has anything at all landed on this client?". Reading the global counter here
  // let a sibling file's publication end this file's wait before its own budget
  // lapsed, which then labelled the outcome row `silent` (reserved for "own
  // budget lapsed with nothing published") instead of `cut_off`.
  const hasFreshDiagnostics = (): boolean =>
    minVersion === undefined || diagnosticsVersionForPath(state, normalizedPath) > minVersion;

  // Version coherence: a cached push is "stale" only when the server reported
  // the document version it computed against AND that version lags the latest
  // didChange we sent. This prevents serving diagnostics from a superseded
  // version as fresh (e.g. once the redundant double-push is collapsed and the
  // dispatch wait runs without a push-counter baseline — #203). Unknown version
  // (server omits it) is treated as current so version-less servers are
  // unaffected, and the timeout remains the backstop.
  const isVersionStale = (): boolean => {
    const cachedVersion = state.diagnosticDocVersions?.get(normalizedPath);
    if (cachedVersion === undefined) return false;
    const currentVersion = state.documentVersions?.get(normalizedPath);
    return currentVersion !== undefined && cachedVersion < currentVersion;
  };

  if (state.workspaceDiagnosticsSupport.mode === "pull") {
    // Pull is authoritative. An AFFIRMATIVE outcome — diagnostics `found`, or
    // an authoritative empty `clean` report — ends the wait. An `unavailable`
    // pull (dead client / no reply / thrown) is NOT clean and must not
    // short-circuit: fall through to the push-wait/timeout backstop. This is
    // the #240 fix — previously the early-return also fired on
    // `hasFreshDiagnostics()`, which is unconditionally true when there is no
    // version baseline (`minVersion === undefined`), so a failed pull returned
    // 0 and was read as a fresh clean.
    // #1639: the settle operation's OWN clock — durationMs on the eventual
    // log record measures from here, never from didOpen (that stays in
    // metadata.elapsedSinceDidOpenMs, computed separately below).
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

    // Retry within budget to catch incremental servers whose first pull is
    // empty while analysis is still running (rust-analyzer). A `clean` seen at
    // any point is a valid affirmative answer for this touch.
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

      // Adaptive debounce: use time since last push to compute remaining
      // wait instead of always waiting the full debounce window.
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
