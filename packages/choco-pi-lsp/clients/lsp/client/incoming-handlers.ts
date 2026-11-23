/**
 * Server-to-client request and notification handlers, and connection lifecycle wiring.
 */
import { pathToFileURL } from "node:url";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import { isBooleanValue } from "../schema-guards.ts";
import { incrementDegradationCount } from "../../degradation-ledger.ts";
import { logExtension } from "../../extension-log.ts";
import { logLatency } from "../../latency-logger.ts";
import { type LspMutationContext, newLspMutationCorrelationId } from "../../lsp-mutation.ts";
import { applyWorkspaceEdit } from "../edits.ts";
import { normalizeMapKey, uriToPath } from "../../path-utils.ts";
import { getStrategy } from "../wait-policy/index.ts";
import {
  clearAllWorkspaceDiagnosticsCaches,
  clearWorkspaceDiagnosticsCache,
} from "../workspace-diagnostics-cache.ts";
import { applyDynamicCapabilities, resolveConfigurationSection } from "./capabilities.ts";
import { REFRESH_REPULL_CONCURRENCY, mapWithConcurrency } from "./constants.ts";
import {
  bumpDiagnosticsVersion,
  clearDiagnosticsForPath,
  normalizeLspDiagnostics,
  retirePullSource,
} from "./diagnostics-store.ts";
import { disposeClientConnection } from "./process.ts";
import { clientRequestPullDiagnostics } from "./pull-diagnostics.ts";
import {
  PUB_DEBUG,
  isDynamicRegistrationParams,
  parseWorkspaceEditPayload,
  type JsonObject,
  type MutableDynamicRegistration,
} from "./schemas.ts";
import type { LSPClientState, LSPDiagnostic } from "./types.ts";

