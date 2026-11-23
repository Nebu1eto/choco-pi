/**
 * Public and shared types of the LSP service layer.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import type { LSPClientInfo } from "./client.ts";
import { type BoundToCurrentDisk } from "./diagnostic-binding.ts";
import type { LSPServerInfo } from "./server.ts";

// --- Types ---

export interface LSPState {
  clients: Map<string, LSPClientInfo>; // key: "serverId:root"
  servers: Map<string, LSPServerInfo>;
  broken: Map<string, number>; // servers that failed to initialize with retry-at timestamp
  inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
  clientSpawnedAt: Map<string, number>; // key: "serverId:root" → epoch ms of last successful spawn
  /**
   * #667: key "serverId:root" of every client that has already answered at
   * least one diagnostics-mode `touchFile` (not `.inconclusive`) this
   * session. Deliberately a STRONGER bar than `isAlive()`/spawned/
   * initialize-handshake-complete (all already true at `serverCountReady:1`
   * while the server was still uselessly timing out on real requests — see
   * `ensureWarmForSweep`): only a confirmed round trip counts as "warm".
   */
  demonstratedReady: Set<string>;
  /**
   * #799: key "serverId:root" (same identity as {@link demonstratedReady})
   * of every server whose `ensureWarmForSweep` warm-up ended inconclusive
   * this session (initial attempt + retry both left it without a confirmed
   * round trip — the same condition that populates `failedServerIds`). A
   * later sweep in the SAME session sees this and skips straight to the
   * caller's group-skip accounting instead of re-paying the warm-up
   * round trip (and its retry) all over again. Session-scoped like
   * `demonstratedReady`: a fresh `LSPService` (created by
   * `resetLSPService`) starts with an empty set, so a new session always
   * retries fresh. A key is removed the moment that server demonstrates
   * readiness through ANY path (see `markDemonstratedReadyKey`), so a
   * server that recovers later in the same session is never stuck cold.
   */
  demonstratedCold: Set<string>;
}

export interface SpawnedServer {
  client: LSPClientInfo;
  info: LSPServerInfo;
}

// #1621: a rename-propagation notify failure now records WHY it failed —
// `timedOut` (the notify write never settled inside its budget) is distinct
// from `rejected` (the send itself errored) — so an empty failure list still
// means clean, and a timeout doesn't read as an indistinguishable rejection.
export type RenameNotifyDisposition = "timedOut" | "rejected";

export interface RenameNotifyFailure {
  serverId: string;
  error: string;
  disposition: RenameNotifyDisposition;
}

export interface LSPRenameFileResult {
  applied: boolean;
  serverIds: string[];
  willRenameFailures: Array<{ serverId: string; error: string }>;
  didRenameFailures: RenameNotifyFailure[];
  droppedConflicts: number;
  inputEditCount: number;
  summary: string[];
  descriptions?: string[];
  files?: string[];
}

export interface LSPDiagnosticsHealth {
  health: "ok" | "ok_empty" | "no_clients" | "no_clients_stale" | "destroyed";
  failureKind: string;
  serverCountAttempted: number;
  serverCountReady: number;
  candidateServerIds: string[];
  mergedCount: number;
  dedupDroppedCount: number;
  checkedAt: string;
}

export type LSPDiagnosticsMode = "none" | "document" | "full";

export type LSPTouchClientScope = "primary" | "all" | "with-auxiliary";

