/**
 * Timing budgets, breaker thresholds, and environment-tunable limits of the LSP service.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import type { LSPServerInfo } from "./server.ts";

export const BROKEN_BASE_COOLDOWN_MS = 15_000;

export const BROKEN_MAX_COOLDOWN_MS = 5 * 60_000;
// cap at 5 minutes
export const BROKEN_PERMANENT_AFTER = 5;
// disable for session after N consecutive failures
// #1127: a client that dies THIS soon after a successful spawn/initialize is
// treated as a crash-loop symptom (opengrep's post-init "Unhandled message"
// exit), not a legitimate long-running server that happened to restart once.
// 60s comfortably covers normal serve-a-few-files-then-idle sessions while
// still catching "spawns fine, dies within seconds every time" servers.
export const RUNTIME_EXIT_UPTIME_THRESHOLD_MS = 60_000;

// #1142: the fast path above only trips on CONSECUTIVE exits UNDER the 60s
// threshold, so a server that reliably dies just PAST it (~65-90s after every
// spawn) resets that streak on every death and churns forever — a persistent
// low-frequency crash loop the hard-cutoff design structurally cannot see. The
// windowed-rate trip COMPOSES with (does not replace) the fast path: N
// non-intentional deaths within a rolling M-minute window trip the breaker
// regardless of each death's individual lifetime.
//   N = BROKEN_PERMANENT_AFTER (5): one uniform "5 strikes" give-up count
//       across both streams, and high enough that the benign over-threshold
//       deaths that reach this path (a one-off crash after a long healthy run;
//       a single sleep/resume connection drop) — at most one per key per event
//       — cannot approach it.
//   M = 15 min: wide enough for a genuine slow loop (each life ~65-90s, so 5
//       death→respawn cycles land in ~6-15 min of active churn) to accumulate
//       5, yet short enough that sparse benign crashes (e.g. "twice last hour,
//       now healthy") age out of the rolling window before five ever coincide.
export const RUNTIME_EXIT_WINDOW_MS = 15 * 60_000;

export const RUNTIME_EXIT_WINDOW_TRIP_COUNT = BROKEN_PERMANENT_AFTER;

// A death whose measured lifetime (`exitedAt - spawnedAt`) exceeds this ceiling
// is NOT recorded toward the window: it is either a genuinely long healthy run
// that crashed once, or a lifetime computed ACROSS a machine-sleep / Modern-
// Standby suspend (the #1122/#1139 death-timestamp lesson — a suspend gap makes
// a benign exit look like a huge "uptime"), and neither is crash-loop churn.
// The slow-loop residual this fix targets dies well within the ceiling
// (~65-90s), so it is unaffected. This is a belt-and-suspenders guard on top of
// the structural defense that the window is per-KEY: a single suspend kills at
// most one live client per server, contributing at most one death to any one
// key's window, so it cannot by itself reach the trip count regardless.
export const RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS = 10 * 60_000;

// #743: a server whose per-server notify write (didOpen/didChange) times out
// this many times in a row is a persistently backpressured server; it is demoted
// into the `broken` cooldown map (evicted + cooled down) so subsequent sweeps
// stop re-paying its notify budget on every file. A single successful write
// resets the streak.
export const NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3;

export const OPTIONAL_LSP_RETRY_COOLDOWN_MS = 5 * 60_000;

export const OPTIONAL_LSP_SERVER_IDS = new Set<string>();

export const NAV_CLIENT_WAIT_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_NAV_CLIENT_WAIT_MS ?? "1500", 10) || 1500,
);

export const TOUCH_DEBOUNCE_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_TOUCH_DEBOUNCE_MS ?? "1500", 10) || 1500,
);

// #1621: the rename-propagation notifies (`didClose` ahead of the rename,
// `workspace/didRenameFiles` after) share the exit-notify defect #1620 fixed —
// a notify write on a pipe that is not draining neither resolves nor rejects,
// so the bare `await` was unbounded. Rename propagation is best-effort advice
// to servers, not a correctness gate, so a wedged client's notify gets its own
// ceiling and a recorded disposition rather than stalling the `Promise.all`
// for every healthy client alongside it.
// #1621 F3: floor at 50ms, not 0 — a negative env value (e.g. "-100") is
// truthy after `Number.parseInt`, so it survives the `|| 1500` fallback and
// would otherwise reach `withDeadline`'s `ms <= 0` branch. That branch treats
// the budget as already expired and settles without ever really attempting
// the notify — a negative override would silently disable rename propagation
// instead of merely shortening its budget.
export const RENAME_NOTIFY_TIMEOUT_MS = Math.max(
  50,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_RENAME_NOTIFY_TIMEOUT_MS ?? "1500", 10) || 1500,
);

export const DEFAULT_LSP_CLIENT_CEILING = 24;

export const DEFAULT_TS_IDLE_EVICT_MS = 20 * 60_000;

export function getTypeScriptIdleEvictMs(): number {
  const parsed = Number.parseInt(process.env.CHOCO_PI_LSP_TS_IDLE_EVICT_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TS_IDLE_EVICT_MS;
}

export function getLspClientCeiling(): number {
  const parsed = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_CLIENT_CEILING ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LSP_CLIENT_CEILING;
}

// #667: the sweep warm-up round trip's OWN generous, one-time budget —
// deliberately larger than any single per-file sweep budget (`perFileMs` in
// `runWorkspaceDiagnostics`, or the batch tool's per-file wait) because this
// pays for whatever a cold tsserver-style server needs to finish its internal
// project load/index before it can usefully answer ANY diagnostics request,
// not just one file's worth of work. Env-tunable like every other wait budget
// in this file.
export function warmupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WARMUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

// #744: short pause between the first warm-up round trip and the single retry
// `ensureWarmForSweep` gives a server that didn't warm on its first attempt.
// Deliberately small — it's a breather for a server mid-relaunch/index (the
// state where warmup failure is most likely, e.g. a sweep starting seconds
// after an `lsp_service_reset`), not a second full budget. Read at call time so
// tests can drive the retry without waiting out a real backoff. 0 disables the
// pause entirely (retry fires immediately).
export function warmupRetryBackoffMs(): number {
  const raw = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WARMUP_RETRY_BACKOFF_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/**
 * Read the `CHOCO_PI_LSP_LSP_DIAGNOSTICS_MAX_WAIT_MS` env override at call time
 * (process.env mutations in tests stay live). Returns undefined when unset,
 * non-numeric, or negative — callers fall back through the explicit option
 * chain in {@link LSPService.touchFile}.
 */
