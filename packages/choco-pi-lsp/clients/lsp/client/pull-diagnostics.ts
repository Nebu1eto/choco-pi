import { pathToFileURL } from "node:url";
import { emitBounded } from "../../bounded-telemetry.ts";
import { withTimeout } from "../../deadline-utils.ts";
import { raceToCompletion } from "../aggregation.ts";
import { normalizeMapKey, uriToPath } from "../../path-utils.ts";
import { PULL_MIN_USABLE_BUDGET_MS, PULL_REQUEST_TIMEOUT_MS } from "./constants.ts";
import {
  bumpDiagnosticsVersion,
  claimPullRequestSequence,
  isNewestPullRequest,
  normalizeLspDiagnostics,
  pullDiagnosticSources,
  pullGenerationFor,
  pullSourceDiagnostics,
  pullSourceKey,
  storePullSourceDiagnostics,
} from "./diagnostics-store.ts";
import { isClientAlive } from "./process.ts";
import { isErrorDetails, type ErrorDetails } from "./schemas.ts";
import { safeSendRequest } from "./transport.ts";
import type { LSPClientState, LSPDiagnostic, LSPPullFailure } from "./types.ts";

type PullDiagnosticsOutcome =
  | { status: "found"; count: number }
  | { status: "clean" }
  | { status: "unavailable" };

type PullSourceOutcome =
  | { status: "found"; count: number; primaryCount: number }
  | { status: "clean" }
  | { status: "unavailable" };

const PULL_RACE_BACKSTOP_MARGIN_MS = 25;

export async function clientRequestPullDiagnostics(
  state: LSPClientState,
  filePath: string,
  budgetMs: number = PULL_REQUEST_TIMEOUT_MS,
): Promise<PullDiagnosticsOutcome> {
  if (!isClientAlive(state)) return { status: "unavailable" };
  const sources = pullDiagnosticSources(state);
  if (sources.length === 1) {
    return aggregatePullOutcomes(state, filePath, [
      await pullDiagnosticSource(state, filePath, budgetMs, undefined),
    ]);
  }

  const attempts = sources.map((identifier) =>
    pullDiagnosticSource(state, filePath, budgetMs, identifier),
  );
  const settled = await raceToCompletion(
    attempts,
    (results) => results.some((r) => r.status === "found" && r.primaryCount > 0),
    {
      timeoutMs:
        Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs)) + PULL_RACE_BACKSTOP_MARGIN_MS,
    },
  );
  return aggregatePullOutcomes(state, filePath, settled);
}

function aggregatePullOutcomes(
  state: LSPClientState,
  filePath: string,
  outcomes: PullSourceOutcome[],
): PullDiagnosticsOutcome {
  const found = outcomes.filter((o) => o.status === "found");
  if (found.length > 0) {
    const normalizedPath = normalizeMapKey(filePath);
    const unionCount = state.documentPullDiagnostics.get(normalizedPath)?.length ?? 0;
    return {
      status: "found",
      count: Math.max(unionCount, ...found.map((o) => o.count)),
    };
  }
  if (outcomes.some((o) => o.status === "unavailable")) {
    return { status: "unavailable" };
  }
  return outcomes.some((o) => o.status === "clean")
    ? { status: "clean" }
    : { status: "unavailable" };
}