export interface LSPTouchFileOptions {
  diagnostics?: LSPDiagnosticsMode;
  source?: string;
  clientScope?: LSPTouchClientScope;
  /**
   * For clientScope "with-auxiliary": the auxiliary server ids (e.g. "opengrep")
   * to attach alongside the primary. The caller (lsp runner) computes which are
   * enabled (it owns flag access); the service just spawns + collects them.
   */
  auxiliaryServerIds?: readonly string[];
  /**
   * For clientScope "all": server ids to skip even though they match the
   * file's extension. Used by `runWorkspaceDiagnostics` (#584) to keep
   * opengrep off the per-file bulk-sweep touch loop — its findings now come
   * from a dedicated CLI project-diagnostics extractor (`opengrep-client.ts`)
   * that runs once per project instead of once per file, so re-touching it
   * here would be redundant AND (per #584/#387) the slow auxiliary that
   * dominates the per-file wait during a full workspace sweep.
   */
  excludeServerIds?: ReadonlySet<string>;
  /** Budget for waiting on the LSP client to spawn / become ready. */
  maxClientWaitMs?: number;
  /**
   * Budget for waiting on `textDocument/publishDiagnostics` after the notify
   * lands. The dispatch-lsp-runner sets this to a tighter value so a slow
   * LSP on one file doesn't dominate the per-edit pipeline budget (#117).
   *
   * Resolution order (first wins):
   *   1. `CHOCO_PI_LSP_LSP_DIAGNOSTICS_MAX_WAIT_MS` env var (user override)
   *   2. this option
   *   3. `maxClientWaitMs` (legacy fallback)
   *   4. built-in defaults (3000 ms for `full`, 1200 ms for `document`)
   */
  maxDiagnosticsWaitMs?: number;
  /** Return merged diagnostics from the clients touched by this call. */
  collectDiagnostics?: boolean;
  /** Skip workspace/didChangeWatchedFiles — use for cascade reads, not real fs changes */
  silent?: boolean;
  /**
   * #645: per-sweep gate (see `createSweepIndexGate`/`SweepIndexGate`) that
   * lets a `workspaceIndexing`-strategy server (e.g. marksman) pay its full
   * `aggregateWaitMs` wait only once per `runWorkspaceDiagnostics` sweep
   * instead of once per swept file. Only `runWorkspaceDiagnostics` passes
   * this; every other caller (per-edit dispatch, cascade touches) omits it,
   * so `perServerTimeout` below always falls back to the pre-#645 full-wait
   * behavior for them.
   */
  sweepIndexGate?: SweepIndexGate;
  /**
   * #669: `perServerTimeout`'s caller-cap is a CEILING by design (#242) for
   * the normal per-edit/steady-state dispatch path — a slow strategy must
   * never blow past the pipeline's cap. `ensureWarmForSweep`'s cold-server
   * warm-up call is the inverse case: it deliberately asks for a budget
   * LARGER than the server's normal warm-state `aggregateWaitMs`, precisely
   * because the server hasn't finished its cold launch/indexing yet. Without
   * this flag, `Math.min(callerCap, strategyWait)` silently shrinks that
   * request back down to `strategyWait` (e.g. 1000ms for typescript)
   * regardless of the 20000ms actually requested, defeating the warm-up
   * entirely. When true, the caller's cap is treated as a FLOOR instead —
   * `Math.max(callerCap, strategyWait)` — never shrunk below what was asked.
   * #832: the first warm-up touch is exempt from this floor when the live
   * capability classification identifies a workspace-indexing push-only
   * server as silent-on-clean; that server uses its configured strategy wait.
   * Only `ensureWarmForSweep` sets this; every other caller leaves it unset
   * and keeps the pre-existing ceiling-only semantics exactly as-is.
   */
  warmupOverride?: boolean;
  /**
   * #799: which `warmupOverride` attempt this touch is (1 = the first
   * round trip against a cold server, 2 = `ensureWarmForSweep`'s single
   * retry). Normally only the FIRST attempt gets the full cold-start floor
   * (`Math.max(callerCap, strategyWait)`) — a genuinely slow-to-index
   * server (tsserver-style) deserves that full window once. #832's
   * workspace-indexing push-only silent-on-clean exception uses the shorter
   * configured strategy wait on both attempts. A retry
   * attempt already got that window and re-flooring it to another 20s
   * would silently double-pay the ceiling for a server whose real issue
   * is that it's `silentOnClean` and simply never publishes (marksman) —
   * that retry instead respects the server's own (much shorter) strategy
   * budget, same as a normal steady-state touch. For non-exempt servers,
   * undefined/1 keeps today's floor-every-attempt behavior; only
   * `ensureWarmForSweep`'s retry sets this to 2.
   */
  warmupAttempt?: number;
}

/**
 * #1618: discriminated cause for an unconfirmed (`timedOut: true`)
 * `LSPWorkspaceDiagnosticResult` — replaces the old single `timedOutFiles`
 * bucket, which conflated a real budget timeout with a thrown error (the
 * `unconfirmedErrored = length - unconfirmedTimedOut` dead-subtraction bug
 * downstream in `tools/diagnostics-report.ts` was structurally always 0
 * because the sweep's own catch block set BOTH `error` and `timedOut`) and
 * with a service torn down mid-sweep by the idle-reset race (81 files that
 * left zero trace and rendered as "check didn't complete within budget").
 *
 * - `budget` — the outer per-file `withDeadline` wrapper never got a result
 *   back at all within `perFileMs`.
 * - `inconclusive` — `touchFile`'s own `.inconclusive` flag (#570): the
 *   notify write or the diagnostics wait itself timed out. Also used for a
 *   group skipped after a failed pre-sweep server warm-up (#744) — the
 *   check was never even attempted, which is inconclusive, not a timeout.
 * - `coverage_gap` — an auxiliary scanner never reported for this touch
 *   (breaker-open, deferred resync, or a silent/cut-off wait — see
 *   `touchCoverageGap`).
 * - `service_destroyed` — the LSP service was torn down (`resetLSPService`)
 *   while this sweep was still in flight; the remainder of the sweep never
 *   even attempted a language-server round trip for this file.
 * - `error` — the per-file check threw.
 * - `binding_mismatch` — never set by this module. `tools/diagnostics-report.ts`
 *   classifies a result into this reason AFTER the sweep returns, when its
 *   content-binding fingerprint no longer matches disk (`boundToCurrentDisk:
 *   false`, or a hash check that failed post-hoc) — the LSP layer itself
 *   considered the touch confirmed, but the file changed under it. Listed
 *   here so both modules share one discriminated union rather than the tools
 *   layer inventing a second, parallel one (#1618 review round 2).
 */
