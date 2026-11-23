/**
 * The per-edit touch pipeline ({@link LSPService.touchFile}): sync, wait, and bind diagnostics to content.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { logLatency } from "../latency-logger.ts";
import { incrementDegradationCount } from "../degradation-ledger.ts";
import { shouldPreferPullOnlyDiagnostics } from "../lsp-budget.ts";
import { withDeadline } from "../deadline-utils.ts";
import { normalizeMapKey } from "../path-utils.ts";
import {
  auxiliaryCoverageGap,
  bindingStateLabel,
  resolveTouchVerdict,
  type DiagnosticBinding,
  type StoredDiagnosticBinding,
  type TouchFileResult,
} from "./diagnostic-binding.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getLanguageId } from "./language.ts";
import {
  classifyCascadeWaitTier,
  classifyServerWaitTier,
  getStrategy,
  type LSPCapabilitySnapshot,
} from "./wait-policy/index.ts";
import { attemptTsserverSyncDiagnostics } from "./tsserver-sync.ts";
import {
  acquireClientLeases,
  brokenSkippedAuxiliaryServerIds,
  checkDestroyed,
  demonstratedReadyKeyFor,
  markDemonstratedReadyKey,
  releaseClientLease,
} from "./service-clients.ts";
import { hashContent, mergeBinding, mergeLspDiagnostics } from "./service-diagnostics.ts";
import { markTouched, shouldSkipNotify, shouldSkipTouch } from "./service-documents.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import {
  claimAuxNotifySlot,
  noteAuxNotifyIssued,
  paceAuxNotify,
  recordNotifyWriteBackpressure,
  retractNotifyWriteBackpressure,
} from "./service-notify-pacing.ts";
import {
  notifyWedgedMs,
  notifyWriteBudgetMs,
  readEnvAuxGraceMs,
  readEnvDiagnosticsWaitMs,
  readTsserverSyncGraceMs,
} from "./service-tunables.ts";
import type { LSPTouchClientScope, LSPTouchFileOptions, SpawnedServer } from "./service-types.ts";

/** Implements {@link LSPService.touchFile}. */
export async function touchFile(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  options: LSPTouchFileOptions = {},
): Promise<
  // #1179 (shape-5 structural fix): a WRAPPER, not the bare array. `.diags`
  // carries the diagnostics; `.inconclusive` (#570/#1093) and `.binding`
  // (#1095) are EXPLICIT ENUMERABLE fields, so a `[...]`/`.map`/`.filter`/
  // `JSON` copy of `.diags` cannot silently drop them (was the #1094/#1096
  // copy-loss class — the flags used to ride the array as non-enumerable
  // side-channels). See `TouchFileResult` for the field-presence contract.
  TouchFileResult | undefined
