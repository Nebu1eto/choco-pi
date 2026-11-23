/**
 * Navigation requests with stale-answer handling, nav timeout telemetry, and liveness pings.
 */
import { readFile } from "node:fs/promises";
import { emitBounded } from "../../bounded-telemetry.ts";
import { withTimeout } from "../../deadline-utils.ts";
import { getAmbientAbortSignal } from "../../safe-spawn.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { convertCharacterOffset, lineTextAt } from "../position-encoding.ts";
import {
  LIVENESS_PING_QUERY,
  LIVENESS_PING_TIMEOUT_MS,
  NAV_REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { isClientAlive } from "./process.ts";
import type { JsonRpcParams } from "./schemas.ts";
import { safeSendRequest } from "./transport.ts";
import type { LSPClientState } from "./types.ts";

/**
 * Translate a caller-supplied (UTF-16) `(line, character)` into the position the
 * server expects under its negotiated encoding (#269). UTF-16 is the identity —
 * the common case pays nothing (no I/O). For UTF-8/UTF-32 we read the target
 * line from disk (pi edits files on disk before navigating, so disk == the
 * server's content) and re-measure the character offset; a read failure falls
 * back to the raw offset rather than dropping the request.
 */
export async function toWirePosition(
  state: LSPClientState,
  filePath: string,
  line: number,
  character: number,
): Promise<{ line: number; character: number }> {
  if (state.positionEncoding === "utf-16") return { line, character };
  try {
    const content = await readFile(filePath, "utf8");
    return {
      line,
      character: convertCharacterOffset(
        state.positionEncoding,
        lineTextAt(content, line),
        character,
      ),
    };
  } catch {
    return { line, character };
  }
}

// #276: drop a navigation result whose document was edited while the request was
// in flight. Mirrors the diagnostics-path staleness check (isVersionStale) which
// compares the version computed-against to the latest didChange. Default on;
// CHOCO_PI_LSP_LSP_NAV_STALE_DROP=0 disables it if it ever over-drops.
function navStaleDropEnabled(): boolean {
  return process.env.CHOCO_PI_LSP_LSP_NAV_STALE_DROP !== "0";
}

// Exported for the timeout regression tests (#365). `timeoutMs` overrides the
// per-request ceiling so a test can bound a hung server quickly.
export async function navRequest<T>(
  state: LSPClientState,
  method: string,
  params: JsonRpcParams,
  // When provided, the request is dropped if the document's version advances
  // (an edit landed) between send and response. Omit for non-single-file
  // requests (workspaceSymbol, call-hierarchy follow-ups) that have no version.
  staleCheckPath?: string,
  timeoutMs: number = NAV_REQUEST_TIMEOUT_MS,
  // Cancels the in-flight request (LSP `$/cancelRequest`) when the turn is
  // abandoned. Defaults to the ambient abort signal set around dispatch/tool
  // handling, so callers get cancellation for free without a signature change
  // (#238 Item 1). Pass explicitly in tests.
  signal: AbortSignal | undefined = getAmbientAbortSignal(),
): Promise<T | null | undefined> {
  if (!isClientAlive(state)) return null;
  const normalizedPath = staleCheckPath !== undefined ? normalizeMapKey(staleCheckPath) : undefined;
  const requestVersion =
    normalizedPath !== undefined ? state.documentVersions.get(normalizedPath) : undefined;
  // #1716: captured OUTSIDE withTimeout, mirroring #1713's pull-diagnostic
  // fix (`pullDiagnosticSource`), so a timeout's catch below still holds a
  // live handle on the request for the late-answer watch. `withTimeout`
  // only races it against a timer — the request keeps running server-side
  // either way, and without this handle an abandoned answer would settle
  // into the void with no way to observe it.
  const requestStartedAt = Date.now();
  const requestPromise = safeSendRequest<T>(state.connection, method, params, signal);
  const result = await withTimeout(requestPromise, timeoutMs).catch((err) => {
    if (isNavTimeoutError(err, timeoutMs)) {
      recordNavTimeoutTelemetry({
        method,
        scope: normalizedPath,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - requestStartedAt,
      });
      armNavLateAnswerTelemetry({
        requestPromise,
        method,
        scope: normalizedPath,
        requestStartedAt,
      });
      return undefined;
    }
    if (err instanceof Error && err.message.startsWith("Timeout after")) {
      return undefined;
    }
    throw err;
  });
  // requestVersion === undefined (never opened, or version-less) → unaffected,
  // matching the diagnostics path; the request timeout remains the backstop.
  if (normalizedPath !== undefined && requestVersion !== undefined && navStaleDropEnabled()) {
    const currentVersion = state.documentVersions.get(normalizedPath);
    if (currentVersion !== undefined && currentVersion > requestVersion) {
      return undefined;
    }
  }
  return result;
}

/**
 * #1716: `withTimeout` rejects with this EXACT message (`clients/deadline-
 * utils.ts`) only when its own timer wins the race — mirrors #1713's
 * `isPullTimeoutError`. Only the timer-won case is a "the answer might still
 * be coming" situation worth a late-answer watch; a request that already
 * failed fast (or a stale-message coincidence) has nothing further to
 * observe. `navRequest`'s own behavior still falls back to the looser
 * `startsWith` check afterward, unchanged, so this stricter check only gates
 * telemetry — never the existing timeout-handling behavior.
 */
function isNavTimeoutError<T>(err: T, timeoutMs: number): boolean {
  return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

// #1716: subject/scope used when a nav request has no `staleCheckPath` (e.g.
// workspaceSymbol, call-hierarchy follow-ups) — mirrors WORKSPACE_PULL_SCOPE
// above for the same reason: telemetry identity needs a stable placeholder
// where there is no real path.
const NAV_REQUEST_NO_PATH_SCOPE = "*no-path*";

/**
 * #1716: `navRequest` is the highest-volume LSP call site — hover,
 * definition, references, signatureHelp, documentSymbol, workspace/symbol,
 * call hierarchy all route through it, often several times per turn. A stuck
 * server can storm timeouts across many methods and files far faster than
 * the pull-diagnostic path #1713 fixed, so a per-event latency.log write
 * (that fix's shape) would itself become the flood. Every timeout is still
 * counted exactly, via the degradation ledger (bounded, in-memory, no I/O),
 * but only the RISING EDGE — the first occurrence per (method, file) this
 * session — also pays for a detailed log write. `incrementDegradationCount`'s
 * return value (`true` on the first occurrence for a kind/subject pair) is
 * reused as that rising-edge gate instead of a second hand-rolled latch: it
 * already re-arms at session_start via `resetDegradationLedger`, so this
 * adds zero new module state. Never throws: telemetry must not perturb a
 * path that has already decided to return `undefined` regardless.
 */
function recordNavTimeoutTelemetry(args: {
  method: string;
  scope: string | undefined;
  budgetMs: number;
  elapsedMs: number;
}): void {
  // #1743: `risingEdgePer: "identity"` is the same gate this site hand-rolled
  // off `incrementDegradationCount`'s return value, now expressed as an
  // option. The ledger still counts every timeout exactly, per (method, file).
  emitBounded(
    "lsp_nav_request_timeout",
    `${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
    {
      type: "phase",
      filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
      durationMs: args.elapsedMs,
      metadata: { method: args.method, effectiveBudgetMs: args.budgetMs },
    },
    {
      ledgerKind: "lsp-nav-request-timeout",
      risingEdgePer: "identity",
      reason: `timeout budget=${args.budgetMs}ms elapsed=${args.elapsedMs}ms`,
    },
  );
}

/**
 * #1716: nav-request sibling of #1713's `armLateAnswerTelemetry`. A
 * telemetry-only continuation on the ALREADY-abandoned request promise —
 * purely observational, never touches `state`, and attaching `.then` here
 * creates no new timer, socket, or other handle, so it cannot keep the
 * process alive a moment longer than the pending request already does.
 *
 * Bounded the same way as the timeout record above: every late answer is
 * counted exactly via the ledger, but only the rising edge per (method,
 * file) also writes an `lsp_nav_late_answer_discarded` record.
 *
 * Nav answers are read-once — unlike diagnostics' persistent pull cache,
 * there is no stale value this could poison — so this exists purely for
 * observability: telling a dogfood session "truly hung" apart from
 * "answered late", the same distinction #1713 made possible for pulls.
 */
function armNavLateAnswerTelemetry(args: {
  requestPromise: Promise<unknown>;
  method: string;
  scope: string | undefined;
  requestStartedAt: number;
}): void {
  args.requestPromise.then(
    () => {
      try {
        const elapsedMs = Date.now() - args.requestStartedAt;
        // #1743: same rising-edge gate as the timeout record above, now
        // carried by the helper instead of hand-rolled here.
        emitBounded(
          "lsp_nav_late_answer_discarded",
          `${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
          {
            type: "phase",
            filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
            durationMs: elapsedMs,
            metadata: { method: args.method },
          },
          {
            ledgerKind: "lsp-nav-late-answer",
            risingEdgePer: "identity",
            reason: `late nav answer discarded after ${elapsedMs}ms`,
          },
        );
      } catch {
        // Telemetry must never break the observed path.
      }
    },
    () => {
      // The abandoned request eventually failed rather than answering —
      // not an "answer discarded" event. Nothing more to record here; this
      // handler exists so the request's eventual rejection never surfaces
      // as an unhandled rejection.
    },
  );
}