export type LSPWorkspaceUnconfirmedReason =
  | "budget"
  | "inconclusive"
  | "coverage_gap"
  | "service_destroyed"
  | "error"
  | "binding_mismatch";

export interface LSPWorkspaceDiagnosticResult {
  filePath: string;
  diagnostics: import("./client.ts").LSPDiagnostic[];
  count: number;
  error?: string;
  /**
   * True when this file's per-file check was NOT confirmed — either
   * `touchFile`'s own `.inconclusive` flag was set (#570: the notify write
   * or the diagnostics wait itself timed out), the OUTER `perFileMs`
   * `withDeadline` wrapper never got a result back at all, or the check
   * threw. `diagnostics` is a default-empty placeholder in every one of
   * those cases, not a confirmed result, and must not be treated as
   * "confirmed clean" by any caller reconciling this into cached state
   * (#571). Absent/false means the per-file check completed within budget
   * AND was confirmed; workspace-pull results (`tryWorkspacePull`) are
   * always confirmed (a pull either returns a real report or the caller
   * falls back to per-file, never a silent empty default).
   */
  timedOut?: boolean;
  /**
   * #1618: WHY `timedOut` is true — see {@link LSPWorkspaceUnconfirmedReason}.
   * Always set alongside `timedOut: true` on every path this sweep
   * produces; absent only on a legacy/test double that predates this field.
   */
  unconfirmedReason?: LSPWorkspaceUnconfirmedReason;
  /**
   * #744: true when this file's per-file check was never even attempted
   * because its primary language server failed the pre-sweep warm-up (an
   * initial round trip plus one retry both left it cold — e.g. marksman still
   * building its workspace index). Such a server would re-pay its full timeout
   * on every one of its files and drag the whole sweep, so the group is skipped
   * up front. Always accompanies `timedOut: true` (the result is unconfirmed,
   * NOT a confirmed-clean `[]`); this flag only records WHY, so the outcome
   * reads honestly as "skipped after failed warm-up" rather than "ran clean".
   */
  skippedWarmupFailure?: boolean;
  /**
   * #1093: wall-clock time (ms) these diagnostics were actually OBSERVED, set
   * ONLY for results served from the workspace-diagnostics cache (a replay of
   * an older scan). Absent for freshly-touched results (observed now). Callers
   * reconciling this into the footer widget must pass it as the `observedAt`
   * stamp so a cache-hit replay doesn't re-arm the mtime-staleness gate
   * (`reconcileStaleWidgetFiles`) and keep a resolved finding on screen (the
   * #1092 touchedAt-re-arming defect).
   */
  observedAt?: number;
  /**
   * #1104: sha256 of the file bytes this result's diagnostics were computed
   * against, when known — from the pull path's server-answered `resultId`
   * flow (a "full" `workspace/diagnostic`/`textDocument/diagnostic` report is
   * fingerprinted at request time; an "unchanged" report inherits the prior
   * fingerprint) or, for a per-file touch, the SAME `contentHash` the #1095
   * push-path binding records. Absent means "no hash available" (never
   * fabricated) — the cache-record site below then honestly stores no
   * contentHash and a later `lookup()`'s binding reads "unknown", exactly the
   * pre-#1104 behavior for that entry.
   */
  contentHash?: string;
  /**
   * Monotonic token reserved when this file entered the scan, rather than when
   * its asynchronous LSP work settled. Consumers use it to reject late old
   * results (#1198).
   */
  writeIndex?: number;
  /** #1198: explicit content-binding verdict from a per-file touch. */
  boundToCurrentDisk?: BoundToCurrentDisk;
}

/**
 * #645: tracks, for ONE `runWorkspaceDiagnostics` sweep, which server ids
 * have already had at least one file pay the full `aggregateWaitMs` wait
 * budget. `touchFile` consults this (via `LSPTouchFileOptions.sweepIndexGate`)
 * only for servers whose strategy is marked `workspaceIndexing: true` —
 * every other server is untouched. Deliberately a plain per-sweep object
 * (created fresh by `runWorkspaceDiagnostics`, never stored on `LSPService`
 * itself) so this is scoped to a single sweep call and can never leak state
 * across sweeps or affect a per-edit touch, which never receives one.
 */
export interface SweepIndexGate {
  /**
   * Returns true the first time it's called for `serverId` in this sweep
   * (and records that it was called), false on every subsequent call for
   * the same `serverId`. Synchronous and side-effecting by design — callers
   * must call it exactly once per touched file's server list (see
   * `touchFile`'s upfront per-server precompute) so a single `touchFile`
   * call's internal helper re-invocations don't each consume a separate
   * "first touch" slot.
   */
  consumeFirstTouch(serverId: string): boolean;
}