async function pullDiagnosticSource(
  state: LSPClientState,
  filePath: string,
  budgetMs: number,
  identifier: string | undefined,
): Promise<PullSourceOutcome> {
  if (!isClientAlive(state)) return { status: "unavailable" };
  const normalizedPath = normalizeMapKey(filePath);
  if (budgetMs < PULL_MIN_USABLE_BUDGET_MS) {
    emitBounded(
      "lsp_pull_skipped_budget_exhausted",
      `${state.serverId}::${pullSourceKey(normalizedPath, identifier)}`,
      {
        type: "phase",
        filePath: normalizedPath,
        durationMs: 0,
        metadata: {
          identifier: identifier ?? "bare",
          remainingBudgetMs: budgetMs,
          server: state.serverId,
        },
      },
      {
        ledgerKind: "lsp-pull-skipped-budget-exhausted",
        reason: `pull skipped on ${state.serverId}: budget already exhausted (${budgetMs}ms remaining)`,
      },
    );
    return { status: "unavailable" };
  }
  const uri = pathToFileURL(filePath).href;
  const sourceKey = pullSourceKey(normalizedPath, identifier);
  const previousResultId = state.pullResultIds.get(sourceKey);
  const generation = pullGenerationFor(state, normalizedPath);
  const requestSequence = claimPullRequestSequence(state, sourceKey);
  const requestStartedAt = Date.now();
  const effectiveTimeoutMs = Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs));
  const requestPromise = safeSendRequest<{
    kind?: string;
    resultId?: string;
    items?: LSPDiagnostic[];
    relatedDocuments?: Record<
      string,
      { kind?: string; resultId?: string; items?: LSPDiagnostic[] }
    >;
  }>(state.connection, "textDocument/diagnostic", {
    textDocument: { uri },
    ...(identifier !== undefined && { identifier }),
    ...(previousResultId !== undefined && { previousResultId }),
  });
  try {
    const report = await withTimeout(requestPromise, effectiveTimeoutMs);

    if (!report) {
      recordPullFailure(state, "textDocument/diagnostic", new Error("empty response"));
      return { status: "unavailable" };
    }

    const now = Date.now();
    const sentHash = state.documentContentHashes.get(normalizedPath)?.hash;
    if (
      pullGenerationFor(state, normalizedPath) !== generation ||
      !isNewestPullRequest(state, sourceKey, requestSequence)
    ) {
      return { status: "unavailable" };
    }
    let primaryCount: number;
    if (report.kind === "unchanged") {
      primaryCount = pullSourceDiagnostics(state, normalizedPath, identifier).length;
      state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
    } else {
      const primaryItems = normalizeLspDiagnostics(report.items ?? []);
      storePullSourceDiagnostics(state, normalizedPath, identifier, primaryItems);
      state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
      bumpDiagnosticsVersion(state, normalizedPath);
      state.diagnosticBindings.set(normalizedPath, { contentHash: sentHash });
      primaryCount = primaryItems.length;
    }
    let totalCount = primaryCount;
    if (report.resultId !== undefined) {
      state.pullResultIds.set(sourceKey, report.resultId);
    } else {
      state.pullResultIds.delete(sourceKey);
    }

    if (report.relatedDocuments) {
      for (const [relatedUri, related] of Object.entries(report.relatedDocuments)) {
        const relatedPath = uriToPath(relatedUri);
        const relatedNormalized = normalizeMapKey(relatedPath);
        if (related?.kind === "unchanged") {
          totalCount += pullSourceDiagnostics(state, relatedNormalized, identifier).length;
          state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
        } else {
          const relatedItems = normalizeLspDiagnostics(related?.items ?? []);
          storePullSourceDiagnostics(state, relatedNormalized, identifier, relatedItems);
          state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
          state.diagnosticBindings.delete(relatedNormalized);
          totalCount += relatedItems.length;
        }
        if (related?.resultId !== undefined) {
          state.pullResultIds.set(pullSourceKey(relatedNormalized, identifier), related.resultId);
        }
      }
    }

    state.diagnosticEmitter.emit("diagnostics", normalizedPath);
    return totalCount > 0
      ? { status: "found", count: totalCount, primaryCount }
      : { status: "clean" };
  } catch (err) {
    if (isPullTimeoutError(err, effectiveTimeoutMs)) {
      recordPullTimeoutTelemetry({
        scope: normalizedPath,
        identifier,
        effectiveBudgetMs: effectiveTimeoutMs,
        hadPreviousResultId: previousResultId !== undefined,
        elapsedMs: Date.now() - requestStartedAt,
        server: state.serverId,
      });
      armLateAnswerTelemetry({
        requestPromise,
        scope: normalizedPath,
        identifier,
        subject: sourceKey,
        requestStartedAt,
        server: state.serverId,
      });
    }
    recordPullFailure(state, "textDocument/diagnostic", err);
    return { status: "unavailable" };
  }
}