// Exported (only) so tests can invoke the publishDiagnostics notification
// handler directly against a mock LSPClientState/connection without spawning
// a real language server. Not part of the public client API surface.
export function setupIncomingHandlers(
  state: LSPClientState,
  initialization: JsonObject | undefined,
): void {
  state.connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics?: LSPDiagnostic[]; version?: number }) => {
      // #1639: the settle operation's own clock for THIS publish. A
      // "quiet-window" settle's durationMs below measures from here (when
      // this publish arrived and — armed or re-armed — the debounce timer)
      // to when that timer actually fires, i.e. the real debounce wait, not
      // time-since-didOpen.
      const publishReceivedAt = Date.now();
      const filePath = uriToPath(params.uri);
      const normalizedPath = normalizeMapKey(filePath);
      // A server can flush a queued publish after didClose during teardown.
      // Do not resurrect diagnostics or their content binding for a document
      // that is no longer open on this client.
      if (state.closedDocuments?.has(normalizedPath)) return;
      const newDiags = normalizeLspDiagnostics(params.diagnostics || []);
      const docVersion = params.version;
      if (PUB_DEBUG) {
        // #1333: PUB_DEBUG gate preserved; sink is extension.log.
        logExtension({
          subsystem: "lsp-pub",
          level: "debug",
          message: `server=${state.serverId} pubVersion=${docVersion} docVersion=${state.documentVersions?.get(normalizedPath)} diags=${newDiags.length}`,
        });
      }
      const strategy = getStrategy(state.serverId, state.launchVariant);
      // Publication counting and code extraction exist only for the
      // TypeScript diagnostic-sequence telemetry; skip the bookkeeping for
      // every other push server on this hot receive path.
      const isTypeScriptTelemetry = state.serverId === "typescript";
      const publicationIndex = isTypeScriptTelemetry
        ? (state.diagnosticPublicationCounts.get(normalizedPath) ?? 0) + 1
        : 0;
      if (isTypeScriptTelemetry) {
        state.diagnosticPublicationCounts.set(normalizedPath, publicationIndex);
      }
      const diagnosticCodes = isTypeScriptTelemetry
        ? [
            ...new Set(
              newDiags
                .map((diagnostic) => diagnostic.code)
                .filter((code): code is string | number => code !== undefined)
                .map(String),
            ),
          ].slice(0, 8)
        : [];
      // #1639: `durationMs` measures the settle operation, never
      // time-since-didOpen — document age keeps its own honest name in
      // `metadata.elapsedSinceDidOpenMs`, exactly like the pull-path
      // producer above. Before this fix EVERY call (settled or not) logged
      // the doc-age value as durationMs, which is what actually produced
      // the issue's cited evidence: this push-path producer, not the pull
      // path, emitted all 239 records (147 of them >60s "durations" for
      // settles that took milliseconds; a 61ms same-file pair is this
      // function's OWN unsettled-then-settled shape — the
      // `logSequence(false)` raw-receipt record immediately followed by
      // the `logSequence(true, ...)` settle record for the same publish).
      // - "first-push": settles immediately — the seed-first-push strategy
      //   bypasses the debounce timer entirely, so there is no wait to
      //   measure; durationMs is 0.
      // - "quiet-window": the real debounce wait, timed from THIS publish's
      //   own receipt (a later publish that re-arms the timer captures its
      //   OWN `publishReceivedAt`, so a re-armed wait is timed from the
      //   push that actually won the debounce, not the first one that lost
      //   it).
      // - "publication": a raw per-publication receipt, never itself a
      //   settle — durationMs is 0 and `settledReturn` stays false. This
      //   is the record that used to log with NO settleSource at all;
      //   giving it one closes AC3 (distinguish, don't silently overload,
      //   the phase's two shapes) for the pairs that actually occur.
      const logSequence = (
        settledReturn: boolean,
        settleSource: "first-push" | "quiet-window" | "publication",
        durationMs: number,
      ): void => {
        if (state.serverId !== "typescript") return;
        const elapsedSinceDidOpenMs = Math.max(
          0,
          Date.now() - (state.documentOpenedAt.get(normalizedPath) ?? Date.now()),
        );
        logLatency({
          type: "phase",
          phase: "lsp_typescript_diagnostic_sequence",
          filePath: normalizedPath,
          durationMs,
          metadata: {
            launchVariant: state.launchVariant ?? "unknown",
            publicationIndex,
            version: docVersion ?? "push-unversioned",
            diagnosticCount: newDiags.length,
            diagnosticCodes,
            elapsedSinceDidOpenMs,
            settledReturn,
            settleSource,
          },
        });
      };
      // Record the document version these diagnostics were computed against
      // (when the server reports it) so waitForDiagnostics can reject results
      // that lag behind the latest didChange instead of serving them as fresh.
      const recordDocVersion = (): void => {
        if (docVersion !== undefined) {
          state.diagnosticDocVersions.set(normalizedPath, docVersion);
        }
        recordBinding();
      };
      // #1095: bind the just-stored diagnostics to the content they were
      // computed against. Only when the server reported a version AND we still
      // hold the sent-content fingerprint for exactly that version — otherwise
      // no contentHash is recorded, so the binding reads "unknown" and a
      // version-less server behaves exactly as before. Runs at the same
      // write-time moment as `pushDiagnostics.set` (superseded pushes are
      // dropped before this via `isSupersededPush`, so a binding never lags the
      // latest sent version).
      const recordBinding = (): void => {
        if (docVersion === undefined) {
          state.diagnosticBindings.delete(normalizedPath);
          return;
        }
        const sent = state.documentContentHashes.get(normalizedPath);
        state.diagnosticBindings.set(normalizedPath, {
          version: docVersion,
          contentHash: sent && sent.version === docVersion ? sent.hash : undefined,
        });
      };

      // Late/superseded-push guard: if the server stamped this push with a
      // version and that version already lags the latest didChange we sent,
      // this is analysis for an edit that's since been overtaken — caching it
      // would let getDiagnostics()/getAllDiagnostics()/pruneDiagnostics() (none
      // of which consult isVersionStale — that check only gates the *wait*
      // helper below) serve stale results as current until the next genuinely
      // fresh push overwrites them. Drop it before it reaches the cache instead.
      // Checked at write time (not at notification-receipt time) so a push that
      // arrives fresh but whose debounce timer fires after a later didChange is
      // still caught. Version-less servers (docVersion undefined) are
      // unaffected — that's an intentional, separate tradeoff (see
      // isVersionStale below), not something this guard touches.
      //
      // Known, deliberately out-of-scope gaps: the pull-diagnostics path
      // (clientRequestPullDiagnostics/clientRequestWorkspaceDiagnostics) has no
      // version stamp to compare against in this codebase's current handling,
      // so nothing analogous is applied there. The other gap this note used to
      // record — `diagnosticsVersion` being a single global counter, so an
      // unrelated path's fresh push satisfied a wait for THIS path — is closed by
      // #1531: every bump also stamps `diagnosticsVersionsByPath`, and both the
      // `minVersion` freshness gate and the auxiliary answered/silent evidence
      // check read that per-path stamp.
      const isSupersededPush = (): boolean => {
        if (docVersion === undefined) return false;
        const currentVersion = state.documentVersions.get(normalizedPath);
        return currentVersion !== undefined && docVersion < currentVersion;
      };

      // Seed on first push for servers whose first push is known complete.
      // Bypasses the debounce timer entirely — resolves waiting promises immediately.
      if (strategy.seedFirstPush && !state.pushDiagnostics.has(normalizedPath)) {
        if (isSupersededPush()) return;
        state.pushDiagnostics.set(normalizedPath, newDiags);
        state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
        recordDocVersion();
        bumpDiagnosticsVersion(state, normalizedPath);
        state.diagnosticEmitter.emit("diagnostics", normalizedPath);
        // Immediate settle — no debounce wait to measure.
        logSequence(true, "first-push", 0);
        return;
      }
      // A raw per-publication receipt, not itself a settle.
      logSequence(false, "publication", 0);

      const existingTimer = state.pendingDiagnostics.get(normalizedPath);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        state.pendingDiagnostics.delete(normalizedPath);
        if (isSupersededPush()) return;
        state.pushDiagnostics.set(normalizedPath, newDiags);
        state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
        recordDocVersion();
        bumpDiagnosticsVersion(state, normalizedPath);
        state.diagnosticEmitter.emit("diagnostics", normalizedPath);
        // The real debounce wait, timed from THIS publish's own receipt.
        logSequence(true, "quiet-window", Date.now() - publishReceivedAt);
      }, strategy.debounceMs);

      state.pendingDiagnostics.set(normalizedPath, timer);
    },
  );

  state.connection.onRequest("workspace/workspaceFolders", () => [
    { name: "workspace", uri: pathToFileURL(state.root).href },
  ]);
  state.connection.onRequest("client/registerCapability", async (rawParams) => {
    if (!isDynamicRegistrationParams(rawParams)) return;
    for (const reg of rawParams.registrations ?? []) {
      const options = reg.registerOptions ?? undefined;
      const commands = Array.isArray(options?.commands)
        ? options.commands.filter((command): command is string => isRuntimeString(command))
        : undefined;
      const identifier = isRuntimeString(options?.identifier) ? options.identifier : undefined;
      const workspaceDiagnostics = isBooleanValue(options?.workspaceDiagnostics)
        ? options.workspaceDiagnostics
        : undefined;
      if (reg.id && reg.method) {
        // #1667: keep the whole registration, not just its method. An empty
        // `identifier` is treated as absent - it names no source, and
        // sending `identifier: ""` would be a second, indistinguishable
        // bare pull.
        const registration: MutableDynamicRegistration = { method: reg.method };
        if (identifier) registration.identifier = identifier;
        if (workspaceDiagnostics !== undefined) {
          registration.workspaceDiagnostics = workspaceDiagnostics;
        }
        if (commands) registration.commands = commands;
        state.dynamicRegistrations.set(reg.id, registration);
      }
      // executeCommand commands can arrive dynamically too — merge them
      // into the allowlist so dynamically-registered commands are runnable.
      if (reg.method === "workspace/executeCommand" && commands) {
        for (const cmd of commands) state.advertisedCommands.add(cmd);
      }
    }
    applyDynamicCapabilities(state);
  });
  state.connection.onRequest(
    "client/unregisterCapability",
    async (params: { unregisterations?: Array<{ id: string }> }) => {
      const retiredIdentifiers = new Set<string>();
      for (const unreg of params?.unregisterations ?? []) {
        if (!unreg.id) continue;
        const registration = state.dynamicRegistrations.get(unreg.id);
        state.dynamicRegistrations.delete(unreg.id);
        if (registration?.method === "textDocument/diagnostic" && registration.identifier) {
          retiredIdentifiers.add(registration.identifier);
        }
      }
      // #1667: a retired source's cached findings and resultId must go with
      // it, or the union keeps serving them. Checked after the deletes above,
      // and only when NO surviving registration still speaks for that
      // identifier.
      const stillRegistered = new Set(
        [...state.dynamicRegistrations.values()]
          .filter((r) => r.method === "textDocument/diagnostic")
          .map((r) => r.identifier),
      );
      for (const identifier of retiredIdentifiers) {
        if (!stillRegistered.has(identifier)) {
          retirePullSource(state, identifier);
        }
      }
      applyDynamicCapabilities(state);
    },
  );
  // Server-initiated edits (the mutation vector for executeCommand). Honored
  // ONLY while an explicit executeCommand is in flight (serverEditsAllowed > 0);
  // an unsolicited applyEdit outside that window is refused so a server can't
  // push edits to disk at will. Applied through the same applyWorkspaceEdit path
  // as every other edit.
  state.connection.onRequest(
    "workspace/applyEdit",
    async (params: {
      edit?: { changes?: unknown; documentChanges?: unknown };
    }): Promise<{ applied: boolean; failureReason?: string }> => {
      if (state.serverEditsAllowed <= 0 || !params?.edit) {
        return { applied: false, failureReason: "edit not solicited" };
      }
      const edit = parseWorkspaceEditPayload(params.edit);
      if (!edit) return { applied: false, failureReason: "malformed workspace edit" };
      const context =
        (state.activeMutationDepth ?? 0) === 1 ? state.activeMutationContext : undefined;
      const telemetryContext: LspMutationContext = context ?? {
        cwd: state.root,
        correlationId: newLspMutationCorrelationId(),
        tool: "lsp-workspace-applyEdit",
        source: "lsp-edit",
      };
      try {
        await applyWorkspaceEdit(edit, state.root, {
          positionEncoding: state.positionEncoding,
          documentVersions: state.documentVersions,
          mutationContext: telemetryContext,
        });
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          failureReason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  // #983: the LSP spec requires the response array to have exactly one entry
  // per requested item, each resolved against that item's `section` (a
  // dot-path into the server's config, e.g. "scan.jobs") — not a fixed
  // single-element array duplicating the whole blob for every item. An item
  // with no `section` gets the whole blob (that's what "no section" means
  // per spec); an unresolvable section gets `null`, never the whole blob.
  state.connection.onRequest(
    "workspace/configuration",
    async (params: { items?: Array<{ section?: string }> }) => {
      const items = params?.items ?? [];
      return items.map((item) => resolveConfigurationSection(initialization, item?.section));
    },
  );
  state.connection.onRequest("window/workDoneProgress/create", async () => {});
  // #1669: a server can send `workspace/diagnostic/refresh` (typically after a
  // project-wide config change) to say every pull result it has already
  // reported may be stale. Left unhandled, vscode-jsonrpc replies
  // MethodNotFound to a server explicitly telling us its results are stale —
  // this is exactly the signal `workspacePullResultCache` and the persisted
  // workspace-diagnostics cache want (the #1461 family, server-initiated for
  // once). Reply null per spec and drop both so the NEXT pull recomputes
  // instead of replaying — or inheriting an `unchanged` basis from — results
  // the server just told us to distrust.
  // #1669 review R1: single-flight coalescing latch for the re-pull pool
  // below, scoped to THIS client (one `setupIncomingHandlers` call per
  // connection). A refresh FLOOD — a watch-mode rebuild or a `git checkout`
  // can legitimately fire many `workspace/diagnostic/refresh` requests in a
  // tight burst — used to queue one independent capped pool PER refresh:
  // N refreshes meant N pools running concurrently (peak concurrency N x
  // the per-pool cap) and N full passes over every open document (N x
  // redundant pulls for the SAME documents). `refreshRepullRunning` gates a
  // SECOND pool from ever starting while one is already in flight;
  // `refreshRepullRerunRequested` remembers that at least one more refresh
  // arrived meanwhile and coalesces it into exactly ONE trailing rerun
  // after the current pool finishes, using a FRESH snapshot of open
  // documents at rerun time (not the stale list from whenever the burst
  // started) — so an arbitrarily large burst still costs at most 2 passes
  // and never more than `REFRESH_REPULL_CONCURRENCY` pulls at once.
  let refreshRepullRunning = false;
  let refreshRepullRerunRequested = false;

  const runRefreshRepullPool = async (): Promise<void> => {
    do {
      refreshRepullRerunRequested = false;
      const toRepull =
        state.workspaceDiagnosticsSupport.mode === "pull" ? [...state.openDocuments] : [];
      if (toRepull.length > 0) {
        try {
          await mapWithConcurrency(toRepull, REFRESH_REPULL_CONCURRENCY, async (normalizedPath) => {
            const uri = state.openDocumentUris?.get(normalizedPath);
            const filePath = uri ? uriToPath(uri) : normalizedPath;
            await clientRequestPullDiagnostics(state, filePath);
          });
        } catch (err) {
          // #1669 review N2: rejections are observed, never
          // `void`-swallowed — `clientRequestPullDiagnostics` itself never
          // throws (it returns an `unavailable` outcome), so this only
          // fires on a genuine programming error, but a silent throw
          // inside `mapWithConcurrency`'s `Promise.all` must not vanish.
          incrementDegradationCount({
            kind: "lsp-pull-unconfirmed",
            subject: state.serverId,
            reason: `refresh re-pull threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      // A refresh that arrived WHILE this pool was running gets exactly
      // one more pass, never a pass per refresh.
    } while (refreshRepullRerunRequested);
    refreshRepullRunning = false;
  };

  state.connection.onRequest("workspace/diagnostic/refresh", async () => {
    state.workspacePullResultCache.clear();
    // #1669 review F1: clear every on-disk sweep cache this process has
    // recorded a cwd for — `state.root` alone is a per-SERVER identity
    // marker that a monorepo/multi-root project routinely nests BELOW the
    // real sweep cwd, so clearing ONLY there would miss the cache file the
    // sweep actually reads/writes. See the doc comment on
    // `clearAllWorkspaceDiagnosticsCaches`.
    clearAllWorkspaceDiagnosticsCaches();
    // #1669 review N3: ALSO clear at `state.root` directly. The registry
    // above only knows cwds a sweep has already run under IN THIS PROCESS —
    // a refresh arriving before this project's first sweep this process
    // (e.g. right after a respawn) would otherwise clear nothing at all,
    // and a later sweep would load the untouched, now-genuinely-stale
    // on-disk cache a PRIOR process/session left behind. `state.root` is
    // the one cwd this handler can always reach regardless of registry
    // state — a cheap, durable backstop for the common single-root case
    // where root and sweep cwd coincide. It does NOT cover a monorepo
    // subproject a sweep hasn't reached yet under a DIFFERENT cwd than
    // `state.root` — that residual gap is tracked in #1707, not silently
    // claimed as solved (see `clearAllWorkspaceDiagnosticsCaches`'s doc
    // comment for the full shape).
    clearWorkspaceDiagnosticsCache(state.root);
    // #1669 review F3: a server-initiated "everything may be stale" signal
    // must drop the SAME per-document state a normal resync already drops
    // via `clearDiagnosticsForPath` (pullResultIds, pushDiagnostics,
    // documentPullDiagnostics, diagnosticBindings,
    // diagnosticsVersionsByPath, ...) — dropping only
    // `workspacePullResultCache` above left every open document's OTHER
    // pull state intact, so the next pull would echo a disowned
    // `previousResultId`, get back `kind: "unchanged"`, and re-confirm
    // stale diagnostics under a fresh timestamp; nothing would ever
    // re-pull on its own. This clear is cheap and always runs — every
    // refresh in a burst gets its own, unlike the re-pull pool below.
    for (const normalizedPath of state.openDocuments) {
      clearDiagnosticsForPath(state, normalizedPath);
    }
    // #1669 review N2: reply to the PROTOCOL request now — every clear
    // above is synchronous and already complete, so there is nothing left
    // this reply should wait on. The re-pull below is a background
    // improvement (so an open document reflects the refresh without
    // waiting on its next edit), never something worth delaying — or
    // risking — the required `null` reply over.
    if (state.workspaceDiagnosticsSupport.mode === "pull" && state.openDocuments.size > 0) {
      if (refreshRepullRunning) {
        // #1669 review R1: a pool is already in flight from an earlier
        // refresh in this burst — coalesce instead of starting a second
        // one.
        refreshRepullRerunRequested = true;
      } else {
        refreshRepullRunning = true;
        // `setImmediate` defers even the SYNCHRONOUS prefix of the pool
        // (URI lookups, map bookkeeping) to the next tick, so it can
        // never compete with this reply for the current one regardless
        // of how many documents are open.
        setImmediate(() => {
          void runRefreshRepullPool();
        });
      }
    }
    return null;
  });
}

/**
 * #1127: record the FIRST moment this client observed its own death. Detection
 * of a dead client (the next `getClientForFile` attach in index.ts) can happen
 * long after the process actually died — this timestamp is the only reliable
 * "when did it die" signal, so it must be set here, at the earliest death
 * signal, not derived later from detection time.
 */
function markExitedIfUnset(state: LSPClientState): void {
  if (state.exitedAt === undefined) {
    state.exitedAt = Date.now();
  }
}

export function setupConnectionLifecycle(
  state: LSPClientState,
  recentStderr: (lines?: number) => string,
): void {
  state.connection.onError(([error]: [Error, ...unknown[]]) => {
    state.lastError = error instanceof Error ? error : new Error(String(error));
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
  });

  state.connection.onClose(() => {
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
  });

  state.lspProcess.process.on("exit", (code, signal) => {
    // Gate on shutdownRequested (our own clientShutdown() call), not
    // isConnected: a genuine crash's connection.onClose/onError handler above
    // can fire and flip isConnected false BEFORE this 'exit' event arrives,
    // which used to make the old `wasConnected` check silently swallow every
    // crash whose transport died before the process itself reported exiting
    // (previously: 5 ast-grep deaths during a dogfooding sweep logged only
    // "respawn, uptime=Xms" — no exit code, no signal, no stderr — because
    // none of them tripped this log).
    const wasIntentional = state.shutdownRequested;
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
    if (!wasIntentional) {
      logLatency({
        type: "phase",
        phase: "lsp_server_unexpected_exit",
        filePath: state.root,
        durationMs: 0,
        metadata: {
          serverId: state.serverId,
          pid: state.lspProcess.pid,
          exitCode: code ?? null,
          exitSignal: signal ?? null,
          stderrTail: recentStderr(20),
        },
      });
    }
  });
}
