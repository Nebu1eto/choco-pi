/**
 * textDocument/diagnostic pull requests, outcome aggregation, and pull timeout telemetry.
 */
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

/**
 * Outcome of a pull-diagnostics request. Distinguishes an AFFIRMATIVE answer
 * (the server replied — either `found` with diagnostics or an authoritative
 * empty `clean`) from `unavailable` (dead client / no reply / thrown). #240: a
 * failed pull must NEVER be read as clean — only an authoritative empty report
 * is clean. A bare count conflated the two (0 = clean OR failed).
 */
type PullDiagnosticsOutcome =
  | { status: "found"; count: number }
  | { status: "clean" }
  | { status: "unavailable" };

/**
 * One diagnostic SOURCE's outcome. `primaryCount` is the part of `count` that
 * belongs to the REQUESTED file — `count` also includes `relatedDocuments`.
 * The fan-out races on `primaryCount` because "the answer arrived" means the
 * file the caller asked about has an answer, not that some other document did.
 */
type PullSourceOutcome =
  | { status: "found"; count: number; primaryCount: number }
  | { status: "clean" }
  | { status: "unavailable" };

/** Margin between each source's own request timeout and the race's backstop
 *  deadline, so the natural "all sources settled" path wins over the backstop
 *  and the race never reports `unavailable` for sources that did answer. */
const PULL_RACE_BACKSTOP_MARGIN_MS = 25;

/**
 * #1667: pull EVERY registered diagnostic source for a file, in parallel, and
 * answer as soon as the first source returns findings for that file.
 *
 * Roslyn, vtsls and some Java setups register `textDocument/diagnostic` once
 * per source (syntax, semantic, analyzers), each named by
 * `registerOptions.identifier`. One bare request asks only the server's default
 * source, so whole categories of findings were never requested. The fan-out
 * asks all of them plus the bare request.
 *
 * Timing is deliberate and load-bearing:
 *  - PARALLEL, never one source after another. Sequencing would add every
 *    slow source's latency to every touch.
 *  - The race resolves on the FIRST source with findings for the file, with no
 *    settle or debounce window after the match. A post-match wait is the exact
 *    latency shape #1112/#1407 already cost this codebase once.
 *  - Losing sources are NOT cancelled. Each source writes its own findings into
 *    the pull cache before it resolves, so a late answer merges in the
 *    background and the NEXT read of the file sees it. Late answers are not
 *    dropped, they are just not waited for.
 *
 * The race runs inside the existing `raceToCompletion` primitive rather than a
 * second first-wins helper.
 */
export async function clientRequestPullDiagnostics(
  state: LSPClientState,
  filePath: string,
  budgetMs: number = PULL_REQUEST_TIMEOUT_MS,
): Promise<PullDiagnosticsOutcome> {
  if (!isClientAlive(state)) return { status: "unavailable" };
  const sources = pullDiagnosticSources(state);
  if (sources.length === 1) {
    // The overwhelmingly common case: no named sources registered. Skip the
    // race entirely so a single-source server pays nothing for this feature.
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
      // No graceMs: finalize the instant a source answers for this file.
      // The per-request `withTimeout` inside each attempt is the real bound;
      // this deadline is only a backstop, so it sits just past it.
      timeoutMs:
        Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs)) + PULL_RACE_BACKSTOP_MARGIN_MS,
    },
  );
  return aggregatePullOutcomes(state, filePath, settled);
}

/**
 * Collapse the sources that answered into one outcome for the caller.
 * `found` beats `clean` beats `unavailable`: a source with findings is an
 * answer, an authoritative empty report is an answer, and only "nobody
 * answered" is unavailable (#240 — an empty result must distinguish clean
 * from errored).
 */
