/**
 * Workspace diagnostic sweeps and workspace pull for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

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

/** Implements {@link LSPService.runWorkspaceDiagnostics}. */
export async function runWorkspaceDiagnostics(
  core: LSPServiceInternals,
  cwd: string,
  options: {
    maxFiles?: number;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
    /** Called after a cold sweep warm-up successfully brings a server group
     * online. The caller may use this to refresh host observability UI. */
    onServerReady?: () => void;
    /**
     * Reserve per-file reconciliation order at scan admission time. The
     * callback is never called at result-settlement time (#1198).
     */
    nextWriteIndex?: () => number;
    /**
     * Explicit file list (#461): skip the project walk entirely and route
     * exactly these files through the sweep. Used by diagnostics_report'
     * `paths` scope restrictor so a wrapper (e.g. "git-staged files only")
     * gets the full mode=full treatment without paying for a whole-project
     * walk. Caller is responsible for resolving/deduping/filtering these
     * (diagnostics-report.ts already applies the ignore matcher the same way
     * the walk does before calling in).
     */
    files?: string[];
  } = {},
): Promise<LSPWorkspaceDiagnosticResult[]> {
  // #1618: hold the shared sweep gate for this call's ENTIRE lifetime —
  // counter-based (not a boolean) so two overlapping `mode=full` calls each
  // release independently, and try/finally so a throw or an aborted sweep
  // still releases it (a leaked hold would permanently disable idle reset,
  // the inverse defect). While held, `clients/runtime-turn.ts`'s idle-reset
  // timer defers instead of destroying this service mid-sweep.
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
  // Cap the per-file LSP sweep: a Next.js-scale project can route thousands
  // of files through the language server at concurrency 8, and without a
  // caller cap that grinds for tens of minutes (#341). `maxFiles` lets
  // diagnostics_report' `maxLspFiles` bound it; falls back to the env/default.
  const maxFiles =
    options.maxFiles !== undefined && Number.isFinite(options.maxFiles) && options.maxFiles > 0
      ? Math.floor(options.maxFiles)
      : getMaxWorkspaceDiagnosticFiles();
  const files = options.files
    ? options.files.slice(0, maxFiles)
    : await collectWorkspaceDiagnosticFiles(root, maxFiles, signal);
  // Per-file wall-clock: a language server that hangs during spawn/initialize
  // would otherwise park a worker on `touchFile` FOREVER (the per-edit
  // diagnostic wait is bounded, but client acquisition here is not) — the root
  // of an observed multi-hour hang. Budget each file so the worker always
  // returns to the loop (and its abort check). Env-tunable.
  const perFileMs = (() => {
    const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PER_FILE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
  })();
  const results: LSPWorkspaceDiagnosticResult[] = [];
  let completed = 0;
  let timedOutFiles = 0;
  let lastHeartbeat = Date.now();

  // #671: reuse the last CONFIRMED per-file result instead of re-touching
  // every file through the language server(s) again when nothing relevant
  // changed since the last sweep. `createWorkspaceDiagnosticsCacheContext`
  // (`workspace-diagnostics-cache.ts`) is shared with `tools/lsp-
  // diagnostics.ts`'s batch/directory sweep so a file swept by either tool
  // benefits the other's next sweep under the SAME `scopeKey` — see that
  // module's doc comment for the invalidation rules (own-mtime +
  // best-effort cross-file dependency staleness) and why `scopeKey` exists
  // (this sweep's `excludeServerIds` differs from that tool's).
  const workspaceDiagnosticsCacheCtx = createWorkspaceDiagnosticsCacheContext(root);
  const workspaceSweepScopeKey = buildScopeKey("all", [...WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS]);
  const cachedResults: LSPWorkspaceDiagnosticResult[] = [];
  const filesToTouch: string[] = [];
  const writeIndexByPath = new Map<string, number | undefined>();
  for (const filePath of files) {
    // Reserve order before cache lookup/touch admission. A result that settles
    // later is still ordered by when this scan began observing the file (#1198).
    writeIndexByPath.set(normalizeMapKey(filePath), options.nextWriteIndex?.());
    const cached = workspaceDiagnosticsCacheCtx.lookup(filePath, workspaceSweepScopeKey);
    // #1095 (P2-1 bug-class sweep): both sweeps share cache entries under the
    // same scopeKey, so this service sweep must apply the SAME content-binding
    // gate the tools/lsp-diagnostics.ts sibling site does — an entry whose
    // recorded fingerprint no longer matches disk (bytes changed WITHOUT an
    // mtime bump the freshness check would catch, exactly what contentHash
    // exists to detect) must NOT be replayed and reconciled as confirmed via
    // mode=full. On a mismatch, fall through to a fresh touch.
    if (cached && cached.binding.boundToCurrentDisk !== false) {
      cachedResults.push({
        filePath,
        diagnostics: cached.diagnostics,
        count: cached.count,
        // #1093: a cache hit replays an older observation — carry its
        // scan time so mode=full's footer reconcile stamps `touchedAt`
        // with when the truth was seen, not now().
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
  // Per-file scan mtime captured as each file completes below, so a
  // confirmed fresh result can be written back into the cache with the
  // mtime it was ACTUALLY scanned at (not re-stat'd after the fact, which
  // could race a concurrent edit).
  const scannedMtimeByFile = new Map<string, number>();

  // Group files by their primary language server (#387, extracted as
  // `groupFilesByPrimaryServer` for #631). tsserver — and most servers — is
  // single-threaded per project: N concurrent touches to ONE server don't
  // parallelize, they queue. That inflates the working set (each didOpen can
  // force a project recheck) and cascades per-file-budget timeouts by queue
  // position (observed: 51/123 files "timed out" purely from being behind
  // others in an 8-wide flat pool). So serialize WITHIN a server (one
  // in-flight touch each) and parallelize ACROSS servers — real parallelism
  // where it exists (a mixed TS+Python repo runs both), no flooding where it
  // doesn't. Capped so a many-language monorepo can't spawn unbounded groups.
  // Only files that failed the cache-freshness check above go through this
  // (and the touch loop below) at all.
  const groups = groupFilesByPrimaryServer(filesToTouch);
  // #645: shared across every file/group in THIS sweep — lets a
  // `workspaceIndexing`-strategy server (marksman) pay its full
  // aggregateWaitMs budget only for the first file that touches it,
  // instead of every markdown file independently racing the same cold
  // workspace-index build. Scoped to this one call (never stored on the
  // service), so it can't leak into a later sweep or a per-edit touch.
  const sweepIndexGate = createSweepIndexGate();
  // Opt-in project-wide pull: one `workspace/diagnostic` per server instead of
  // N per-file opens (#387 Item 2). Gated off by default — a cold server can
  // answer with an empty/partial report that reads as a false "all clean", and
  // the pull covers only the primary server (files with auxiliary scanners
  // would lose those). Enabled per group only when the server advertises it and
  // no file in the group has an auxiliary; any miss falls back to per-file.
  const workspacePullEnabled = process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PULL === "1";

  // Start marker: without this a hang leaves no trace that the sweep even
  // began (the completion log below never fires). Per-file `lsp_touch_file`
  // phases + these heartbeats let a hang be bracketed to a file/time.
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

  // #608: pre-open every swept file's document, across whichever server(s)
  // it belongs to, in ONE fast pass BEFORE a group's serial per-file
  // diagnostics-wait loop starts (see the per-group worker below).
  // `handleNotifyOpen`'s workspace/didChangeWatchedFiles enqueue (#271)
  // only coalesces opens that land within its 100ms debounce window
  // (`WatchedFilesQueue`, watch-queue.ts) — it arms the flush timer on
  // the FIRST enqueue and just accumulates on every call after that
  // until the timer fires. The per-file loop waits up to several
  // seconds per file for diagnostics before moving to the next one, so
  // consecutive first-opens during a sweep land far outside that 100ms
  // window: every previously-unopened file used to fire its OWN
  // project-wide recheck notification instead of one for the whole
  // sweep, and later files timed out purely from queueing behind those
  // rechecks (#608). Firing every file's open notification here,
  // back-to-back with no diagnostics wait between them, keeps them
  // inside the debounce window so `WatchedFilesQueue` coalesces them
  // into (at most a small handful of) flushes per server the same way
  // a per-edit dispatch burst already does. By the time `processFile`
  // below calls `touchFile`, each document is already in
  // `openDocuments`, so `handleNotifyOpen` takes the cheap already-open
  // `didChange` branch and enqueues nothing further. Content read here
  // is cached so `processFile` doesn't re-read the same file from disk.
  //
  // Only used on the per-file fallback path — a group whose
  // `workspace/diagnostic` pull (#387 Item 2) succeeds never opens
  // per-file documents at all, so pre-opening ahead of a pull attempt
  // would be pure waste (and would break that path's "no per-file
  // opens" guarantee). Called from inside each group's own serial loop
  // (below), so it inherits the SAME #387 shape: one in-flight open at
  // a time per server, parallel across distinct servers via the
  // existing group-worker pool.
  const contentCache = new Map<string, string>();
  const preOpenGroupFiles = async (groupFiles: readonly string[]): Promise<void> => {
    if (isWarmAttached()) return;
    for (const filePath of groupFiles) {
      if (signal?.aborted) return;
      let content: string;
      try {
        content = await nodeFs.promises.readFile(filePath, "utf-8");
      } catch {
        continue; // processFile's own read will surface the real error.
      }
      contentCache.set(filePath, content);
      const languageId = getLanguageId(filePath) ?? "plaintext";
      // #615: this pre-open pass had NO bound at all — unlike every other
      // per-file step in this sweep (`processFile`'s `touchFile` call
      // below is `withDeadline`-wrapped). `getClientsForFile` can wait on
      // a server spawn/initialize handshake, and `notify.open` can wait
      // on a stuck notification write; either hanging left the WHOLE
      // sweep stuck with no heartbeat and no escape (a real dogfooding
      // incident: `lsp_workspace_diagnostics_start` logged, then total
      // silence — and pressing Escape didn't help either, since the
      // per-iteration `signal?.aborted` check above never gets a turn
      // while stuck inside a single file's await). Two bounds, not one:
      // `withDeadline` catches a hang with no abort press at all; racing
      // the abort signal directly means an explicit Escape unblocks
      // immediately too, instead of waiting out the rest of `perFileMs`.
      // `onTimeout:"undefined"` mirrors the existing catch-based "best
      // effort" intent below: a timed-out/aborted pre-open just means
      // `processFile`'s own touchFile call pays for the open instead,
      // exactly like a thrown error already did.
      const preOpenAttempt = withDeadline(
        (async () => {
          const { clients } = await core.service.getClientsForFile(
            filePath,
            WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
          );
          for (const entry of clients) {
            // #1714: this pass is the sweep's SECOND source of `didOpen`
            // volume, and it reaches the server without passing the drain
            // barrier. Charge it to the same backlog ledger, and leave a
            // scanner that is already at its ceiling out of the burst.
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
            } catch {
              // Best-effort: a failed pre-open just means processFile's own
              // touchFile call below pays for the open instead.
            }
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

  // #1618: a service destroyed mid-sweep (idle-reset race, an explicit
  // `resetLSPService` call, session replacement, …) must stop the loop for
  // every file it has not yet reached and record WHY — never a bare
  // `timedOut` that reads identically to a budget timeout. Cheap: no
  // language-server round trip, just a results push.
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
      // #671: captured alongside the read, ahead of the (possibly slow)
      // touchFile wait below, so the cache entry records the mtime this
      // file actually had AT scan time — not a later re-stat that could
      // race a concurrent edit and silently mis-date the entry. Deliberately
      // synchronous (not `nodeFs.promises.stat`): this loop is timing-
      // sensitive (its opens must land inside `WatchedFilesQueue`'s 100ms
      // debounce window — see workspace-diagnostics-sweep-batch-open.test.ts
      // / -preopen-chunk.test.ts), and a blocking `statSync` costs a few
      // microseconds with no extra event-loop tick, where an awaited
      // promise would insert one.
      try {
        scannedMtimeByFile.set(filePath, nodeFs.statSync(filePath).mtimeMs);
      } catch {
        // Best-effort: a failed stat here just means this file won't be
        // eligible for caching below (no entry gets written for it).
      }
      // onTimeout:"undefined" so a hung file yields no diagnostics and the
      // worker moves on; a real touchFile rejection still propagates to the
      // catch below and is recorded as an error.
      const attached = isWarmAttached()
        ? await tryWarmAttachedDiagnostics(filePath, content, perFileMs, "sweep")
        : undefined;
      if (attached && !attached.available) {
        await core.service.ensureWarmForSweep(filePath, { signal });
      }
      // #1179 (shape-5 structural fix): normalize both sources into the
      // `TouchFileResult` wrapper shape so the flag reads below come off
      // EXPLICIT fields, not a non-enumerable side-channel a copy would drop.
      // The warm-attach IPC branch resolves a plain diagnostics array with
      // `inconclusive` re-surfaced as an enumerable DTO field (the socket can
      // carry no binding, and the IPC client already rejects an inconclusive
      // answer, so `available` implies confirmed) — wrap it as `{ diags }`;
      // the incumbent branch already returns the wrapper.
      const touchResult = attached?.available
        ? {
            diags: attached.response.diagnostics,
            // #1470: the incumbent's coverage gap crosses the socket as an
            // explicit DTO field, so carry it onto the wrapper the sweep
            // reads. Dropping it here would let a partially covered
            // incumbent answer be persisted as a confirmed sweep result —
            // the same false clean this change closes on the local route.
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
              // #584: opengrep's findings for a full sweep come from the
              // `opengrep-client.ts` CLI extractor (one project-wide scan,
              // cached, read via extractors.ts) instead — see the
              // `excludeServerIds` doc on `LSPTouchFileOptions`.
              excludeServerIds: WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
              // #645: lets a workspaceIndexing server (marksman) pay its
              // full wait budget only once across this whole sweep.
              sweepIndexGate,
            }),
            { ms: perFileMs, onTimeout: "undefined" },
          );
      const diagnostics = touchResult?.diags;
      // #571: prefer #570's real per-touch inconclusive signal
      // (`touchFile`'s `.inconclusive` flag — set when the notify write or the
      // diagnostics wait itself timed out) over this sweep's own OUTER
      // `perFileMs` deadline, which only catches a touch that never returned at
      // all within budget. Either one means the result wasn't confirmed.
      const inconclusive = touchResult?.inconclusive === true;
      // #1470/#1493: an auxiliary that never reported — cut off by the grace
      // timer, or silent with nothing published for this content — is the
      // THIRD reason this result is not a confirmed observation, and it is
      // deliberately not `inconclusive`. The
      // record loop below persists every `!timedOut` result into the workspace
      // cache, so reading `inconclusive` alone caches a partially covered
      // answer as clean and replays it on every later sweep. The warm-attach
      // incumbent reaches this branch through the aux GRACE wait (its touch
      // runs `clientScope: "with-auxiliary"`), where all three no-answer shapes
      // arise. #1459 added the two pre-wait doors for the sweep's own local
      // `clientScope: "all"` touch — a scanner whose breaker was open, or whose
      // resync the fan-out gate deferred. #1533 closed the last hole: `"all"`
      // still never enters the grace wait, but it now derives the SAME evidence
      // from post-wait state, so a silent auxiliary narrows this scope too
      // instead of aggregating as a confirmed clean. Every route is gated here.
      const coverageGap = touchCoverageGap(touchResult).length > 0;
      const timedOut = touchResult === undefined || inconclusive || coverageGap;
      if (timedOut) timedOutFiles += 1;
      // #1618: WHY, in priority order — the outer deadline (nothing came
      // back at all) outranks an inner inconclusive signal, which outranks
      // a narrower auxiliary coverage gap.
      const unconfirmedReason: LSPWorkspaceUnconfirmedReason | undefined =
        touchResult === undefined
          ? "budget"
          : inconclusive
            ? "inconclusive"
            : coverageGap
              ? "coverage_gap"
              : undefined;
      // #1104 (shape 5 — AGENTS.md): the touch's content binding is an
      // EXPLICIT enumerable field on the wrapper now (#1179), so it survives
      // `applyAuxiliarySuppressions` below rebuilding `.diags` via `.filter()`
      // — read it off `touchResult`, not off the derived array. A version-
      // less/pull-less server composed no binding, so `contentHash` stays
      // undefined here (honest "unknown" downstream), matching prior behavior.
      const rawBinding = touchResult?.binding;
      // #586: honor each auxiliary profile's native inline-suppression
      // comment (e.g. opengrep's `// nosemgrep`, #441) — computed from the
      // raw `diagnostics` (before this drops its non-enumerable
      // `.inconclusive` flag, already read above) so a `diagnostics_report
      // mode=full` sweep suppresses the same findings the per-edit dispatch
      // runner does, instead of only the latter honoring it.
      // #692: also honor a profile's `skipTestFiles` gate (e.g. ast-grep,
      // #687/#688) — those PRs added the gate only to the per-edit merge
      // loop (`clients/dispatch/runners/lsp.ts`), so a `mode=full` sweep
      // re-surfaced every ast-grep finding on `*.test.ts` files wholesale,
      // duplicating what the per-edit path already suppresses. `content`
      // was already read above for this file, so `detectFileRole` gets the
      // higher-accuracy content-aware classification at no extra cost.
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
        // An errored check is exactly as inconclusive as a timed-out one —
        // no confirmed result was obtained, so reconciliation (#571) must
        // skip it the same way. #1618: distinct from every OTHER
        // `timedOut: true` reason — an `error` must never render as "didn't
        // complete within budget" (the old dead-subtraction bug in
        // tools/diagnostics-report.ts's `unconfirmedErrored` computation).
        timedOut: true,
        unconfirmedReason: "error",
        writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
      });
    }
    completed += 1;
    // User-facing progress (streamed to the tool's onUpdate). Per-file so the
    // bar moves; the tool throttles the actual UI writes.
    options.onProgress?.(completed, files.length);
    // Time-based heartbeat (every ~10s): a hang shows the last heartbeat
    // then silence, so latency.log pinpoints how far it got.
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

  // One worker per server group (serial within a server), up to the
  // concurrency cap across distinct servers — `runPerServerGroups` (#631)
  // is the same primitive `tools/lsp-diagnostics.ts`'s batch/directory scan
  // now uses for its own file list.
  const groupWorkers = Math.min(WORKSPACE_DIAGNOSTICS_CONCURRENCY, groups.length);
  await runPerServerGroups(
    groups,
    groupWorkers,
    async (group) => {
      if (signal?.aborted) return;
      // #1618: checked before any per-group work (pull attempt, warm-up,
      // per-file loop) so a service already destroyed when this group
      // starts never pays for a language-server round trip it cannot get.
      if (checkDestroyed(core)) {
        markServiceDestroyed(group.files);
        return;
      }
      // Fast path: one project-wide pull for the whole group (opt-in).
      if (!isWarmAttached() && workspacePullEnabled && !group.multiServer) {
        const pulled = await tryWorkspacePull(core, group.files, perFileMs);
        if (pulled) {
          for (const result of pulled) {
            results.push({
              ...result,
              writeIndex: writeIndexByPath.get(normalizeMapKey(result.filePath)),
            });
            // #671: a pull result is always confirmed (see
            // `tryWorkspacePull`'s doc comment), so it's cache-eligible
            // too — best-effort stat since the pull already resolved the
            // diagnostics for this file some time ago.
            try {
              scannedMtimeByFile.set(result.filePath, nodeFs.statSync(result.filePath).mtimeMs);
            } catch {
              // Not cache-eligible without a confirmed mtime.
            }
          }
          completed += group.files.length;
          options.onProgress?.(completed, files.length);
          return;
        }
      }
      // #667: warm-check before this group's own per-file loop starts —
      // cheap/no-op when the group's primary server already demonstrated
      // readiness (from an earlier sweep, or an earlier group sharing the
      // same server root, this session); pays one deliberate warm-up round
      // trip against the group's first file only when genuinely cold. Not
      // needed above the pull fast path: a `workspace/diagnostic` pull
      // already covers the WHOLE group with its own generous per-server
      // budget in one shot — the per-file "first N files eat individual
      // timeouts" failure mode this fixes doesn't apply there.
      const first = group.files[0];
      if (first && !isWarmAttached()) {
        const warmup = await core.service.ensureWarmForSweep(first, { signal });
        if (signal?.aborted) return;
        // #744: the group's primary server failed warm-up (initial round
        // trip + one retry both left it cold). Every per-file touch to it
        // would re-pay its full timeout and time out again, dragging the
        // whole sweep — the exact wedged-marksman failure mode this closes.
        // So skip this group's files and record each as UNCONFIRMED
        // (timedOut + skippedWarmupFailure), never as confirmed-clean `[]`:
        // the group is keyed by its primary server, so a non-empty
        // `failedServerIds` means that primary is the one that couldn't warm.
        if (warmup.failedServerIds.length > 0) {
          logLatency({
            type: "phase",
            phase: "lsp_sweep_group_skipped_warmup",
            filePath: first,
            durationMs: 0,
            metadata: {
              failedServerIds: warmup.failedServerIds,
              // #799: distinguishes a fresh warm-up failure from a
              // negative-cache hit (this sweep never re-attempted warm-up
              // at all — it was already known cold from earlier this
              // session).
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
      // #608/#621: batch-open a CHUNK of this group's files before
      // waiting on diagnostics for any of them individually — see
      // `preOpenGroupFiles` above. Chunking (rather than the whole
      // group at once) bounds how much a single burst can dump on
      // the server's request queue at real project scale, while each
      // chunk's opens still land inside the debounce window and
      // coalesce into one flush — see `WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE`.
      for (
        let chunkStart = 0;
        chunkStart < group.files.length;
        chunkStart += WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE
      ) {
        if (signal?.aborted) return;
        // #1618: a service destroyed WHILE this group's chunk loop was
        // already running (the group-start check above can't see a
        // destruction that lands mid-loop) — stop here and mark every
        // file from this chunk onward, rather than letting the remaining
        // chunks pay for pre-opens/touches against a torn-down service.
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
          // Honor cancellation between files (#341); already-collected
          // results are returned as a partial.
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

  // #1618: per-reason tally alongside the flat `timedOutFiles` count (kept
  // for the existing `scripts/analyze-choco-pi-lsp-logs.mjs` consumer) — a
  // dashboard reading only the flat count can no longer mistake 81
  // service-destroyed files for 81 budget-exhausted ones.
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

  // #671: record every CONFIRMED fresh result (`!timedOut && !error`) back
  // into the cache, keyed by the mtime it was actually scanned at
  // (`scannedMtimeByFile`, captured per-file above), then persist once.
  // Deliberately survives an aborted/partial sweep — whatever completed
  // before the abort is still real, confirmed work and shouldn't be thrown
  // away; files that never got a confirmed result (including ones an abort
  // cut off before `processFile` ran) are simply absent from
  // `scannedMtimeByFile` and are skipped, leaving any pre-existing cache
  // entry for them exactly as `createWorkspaceDiagnosticsCacheContext`
  // loaded it (already-stale entries stay unreachable via `lookup`'s own
  // freshness check; nothing here needs to explicitly evict them).
  for (const result of results) {
    const scannedAt = scannedMtimeByFile.get(result.filePath);
    if (result.error || result.timedOut || scannedAt === undefined) continue;
    // #1104: thread the per-result `contentHash` (from either the
    // `tryWorkspacePull` fast path or a per-file touch's own #1095 binding)
    // into the cache entry — previously this call never passed one, so
    // every pull-served entry read binding "unknown" forever and the #1095
    // P2-1 service-sweep binding gate above (`cached.binding.
    // boundToCurrentDisk !== false`) could never demote a pull-cached
    // entry. Absent `contentHash` (no binding was available) behaves
    // exactly as before.
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

/**
 * #387 Item 2: one `workspace/diagnostic` pull covering a whole server group,
 * instead of N per-file opens. Returns per-file results (files absent from the
 * report are reported clean), or `undefined` when the server doesn't advertise
 * workspace pull / the pull fails — the caller then falls back to per-file.
 */
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
      // A pull that got here returned a real workspace/diagnostic report
      // (see the `!report` guard above) — always confirmed, unlike a
      // per-file touchFile default-empty on timeout.
      // #1104: `contentHash` comes straight from the client's pull layer —
      // a file absent from the report (reported "clean" here) carries none,
      // same honest "unknown" the record site already applies for it.
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