export function isPullTimeoutError<T>(err: T, timeoutMs: number): boolean {
  return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

export function recordPullTimeoutTelemetry(args: {
  scope: string;
  identifier: string | undefined;
  effectiveBudgetMs: number;
  hadPreviousResultId: boolean;
  elapsedMs: number;
  server: string;
}): void {
  emitBounded(
    "lsp_pull_diagnostic_timeout",
    `${args.server}::${args.scope}::${args.identifier ?? "bare"}`,
    {
      type: "phase",
      filePath: args.scope,
      durationMs: args.elapsedMs,
      metadata: {
        identifier: args.identifier ?? "bare",
        effectiveBudgetMs: args.effectiveBudgetMs,
        hadPreviousResultId: args.hadPreviousResultId,
        server: args.server,
      },
    },
    {
      ledgerKind: "lsp-pull-diagnostic-timeout",
      reason: `pull timeout on ${args.server} after ${args.elapsedMs}ms (budget ${args.effectiveBudgetMs}ms)`,
    },
  );
}

export function armLateAnswerTelemetry(args: {
  requestPromise: Promise<unknown>;
  scope: string;
  identifier: string | undefined;
  subject: string;
  requestStartedAt: number;
  server: string;
}): void {
  args.requestPromise.then(
    () => {
      try {
        const elapsedMs = Date.now() - args.requestStartedAt;
        emitBounded(
          "lsp_pull_late_answer_discarded",
          args.subject,
          {
            type: "phase",
            filePath: args.scope,
            durationMs: elapsedMs,
            metadata: { identifier: args.identifier ?? "bare" },
          },
          {
            ledgerKind: "lsp-pull-late-answer",
            reason: `late pull answer discarded after ${elapsedMs}ms`,
          },
        );
      } catch {}
    },
    (err) => {
      try {
        const elapsedMs = Date.now() - args.requestStartedAt;
        const candidate: ErrorDetails = isErrorDetails(err) ? err : {};
        const code = candidate.code;
        emitBounded(
          "lsp_pull_late_rejection",
          `${args.server}::${args.subject}`,
          {
            type: "phase",
            filePath: args.scope,
            durationMs: elapsedMs,
            metadata: {
              identifier: args.identifier ?? "bare",
              server: args.server,
              ...(code !== undefined && { code }),
            },
          },
          {
            ledgerKind: "lsp-pull-late-rejection",
            reason: `late pull rejection ${elapsedMs}ms after timeout${code !== undefined ? ` (code ${code})` : ""}`,
          },
        );
      } catch {}
    },
  );
}

const PULL_FAILURE_HISTORY_LIMIT = 10;

export function recordPullFailure<T>(
  state: LSPClientState,
  method: LSPPullFailure["method"],
  error: T,
): void {
  const candidate: ErrorDetails = isErrorDetails(error) ? error : {};
  const message = candidate.message ?? "";
  const unsupportedMessage = /^(?:method not found|unknown method|unsupported method)(?::|$)/i;
  if (
    candidate.code === -32601 ||
    candidate.code === "-32601" ||
    unsupportedMessage.test(message.trim())
  )
    return;
  const failure: LSPPullFailure = {
    timestamp: Date.now(),
    method,
    message: candidate.message ?? String(error),
  };
  if (candidate.code !== undefined) failure.code = candidate.code;
  state.pullFailureHistory.push(failure);
  if (state.pullFailureHistory.length > PULL_FAILURE_HISTORY_LIMIT) {
    state.pullFailureHistory.splice(
      0,
      state.pullFailureHistory.length - PULL_FAILURE_HISTORY_LIMIT,
    );
  }
}