// #1277: cheap liveness round-trip used by the silent-clean gates in
// `index.ts`. `isAlive()`/`checkAlive()` only look at process/connection
// state — a server that accepted the notify write and then wedged (still
// running, connection still open, just never replying) reads as "alive" by
// those checks even though it will never answer anything again. This sends a
// real request (`workspace/symbol`, chosen because it needs no open document)
// and reports whether the connection round-tripped it — success, a genuine
// protocol-level error (e.g. MethodNotFound), and a stream-destroyed/
// cancelled response (safeSendRequest swallows those to `undefined`, so the
// final `isClientAlive` re-check is what catches "died mid-flight") ALL count
// as "alive"; only a real timeout, or the connection having gone down by the
// time this resolves, reports dead. The response content itself is never
// inspected — only whether one arrived in time.
export async function clientPingLiveness(
  state: LSPClientState,
  timeoutMs: number = LIVENESS_PING_TIMEOUT_MS,
): Promise<boolean> {
  if (!isClientAlive(state)) return false;
  try {
    await withTimeout(
      safeSendRequest(state.connection, "workspace/symbol", {
        query: LIVENESS_PING_QUERY,
      }),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Timeout after")) {
      return false;
    }
    // A real protocol-level error reply still proves the server round-
    // tripped the request — fall through to the alive re-check below
    // rather than treating an error response as "dead".
  }
  return isClientAlive(state);
}