> {
  if (checkDestroyed(core)) {
    // #1618: a destroyed service never reaches the language server — this
    // early return used to log nothing at all, so a workspace sweep whose
    // idle-reset timer fired mid-run left every remaining file with zero
    // trace, indistinguishable from budget exhaustion. Cheap and local: no
    // server round trip, matching the `no_clients`/`success` sibling
    // records this phase already emits below.
    const destroyedDiagnosticsMode = options.collectDiagnostics
      ? (options.diagnostics ?? "document")
      : (options.diagnostics ?? "none");
    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizeMapKey(filePath),
      durationMs: 0,
      metadata: {
        serverCountAttempted: 0,
        serverCountReady: 0,
        clientScope:
          options.clientScope ?? (destroyedDiagnosticsMode === "full" ? "all" : "primary"),
        diagnosticsMode: destroyedDiagnosticsMode,
        source: options.source ?? "unknown",
        failureKind: "destroyed",
      },
    });
    return;
  }
  const startedAt = Date.now();
  const normalizedPath = normalizeMapKey(filePath);
  const diagnosticsMode = options.collectDiagnostics
    ? (options.diagnostics ?? "document")
    : (options.diagnostics ?? "none");
  const source = options.source ?? "unknown";
  const clientScope: LSPTouchClientScope =
    options.clientScope ?? (diagnosticsMode === "full" ? "all" : "primary");
  const useAllClients = clientScope === "all";
  let spawned: SpawnedServer[];
  let serverCountAttempted: number;
  if (useAllClients) {
    const result = await core.service.getClientsForFile(filePath, options.excludeServerIds);
    spawned = result.clients;
    serverCountAttempted = result.serverCountAttempted;
  } else if (clientScope === "with-auxiliary") {
    // Primary language server + the enabled cross-cutting auxiliaries
    // (opengrep, …). The aggregation layer merges/dedups their diagnostics.
    const [entry, aux] = await Promise.all([
      core.service.getClientForFile(filePath, options.maxClientWaitMs),
      core.service.getAuxiliaryClientsForFile(filePath, new Set(options.auxiliaryServerIds ?? [])),
    ]);
    spawned = entry ? [entry, ...aux] : aux;
    serverCountAttempted = spawned.length;
  } else {
    const entry = await core.service.getClientForFile(filePath, options.maxClientWaitMs);
    spawned = entry ? [entry] : [];
    serverCountAttempted =
      spawned.length > 0 ? 1 : getServersForFileWithConfig(filePath).length > 0 ? 1 : 0;
  }
  if (spawned.length === 0) {
    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizedPath,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverCountAttempted,
        serverCountReady: 0,
        clientScope,
        diagnosticsMode,
        source,
        maxClientWaitMs: options.maxClientWaitMs,
        failureKind: "no_clients",
      },
    });
    return;
  }
  const leaseKeys = await acquireClientLeases(core, spawned, filePath);
  if (!leaseKeys) {
    // An idle eviction won between selection and lease admission. Resolve the
    // now-current client set and replay; no notification targets the retiree.
    return core.service.touchFile(filePath, content, options);
  }
  try {
    const spawnedServerIds = spawned.map((entry) => entry.info.id);
    if (
      shouldSkipTouch(
        core,
        filePath,
        content,
        clientScope,
        diagnosticsMode !== "none",
        spawnedServerIds,
      )
    ) {
      logLatency({
        type: "phase",
        phase: "lsp_touch_file",
        filePath: normalizedPath,
        durationMs: Date.now() - startedAt,
        metadata: {
          serverCountReady: spawned.length,
          clientScope,
          diagnosticsMode,
          source,
          failureKind: "success",
          skipped: true,
          reason: "debounced_unchanged_content",
        },
      });
      // #1179: a debounced skip collected nothing — resolve the wrapper's
      // `.diags` as empty with neither flag (exactly the pre-wrapper `[]`).
      return { diags: [] };
    }

    const languageId = getLanguageId(filePath) ?? "plaintext";
    const silent = options.silent ?? false;
    // When the same content was already pushed to the LSP within the touch
    // debounce window, skip the notify — pushing again clears the LSP's
    // diagnostic cache (via notify.open) and forces it to restart work it
    // already did. This is what makes the post-write touch + dispatch-lsp-
    // runner touch sequence expensive on slow TS projects.
    //
    // #743: resolved PER SERVER. A server whose sibling's write stalled last
    // touch still holds its own debounce entry, so it is skipped here while the
    // stalled server (which has no entry) gets re-pushed. `notifySkipped` stays
    // as the file-level "every server was skipped" summary for the logs and the
    // no-new-version baseline below.
    const notifySkippedServerIds = new Set(
      spawnedServerIds.filter((serverId) =>
        shouldSkipNotify(core, filePath, content, clientScope, serverId),
      ),
    );
    const notifySkipped = spawned.length > 0 && notifySkippedServerIds.size === spawned.length;
    // #1531: the pre-notify diagnostics baseline for THIS file on each client.
    // It used to be `client.diagnosticsVersion`, a client-GLOBAL counter that also
    // advances for files this touch never mentions — which let a sibling file's
    // publication both end this file's wait early and read as an answer for it.
    // `getDiagnosticsVersionForPath` returns that same counter's value as of this
    // file's last publication, so every comparison downstream stays on one axis
    // while ignoring sibling paths. Captured here because the notify below clears
    // each client's cache for the file.
    //
    // The accessor is REQUIRED on `LSPClient`, so a real client always answers
    // with a number. The optional call is only so a hand-written test double that
    // predates it fails CLOSED — `undefined` keeps the existing "no usable
    // baseline" branch below and can never satisfy the evidence check — instead of
    // quietly reverting to the global counter, which is the defect itself.
    const readPathVersion = (client: (typeof spawned)[number]["client"]): number | undefined =>
      client.getDiagnosticsVersionForPath?.(filePath);
    const diagnosticBaselines = new Map(
      spawned.map((entry) => [entry.client, readPathVersion(entry.client)]),
    );
    // #1458: read a late auxiliary publication BEFORE the ordinary resync
    // clears its client cache. Carry it only when the publication's exact
    // sent-content fingerprint matches this touch's content. A changed edit,
    // version-less publication, or malformed binding fails closed and is not
    // replayed. The fresh notify still runs below, so scanners continue toward
    // a publication for this touch while the prior late result reaches the read.
    const touchContentHash = hashContent(content);
    // #1586: THE content-match atom. Every content-bound question in this touch
    // — the carry-over below, #1493's pre-notify snapshot, and the merge-time
    // coverage predicate — asks it here and nowhere else, so a door cannot
    // acquire a rule of its own by writing the comparison inline. A binding with
    // no `contentHash` (version-less publish) fails closed: `undefined` never
    // equals a hash.
    const bindingMatchesTouchContent = (binding: StoredDiagnosticBinding | undefined): boolean =>
      binding?.contentHash === touchContentHash;
    const carriedAuxiliary = options.collectDiagnostics
      ? spawned.flatMap((entry) => {
          if (entry.info.role !== "auxiliary") return [];
          const binding = entry.client.getDiagnosticBinding?.(filePath);
          if (!bindingMatchesTouchContent(binding)) return [];
          const diags = entry.client.getDiagnostics(filePath);
          return diags.length > 0 ? [{ diags, binding }] : [];
        })
      : [];
    // #1493: auxiliaries whose STORED publication already covers exactly the
    // bytes this touch carries. Read BEFORE the notify below, which clears each
    // client's cache for the file. Unlike `carriedAuxiliary` this does not
    // require findings: an empty publication bound to this content is evidence
    // the scanner reported, which is what keeps a genuinely clean file clean
    // when its wait produces nothing new (a debounce-skipped notify, or a late
    // publication carried in from the previous touch).
    const auxPublishedThisContent = new Set(
      spawned.flatMap((entry) =>
        entry.info.role === "auxiliary" &&
        bindingMatchesTouchContent(entry.client.getDiagnosticBinding?.(filePath))
          ? [entry.info.id]
          : [],
      ),
    );
    const spawnedByServerId = new Map(spawned.map((entry) => [entry.info.id, entry]));
    // #1549/#1586: does this auxiliary's publication describe exactly the bytes
    // this touch carries? THE coverage predicate — every door reads it, so a
    // scanner can never be named uncovered while its findings ride along in
    // `.diags`, or the reverse.
    //
    // It UNIONS two content-bound reads rather than replacing one with the other,
    // because they answer different questions:
    //
    //   - `auxPublishedThisContent` was captured BEFORE the notify (#1493), because
    //     a landed write clears the cache and would erase the evidence that the
    //     scanner had already reported on these bytes.
    //   - the read below is LIVE, and it catches the opposite race — #1459's own
    //     documented signature: a write charged as timed out, or one the fan-out
    //     gate deferred behind, that LANDS LATE, after which the scanner publishes
    //     for this touch's content. Judging that auxiliary on the pre-notify
    //     snapshot alone drops its CURRENT findings and names it uncovered — an
    //     underclaim about a scanner that answered.
    //
    // Either match means covered; both are content-bound, so neither can pass off
    // another revision's findings as this touch's answer.
    //
    // WHEN it is asked is part of the rule. The live half moves over the life of
    // a touch, so two doors that ask at two instants can disagree — and the merge
    // ACTS on its answer by dropping findings, which a later answer cannot undo.
    // Every door that shares the merge's consequences therefore reads ONE frozen
    // evaluation (`auxCoveredAtMerge`, below), taken immediately before the merge
    // and never re-asked afterwards. The only callers of this function are that
    // freeze and the two aux wait-outcome producers, whose rows describe their own
    // instant and are reconciled against the freeze before anything is claimed.
    //
    // Everything it cannot speak for fails CLOSED — an id that never reached
    // `spawned` (a breaker-skipped scanner, which never attached) and any
    // primary-role server, whose findings are governed by #570's
    // timeout-preserves-last-known semantics rather than by this exemption.
    const auxCoversThisContent = (serverId: string): boolean => {
      const entry = spawnedByServerId.get(serverId);
      if (entry?.info.role !== "auxiliary") return false;
      return (
        auxPublishedThisContent.has(serverId) ||
        bindingMatchesTouchContent(entry.client.getDiagnosticBinding?.(filePath))
      );
    };
    // #743: PER-SERVER notify-write deadlines. Each server's didOpen/didChange
    // write gets its OWN notifyWriteBudgetMs budget rather than one shared
    // deadline over a single Promise.all — otherwise one backpressured server
    // (stalled stdin) times out the write for the ENTIRE file, flipping every
    // co-touched healthy server to inconclusive and zeroing its diagnostics.
    // Bounded so a backpressured write can't hang the caller; on timeout we
    // proceed — the diagnostics wait below is separately bounded and simply
    // returns no fresh diagnostics for the server(s) that stalled.
    //
    // Holds the serverId of every server whose write did NOT land in time.
    // The file-level `notifyWriteTimedOut` (logged below) means "at least one
    // server timed out"; this list carries the per-server detail the
    // demonstratedReady gate reads so a healthy sibling stays eligible.
    const notifyWriteTimedOutServerIds: string[] = [];
    // #1459: auxiliaries whose resync was DEFERRED because the gate already had
    // one outstanding write for that server. They carry no evidence about this
    // content, so they join the coverage gap below.
    const notifyDeferredServerIds: string[] = [];
    if (!notifySkipped) {
      const budget = notifyWriteBudgetMs();
      // #1459: how long a queued auxiliary may wait for its resync slot. Bounded
      // by the write budget AND by whatever the caller already declared it is
      // willing to spend on this touch (`maxClientWaitMs` — cascade's cold
      // snapshot passes 1000ms), minus what the client wait above already spent.
      // A flat write-budget wait would tax a caller that asked for less than one
      // budget in total. Non-positive means "no time left to queue": the server
      // is reported as uncovered immediately.
      const queueWaitMs =
        options.maxClientWaitMs !== undefined
          ? Math.min(budget, Math.max(0, options.maxClientWaitMs - (Date.now() - startedAt)))
          : budget;
      await Promise.all(
        spawned.map(async (entry) => {
          // #743: this server already has this content from a recent touch
          // that landed. Pushing again would clear its diagnostic cache for
          // nothing — leave its debounce entry (and its original timestamp)
          // alone so the window still expires naturally.
          if (notifySkippedServerIds.has(entry.info.id)) return;
          // Same identity as the broken/demonstratedReady maps.
          const clientKey = await demonstratedReadyKeyFor(core, entry.info, filePath);
          // #1459: one outstanding resync per auxiliary. Primaries are
          // untouched — they serve one file per touch and are not the fan-out
          // target a `clientScope: "all"` sweep floods.
          const gated = entry.info.role === "auxiliary" && clientKey !== undefined;
          let slot: { release: () => void } | undefined;
          if (gated && clientKey) {
            // #1714: before taking the slot, make the server prove it
            // processed the notifies already sent. A sweep is sequential, so
            // the slot gate below is almost always free and cannot see a
            // backlog building. This never refuses the write — a scanner that
            // will not answer is latched past and left to #743's stall
            // machinery, which can demote and respawn it.
            const barrierStartedAt = Date.now();
            await paceAuxNotify(core, clientKey, entry, filePath, queueWaitMs, {
              source,
              clientScope,
            });
            // The barrier spends from the SAME budget the caller granted, so
            // the slot wait gets only what is left. Otherwise a paced touch
            // could cost two full budgets.
            const slotWaitMs = Math.max(0, queueWaitMs - (Date.now() - barrierStartedAt));
            const claim = await claimAuxNotifySlot(core, clientKey, entry, filePath, slotWaitMs);
            if ("outstandingMs" in claim) {
              // Queued behind a write the scanner has not accepted inside our
              // budget. Pushing anyway is what floods it, so this touch reports
              // the scanner as uncovered instead. The wedge timer armed with the
              // blocking write is what demotes a dead input path.
              notifyDeferredServerIds.push(entry.info.id);
              logLatency({
                type: "phase",
                phase: "lsp_notify_resync_deferred",
                filePath: normalizedPath,
                durationMs: claim.outstandingMs,
                metadata: {
                  serverId: entry.info.id,
                  source,
                  clientScope,
                  reason: "outstanding_write",
                  outstandingMs: claim.outstandingMs,
                  queueWaitMs,
                },
              });
              return;
            }
            slot = claim;
          }
          let wrote: true | undefined;
          let rejected = false;
          try {
            const writeStartedAt = Date.now();
            // Constructed inside the try so a client double without `notify`
            // (or any synchronous throw) still reads as a rejected write rather
            // than rejecting the whole per-file `Promise.all`.
            const writePromise = entry.client.notify
              .open(filePath, content, languageId, undefined, silent)
              .then(() => true as const);
            // #1714: the document is now in this auxiliary's input queue,
            // whether or not the write settles inside our budget. Counted here
            // so the next file sees the real backlog.
            if (gated && clientKey) {
              noteAuxNotifyIssued(core, clientKey, entry.client);
            }
            if (slot && clientKey) {
              const client = entry.client;
              const release = slot.release;
              // Release the slot on the write's OWN settle, whatever the caller
              // below decided to wait for. The handle is identity-checked, so a
              // demotion (which clears the map) or a later claim cannot be
              // released by this one.
              void writePromise.then(() => {
                release();
                // The write landed, just not inside the caller's budget —
                // retract the timeout it was charged for. A write that landed
                // IN budget took the success path below, which clears the
                // streak outright, so only the late case retracts. A landing
                // past the WEDGE window keeps its strike: at that point the
                // stall was long enough that #743's demotion is the honest
                // verdict, not a latency artifact.
                const outstandingMs = Date.now() - writeStartedAt;
                if (outstandingMs > budget && outstandingMs <= notifyWedgedMs()) {
                  retractNotifyWriteBackpressure(
                    core,
                    clientKey,
                    entry.info.id,
                    filePath,
                    outstandingMs,
                    client,
                  );
                }
              }, release);
            }
            wrote = await withDeadline(writePromise, {
              ms: budget,
              onTimeout: "undefined",
              onReject: "propagate",
            });
          } catch {
            // The write itself rejected (not backpressure): the content did
            // not land, so this server is inconclusive for the touch, but a
            // rejection is not a stdin-backpressure signal and must not count
            // toward the backpressure demotion streak.
            rejected = true;
            // A synchronous throw (a client double without `notify`) never
            // reached the settle handlers that release the slot — release it
            // here so one bad client cannot wedge the queue. Idempotent.
            slot?.release();
          }
          if (wrote === true) {
            // A clean write clears any accrued backpressure streak (#743).
            if (clientKey) core.notifyWriteBackpressureStreak.delete(clientKey);
            // #1253: record the debounce entry for THIS server only, and only
            // because its own write landed. A server whose write timed out or
            // rejected falls through without an entry, so the next touch
            // re-pushes it instead of laundering the failure into a later
            // touch that looks fully delivered (which the silent-clean gates
            // would then read as a confirmed clean).
            markTouched(core, filePath, content, clientScope, entry.info.id);
          } else {
            notifyWriteTimedOutServerIds.push(entry.info.id);
            if (!rejected) {
              recordNotifyWriteBackpressure(core, clientKey, entry, filePath);
            }
          }
        }),
      );
      if (notifyWriteTimedOutServerIds.length > 0) {
        logLatency({
          type: "phase",
          phase: "lsp_notify_timeout",
          filePath: normalizedPath,
          durationMs: Date.now() - startedAt,
          metadata: {
            source,
            clientScope,
            serverCount: spawned.length,
            timedOutServerIds: notifyWriteTimedOutServerIds,
          },
        });
      }
    }
    // File-level flag: at least one server's write timed out. Kept as the
    // observability summary (`lsp_touch_file.notifyWriteTimedOut`); the
    // `inconclusive` verdict reads the PRIMARY-scoped flag below (#1549).
    const notifyWriteTimedOut = notifyWriteTimedOutServerIds.length > 0;
    // #1549: the honesty verdict is decided from the PRIMARY population only.
    // An auxiliary that missed a deadline is a named coverage gap, never an
    // inconclusive touch — see `resolveTouchVerdict` (diagnostic-binding.ts).
    const primaryEntries = spawned.filter((entry) => entry.info.role !== "auxiliary");
    const primaryServerIds = new Set(primaryEntries.map((e) => e.info.id));
    const primaryNotifyWriteTimedOutServerIds = notifyWriteTimedOutServerIds.filter((id) =>
      primaryServerIds.has(id),
    );
    const primaryNotifyWriteTimedOut = primaryNotifyWriteTimedOutServerIds.length > 0;
    // #1459: read by the diagnostics wait and the merge below — a deferred
    // server is neither waited on nor read from.
    const deferredResyncServerIds = new Set(notifyDeferredServerIds);

    let diagnosticsTimedOut = false;
    // #1549: every server (any role) that produced no publication evidence when
    // the diagnostics wait lapsed. Read three ways: the primary members decide
    // `diagnosticsTimedOut` and are the `inconclusiveServerIds` attribution, the
    // auxiliary members join the coverage gap, and no member may be marked
    // `demonstratedReady`. Empty when the wait did not lapse.
    let diagnosticsUnansweredServerIds: string[] = [];
    // #1549: the primary subset of the list above, captured when the wait lapsed
    // so the attribution survives the silent-clean/sync gates clearing the flag.
    let diagnosticsUnansweredPrimaryServerIds: string[] = [];
    // #1549: a gate that certifies silence AS the answer (the tsserver sync
    // confirm, either silent-clean gate) retracts the primary attribution with it —
    // those servers answered, in the only way their capabilities allow, so they
    // stay eligible for `demonstratedReady` exactly as before this change.
    // Auxiliary members are left in place: nothing certified them, and they are
    // what the coverage gap reports.
    const retractPrimaryTimeoutAttribution = (): void => {
      diagnosticsUnansweredPrimaryServerIds = [];
      diagnosticsUnansweredServerIds = diagnosticsUnansweredServerIds.filter(
        (id) => !primaryServerIds.has(id),
      );
    };
    // R8 (#714): server ids of aux-role servers whose push wait was cut off by
    // the aux grace window. Undefined when no aux was cut off (primary-only
    // paths never set this). Logged in lsp_touch_file metadata.
    let auxCutOffServerIds: string[] | undefined;
    // #1493: aux-role servers this touch carries NO evidence from — the cut-off
    // set above PLUS the ones that stayed silent through their own budget with
    // no stored publication for this content. This is what narrows the
    // confirmation; `auxCutOffServerIds` stays cut_off-only so the R8 latency
    // field keeps its original meaning.
    let auxUnconfirmedServerIds: string[] | undefined;
    // #707: tsserver sync clean-confirm state. `tsserverSyncEligible` is the
    // full gate (evaluated once, before the wait); `tsserverSyncConfirmed`
    // holds the sync commands' answer when the racing confirm won the wait
    // (undefined = the race didn't produce an answer; the end-of-wait
    // fallback below may still fill it in on a timed-out empty result).
    let tsserverSyncEligible = false;
    let tsserverSyncConfirmed: import("./client.ts").LSPDiagnostic[] | undefined;
    if (diagnosticsMode !== "none") {
      // Resolution: env wins so users can tune the cap without rebuilding.
      // Otherwise, on the single-server hot path (primary scope), use that
      // server's own strategy budget (wait-policy/strategies.ts) so a fast server
      // (TypeScript ~1s) isn't held to a flat multi-second wait while a slow
      // one (rust-analyzer 3s) gets the time it needs — bounded by any caller
      // ceiling that exists to protect the per-edit pipeline budget (#203).
      // #573: clientScope "all" (lsp_diagnostics, lens_diagnostics_full) now
      // gets the same per-server treatment as "with-auxiliary" — each spawned
      // server (primary + any auxiliaries) is bounded by ITS OWN strategy
      // budget instead of one flat number shared by every server. This was
      // never a deliberate "all means wait for the group ceiling" semantic:
      // #203 introduced perServerTimeout only for the single-server primary
      // path and left "full"/"all" on the pre-existing flat resolution
      // ("full/cascade path unchanged"); #242 later added "with-auxiliary"
      // without revisiting "all". The one property "all" genuinely needs —
      // the touch's overall detection deadline is the SLOWEST spawned
      // server's budget, not the fastest — is unaffected: `timeoutMs` below
      // is always `Math.max(...spawned.map(timeoutFor))` regardless of which
      // timeoutFor is selected, so a slow auxiliary still gets to run to its
      // own budget before the touch is logged as timed out. What changes is
      // only that a fast server's *individual* `waitForDiagnostics` call
      // (further below) now resolves/times out against its own budget
      // instead of blocking to the flat multi-server number.
      const envWait = readEnvDiagnosticsWaitMs();
      const callerCap = options.maxDiagnosticsWaitMs ?? options.maxClientWaitMs;
      const modeFloor = diagnosticsMode === "full" ? 3000 : 1200;
      // #645: resolve each spawned server's "is this the first same-sweep
      // touch for it" verdict EXACTLY ONCE up front, before `perServerTimeout`
      // is defined. `SweepIndexGate.consumeFirstTouch` is side-effecting
      // (it marks the server seen), and `perServerTimeout` below is invoked
      // twice per server in this call (once to compute the overall
      // `timeoutMs` deadline, again inside the wait `Promise.all`) — calling
      // the gate directly from inside `perServerTimeout` would consume the
      // "first touch" slot on the first of those two calls and read as
      // already-warm on the second, silently shortchanging the very touch
      // that was supposed to get the full budget.
      const sweepFirstTouch = new Map<string, boolean>();
      if (options.sweepIndexGate) {
        for (const entry of spawned) {
          const strategy = getStrategy(entry.client.serverId, entry.client.getLaunchVariant?.());
          if (strategy.workspaceIndexing) {
            sweepFirstTouch.set(
              entry.client.serverId,
              options.sweepIndexGate.consumeFirstTouch(entry.client.serverId),
            );
          }
        }
      }
      // #832: workspace-indexing servers that are classified as silent on
      // clean do not benefit from the generic cold-indexing floor. Their
      // configured strategy already gives the first sweep touch a bounded
      // workspace-index budget (marksman: 1500ms), while the capability
      // classification proves that a clean push has no affirmative signal to
      // wait for. Keep this restricted to the workspace-indexing strategy:
      // TypeScript is also a silent-on-clean push server, but its cold project
      // load still needs the longer 20s floor.
      //
      // Build this from the live spawned client's capabilities rather than
      // server id alone. Missing/throwing capability data fails closed, so a
      // new or ambiguous server keeps the existing generous warm-up budget.
      const silentCleanWarmupServers = new Set<string>();
      if (options.warmupOverride && (options.warmupAttempt ?? 1) <= 1) {
        for (const entry of spawned) {
          const strategy = getStrategy(entry.client.serverId, entry.client.getLaunchVariant?.());
          if (strategy.workspaceIndexing !== true) continue;
          try {
            const snapshot: LSPCapabilitySnapshot = {
              serverId: entry.client.serverId,
              root: entry.client.root,
              operationSupport: entry.client.getOperationSupport(),
              workspaceDiagnosticsSupport: entry.client.getWorkspaceDiagnosticsSupport(),
              advertisedCommands: entry.client.getAdvertisedCommands(),
              rawCapabilityKeys: entry.client.getRawCapabilityKeys?.() ?? [],
              launchVariant: entry.client.getLaunchVariant?.(),
            };
            if (classifyServerWaitTier(entry.client.serverId, snapshot) === "tier3-silent") {
              silentCleanWarmupServers.add(entry.client.serverId);
            }
          } catch {
            // Fail closed: capability uncertainty must retain the cold floor.
          }
        }
      }
      // Each server gets its OWN deadline, bounded by the caller cap as a
      // CEILING (never a floor) — so a clean push-silent primary (typescript
      // ~1s) can't hold the whole touch to a slow auxiliary's budget, and a
      // slow aux (opengrep) can't override the per-edit cap. Resolves as soon
      // as a server publishes; this is just its individual deadline. (#242)
      const perServerTimeout = (serverId: string): number => {
        const launchVariant = spawned
          .find((entry) => entry.client.serverId === serverId)
          ?.client.getLaunchVariant?.();
        const strategy = getStrategy(serverId, launchVariant);
        let strategyWait = strategy.aggregateWaitMs;
        // #645: a `workspaceIndexing` server (marksman) only needs the
        // full budget for the FIRST same-sweep touch to it — every
        // subsequent touch in this sweep uses the much shorter warm-wait
        // instead, since the one-time index build only needs to finish
        // once. `sweepFirstTouch` only has entries when a sweep gate was
        // passed in AND the strategy is marked, so a per-edit touch
        // (no gate) or an unmarked server is completely unaffected.
        const isFirstTouch = sweepFirstTouch.get(serverId);
        if (isFirstTouch === false && strategy.workspaceIndexing) {
          strategyWait = strategy.workspaceIndexingWarmWaitMs ?? Math.min(300, strategyWait);
        }
        if (callerCap !== undefined) {
          // #669: `ensureWarmForSweep`'s cold-server warm-up wants its cap
          // to act as a FLOOR (give it at least this much, possibly more
          // if the strategy already wants more) rather than the normal
          // ceiling — see `warmupOverride` doc on `LSPTouchFileOptions`.
          if (options.warmupOverride) {
            // #832: a workspace-indexing server already classified as
            // silent-on-clean uses its strategy's bounded wait on the first
            // attempt; the generic cold floor is for servers whose cold work
            // can eventually produce a push answer (notably TypeScript).
            if (silentCleanWarmupServers.has(serverId)) {
              return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
            }
            // #799: only the FIRST warm-up attempt for a cold server gets the
            // floor — see the `warmupAttempt` doc on `LSPTouchFileOptions`.
            if ((options.warmupAttempt ?? 1) > 1) {
              return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
            }
            return Math.max(callerCap, strategyWait > 0 ? strategyWait : 0);
          }
          return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
        }
        return strategyWait > 0 ? strategyWait : modeFloor;
      };
      let timeoutFor: (serverId: string) => number;
      if (envWait !== undefined) {
        // Env override is a single flat cap so users can tune without rebuilding.
        timeoutFor = () => envWait;
      } else if (
        (!useAllClients && spawned.length === 1) ||
        clientScope === "with-auxiliary" ||
        clientScope === "all"
      ) {
        timeoutFor = perServerTimeout;
      } else {
        // Fail-safe for any future clientScope this branch hasn't been
        // taught about yet — keep the old flat resolution rather than
        // silently mis-budgeting an unrecognized scope.
        timeoutFor = () => callerCap ?? modeFloor;
      }
      // Detection deadline = the slowest individual server's budget.
      // #1459: computed over the servers actually WAITED ON. A deferred server
      // contributes no wait, so including its (typically longest) scanner budget
      // here would raise the aggregate threshold above anything that can elapse
      // and mask a real timeout on the servers that did wait.
      const timeoutMs = Math.max(
        0,
        ...spawned
          .filter((e) => !deferredResyncServerIds.has(e.info.id))
          .map((e) => timeoutFor(e.client.serverId)),
      );

      // #707: evaluate the tsserver sync clean-confirm gate BEFORE the wait
      // starts. Cheap synchronous gates first (notify succeeded, collecting,
      // primary scope, `serverId === "typescript"` — the sync commands this
      // races are tsserver-specific protocol extensions, not a generic
      // push-only capability, so #799 giving other servers (marksman) the
      // SAME `silentOnClean` marker must not route them into a sync attempt
      // that can never succeed for them), then the live capability-snapshot
      // tier classification (`classifyCascadeWaitTier`, which also excludes
      // native-ts7 via `launchVariant`). Every other server fails this
      // synchronous gate and pays ZERO extra work — not even the snapshot
      // read; a non-typescript `silentOnClean` server instead gets the
      // generic (non-racing) clean-confirm fallback further below.
      if (
        !notifyWriteTimedOut &&
        options.collectDiagnostics === true &&
        clientScope === "primary" &&
        spawned.length === 1 &&
        spawned[0].client.serverId === "typescript" &&
        getStrategy(spawned[0].client.serverId, spawned[0].client.getLaunchVariant?.())
          .silentOnClean === true
      ) {
        try {
          const snapshots = await core.service.getCapabilitySnapshots(filePath);
          tsserverSyncEligible =
            classifyCascadeWaitTier(core.service, filePath, snapshots) === "tier3-silent";
        } catch {
          // Fail-safe: ineligible — today's full wait, no sync attempt.
        }
      }

      const waitStartedAt = Date.now();
      // R8 (#714): on the with-auxiliary path, apply a bounded aux grace so a
      // slow auxiliary no longer holds the push wait to its own deadline.
      // Primary waits resolve on their own per-server budget; once ALL primaries
      // have settled the auxiliaries get at most auxGraceMs before we proceed.
      // Primary-only and "all"/"primary" scopes are completely unaffected —
      // they fall through to the original Promise.all path below.
      //
      // "Primary" here = a server whose LSPServerInfo.role is not "auxiliary".
      // In the with-auxiliary spawn list, `getClientForFile` returns the
      // language-primary entry first and `getAuxiliaryClientsForFile` appends
      // the rest — but we use info.role rather than position so the logic is
      // correct even if ordering shifts in the future.
      //
      // The #707 tsserver sync race operates exclusively on single-server
      // primary-scope touches (guarded by `clientScope === "primary" &&
      // spawned.length === 1`), so there is NO interaction with this path.
      // #1458 S4: also gated on `collectDiagnostics` — a non-collecting
      // with-auxiliary touch has nothing to carry the aux wait's result
      // INTO (its diagnostics are discarded either way), so paying up to
      // `auxCeilingMs` of extra latency for it buys nothing. Both current
      // callers (`getDiagnostics`'s with-auxiliary path and the cascade's
      // collecting touch) already pass `collectDiagnostics: true`, so this
      // is latent-today defense, not a behavior change — but a future
      // non-collecting with-auxiliary caller must not silently inherit the
      // full aux-grace cost for diagnostics it's about to throw away.
      const hasTouchAuxiliaries =
        clientScope === "with-auxiliary" &&
        options.collectDiagnostics === true &&
        spawned.some((e) => e.info.role === "auxiliary");

      // Per-server wait promises (each already bounded by its own
      // perServerTimeout — unchanged from before R8).
      let pressureSnapshots: LSPCapabilitySnapshot[] = [];
      if (shouldPreferPullOnlyDiagnostics()) {
        try {
          pressureSnapshots = await core.service.getCapabilitySnapshots(filePath);
        } catch {
          // Fail-open: missing capability state keeps today's push fallback.
        }
      }
      const perServerWaits = spawned.map((entry) => {
        // #1459: a DEFERRED server never received this content, so its version
        // can never advance past the baseline — waiting on it burns its whole
        // budget and would flip the touch to `inconclusive`, discarding a
        // primary answer that IS trustworthy. It contributes no wait; the
        // coverage gap below is what reports its absence.
        if (deferredResyncServerIds.has(entry.info.id)) {
          return Promise.resolve(undefined);
        }
        const serverTimeout = timeoutFor(entry.client.serverId);
        // #1531: a per-path baseline. `clientWaitForDiagnostics` compares it
        // against this path's own publication stamp, so a sibling file's
        // publication on a shared client can no longer end this wait before the
        // server's own budget lapses — which is what kept the outcome labels
        // honest (`cut_off` means our grace won, `silent` means the server's own
        // budget lapsed with nothing published).
        const baseline = diagnosticBaselines.get(entry.client);
        const pullOnly =
          classifyServerWaitTier(
            entry.client.serverId,
            pressureSnapshots.find((snapshot) => snapshot.serverId === entry.client.serverId),
          ) === "pull-capable";
        // #1639: `ensureWarmForSweep`'s readiness probe (`source:
        // "lsp_sweep_warmup"`, `collectDiagnostics: false`) runs a real pull
        // round trip on this same file, then the sweep's real touch follows
        // immediately after — two legitimate settle observations for one
        // file, not a duplicate. Tag the warm-up one distinctly so a
        // consumer can tell them apart instead of double-counting. Omitted
        // (rather than passed as "pull") on the common path — the client
        // already defaults to "pull", and existing tests assert the exact
        // argument list `waitForDiagnostics` is called with.
        const isWarmupTouch = source === "lsp_sweep_warmup";
        // #743: per-server — a server we DID push to still gets the
        // version-baseline wait even when a sibling was debounced away.
        const wait =
          !notifySkippedServerIds.has(entry.info.id) && Number.isFinite(baseline)
            ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                minVersion: baseline,
                ...(pullOnly && { pullOnly: true }),
                ...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
              })
            : pullOnly
              ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                  pullOnly: true,
                  ...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
                })
              : isWarmupTouch
                ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                    pullSettleSource: "pull-warmup",
                  })
                : entry.client.waitForDiagnostics(filePath, serverTimeout);
        return wait.catch(() => undefined);
      });

      // The push wait — same per-server budget composition as before #707;
      // only the awaiting changed (assigned so it can be raced below).
      let pushWaitSettled = false;
      const pushWait: Promise<void> = hasTouchAuxiliaries
        ? (() => {
            // Primary waits: all non-auxiliary servers.
            const primaryWaits = perServerWaits.filter(
              (_, i) => spawned[i].info.role !== "auxiliary",
            );
            // Aux waits: auxiliary servers (advisory). `client` and the
            // pre-notify `diagnosticsVersion` baseline travel alongside the
            // promise so the outcome can be decided from EVIDENCE after the
            // race, not from how the raced promise settled (#1458 S1 — see
            // below).
            const auxWaits = perServerWaits
              .map((p, i) =>
                spawned[i].info.role === "auxiliary"
                  ? {
                      promise: p,
                      serverId: spawned[i].info.id,
                      client: spawned[i].client,
                      baseline: diagnosticBaselines.get(spawned[i].client),
                    }
                  : null,
              )
              .filter(
                (
                  x,
                ): x is {
                  promise: Promise<void | undefined>;
                  serverId: string;
                  client: (typeof spawned)[number]["client"];
                  baseline: number | undefined;
                } => x !== null,
              );
            const auxCeilingMs = readEnvAuxGraceMs() ?? 2000;
            // After all primaries settle, give each auxiliary the smaller of
            // its declared wait budget and the global auxiliary ceiling. The
            // 2000ms default admits measured ~1.3s warm scanner runs without
            // making every edit pay opengrep's 3500ms cold-start allowance.
            // Late aux results are dropped from this wait. A later unchanged-
            // content read may carry a SHA-256-bound cache publication before its
            // resync clears the cache; changed or unknown content never replays.
            // Aux servers that answer within the grace are included automatically since
            // their waitForDiagnostics already resolved. The cut-off server ids
            // are logged in the latency metadata (lsp_touch_file phase, field
            // `auxCutOffServerIds`).
            return Promise.all(primaryWaits).then(async () => {
              if (auxWaits.length === 0) return;
              const auxWaitStartedAt = Date.now();
              const outcomes = await Promise.all(
                auxWaits.map(async (aux) => {
                  const budgetMs = Math.min(timeoutFor(aux.serverId), auxCeilingMs);
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  const timeout = new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), budgetMs);
                    timer.unref();
                  });
                  const raced = await Promise.race([
                    aux.promise.then(() => true as const),
                    timeout,
                  ]);
                  if (timer) clearTimeout(timer);
                  // #1458 S1: `waitForDiagnostics` RESOLVES on its own timeout
                  // (client.ts) — it never rejects, and a silent scanner that
                  // published nothing looks identical, promise-wise, to one
                  // that answered. `raced === true` only means "the promise
                  // settled before our timer fired"; it is not proof anything
                  // was published. Decide the outcome from evidence instead:
                  // did this aux's `diagnosticsVersion` advance past the
                  // pre-notify baseline captured before the wait started?
                  //   - raced === false            → "cut_off" (our timer won;
                  //     the aux's own wait never got to answer for itself).
                  //   - raced === true, no evidence → "silent" (the aux's own
                  //     wait gave up within its budget with nothing to report —
                  //     NOT the same as having answered).
                  //   - raced === true, evidence   → "answered" (a fresh
                  //     publication actually landed for this touch).
                  //
                  // #1531: the evidence is read PER PATH. The global
                  // `diagnosticsVersion` advances for every file this client
                  // publishes, so a concurrent touch of an unrelated file used to
                  // hand this one an unearned "answered" row. The per-path stamp
                  // carries the global counter's value at store time, so the
                  // comparison stays monotonic across cache evictions while
                  // ignoring sibling paths — and it is the SAME axis `baseline`
                  // was captured on above.
                  const currentPathVersion = readPathVersion(aux.client);
                  const publishedEvidence =
                    raced &&
                    aux.baseline !== undefined &&
                    Number.isFinite(aux.baseline) &&
                    currentPathVersion !== undefined &&
                    currentPathVersion > aux.baseline;
                  // #1459: a DEFERRED aux was never sent this content and is not
                  // waited on at all, so its instantly-resolved placeholder
                  // promise must not read as "silent". "Silent" is the reserved
                  // signal for a scanner that HAD the content, finished inside
                  // its own budget, and published nothing (#1493) — recording a
                  // deferral there would corrupt the one row that tracks it.
                  const outcome = deferredResyncServerIds.has(aux.serverId)
                    ? ("deferred" as const)
                    : !raced
                      ? ("cut_off" as const)
                      : publishedEvidence
                        ? ("answered" as const)
                        : ("silent" as const);
                  return {
                    serverId: aux.serverId,
                    outcome,
                    // #1493: carried into the coverage-gap policy so a silent
                    // auxiliary that already published for these exact bytes is
                    // not demoted. Logged too — it is the reason a `silent` row
                    // did not narrow the touch.
                    // #1586: through the one predicate, so this row and the merge
                    // below cannot disagree about the same scanner.
                    publishedThisContent: auxCoversThisContent(aux.serverId),
                    budgetMs,
                    elapsedMs: Date.now() - auxWaitStartedAt,
                    // #1458 S3: elapsed measured from BEFORE the primary wait
                    // (waitStartedAt), not just from auxWaitStartedAt — this is
                    // what lets a latency row validate the ~1.3s warm-scanner
                    // figure the 2000ms ceiling was set from; `elapsedMs` alone
                    // only covers the POST-primary aux phase.
                    elapsedSinceNotifyMs: Date.now() - waitStartedAt,
                  };
                }),
              );
              const unfinished = outcomes
                .filter((outcome) => outcome.outcome === "cut_off")
                .map((outcome) => outcome.serverId);
              if (unfinished.length > 0) auxCutOffServerIds = unfinished;
              // #1493: one policy over both no-answer shapes. Lives in
              // diagnostic-binding.ts so no consumer re-derives the rule from
              // an outcome string.
              const uncovered = auxiliaryCoverageGap(outcomes);
              if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
              logLatency({
                type: "phase",
                phase: "lsp_aux_wait_outcome",
                filePath: normalizedPath,
                durationMs: Date.now() - auxWaitStartedAt,
                // #1533: `waitShape` names the producer, because the aggregate
                // path emits the same row with the same outcome vocabulary
                // minus `cut_off`. A field query that sees only `silent` rows
                // must be able to tell "our ceiling was in play" from "the
                // auxiliary's own full budget lapsed".
                metadata: { clientScope, ["wait" + "Shape"]: "aux_grace", outcomes },
              });
            });
          })()
        : Promise.all(perServerWaits).then(() => {});
      pushWait.then(() => {
        pushWaitSettled = true;
      });

      if (tsserverSyncEligible) {
        // #707 racing variant: rather than burning the full push-wait budget
        // on a silent-on-clean server (which by definition never answers on a
        // clean file), race the push wait against a grace-delayed sync
        // confirm. The grace (default 300ms, CHOCO_PI_LSP_TSSERVER_SYNC_GRACE_MS)
        // gives a genuinely dirty file's push a head start: if diagnostics
        // arrive before the grace elapses, the sync request never goes out —
        // zero new latency or requests on the push-answers path.
        //
        // Race semantics:
        //   - sync answers first → that's the confirmed result (clean OR
        //     dirty — the sync commands return the file's real syntactic +
        //     semantic state, so a dirty-file win is still correct and its
        //     findings are surfaced, never discarded).
        //   - push settles first → push wins; a still-in-flight sync outcome
        //     is discarded (the racer checks `pushWaitSettled` after the
        //     call returns and drops its own result).
        //   - sync unavailable/fails → the racer parks on a never-resolving
        //     promise so the race is decided by the push wait's own budget,
        //     exactly today's behavior (the end-of-wait fallback below still
        //     gets its shot on a timed-out empty result).
        // The racer never rejects (every failure path is caught), so the
        // losing promise can never surface as an unhandled rejection.
        const graceMs = readTsserverSyncGraceMs();
        const primaryClient = spawned[0].client;
        // Resolves with the sync commands' diagnostics when the confirm
        // succeeds; parks on a never-resolving promise on EVERY other path
        // (push already answered, sync unavailable/failed, push won while
        // in flight) so the race is then decided by the push wait's own
        // budget — exactly today's behavior.
        const syncRacer = (async (): Promise<import("./client.ts").LSPDiagnostic[]> => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, graceMs);
            timer.unref?.();
          });
          // Push already answered (settled, or published diagnostics that
          // its wait is about to settle on) — nothing to confirm, no sync
          // request goes out.
          if (pushWaitSettled || primaryClient.getDiagnostics(filePath).length > 0) {
            return new Promise<never>(() => {});
          }
          try {
            const result = await attemptTsserverSyncDiagnostics(filePath, core.service);
            if (result === undefined || pushWaitSettled) {
              // Sync unavailable/failed, or push won while the sync call
              // was in flight — drop the sync outcome and let the push
              // wait decide the race.
              return new Promise<never>(() => {});
            }
            return result;
          } catch {
            return new Promise<never>(() => {});
          }
        })();
        const raceOutcome = await Promise.race([
          pushWait.then((): undefined => undefined),
          syncRacer,
        ]);
        if (raceOutcome !== undefined) {
          tsserverSyncConfirmed = raceOutcome;
        }
      } else {
        await pushWait;
      }
      const waitedMs = Date.now() - waitStartedAt;
      // #1533: the same auxiliary coverage evidence for a collecting touch that
      // did NOT enter the aux-grace wait — in practice `clientScope: "all"`, the
      // batch/directory scan surface. Auxiliaries ARE spawned on that scope
      // (`getClientsForFile` returns every matching server, #573) and each one is
      // waited on inside `Promise.all(perServerWaits)` on its own per-server
      // budget, but `hasTouchAuxiliaries` is `with-auxiliary`-only, so no evidence
      // was ever derived and a silent scanner aggregated as an unqualified
      // `"confirmed"` — the #1493 false clean surviving on a different scope.
      //
      // NO SECOND WAIT. Every aux promise here has already settled (the
      // `Promise.all` above awaited it), so this reads post-wait state only. That
      // is deliberate: #1459's resync gate exists to ABSORB the aux fan-out of an
      // "all"-scope sweep into deferrals, and entering a per-neighbour aux grace
      // here would pay back the latency that gate just recovered. The evidence is
      // free; only the verdict changes.
      //
      // WHICH verdicts change, stated without overreach. Where the auxiliary's
      // budget is the MAX over waited servers (`perServerTimeout` is
      // `min(callerCap, strategyWait)` per server, `timeoutMs` is the max across
      // them), a silent auxiliary already tripped `diagnosticsTimedOut` and the
      // touch was already `inconclusive` — which is decided BEFORE the coverage
      // gap, so those results are unchanged. That covers opengrep on every current
      // per-edit path, whose 3500 exceeds either cap. But a FASTER auxiliary beside
      // a slower primary (typos 1500 or ast-grep 1800 next to rust-analyzer 3000
      // under a 2000 cap) settles inside `timeoutMs`, so nothing timed out and this
      // block genuinely narrows a result that used to read `confirmed`. That is the
      // fix working: the scanner said nothing about these bytes. It is fail-safe —
      // the primary's findings still ride along and only the coverage claim is
      // withdrawn — and the cost is a skipped cache seed for that file. Both cases
      // are pinned in `tests/clients/lsp/service-aux-grace.test.ts`.
      //
      // `cut_off` cannot arise on this path — there is no grace timer to end a
      // wait early — so the shapes are `answered` / `silent` / `deferred`, decided
      // by exactly the rules the grace path uses (#1458 S1: a settled promise is
      // not proof of a publication; only a `diagnosticsVersion` advance past the
      // pre-notify baseline is). `waitShape` distinguishes the two producers in
      // field data, since a `silent` row here means the auxiliary's own full
      // per-server budget lapsed rather than our ceiling cutting it short.
      //
      // A server the caller EXCLUDED (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`, #584)
      // never reaches `spawned`, so it cannot be reported here — an excluded-by-
      // design scanner is a routing decision, not a coverage gap, exactly as
      // `brokenSkippedAuxiliaryServerIds` already treats it.
      //
      // Written as `!hasTouchAuxiliaries` rather than `clientScope === "all"` so a
      // future scope that spawns auxiliaries without entering the grace wait fails
      // closed here by default instead of needing to be remembered. The #707
      // tsserver sync race can reach here with `pushWait` still pending, but it is
      // gated on `clientScope === "primary" && spawned.length === 1`, which spawns
      // no auxiliaries at all — so the per-role filter below is empty and no
      // evidence is read before its wait ends.
      //
      // `elapsedMs` and `elapsedSinceNotifyMs` are equal by construction here:
      // there is no separate post-primary aux phase to measure, so both describe
      // the one aggregate wait. Both fields are kept so a query can read either
      // producer's rows without special-casing the schema.
      //
      // The evidence is read PER PATH, through the same `readPathVersion` accessor
      // the grace path uses (#1531, landed on master while this was in review).
      // This is NOT interchangeable with `client.diagnosticsVersion`: that global
      // counter also advances for files this touch never mentions, so two
      // CONCURRENT touches sharing one auxiliary client cross-satisfy — a
      // publication for a.ts hands b.ts an unearned `answered`. That matters
      // especially here, because the highest-frequency `"all"` caller (the cascade
      // neighbour fan-out in `clients/dispatch/integration.ts`) is a
      // `Promise.allSettled` and its touches are always concurrent. Reading the
      // per-path stamp keeps this comparison on the SAME axis `baseline` was
      // captured on, and `undefined` from a double that predates the accessor fails
      // CLOSED rather than silently reverting to the global counter.
      if (!hasTouchAuxiliaries && options.collectDiagnostics === true) {
        const auxEntries = spawned.filter((entry) => entry.info.role === "auxiliary");
        if (auxEntries.length > 0) {
          const outcomes = auxEntries.map((entry) => {
            const baseline = diagnosticBaselines.get(entry.client);
            const currentPathVersion = readPathVersion(entry.client);
            const publishedEvidence =
              baseline !== undefined &&
              Number.isFinite(baseline) &&
              currentPathVersion !== undefined &&
              currentPathVersion > baseline;
            return {
              serverId: entry.info.id,
              outcome: deferredResyncServerIds.has(entry.info.id)
                ? ("deferred" as const)
                : publishedEvidence
                  ? ("answered" as const)
                  : ("silent" as const),
              publishedThisContent: auxCoversThisContent(entry.info.id),
              budgetMs: timeoutFor(entry.client.serverId),
              elapsedMs: waitedMs,
              elapsedSinceNotifyMs: waitedMs,
            };
          });
          const uncovered = auxiliaryCoverageGap(outcomes);
          if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
          logLatency({
            type: "phase",
            phase: "lsp_aux_wait_outcome",
            filePath: normalizedPath,
            durationMs: waitedMs,
            metadata: { clientScope, ["wait" + "Shape"]: "aggregate", outcomes },
          });
        }
      }
      if (tsserverSyncConfirmed !== undefined) {
        // #707: the racing sync confirm won — a definitive answer well under
        // the push-wait budget. Not a timeout, not inconclusive.
        logLatency({
          type: "phase",
          phase: "lsp_tsserver_sync_confirm",
          filePath: normalizedPath,
          durationMs: waitedMs,
          metadata: {
            source,
            serverId: spawned[0]?.client.serverId,
            clientScope,
            diagnosticsMode,
            mode: "race",
            confirmedDiagnosticCount: tsserverSyncConfirmed.length,
            budgetMs: timeoutMs,
            savedVsBudgetMs: Math.max(0, timeoutMs - waitedMs),
          },
        });
      } else if (waitedMs + 20 >= timeoutMs) {
        // Within ~20 ms of the configured budget we treat it as a timeout;
        // the LSP didn't beat the cap. Diagnostics that arrive late still
        // land in the client's cache and surface on the next edit.
        //
        // #1549: WHOSE budget lapsed decides the verdict. `timeoutMs` is the MAX
        // over the servers waited on, so a slow auxiliary (opengrep declares
        // 3500ms) sets the aggregate deadline for the whole touch — and a
        // touch-wide `diagnosticsTimedOut = true` then discarded a primary answer
        // that landed in 100ms. Attribute the lapse per server instead: the
        // touch is inconclusive only when a PRIMARY produced no evidence; an
        // auxiliary that produced none becomes a named coverage gap below.
        //
        // Evidence, not promise settlement (#1458 S1): `waitForDiagnostics`
        // resolves on its own timeout, so a settled wait proves nothing. The
        // per-path publication stamp advancing past this touch's pre-notify
        // baseline (#1531) is the primary signal; a present per-file cache entry
        // is the second, because the notify this touch just sent cleared that
        // entry (`clearDiagnosticsForPath`), so a present one can only be a fresh
        // answer — the same signal #814's aggregate gate already trusts.
        //
        // Every unknown fails CLOSED: a client that exposes neither accessor
        // reads as unanswered, which for a primary is exactly the pre-#1549
        // verdict. This block can therefore only ever NARROW an inconclusive
        // touch, never create one.
        const answeredForThisTouch = (entry: (typeof spawned)[number]): boolean => {
          const baseline = diagnosticBaselines.get(entry.client);
          const currentPathVersion = readPathVersion(entry.client);
          if (
            baseline !== undefined &&
            Number.isFinite(baseline) &&
            currentPathVersion !== undefined &&
            currentPathVersion > baseline
          ) {
            return true;
          }
          try {
            return entry.client.getAllDiagnostics?.().has(normalizedPath) === true;
          } catch {
            // Fail closed: an unreadable cache is not evidence of an answer.
            return false;
          }
        };
        // A deferred server was never sent this content and is not waited on, so
        // it cannot have "timed out" — it is already reported as a coverage gap.
        const waited = spawned.filter((entry) => !deferredResyncServerIds.has(entry.info.id));
        const unanswered = waited.filter((entry) => !answeredForThisTouch(entry));
        diagnosticsUnansweredServerIds = unanswered.map((e) => e.info.id);
        diagnosticsUnansweredPrimaryServerIds = unanswered
          .filter((entry) => entry.info.role !== "auxiliary")
          .map((e) => e.info.id);
        // Fail-safe: a touch with no waited-on primary has no primary answer to
        // preserve, so it keeps the pre-#1549 touch-wide verdict rather than
        // absolving itself on an auxiliary's evidence.
        const hasWaitedPrimary = waited.some((entry) => entry.info.role !== "auxiliary");
        diagnosticsTimedOut = !hasWaitedPrimary || diagnosticsUnansweredPrimaryServerIds.length > 0;
        for (const entry of unanswered) {
          incrementDegradationCount({
            kind: "lsp-diagnostics-timeout",
            // `info.id` is the authoritative server identity carried by
            // every spawned entry. The client test doubles (and some
            // lightweight clients) need not expose a serverId property;
            // ledger recording must never abort the touch or alter #570's
            // timeout-preserves-last-known-diagnostics semantics.
            subject: entry.info.id,
            reason: "diagnostics wait timed out",
          });
        }
        logLatency({
          type: "phase",
          phase: "lsp_diagnostics_timeout",
          filePath: normalizedPath,
          durationMs: waitedMs,
          metadata: {
            source,
            // #1444: WHICH server(s) burned the budget — without this the
            // ~221/day timeout rows can't be attributed to a server at all.
            // `info.id` (not `client.serverId`) for the same reason the
            // degradation ledger above uses it: test doubles and lightweight
            // clients need not expose `serverId`.
            serverIds: spawned.map((e) => e.info.id),
            clientScope,
            diagnosticsMode,
            timeoutMs,
            // #1549: which of those servers actually produced no evidence, and
            // whether the lapse is attributable to a primary (the touch is
            // inconclusive) or only to auxiliaries (a named coverage gap, with
            // the primary's findings intact). Without these two fields a
            // forensic sweep cannot tell the two apart at all.
            unansweredServerIds: diagnosticsUnansweredServerIds,
            attributedToPrimary: diagnosticsTimedOut,
          },
        });
      }

      // #814: capability-aware AGGREGATE wait — generalize #799's
      // single-server (`clientScope === "primary" && spawned.length === 1`)
      // silent-clean confirm to multi-server `clientScope: "all"` touches
      // (`diagnostics_report` mode=full per-file sweep, `lsp_diagnostics`
      // `serverScope: "all"`). #799's gate never fires here (it's scoped to
      // the primary hot path), so a scope-"all" touch where every OTHER
      // spawned server already answered but one push-only `silentOnClean`
      // server (marksman on a clean markdown file) never publishes still
      // reported the WHOLE touch `inconclusive`/`diagnosticsTimedOut` even
      // though the "silence" is exactly what that server's own known
      // clean-behavior predicts — not an unresolved question.
      //
      // A spawned server counts as "still outstanding" when nothing landed
      // in its per-file diagnostics cache for THIS touch — `getAllDiagnostics`
      // is keyed by file and `clearDiagnosticsForPath` (`client.ts`) deletes
      // that file's entry as part of the didOpen/didChange this touch just
      // sent, so a present entry can only be a FRESH answer (found or a real
      // confirmed-empty push/pull), never a stale one bleeding through from
      // an earlier touch. This is the same "did anything publish for this
      // file since we asked" signal `cascade-tier.ts`'s Tier-3 reconcile
      // already trusts (#240 doctrine) — reused here, not reinvented.
      //
      // The touch stays inconclusive unless EVERY still-outstanding server
      // is classified `tier3-silent` (push-only + `silentOnClean`, the same
      // `classifyServerWaitTier` rule the single-server gate below and the
      // cascade lane use) — one ordinary push-only straggler (still
      // genuinely analyzing) or a pull-capable server that never answered
      // keeps the touch cautious, matching #799's "err toward caution"
      // posture for partial timeouts. `!notifyWriteTimedOut` (touch-wide)
      // plus the per-server re-check below are the same "the notify write
      // must have actually landed" conservatism #799 established — a
      // server's silence is only evidence of "clean" when we know it saw
      // the new content.
      //
      // #1549: both the gate and its "still outstanding" set are PRIMARY-scoped.
      // An auxiliary is never asked to prove itself tier3-silent here, because an
      // auxiliary that never reported is already named as a coverage gap — and
      // requiring it to was the second half of the touch-wide conflation: a clean
      // markdown file whose marksman silence IS the answer stayed inconclusive
      // purely because an opengrep scan beside it had not finished. The auxiliary's
      // absence still costs the touch its full confirmation (`partial`); what it no
      // longer does is erase the primary's answer.
      if (diagnosticsTimedOut && !primaryNotifyWriteTimedOut && clientScope === "all") {
        try {
          const outstanding = primaryEntries.filter(
            (entry) =>
              !notifyWriteTimedOutServerIds.includes(entry.info.id) &&
              !entry.client.getAllDiagnostics().has(normalizedPath),
          );
          if (outstanding.length > 0) {
            const snapshots = await core.service.getCapabilitySnapshots(filePath);
            const allSilent = outstanding.every(
              (entry) =>
                classifyServerWaitTier(
                  entry.client.serverId,
                  snapshots.find((s) => s.serverId === entry.client.serverId),
                ) === "tier3-silent",
            );
            if (allSilent) {
              // #1277: the static tier3-silent classification alone can't
              // tell a genuinely clean server from one that accepted the
              // notify write and then wedged — both look identical to
              // `classifyServerWaitTier`, which only reads the capability
              // snapshot, never the server's actual current responsiveness.
              // Require every still-outstanding server to answer a cheap
              // bounded round-trip before trusting the silence as clean;
              // any server that doesn't respond in time keeps the touch
              // inconclusive rather than confirming a possibly-dead server
              // clean.
              const liveness = await Promise.all(
                outstanding.map((entry) =>
                  (entry.client.pingLiveness?.() ?? Promise.resolve(true)).catch(() => false),
                ),
              );
              if (liveness.every(Boolean)) {
                diagnosticsTimedOut = false;
                retractPrimaryTimeoutAttribution(); // #1549
                logLatency({
                  type: "phase",
                  phase: "lsp_silent_clean_confirm",
                  filePath: normalizedPath,
                  durationMs: Date.now() - startedAt,
                  metadata: {
                    source,
                    clientScope,
                    diagnosticsMode,
                    aggregate: true,
                    serverIds: outstanding.map((entry) => entry.client.serverId),
                  },
                });
              }
            }
          }
        } catch {
          // Fail-safe: leave `diagnosticsTimedOut` as-is — today's
          // inconclusive behavior, exactly like the single-server gate.
        }
      }
    }

    // #1586: THE coverage evaluation, taken ONCE, here — the last statement before
    // the merge, with no `await` between it and the drop it authorizes. Everything
    // that shares the merge's consequences reads this frozen set and never asks
    // the live predicate again.
    //
    // The review round on this change proved why the freeze has to be the unit.
    // `touchFile` awaits after the merge — `brokenSkippedAuxiliaryServerIds` on
    // every collecting touch, the tsserver sync and liveness gates on theirs — and
    // a publication landing in that window flips the live predicate. Re-asking it
    // when the coverage gap was named then un-named a scanner whose findings the
    // merge had ALREADY dropped: `.diags` missing the scanner's answer while the
    // touch claimed `confirmed`, which unblocks the `lastKnownDiagnostics` prime
    // and the `demonstratedReady` mark that `coverageGap` exists to hold shut.
    // That is #1459's blackout reading as scanned-clean — the overclaim direction,
    // and the worse one. A drop is an action; a later answer cannot undo it, so
    // the naming must be settled from the same instant that authorized it.
    const auxCoveredAtMerge = new Set(
      spawned.filter((entry) => auxCoversThisContent(entry.info.id)).map((entry) => entry.info.id),
    );
    // Which DEFERRED auxiliaries this touch genuinely carries no evidence from.
    // The deferral itself only proves the gate did not send these bytes on THIS
    // touch; whether the scanner has reported on them is a content-hash question.
    const uncoveredDeferredServerIds = notifyDeferredServerIds.filter(
      (serverId) => !auxCoveredAtMerge.has(serverId),
    );
    // An AUXILIARY whose notify write never landed still holds the previous
    // content's findings — nothing cleared its cache — and before this change that
    // touch was blanket `inconclusive`, so no consumer read the merged array. Now
    // the primary's answer flows, which means the auxiliary's stale findings would
    // flow with it and be reported (with the previous revision's line numbers) as
    // this touch's answer. Drop them; the write failure is reported as a coverage
    // gap instead.
    // Auxiliaries only. A PRIMARY keeps #570's deliberate
    // timeout-preserves-last-known-diagnostics semantics, and its write failure
    // makes the touch inconclusive anyway, so no consumer reads the array as
    // current.
    const staleWriteAuxiliaryServerIds = spawned
      .filter(
        (entry) =>
          entry.info.role === "auxiliary" &&
          notifyWriteTimedOutServerIds.includes(entry.info.id) &&
          !auxCoveredAtMerge.has(entry.info.id),
      )
      .map((entry) => entry.info.id);
    // #1586: every contribution this merge withholds, in one set. The merged
    // BINDING reads it too (#1459's door, which filtered the raw deferral set and
    // so excluded the fingerprint of a deferred-but-covered scanner whose findings
    // the merge had just kept) — a dropped contributor must lose its findings and
    // its binding together, or the merged `boundToCurrentDisk` describes bytes the
    // result no longer contains.
    const droppedAuxiliaryServerIds = new Set([
      ...uncoveredDeferredServerIds,
      ...staleWriteAuxiliaryServerIds,
    ]);
    // #707: when the racing sync confirm won the wait, its answer IS the
    // collected result — the file's real syntactic + semantic state straight
    // from tsserver (clean = [], dirty = real findings that a silentOnClean
    // server had computed but never published). Otherwise merge the push
    // diagnostics from the client cache as always.
    let collected = options.collectDiagnostics
      ? tsserverSyncConfirmed !== undefined
        ? mergeLspDiagnostics(tsserverSyncConfirmed)
        : mergeLspDiagnostics([
            // #1459: a DEFERRED server's cache still holds the PREVIOUS
            // content's findings — the resync that would have cleared it never
            // ran. Merging them would report another revision's findings (and
            // its line numbers) as this touch's answer, the one hazard the
            // gate itself creates. Drop them; the gap is reported instead.
            // #1586: unless the scanner has since published for exactly these
            // bytes — `droppedAuxiliaryServerIds` is the one frozen answer the
            // coverage naming and the merged binding read too.
            ...spawned.flatMap((entry) =>
              droppedAuxiliaryServerIds.has(entry.info.id)
                ? []
                : entry.client.getDiagnostics(filePath),
            ),
            ...carriedAuxiliary.flatMap((entry) => entry.diags),
          ])
      : undefined;
    // #1095 (P3-b): whether `collected` came from a tsserver sync confirm
    // (`tsserverSyncRequest`) rather than the publish cache. A sync-confirmed
    // result is authoritative for the CURRENT buffer but is NOT tied to the
    // publish-path content binding (`diagnosticBindings`, set on publish), so
    // composing that binding here could let a STALE publish fingerprint demote a
    // genuinely-fresh sync answer to `false`. The end-of-wait fallback below can
    // also set this. When true, the binding is surfaced as "unknown" (honest,
    // non-demoting) rather than the stale publish binding.
    let syncConfirmed = tsserverSyncConfirmed !== undefined;

    // #707 end-of-wait fallback: when the racing confirm did NOT decide the
    // wait (sync unavailable/failed mid-race, or push resolved as a bare
    // timeout) and the wait timed out with an empty result on an eligible
    // touch, give the sync clean-confirm one last shot before reporting
    // inconclusive. `tsserverSyncEligible` already encodes every gate (notify
    // succeeded, collecting, primary scope, tier3-silent classic typescript —
    // native-ts7 excluded by `classifyCascadeWaitTier`). If the sync call
    // answers (even with an empty body, which is a confirmed clean), we use
    // those diagnostics as the confirmed result and clear the
    // `diagnosticsTimedOut` flag so the touch is no longer treated as
    // inconclusive. Sync diagnostics on a dirty file are surfaced, not
    // discarded. If the sync call fails or is unavailable, we fall through to
    // today's behavior: `inconclusive` = true, `collected` unchanged. This
    // turns "unconfirmed after ~1000ms" into "confirmed at ~wait+sync-RTT"
    // even when the race path couldn't answer.
    if (
      diagnosticsTimedOut &&
      tsserverSyncEligible &&
      collected !== undefined &&
      collected.length === 0
    ) {
      try {
        const syncResult = await attemptTsserverSyncDiagnostics(filePath, core.service);
        if (syncResult !== undefined) {
          // Sync answered — confirmed result (clean or with diagnostics).
          // Clear the timed-out flag so the touch is no longer inconclusive.
          diagnosticsTimedOut = false;
          retractPrimaryTimeoutAttribution(); // #1549
          syncConfirmed = true;
          collected = syncResult.length > 0 ? mergeLspDiagnostics(syncResult) : [];
          logLatency({
            type: "phase",
            phase: "lsp_tsserver_sync_confirm",
            filePath: normalizedPath,
            durationMs: Date.now() - startedAt,
            metadata: {
              source,
              clientScope,
              diagnosticsMode,
              mode: "end-of-wait",
              confirmedDiagnosticCount: collected.length,
            },
          });
        }
      } catch {
        // Any failure here falls through to today's inconclusive behavior.
      }
    }

    // #799: generalize the "silent-clean push-only" confirm beyond
    // typescript's active sync-command race above. That mechanism is
    // TS-specific (`attemptTsserverSyncDiagnostics` races an actual
    // `typescript.tsserverRequest` — no equivalent protocol exists for
    // e.g. marksman) and is now scoped to `serverId === "typescript"`
    // only (see the gate above), so it never fires for another
    // `silentOnClean` server. This is the generic fallback for those
    // servers: if the wait ran its full budget with a successful notify
    // write and nothing published, and the live capability snapshot
    // classifies this touch as tier3-silent (push-only + `silentOnClean`,
    // #458's `classifyCascadeWaitTier`), that is not "still working" —
    // `silentOnClean` means by definition this server publishes NOTHING
    // on a clean transition, so a timeout under those conditions IS the
    // confirmed-clean answer. `!tsserverSyncEligible` keeps this from
    // ever double-deciding typescript's own touches — when the sync race
    // was attempted and failed/was unavailable, typescript's existing
    // "falls through to inconclusive, unchanged" contract (#707) is
    // preserved exactly; typescript touches that never enter that gate
    // (e.g. `collectDiagnostics: false`, like `ensureWarmForSweep`'s own
    // warm-up call) are still eligible here as a genuine bonus fix. Scoped
    // to `clientScope === "primary"`/`spawned.length === 1` exactly like
    // the sync-eligible gate above (and like `ensureWarmForSweep`'s own
    // `clientScope: "primary"` warm-up touch) so a multi-server
    // with-auxiliary/all touch — where a partial timeout must stay
    // cautious per the doc below — is never affected.
    //
    // #814: this is now a SPECIAL CASE of the more general per-server gate
    // above (the `clientScope === "all"` block right before the diagnostics-
    // wait `if` closes) — for `spawned.length === 1`, "every still-outstanding
    // server is tier3-silent" collapses to exactly this single-server check.
    // Left in place unchanged (rather than deleted/rewritten to delegate to
    // the new gate) per #814's scope: a future cleanup could fold this block
    // into the general one once both have soaked, but that's a separate,
    // lower-risk follow-up, not bundled into this fix.
    if (
      diagnosticsTimedOut &&
      // #1549: primary-scoped, like the aggregate gate. `spawned.length === 1`
      // below means the one server IS the primary, so this is the same condition
      // written in the vocabulary the rest of the merge now uses.
      !primaryNotifyWriteTimedOut &&
      !tsserverSyncEligible &&
      clientScope === "primary" &&
      spawned.length === 1 &&
      getStrategy(spawned[0].client.serverId, spawned[0].client.getLaunchVariant?.())
        .silentOnClean === true
    ) {
      try {
        const snapshots = await core.service.getCapabilitySnapshots(filePath);
        if (classifyCascadeWaitTier(core.service, filePath, snapshots) === "tier3-silent") {
          // #1277: same liveness precondition as the aggregate gate above —
          // `tier3-silent` is a static capability classification and can't
          // distinguish "silent because clean" from "silent because wedged".
          // A cheap bounded round-trip proves the server is still actually
          // responding before its silence is trusted as a clean confirm; a
          // server that doesn't answer in time leaves the touch inconclusive.
          const alive = await (spawned[0].client.pingLiveness?.() ?? Promise.resolve(true)).catch(
            () => false,
          );
          if (alive) {
            diagnosticsTimedOut = false;
            retractPrimaryTimeoutAttribution(); // #1549
            if (collected !== undefined) collected = mergeLspDiagnostics([]);
            logLatency({
              type: "phase",
              phase: "lsp_silent_clean_confirm",
              filePath: normalizedPath,
              durationMs: Date.now() - startedAt,
              metadata: {
                source,
                clientScope,
                diagnosticsMode,
                serverId: spawned[0].client.serverId,
              },
            });
          }
        }
      } catch {
        // Fail-safe: leave `diagnosticsTimedOut` as-is — today's inconclusive
        // behavior.
      }
    }

    // #1549: a touch is inconclusive when a PRIMARY's notify write or the
    // diagnostics wait hit their deadline. Both inputs are primary-scoped now.
    //
    // The rule this replaced — `notifyWriteTimedOut || diagnosticsTimedOut`, both
    // flags touch-wide over every spawned server — discarded every good answer in
    // the touch whenever one auxiliary was slow. `timeoutMs` is the MAX over the
    // servers waited on, so opengrep's 3500ms budget set the deadline for the whole
    // touch and a typescript answer that landed in 100ms read as "nothing is known
    // about this file". Measured over 6,079 cascade neighbour sweeps: 97.6%
    // inconclusive, against 15% for ordinary edit-time touches in the same window.
    //
    // The caution the old comment argued for is preserved, in the honest place: the
    // merged result IS missing whatever the unreporting auxiliary would have said,
    // so the touch withdraws its claim of full coverage (`confirmation: "partial"`
    // plus `unconfirmedServerIds`, below) and every consumer that treats
    // confirmation as proof of coverage still fails closed. What it no longer does
    // is throw away the primary's answer, which is the #533 honesty doctrine
    // cutting both ways.
    const verdict = resolveTouchVerdict({
      primaryNotifyWriteTimedOutServerIds,
      diagnosticsTimedOut,
      diagnosticsUnansweredServerIds: diagnosticsUnansweredPrimaryServerIds,
    });
    const inconclusive = verdict.inconclusive;

    // #1470/#1493: an auxiliary whose push wait was CUT OFF by the aux grace
    // timer (R8/#714) contributed exactly as much evidence about this file as one
    // that went silent inside its own budget — none. Both now narrow the
    // confirmation, through the one `auxiliaryCoverageGap` policy. A hung or
    // silent opengrep used to resolve `confirmation: "confirmed"` and read as
    // confirmed-clean on the security lane; the silent half survived #1470
    // because it only tripped `diagnosticsTimedOut` when it was the ONLY
    // auxiliary, so a fast sibling hid it (#1493).
    // This does NOT flip the touch to inconclusive: that would discard a
    // primary answer that IS trustworthy (#533 honesty doctrine cuts both ways —
    // overclaiming and underclaiming are both dishonest). Instead the confirmation
    // is NARROWED: `"partial"`, naming the servers it does not speak for, so every
    // consumer that treats confirmation as proof of coverage fails closed while
    // the primary's findings still flow.
    // #1459: two more doors into the same room, and they open BEFORE any wait —
    // so `auxiliaryCoverageGap` (which reads wait outcomes) cannot see either on
    // its own. A scanner whose breaker was open never attached, and one whose
    // resync the fan-out gate deferred never received this content.
    //
    // The deferred ids are unioned in rather than left to the aux-wait policy on
    // purpose: an aux outcome row requires an auxiliary to have been SPAWNED, and a
    // breaker-skipped scanner never was. #1533: an `"all"`-scope sweep emits outcome
    // rows now too, so a spawned-but-deferred server arrives through BOTH routes as
    // outcome `"deferred"` — where a stored publication
    // for these exact bytes can still exempt it — so the Set dedups rather than
    // double-reports, and #1493's content-hash exemption is not bypassed here:
    // a deferred aux is only unioned in because the gate itself proves it was
    // never sent this content.
    const brokenSkippedServerIds =
      collected !== undefined
        ? await brokenSkippedAuxiliaryServerIds(core, filePath, clientScope, options, spawned)
        : [];
    // #1549: the fourth door, and the one this issue opened. An auxiliary that
    // missed a deadline no longer makes the touch inconclusive, so it MUST arrive
    // here instead — otherwise the fix would launder a scanner blackout into a
    // clean bill of health, which is the #1459/#1493 false-clean pointing the other
    // way. Two shapes reach this and no aux outcome row: an auxiliary whose notify
    // write timed out or rejected, and one that produced no publication evidence
    // when the wait lapsed (including on a NON-collecting touch, which derives no
    // outcome rows at all). The content-bound exemption is honored through the same
    // `auxCoversThisContent` predicate the merge uses — one rule, so a scanner
    // cannot be named uncovered while its findings ride along in `.diags`, or the
    // reverse. The Set dedups against the ids `auxiliaryCoverageGap` reported.
    const auxNoAnswerServerIds = spawned
      .filter(
        (entry) =>
          entry.info.role === "auxiliary" &&
          (diagnosticsUnansweredServerIds.includes(entry.info.id) ||
            notifyWriteTimedOutServerIds.includes(entry.info.id)) &&
          !auxCoveredAtMerge.has(entry.info.id),
      )
      .map((entry) => entry.info.id);
    // #1586: whatever the doors contributed, the RESULT's coverage claim is
    // settled from the MERGE's frozen evaluation — never a fresh one, which is
    // what made this an overclaim in review (see `auxCoveredAtMerge`). The
    // per-door filters above are not redundant with this one: they shape the
    // `lsp_scanner_coverage_gap` fields, which each answer "what did THIS door
    // see", while this settles "what does the touch speak for". It matters most
    // for `auxUnconfirmedServerIds`, decided when the aux wait ended and therefore
    // strictly BEFORE the merge — reconciling it here is what keeps a scanner from
    // being named while the merge kept its findings. A breaker-skipped scanner
    // never reached `spawned`, so it is not in the covered set and stays named:
    // fail closed.
    const unconfirmedServerIds = [
      ...new Set([
        ...(auxUnconfirmedServerIds ?? []),
        ...auxNoAnswerServerIds,
        ...uncoveredDeferredServerIds,
        ...brokenSkippedServerIds,
      ]),
    ].filter((serverId) => !auxCoveredAtMerge.has(serverId));
    const coverageGap = unconfirmedServerIds.length > 0;
    // The record that proves a blackout is no longer read as clean: one row per
    // touch that a scanner did not cover, naming the scanner and the reason.
    if (
      brokenSkippedServerIds.length > 0 ||
      uncoveredDeferredServerIds.length > 0 ||
      // #1549: the auxiliary deadline misses that used to surface as a blanket
      // `inconclusive` need their own row now that the touch reports usable
      // findings — otherwise the fix would remove the only record of the blackout.
      auxNoAnswerServerIds.length > 0
    ) {
      logLatency({
        type: "phase",
        phase: "lsp_scanner_coverage_gap",
        filePath: normalizedPath,
        durationMs: Date.now() - startedAt,
        metadata: {
          source,
          clientScope,
          ...(brokenSkippedServerIds.length > 0 && { brokenSkippedServerIds }),
          // #1586: the deferrals this touch is actually uncovered for. The raw
          // gate action keeps its own record in `lsp_notify_resync_deferred`;
          // this row exists to prove a blackout, and a scanner already bound to
          // these bytes is not one.
          ...(uncoveredDeferredServerIds.length > 0 && {
            deferredResyncServerIds: uncoveredDeferredServerIds,
          }),
          ...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
        },
      });
    }

    // #667: a confirmed (non-inconclusive) diagnostics-mode touch is the
    // "actually warm" signal `ensureWarmForSweep` waits for — mark every
    // spawned server so a later sweep in this session sees the check as a
    // no-op instead of paying the warm-up round trip again.
    //
    // #743: the diagnostics wait is a blanket (touch-wide) gate, but the
    // notify-write timeout is now PER-SERVER — a healthy server whose sibling's
    // write stalled must still be eligible, so only servers whose OWN write
    // timed out are skipped here (rather than gating the whole loop on the
    // file-level `inconclusive`).
    //
    // #1470/#1493: same per-server reasoning for an auxiliary that contributed
    // no evidence. "Demonstrated ready" means this server answered for this
    // file; an auxiliary our grace timer cut off, or one that stayed silent
    // through its own budget, demonstrably did not.
    //
    // NO TEST PINS THIS LINE, and that is a property of today's readers rather
    // than a coverage gap: `ensureWarmForSweep` filters `role === "auxiliary"`
    // out of its server list entirely, so no reader consumes an auxiliary's
    // `demonstratedReady` mark and deleting this `continue` changes no observable
    // behavior (verified by mutation — the LSP suite stays green). It stays
    // because the mark's meaning is "this server answered", and the moment any
    // reader stops filtering auxiliaries out, marking a cut-off scanner warm
    // would let it skip a warm-up it never earned.
    //
    // #1549: `diagnosticsTimedOut` is primary-attributed now, so this loop can be
    // reached with an auxiliary that never answered — including on a NON-COLLECTING
    // touch, which derives no aux wait-outcome rows. `unconfirmedServerIds` covers
    // that case because `auxNoAnswerServerIds` is computed for every touch, not only
    // a collecting one; an unheard scanner is therefore already excluded here and
    // needs no separate guard. A primary cannot reach this loop unheard at all: it
    // would have set `diagnosticsTimedOut`, and the gates that clear that flag
    // retract its attribution precisely because they certified its silence AS the
    // answer (`retractPrimaryTimeoutAttribution`).
    const notifyTimedOutServerIds = new Set(notifyWriteTimedOutServerIds);
    const uncoveredServerIds = new Set(unconfirmedServerIds);
    if (diagnosticsMode !== "none" && !diagnosticsTimedOut) {
      for (const entry of spawned) {
        if (notifyTimedOutServerIds.has(entry.info.id)) continue;
        if (uncoveredServerIds.has(entry.info.id)) continue;
        const key = await demonstratedReadyKeyFor(core, entry.info, filePath);
        if (key) markDemonstratedReadyKey(core, key);
      }
    }

    // Prime the last-known cache WITH the hash of the content we just synced,
    // so a hot-path consumer (actionable-warnings at turn_end) can verify the
    // cached diagnostics are for the current bytes before reusing them instead
    // of paying for a second open+wait. Only when we actually collected — a
    // non-collecting touch (didChange-only) leaves the prior entry intact.
    // Skip this entirely when the touch was inconclusive: an unconfirmed
    // empty `collected` must never erase a previously-confirmed non-empty
    // record (that's the #570 bug — a timeout silently reporting as clean
    // and wiping out known-good diagnostic state).
    // #1470/#1493: a PARTIAL touch is the same hazard wearing a different flag.
    // Its merged array is missing whatever the unreporting auxiliary would have said, so
    // priming the cache with it would let `actionable-warnings`' hash-guarded
    // read replay a partially-covered result as an authoritative observation —
    // and an empty one would DELETE a previously-confirmed record on the strength
    // of a scanner that never answered. Skip the prime; the next read pays a real
    // round trip instead of trusting an incomplete one.
    if (collected !== undefined && !inconclusive && !coverageGap) {
      const normalizedKey = normalizeMapKey(filePath);
      if (collected.length > 0) {
        core.lastKnownDiagnostics.set(normalizedKey, collected);
        core.lastKnownContentHash.set(normalizedKey, hashContent(content));
      } else {
        core.lastKnownDiagnostics.delete(normalizedKey);
        core.lastKnownContentHash.delete(normalizedKey);
      }
    }

    // #1179 (shape-5 structural fix): build the result WRAPPER. The two flags
    // that used to ride the returned array as NON-enumerable side-channels
    // (`Object.defineProperty(collected, ...)`, dropped by any `[...]`/`.filter`/
    // `JSON` copy — the #1094/#1096 loss class) are now EXPLICIT ENUMERABLE
    // fields on this wrapper. `.diags` holds the array a copy operates on, so the
    // flags survive by construction. Field presence mirrors the old attachment
    // conditions EXACTLY: `inconclusive` only for a confirmed-inconclusive
    // collect, `binding` only for a collecting touch — a non-collecting touch
    // keeps resolving `{ diags: [] }`, no flags.
    const result: TouchFileResult = { diags: collected ?? [] };

    if (collected !== undefined && inconclusive) {
      result.inconclusive = true;
      // #1549: name the primary that produced the verdict and which deadline it
      // missed, so a forensic sweep reads the cause instead of inferring it from
      // duration histograms. Absent ids on an inconclusive touch mean the
      // attribution was not derivable (a client with no per-path publication
      // stamp) — honest, and the same fail-closed verdict as before.
      if (verdict.inconclusiveServerIds) {
        result.inconclusiveServerIds = verdict.inconclusiveServerIds;
      }
      result.inconclusiveReason = verdict.inconclusiveReason;
    } else if (collected !== undefined && coverageGap) {
      // #1470/#1493: narrowed, not collapsed. Reached for EITHER no-answer
      // shape — a cut-off auxiliary or a silent one with nothing published for
      // this content. The primary's findings ride along in `.diags` exactly as
      // before; what changes is that the touch now states which servers it does
      // not speak for, so no consumer can read this as a full clean bill of
      // health.
      result.confirmation = "partial";
      result.unconfirmedServerIds = [...unconfirmedServerIds];
    } else if (collected !== undefined) {
      // Preserve the lower-level affirmative result across consumers. In
      // particular, the silent-clean gates above clear diagnosticsTimedOut only
      // after a successful notify and capability-confirmed wait; reclassifying
      // that empty array later would discard the evidence that made it clean.
      result.confirmation = "confirmed";
    }

    // #1095: attach the merged content binding so a consumer can ask whether
    // these diagnostics were computed against current disk. Composed across every
    // spawned client so a single client whose view diverged from disk marks the
    // whole merged result mismatched. Disk verify is lazy + memoized per
    // (file, mtime).
    let binding: DiagnosticBinding | undefined;
    if (collected !== undefined) {
      binding = syncConfirmed
        ? // #1095 (P3-b): a tsserver sync-confirmed result is authoritative for
          // the current buffer but not tied to the publish-path fingerprint —
          // surface "unknown" so a stale publish binding can't demote it.
          { boundToCurrentDisk: "unknown" }
        : mergeBinding(
            core,
            filePath,
            // Optional-chain so a client without the getter (test doubles, a
            // partially-mocked client) yields "unknown" rather than throwing —
            // unknown preserves pre-#1095 behavior for that contributor.
            [
              // #1459/#1549: a contributor whose findings the merge DROPPED must
              // not decide the merged verdict either — its binding describes
              // bytes this result no longer contains.
              // #1586: read off the same frozen set the drop used. Filtering the
              // raw deferral set instead excluded the fingerprint of a
              // deferred-but-COVERED scanner whose findings the merge had just
              // kept, which diverges whenever the primary is version-less and
              // that scanner is the only contributor with a fingerprint.
              ...spawned
                .filter((entry) => !droppedAuxiliaryServerIds.has(entry.info.id))
                .map((entry) => entry.client.getDiagnosticBinding?.(filePath)),
              ...carriedAuxiliary.map((entry) => entry.binding),
            ],
          );
      result.binding = binding;
    }

    // The recent-touches entries are recorded per server inside the notify-write
    // loop above, at the moment each server's own write lands (#1253) — a server
    // whose write timed out or rejected deliberately gets none, so the next touch
    // re-pushes it rather than debouncing a failure into a later touch that looks
    // fully delivered. Nothing to record here: a skipped server keeps its original
    // entry (and timestamp) so its window still expires naturally instead of being
    // extended by every reuse.

    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizedPath,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverCountReady: spawned.length,
        clientScope,
        diagnosticsMode,
        source,
        failureKind: "success",
        collectedDiagnostics: collected?.length,
        // #1095: observability so an unbinding server is diagnosable —
        // "bound" (matches disk) / "mismatch" (diverged) / "unknown"
        // (version-less server or disk unreadable). Absent for non-collecting
        // touches (no merged result to bind).
        ...(binding !== undefined && {
          bindingState: bindingStateLabel(binding.boundToCurrentDisk),
        }),
        notifySkipped,
        notifyWriteTimedOut,
        // #743: per-server detail — which servers' writes actually timed out.
        // Absent when none did. `notifyWriteTimedOut` is the file-level "at
        // least one" summary.
        ...(notifyWriteTimedOutServerIds.length > 0 && {
          notifyWriteTimedOutServerIds,
        }),
        diagnosticsTimedOut,
        inconclusive,
        // #1549: the attribution the issue's observability contract asks for —
        // WHICH primary made the touch inconclusive and which deadline it missed
        // (`notify-write` vs `diagnostics-wait`, or `mixed`). Absent on a
        // conclusive touch, which blames nobody.
        ...(verdict.inconclusiveServerIds && {
          inconclusiveServerIds: verdict.inconclusiveServerIds,
        }),
        ...(verdict.inconclusiveReason && {
          inconclusiveReason: verdict.inconclusiveReason,
        }),
        // #1470: the touch's own honesty verdict, so a `cut_off` row in
        // `lsp_aux_wait_outcome` can be joined to the touch that produced it and
        // shown NOT to have claimed confirmation for that server's coverage.
        // Absent for a non-collecting touch, which claims nothing either way.
        ...(result.confirmation !== undefined && {
          confirmation: result.confirmation,
        }),
        // R8 (#714): server ids of auxiliaries whose push wait was cut off by
        // the aux grace window (primary settled clean + aux timed out in grace).
        // Absent when no aux was cut off. These servers' diagnostics are
        // advisory-only and will surface on the next edit from their cache.
        ...(auxCutOffServerIds !== undefined && { auxCutOffServerIds }),
        // #1493: the full set the confirmation was narrowed on — the cut-off
        // ids plus every auxiliary that stayed silent with nothing published
        // for this content. Absent when the touch speaks for every server.
        // This is the join key for the issue's observability contract: a
        // `silent` row in `lsp_aux_wait_outcome` must appear here, on a touch
        // whose `confirmation` is `"partial"`.
        ...(auxUnconfirmedServerIds !== undefined && {
          auxUnconfirmedServerIds,
        }),
        // #1459: scanners this touch does not speak for because their breaker
        // was open, or because the resync gate deferred their write. Separate
        // fields because these two doors open BEFORE any wait, so neither can
        // appear in an `lsp_aux_wait_outcome` row on the sweep path. Absent
        // when every configured scanner got this content — #1586 included: a
        // deferred scanner already bound to these bytes is covered, so it is not
        // named here either. The gate's own action is recorded regardless, in
        // `lsp_notify_resync_deferred`.
        ...(brokenSkippedServerIds.length > 0 && { brokenSkippedServerIds }),
        ...(uncoveredDeferredServerIds.length > 0 && {
          deferredResyncServerIds: uncoveredDeferredServerIds,
        }),
        // #1549: auxiliaries whose own deadline lapsed — the wait produced no
        // publication, or the notify write never landed. Distinct from the fields
        // above (a different door) and from `auxUnconfirmedServerIds` (derived
        // from aux wait-outcome rows, which a non-collecting touch never emits).
        ...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
      },
    });
    return result;
  } finally {
    for (const key of leaseKeys) releaseClientLease(core, key);
  }
}