export function readEnvDiagnosticsWaitMs(): number | undefined {
  const raw = process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_MAX_WAIT_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * #707: grace delay before the racing tsserver sync clean-confirm fires on a
 * tier-3 silent primary. Short enough to beat the full push-wait budget by a
 * wide margin (~300ms grace + sync RTT vs ~1000ms budget), long enough to give
 * a genuinely dirty file's push a head start — a push that arrives within the
 * grace costs zero extra requests. Read at call time (not memoized) so tests
 * and users can tune without a rebuild.
 */
export function readTsserverSyncGraceMs(): number {
  const raw = process.env.CHOCO_PI_LSP_TSSERVER_SYNC_GRACE_MS;
  if (raw === undefined) return 300;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 300;
  return parsed;
}

/**
 * Read the `CHOCO_PI_LSP_AUX_GRACE_MS` env override at call time (not module
 * load time) so tests can set it per-case. Controls the CEILING on how long
 * auxiliary-role promises (opengrep, ast-grep, zizmor, …) are waited after
 * all primary-role promises have settled, in both getDiagnostics
 * (raceToCompletion) and the touchFile push wait (#1458 S2 — the two lanes
 * share the same declared-budget-capped-by-ceiling shape). Each auxiliary
 * still gets only its OWN declared `aggregateWaitMs` up to this ceiling —
 * this is not a flat per-touch wait. Returns undefined when the var is
 * absent; each call site then supplies its own default ceiling (touchFile:
 * 2000ms; getDiagnostics: 2000ms — see the `?? 2000` at each call site).
 */
export function readEnvAuxGraceMs(): number | undefined {
  const raw = process.env.CHOCO_PI_LSP_AUX_GRACE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export const DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS ?? "250", 10) ||
    250,
);

export const DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS ?? "400", 10) || 400,
);

// Once the fastest client has diagnostics, remaining clients get this window before
// we proceed with whatever results are ready. 0 disables early-unblock.
export const EARLY_UNBLOCK_GRACE_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_EARLY_UNBLOCK_GRACE_MS ?? "400", 10) || 400,
);

export const CASCADE_DIAGNOSTICS_TTL_MS = 240_000;

export const WORKSPACE_DIAGNOSTICS_CONCURRENCY = 8;

