/**
 * Request timeouts, client capabilities, and other LSP client tunables.
 */
import { ADVERTISED_POSITION_ENCODINGS } from "../position-encoding.ts";

// --- Constants ---

export const INITIALIZE_TIMEOUT_MS = positiveIntFromEnv("CHOCO_PI_LSP_LSP_INIT_TIMEOUT_MS", 15_000); // 15s — npx downloads are handled by ensureTool, not here

/**
 * The client capabilities advertised in every `initialize`. The textDocument set
 * is intentionally COMPLETE and spec-compliant: servers built on
 * OmniSharp.Extensions.LanguageServer (PowerShell Editor Services, #278)
 * dereference these sub-capabilities while handling `initialize` and throw a
 * NullReferenceException when an expected one is absent, hanging the handshake. A
 * partial textDocument object (the old `synchronization: {didOpen, didChange}` —
 * not even valid TextDocumentSyncClientCapabilities fields) triggered exactly
 * that. Declaring the full set is harmless to other servers (they act only on the
 * requests we actually send), so this is the single, server-agnostic shape.
 * Exported for the regression guard in client-internals tests.
 */
export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ADVERTISED_POSITION_ENCODINGS },
  // #974: workDoneProgress is intentionally NOT advertised. choco-pi-lsp never
  // consumes `$/progress` notifications (grepped: zero listeners anywhere in
  // clients/), so declaring the capability only invites servers to open
  // progress tokens choco-pi-lsp will silently ignore — and opengrep's
  // `--experimental` LSP mode crash-loops when it can't parse our
  // spec-correct `{"result": null}` reply to its
  // `window/workDoneProgress/create` request. "Only advertise what you
  // implement" — the `window/workDoneProgress/create` handler below stays as
  // a defensive no-op in case a server ignores capabilities and asks anyway.
  window: {},
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    completion: {
      dynamicRegistration: false,
      completionItem: { snippetSupport: false },
    },
    hover: { dynamicRegistration: false },
    signatureHelp: { dynamicRegistration: false },
    definition: { dynamicRegistration: false },
    typeDefinition: { dynamicRegistration: false },
    implementation: { dynamicRegistration: false },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false },
    codeAction: { dynamicRegistration: false },
    rename: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
    },
  },
} as const;
export const NAV_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_NAV_REQUEST_TIMEOUT_MS",
  10_000,
); // 10s — per-request ceiling; prevents heavy servers (vue, svelte) from hanging
export const DIAGNOSTICS_WAIT_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_DIAGNOSTICS_WAIT_MS",
  10_000,
);
export const PULL_DIAGNOSTICS_RETRY_INTERVAL_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PULL_RETRY_INTERVAL_MS",
  250,
);
// Per-request ceiling for pull diagnostics (textDocument/diagnostic), mirroring
// NAV_REQUEST_TIMEOUT_MS. safeSendRequest only settles on a reply or a *destroyed*
// stream, so a pull-mode server that is alive but hung (accepts the request, never
// replies) would await forever — hanging clientWaitForDiagnostics and, upstream,
// the diagnostics flush. On timeout the request is treated as `unavailable`, which
// (per #240) is NOT read as clean and falls through to the bounded push backstop.
export const PULL_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PULL_REQUEST_TIMEOUT_MS",
  10_000,
);
// #1773: the smallest budget this codebase treats as usable — dispatching
// BELOW it is not a real attempt. The old clamp (`Math.max(1, ...)`) let an
// exhausted `budgetMs` (0 or negative) through as a 1ms pull — sent, timed
// out by construction, and recorded as a genuine `lsp_pull_diagnostic_timeout`
// with a fabricated `effectiveBudgetMs: 1` (observed live: both pull-timeout
// records in the 2026-08-20 plegma dogfood session carried exactly that).
// 5ms sits below the smallest budget this codebase's own regression fixtures
// already treat as a real dispatch (`tests/clients/lsp/pull-diagnostic-
// timeout-telemetry.test.ts` exercises 20ms and 30ms as genuinely-attempted-
// then-timed-out) and above the 1-4ms band that is indistinguishable from
// "already exhausted" — a local stdio server round trip (write + compute +
// parse) needs more than a handful of milliseconds even on the fast path.
// `budgetMs === PULL_MIN_USABLE_BUDGET_MS` dispatches (the comparison below
// is strict `<`), so the name reads literally: this is the floor value that
// still gets a real attempt.
export const PULL_MIN_USABLE_BUDGET_MS = 5;
export const SHUTDOWN_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_SHUTDOWN_TIMEOUT_MS",
  1000,
);
// #1620: the `exit` NOTIFICATION needs its own ceiling, for the same reason the
// `shutdown` REQUEST has one. A notification write on a pipe that is not
// draining neither resolves nor rejects, so `safeSendNotification`'s catch never
// runs and the await is unbounded. The #1459 wedged-write breaker calls this
// teardown precisely when that stdin has already been PROVEN wedged, so the
// unbounded await was the whole mechanism of the leak. Kept equal to the request
// budget: a healthy server still gets a brief graceful window before the kill.
export const EXIT_NOTIFY_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_EXIT_NOTIFY_TIMEOUT_MS",
  1000,
);
// #1277: cheap liveness round-trip for the silent-clean gates (`index.ts`).
// Those gates convert a diagnostics-wait timeout into a confirmed-clean
// result from a STATIC capability classification (`silentOnClean`) alone —
// but a wedged server (accepted the notify write, then hung) satisfies that
// classification identically to a genuinely clean one. This is deliberately
// short relative to NAV_REQUEST_TIMEOUT_MS: it only needs to prove the
// connection round-trips SOMETHING before the touch reports clean, not
// complete a real navigation request.
export const LIVENESS_PING_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_LIVENESS_PING_TIMEOUT_MS",
  300,
);
// Distinctive, unlikely-to-collide query string — the response content is
// never inspected, only whether one arrived before the timeout.
export const LIVENESS_PING_QUERY = "__pi_lens_liveness_ping__";
// #1104: bound on `state.workspacePullResultCache` — one entry per distinct
// file the server has ever returned a `resultId` for across this client's
// lifetime. A full clear on overflow (rather than an LRU) is fine, same
// reasoning as `DISK_BINDING_MEMO_MAX` in diagnostic-binding.ts: each entry is
// cheaply rebuilt by the next full pull, the worst case is just one extra full
// (non-`unchanged`) report per affected file.
export const WORKSPACE_PULL_RESULT_CACHE_MAX = 4096;
// #1713: `workspace/diagnostic` has no per-file/per-identifier request to key
// telemetry identity on — it is one project-wide pull — so timeout/late-answer
// records use this fixed subject/scope instead of a real path.
export const WORKSPACE_PULL_SCOPE = "*workspace*";
// #1669 review N2: cap on simultaneous re-pulls the `workspace/diagnostic/
// refresh` handler fires for open documents. A workspace with hundreds of
// open documents fanning out one `textDocument/diagnostic` request each,
// with no cap, floods the server the refresh itself just told us is under
// load. Small and fixed — this is a background improvement after the
// protocol reply, never something worth tuning per project.
export const REFRESH_REPULL_CONCURRENCY = 4;

/** Run `mapper` over `items` with at most `concurrency` in flight at once.
 *  Same shape as `dependency-checker.ts`'s helper of the same name — a
 *  worker-pool pattern repeated per-file by design in this codebase rather
 *  than shared, so each caller can keep it un-exported and file-local. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
// Anti-deadlock backstop for workspace/executeCommand. Deliberately generous
// (30s): the command is mutating and legitimately long-running (a real server
// refactor / organize-imports), so this must not truncate valid work — it only
// stops a hung server from blocking the caller forever. On timeout the command
// may still be applying server-side; we surface that rather than pretend it ran.
export const EXECUTE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_EXECUTE_COMMAND_TIMEOUT_MS",
  30_000,
);
// #1412 H1: short ceiling for the read-only tsserver project-identity probe.
// This is a telemetry sample, not a mutation — it must never hold the door
// open for anything close to EXECUTE_COMMAND_TIMEOUT_MS.
export const PROBE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PROJECT_IDENTITY_PROBE_TIMEOUT_MS",
  2_500,
);

// Using shared path utilities from path-utils.ts

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