function aggregatePullOutcomes(
  state: LSPClientState,
  filePath: string,
  outcomes: PullSourceOutcome[],
): PullDiagnosticsOutcome {
  const found = outcomes.filter((o) => o.status === "found");
  if (found.length > 0) {
    const normalizedPath = normalizeMapKey(filePath);
    // The union for the requested file, which is what a caller reading the
    // cache will see. A source that only reported `relatedDocuments` findings
    // contributes nothing there, so fall back to its own count.
    const unionCount = state.documentPullDiagnostics.get(normalizedPath)?.length ?? 0;
    return {
      status: "found",
      count: Math.max(unionCount, ...found.map((o) => o.count)),
    };
  }
  // #240, applied across sources: `clean` is an authoritative "this file has no
  // findings", and one source saying so proves nothing about a source that
  // FAILED to answer. A fan-out where any source errored is therefore
  // unavailable, not clean - the caller falls through to the push-wait/timeout
  // backstop instead of recording a confirmed-clean touch it cannot support.
  // (`raceToCompletion` drops still-pending promises from its result array, so
  // "every source settled, none errored" is the only shape that reads clean.)
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
  // #1773: a budget at or below the usable floor cannot complete a real
  // round trip. Skip the dispatch entirely — no `safeSendRequest` call, no
  // generation/sequence claim — and say so with a distinct record, so
  // `lsp_pull_diagnostic_timeout` only ever means a pull was genuinely
  // attempted. The caller sees the same `unavailable` outcome a timeout
  // would have produced (#240: unavailable, never a false clean), so
  // nothing downstream of this call changes shape.
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
  // #1104: echo the last resultId we hold for this document so a server that
  // hasn't changed its view can answer `kind: "unchanged"` instead of
  // recomputing — see the `kind === "unchanged"` branch below for how that's
  // honored (inherit, never treat an omitted `items` as clean).
  // #1667: read THIS source's id, never another source's. Result ids are
  // issued per source, so echoing a syntax id on a semantic request asks the
  // server to compare against a basis it never handed out.
  const sourceKey = pullSourceKey(normalizedPath, identifier);
  const previousResultId = state.pullResultIds.get(sourceKey);
  // #1667: the generation this pull was computed against. A resync landing
  // while the request is in flight bumps it, and every write below is dropped
  // rather than resurrecting state the resync cleared.
  const generation = pullGenerationFor(state, normalizedPath);
  // #1667: claim the newest-request slot for THIS source. Two fan-outs can
  // overlap for the same file with no resync between them (`ensureWarmForSweep`
  // touches, then the real touch follows ~60ms later), so the generation check
  // alone would let a slow answer from the earlier round land on top of a newer
  // one. Re-checked at write time below.
  const requestSequence = claimPullRequestSequence(state, sourceKey);
  // #1713: captured OUTSIDE withTimeout so a timeout's `catch` below still
  // holds a live handle on the request. `withTimeout` itself only races it
  // against a timer — the request keeps running server-side either way — and
  // without this handle the abandoned answer would settle into the void with
  // no way to observe it.
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
    // #1667: name the source this request is for, so the server answers
    // from that source instead of its default one.
    ...(identifier !== undefined && { identifier }),
    ...(previousResultId !== undefined && { previousResultId }),
  });
  try {
    // withTimeout is the backstop against a hung pull-mode server: without it
    // this await never settles unless the stream is destroyed. Bounded by the
    // smaller of the absolute ceiling and the caller's remaining wait budget.
    // On timeout the caught error yields `unavailable` below (never a false
    // `clean`), so it falls through to the push-wait/timeout backstop.
    const report = await withTimeout(requestPromise, effectiveTimeoutMs);

    if (!report) {
      recordPullFailure(state, "textDocument/diagnostic", new Error("empty response"));
      return { status: "unavailable" };
    }

    const now = Date.now();
    // #1104: the fingerprint of the content we last sent for this document —
    // the SAME `documentContentHashes` entry the push binding path uses
    // (`recordSentContent` runs unconditionally on every didOpen/didChange,
    // regardless of push/pull mode), so this costs no extra read. A pull
    // response describes whatever the server had when it answered, which for
    // a choco-pi-lsp-opened document is exactly that last-sent payload.
    const sentHash = state.documentContentHashes.get(normalizedPath)?.hash;
    // #1667: two ways this answer can already be obsolete, and neither may
    // write. Report the round trip as unavailable - a superseded answer is not
    // evidence the file is clean (#240).
    //  - A resync landed while the request was in flight, so these findings
    //    describe content that no longer exists.
    //  - A LATER request for this same source has already been issued (an
    //    overlapping fan-out), so this answer is the stale loser and would
    //    clobber the newer result.
    if (
      pullGenerationFor(state, normalizedPath) !== generation ||
      !isNewestPullRequest(state, sourceKey, requestSequence)
    ) {
      return { status: "unavailable" };
    }
    let primaryCount: number;
    if (report.kind === "unchanged") {
      // #1104: same resultId basis as last time — an omitted `items` here
      // means "no change", NOT "clean". Overwriting with `[]` would be the
      // exact false-clean shape #570/#571 already fixed for the touch path;
      // keep the previously stored diagnostics and binding as-is.
      // #1667: "the previously stored diagnostics" means THIS SOURCE's, so
      // one source reporting unchanged neither inherits nor disturbs another
      // source's findings for the same file.
      primaryCount = pullSourceDiagnostics(state, normalizedPath, identifier).length;
      // Still a fresh confirmation as of `now` even though the content is
      // unchanged — bump the timestamp so `getAllDiagnostics()` doesn't read
      // this entry as aging purely because the server had nothing new to say.
      state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
    } else {
      const primaryItems = normalizeLspDiagnostics(report.items ?? []);
      // #1667: replace only this source's slice; `documentPullDiagnostics`
      // becomes the deduped union of every source that has reported.
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

    // #1531 note (pre-existing, unchanged): a related document's diagnostics are
    // STORED below but earn no version bump and therefore no per-path stamp —
    // exactly as before, since this loop never bumped the global counter either.
    // A wait on a path that only ever hears about itself through some other
    // document's `relatedDocuments` sees no freshness evidence and rides its
    // timeout. Direction is under-detection, and correcting it means deciding
    // what a related-document publication is evidence OF (its binding is
    // honestly "unknown" per #1104), so it stays out of scope here.
    if (report.relatedDocuments) {
      for (const [relatedUri, related] of Object.entries(report.relatedDocuments)) {
        const relatedPath = uriToPath(relatedUri);
        const relatedNormalized = normalizeMapKey(relatedPath);
        // #1667: a related document's report belongs to the SAME source as
        // the request that carried it, so it stores and inherits under that
        // source's key too.
        if (related?.kind === "unchanged") {
          totalCount += pullSourceDiagnostics(state, relatedNormalized, identifier).length;
          state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
        } else {
          const relatedItems = normalizeLspDiagnostics(related?.items ?? []);
          storePullSourceDiagnostics(state, relatedNormalized, identifier, relatedItems);
          state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
          // #1104: a related document's diagnostics were NOT computed against
          // content we independently sent/fingerprinted (we never requested
          // it directly) — its binding stays honestly "unknown" rather than
          // borrowing the primary document's hash.
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

/**
 * #1713: `withTimeout` rejects with this EXACT message (`clients/deadline-utils.ts`)
 * only when its own timer wins the race — every other rejection is the request
 * itself failing (bad params, dead connection, thrown by the server). Only the
 * timer-won case is a "the answer might still be coming" situation worth a
 * late-answer watch; a request that already failed fast has nothing further to
 * observe.
 */
export function isPullTimeoutError<T>(err: T, timeoutMs: number): boolean {
  return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

/**
 * #1713: every pull timeout emits exactly one bounded latency.log record — the
 * observability gap the issue names (`withTimeout`'s throw previously skipped
 * ALL telemetry for this site). Never throws: telemetry must not perturb the
 * timeout path, which has already decided to return `unavailable` regardless.
 *
 * #1743: routed through `emitBounded`. This phase takes NO rising-edge gate
 * and NO per-turn cap, which is the pre-existing behavior kept exactly: a
 * pull timeout costs at least the full budget (seconds), so the call cadence
 * already bounds the volume, unlike `navRequest` below. The helper still
 * supplies the identity discipline and the registry membership the sweep
 * checks.
 */
export function recordPullTimeoutTelemetry(args: {
  scope: string;
  identifier: string | undefined;
  effectiveBudgetMs: number;
  hadPreviousResultId: boolean;
  elapsedMs: number;
  server: string;
}): void {
  // #1771: this record is written on a genuine failure path (a dispatched
  // pull that never answered), so per the bounded-telemetry rule
  // (`clients/bounded-telemetry.ts`) it needs a `ledgerKind`, not just the
  // detailed latency.log record. Before this it counted nothing in the
  // degradation ledger — every occurrence wrote a detail line, but nothing
  // tallied. No `risingEdgePer`: timeouts repeat and every one should count,
  // matching the pre-existing "no rising-edge gate" behavior for the
  // detailed record itself.
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

/**
 * #1713: a telemetry-only continuation on the ALREADY-abandoned request
 * promise. `withTimeout` only raced it against a timer — the request is still
 * live server-side — so if it eventually resolves, this is the only place that
 * ever finds out. Purely observational: it runs after the caller has already
 * moved on with `unavailable`, and it never writes into `state`.
 *
 * Bounded via the degradation-ledger convention (`incrementDegradationCount`,
 * chosen over a hand-rolled per-identity rising-edge Set): the ledger already
 * caps entries per kind and re-arms at `session_start`
 * (`resetDegradationLedger`, wired into `handleSessionStart`), so reusing it
 * avoids a second latch this fix would otherwise have to register and reset
 * itself. `subject` is the same `pullSourceKey` (path + identifier) the pull
 * path already uses, so the discriminating identity survives aggregation.
 *
 * Attaching `.then` here creates no timer, socket, or other handle — it only
 * observes a promise the request already created — so it cannot keep the
 * process alive a moment longer than that pending request already does.
 */
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
        // #1743: `emitBounded` counts every late answer in the ledger
        // under the same `pullSourceKey` subject as before, then writes
        // the record. No rising-edge gate, matching #1713's original
        // behavior: a late answer arrives at most once per abandoned
        // request, so the record count cannot exceed the timeout count.
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
      } catch {
        // Telemetry must never break the observed path.
      }
    },
    (err) => {
      // #1774: the abandoned request eventually REJECTED rather than
      // answering. Behavior is unchanged — the rejection is still
      // swallowed here, exactly as before — but "timeout then silence"
      // and "timeout then server rejection (e.g. ContentModified)" were
      // previously indistinguishable: `recordPullFailure` at request
      // time reports the FIRST failure only, and this rejection happens
      // strictly after that request already timed out, so it needs its
      // own record. Bounded via the degradation ledger, same shape as
      // the late-answer branch above, so this rejection cannot outpace
      // the timeout count that gates it.
      try {
        const elapsedMs = Date.now() - args.requestStartedAt;
        const candidate: ErrorDetails = isErrorDetails(err) ? err : {};
        const code = candidate.code;
        emitBounded(
          "lsp_pull_late_rejection",
          // #1774 review: prefix the server, same reason the timeout kind
          // does (#1771). The workspace call site's `subject` is the bare
          // `WORKSPACE_PULL_SCOPE` constant — without the server prefix,
          // two servers' abandoned-workspace-pull rejections would collapse
          // into one ledger subject and hide which server is storming.
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
      } catch {
        // Telemetry must never break the observed path.
      }
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