// #621: a single-server group (the common case — one language, one server)
// used to pre-open its ENTIRE file list in one uninterrupted burst (#608)
// before the per-file diagnostics-wait loop even started. That coalesces
// watched-files notifications into one flush (the #608 fix's intent), but at
// real project scale (~150 files) it also dumps the whole group on the
// server's single-threaded request queue essentially at once, forcing it to
// ingest/typecheck the full burst before any per-file diagnostics request
// even gets a turn — observed to collapse to near-100% per-file timeouts on
// a ~150-file TS project (pi-drykiss dogfooding). `lsp_diagnostics`'
// bounded-concurrency batch/directory mode (tools/lsp-diagnostics.ts, default
// 8) never has this problem: it only ever has ~8 files in flight at once.
// Chunking the pre-open+process cycle to the same width gets both properties:
// each chunk's opens still land inside `WatchedFilesQueue`'s 100ms debounce
// window and coalesce into one flush (bounded burst, not per-file — the
// original #608 bug pre-opened lazily one file at a time with a full
// diagnostics wait in between, which is what defeated the debounce), while no
// single burst ever exceeds this width regardless of total group size.
export const WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE = (() => {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PREOPEN_CHUNK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

// #584: opengrep has no `workspace/diagnostic` pull support (push-only,
// docs/servercapabilities.md) and `reopenOnResync: true` (wait-policy/strategies.ts)
// means every per-file LSP touch already forces a full re-scan anyway — there's
// no incremental win from routing it through the sweep's per-file loop. On a
// full workspace sweep it instead dominates the per-file wait (its own
// wait-tier budget is the slowest of any spawned server) and serializes with
// everything else in its server group (#387). Its findings for a BULK/
// full-workspace scan come from `opengrep-client.ts` — a dedicated CLI
// extractor that scans the whole tree once and is read via
// `project-diagnostics/extractors.ts`, same architecture as knip/jscpd/
// gitleaks. The per-edit real-time LSP path (clientScope "primary"/
// "with-auxiliary") is untouched by this — opengrep still attaches there.
export const WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS: ReadonlySet<string> = new Set(["opengrep"]);

// The notify write (didOpen/didChange) is normally instant, but it awaits a
// JSON-RPC send that BACKPRESSURES when the server's stdin isn't being drained
// (a wedged/CPU-bound server, e.g. TypeScript mid-recheck). Unbounded, that
// write parks every touchFile caller: the pre-dispatch sync, the dispatch LSP
// runner (which then rides to its 30s dispatcher timeout — the observed ~31s
// edits), and the workspace sweep. Bounding it here degrades a wedged server to
// "no fresh diagnostics" instead of hanging the edit, for ALL callers.
export function notifyWriteBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_NOTIFY_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

// #1459: how long ONE auxiliary notify write may stay outstanding before the
// server counts as wedged rather than merely slow. A scanner whose per-file work
// exceeds the write budget is normal (opengrep routinely needs >2s on a large
// file) and must not be demoted for it — the gate defers the next write instead.
// A write still unaccepted after this window is a different animal: nothing is
// draining that stdin, so the server is demoted through the existing breaker.
// Expressed as a multiple of the write budget so tuning one moves both.
export const NOTIFY_WEDGED_BUDGET_MULTIPLIER = 5;

export function notifyWedgedMs(): number {
  return notifyWriteBudgetMs() * NOTIFY_WEDGED_BUDGET_MULTIPLIER;
}

// #1714: how many document notifies one auxiliary may hold UNACKNOWLEDGED
// before the next notify has to prove the server drained its input.
//
// #1459's gate bounds CONCURRENT writes to one per auxiliary. That stops a
// simultaneous fan-out, but a `diagnostics_report mode=full` sweep is mostly
// SEQUENTIAL — one file after another inside a server group (#387) — so every
// write is alone in flight and the gate never engages. Each write still resolves
// as soon as the pipe accepts the bytes, not when the scanner has read them, so
// the sweep can hand a single-threaded scanner hundreds of full re-parses faster
// than it consumes them. ast-grep stalled and had to be force-killed twice in
// two full-scan exposures. Counting unacknowledged notifies bounds the BACKLOG
// the sweep is allowed to build, which pipe-level backpressure alone does not.
export const AUX_NOTIFY_INFLIGHT_DEFAULT = 8;

export function auxNotifyInflightLimit(info: LSPServerInfo): number {
  const perServer = info.notifyInflightLimit;
  if (perServer !== undefined && Number.isFinite(perServer) && perServer > 0) {
    return Math.floor(perServer);
  }
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_AUX_NOTIFY_INFLIGHT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUX_NOTIFY_INFLIGHT_DEFAULT;
}

// Budget for one project-wide `workspace/diagnostic` pull (#387 Item 2). Larger
// than a per-file wait — it's a single request but scans the whole program —
// yet bounded so a hung server still falls back to the per-file path.
export function workspacePullBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PULL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

// Hard cap on the workspace-diagnostics walk. Even though this is an explicit,
// user-invoked project-wide tool, the walk must be bounded so a misrooted run
// (e.g. cwd that resolves to $HOME) can't enumerate an entire home tree (#250).
// Generous — real projects are well under this; override for monorepos.
export const DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES = 5000;

export function getMaxWorkspaceDiagnosticFiles(): number {
  const override = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_MAX_FILES ?? "", 10);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES;
}
