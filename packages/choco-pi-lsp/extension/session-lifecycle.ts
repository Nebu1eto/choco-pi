/**
 * Session lifecycle hooks: resources_discover, session_start, session_before_fork, session_shutdown.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

import type { RuntimeValue } from "../tools/runtime-values.ts";
import { logExtension } from "../clients/extension-log.ts";
import { adoptProjectTrustFromPorts } from "../clients/project-trust.ts";
import { readExtensionMode } from "../clients/extension-mode.ts";
import {
  releaseIdleEvictionTimers,
  resumeIdleEvictionTimers,
} from "../clients/idle-timer-release.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { resolvePackagePath } from "../clients/package-root.ts";
import { clearWidgetState, exportWidgetState, importWidgetState } from "../clients/widget-state.ts";
import {
  dropStaleFiles,
  loadSessionState,
  saveSessionState,
  sessionStartMode,
} from "../clients/session-state-store.ts";
import { emitBusEventRollupAtSessionEnd } from "../clients/bus-events-logger.ts";
import { recordCrossProcessTouches } from "../clients/agent-nudge.ts";
import { readCrossProcessTouchesForSessionStart } from "../clients/recent-touches.ts";
import { resetLSPService } from "../clients/lsp/index.ts";
import { warmLspService } from "../clients/lsp-lazy.ts";
import { sweepOrphans, sweepUntrackedOrphans } from "../clients/instance-reaper.ts";
import {
  deregisterInstance,
  readInstanceRegistry,
  registerInstance,
} from "../clients/instance-registry.ts";
import { logVanishedInstances } from "../clients/vanished-instance-marker.ts";
import { dumpActiveHandles } from "../clients/debug-handles.ts";
import { configureWarmAttach } from "../clients/warm-attach.ts";
import { checkCrossProcessLspBudget } from "../clients/lsp-budget.ts";
import { handleSessionStart } from "../clients/runtime-session.ts";
import {
  decideSessionStart,
  decrementSecondarySessionCount,
  noteSessionShutdown,
} from "../clients/session-lifecycle.ts";
import { cancelLSPIdleReset } from "../clients/runtime-turn.ts";
import {
  isFreshSessionStart,
  planToolSet,
  recordToolSetMutation,
  supportsDeferredTools,
} from "../clients/tool-set-policy.ts";
import { clearCachePrefixSession } from "../clients/cache-observability.ts";
import { logConcurrentSessionBind } from "../clients/session-start-observability.ts";
import { warmFormatters } from "../clients/formatters-lazy.ts";
import type { ExtensionActivation } from "./activation.ts";
import {
  ensureLSPConfigInitialized,
  resetDispatchBaselines,
  warmDispatchAtSessionStart,
} from "./process-state.ts";
import { cleanStaleTsBuildInfo, dbg, getStableSessionId, log, notifyUi } from "./shared.ts";
import type { LazyToolRegistration } from "./tool-registrations.ts";

/** Register resources_discover, session_start, and session_before_fork. */
export function registerSessionStartHooks(
  activation: ExtensionActivation,
  lazyTools: LazyToolRegistration,
): void {
  const {
    pi,
    hostPorts,
    runtime,
    contextInjectionHistory,
    astGrepClient,
    cacheManager,
    activationState,
    getLensFlag,
    rememberOwnEventCtx,
    refreshCtxDerivedPlumbing,
    updateLspStatus,
    mountLensWidget,
    updateRuntimeIdentityFromCtx,
  } = activation;
  const { LAZY_TOOL_CATALOG, rememberedLazyTools } = lazyTools;
  // --- Register skills with pi ---
  pi.on("resources_discover", async (_event, _ctx) => {
    // Resolve skills relative to the package root (nearest package.json), not the
    // module's own directory — under the compiled dist/ layout (#182) the module
    // lives in dist/ but skills/ stays at the package root, so a module-relative
    // join lands on the non-existent dist/skills/ and skills silently fail to load
    // (#205). resolvePackagePath walks up to package.json, correct for both the
    // source (index.ts at root) and dist (dist/index.js) layouts.
    const skillsDir = resolvePackagePath(import.meta.url, "skills");

    return {
      skillPaths: [skillsDir],
    };
  });

  // --- Events ---

  pi.on("session_start", async (event, ctx) => {
    // A new session re-enables idle-eviction timers suspended by the previous
    // primary session_shutdown in this module graph.
    resumeIdleEvictionTimers();
    contextInjectionHistory.clear(getStableSessionId(ctx));
    warmDispatchAtSessionStart();
    void warmLspService().catch((err) =>
      logExtension({ subsystem: "lsp", level: "warn", message: `LSP warm failed: ${err}` }),
    );
    void warmFormatters().catch((err) =>
      logExtension({
        subsystem: "format",
        level: "warn",
        message: `formatter warm failed: ${err}`,
      }),
    );
    rememberOwnEventCtx(ctx);
    refreshCtxDerivedPlumbing();
    const sessionStartFiredAt = Date.now();
    try {
      dbg("session_start fired");
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      const sessionReason = (event as { reason?: string }).reason;

      // #1334 S5: adopt the HOST's project-trust decision before anything
      // below can auto-install a tool or spawn an LSP server. choco-pi-lsp is a
      // CONSUMER of trust (`ctx.isProjectTrusted()`), never a handler of the
      // `project_trust` event — answering that question on the user's behalf
      // is the host's/user's job. Re-read here and on every turn_start because
      // fork/reload/resume can change cwd and trust can change mid-session.
      // Feature-detected:
      // a host without the accessor yields "unknown" and nothing is gated.
      const trustState = adoptProjectTrustFromPorts(hostPorts);
      if (trustState !== "unknown") {
        dbg(`session_start: project trust = ${trustState}`);
      }
      if (trustState === "untrusted") {
        dbg(
          "session_start: untrusted project — tool auto-install and LSP spawns are disabled for this session",
        );
      }

      // #190: pi's session lifecycle. `reason` distinguishes new/resume/fork/
      // reload/startup; the STABLE session id comes from the session manager
      // (the event carries none), and is what lets a resumed session rehydrate.
      const stableSessionId = (() => {
        try {
          // SAFETY: Pi session-start contexts provide a signature-compatible sessionManager accessor when present.
          return (
            ctx as { sessionManager?: { getSessionId?: () => string } }
          )?.sessionManager?.getSessionId?.();
        } catch {
          return undefined;
        }
      })();

      // #473: distinguish a concurrently-live in-process subagent bind
      // (tintinweb/pi-subagents-style) from a real sequential session
      // replacement BEFORE touching any process-shared singleton. A
      // concurrent secondary must not run handleSessionStart (which resets
      // the shared LSP fleet + runtime generation out from under the still
      // -live parent) or updateRuntimeIdentityFromCtx (which would
      // overwrite the parent's telemetry identity).
      const sessionStartDecision = decideSessionStart(ctx, stableSessionId);
      if (!sessionStartDecision.runFullSessionStart) {
        dbg(
          `session_start: concurrent secondary detected (count=${sessionStartDecision.secondaryCount}) — skipping handleSessionStart`,
        );
        logConcurrentSessionBind({
          secondaryCount: sessionStartDecision.secondaryCount,
          sessionReason,
          // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
          sameCwd: (ctx as { cwd?: string })?.cwd === process.cwd(),
        });
        return;
      }

      // Dynamic tooling (#pi 0.80.x+): put the active tool set back to the
      // posture this logical conversation had — the always-active baseline
      // plus exactly the lazy tools (LAZY_TOOL_CATALOG) the model activated
      // via lsp_activate_tools. session_start is the correct lifecycle
      // point for this call (#643; see the comment left at the old call site
      // above, right after tool registration, for why it can never succeed
      // there).
      //
      // #1453: this RESTORES, it does not merely shrink. Every session_start
      // reason arrives with all registered choco-pi-lsp tools active, because the
      // host builds a fresh AgentSession with `includeAllExtensionTools: true`
      // on fork/reload/resume just as it does on startup, and never persists
      // an active-tool set per session. Skipping the call on those reasons
      // would therefore leave every lazy tool active forever AND change the
      // advertised tool list relative to the parent's cached prompt prefix.
      // Rebuilding the same set instead keeps the prefix identical and
      // genuinely preserves the model's activations, because choco-pi-lsp's own
      // closure state (`rememberedLazyTools`) survives the rebuild.
      //
      // Deliberately BELOW the #473 concurrent-secondary guard: the active
      // tool set is shared runtime state (one loader per process), so a
      // secondary's session_start must never rewrite the still-live
      // primary's set — last writer would win.
      //
      // Feature-detected the same way as elsewhere in this handler:
      // `pi.getActiveTools`/`setActiveTools` aren't guaranteed present on
      // every host the broad `@earendil-works/pi-coding-agent` peer
      // dependency allows, so probe with typeof rather than assuming the
      // pinned devDependency version's API exists at runtime.
      //
      // The lazy tools register inactive (`defaultActive: false` in
      // registration-manifest.json), so `--no-lazy-tools` activates them here.
      try {
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        const piWithActiveTools = pi as {
          getActiveTools?: () => string[];
          setActiveTools?: (names: string[]) => void;
        };
        const getActiveTools = piWithActiveTools.getActiveTools;
        const setActiveTools = piWithActiveTools.setActiveTools;
        const lazyNames = LAZY_TOOL_CATALOG.map((t) => t.name);
        if (getActiveTools && setActiveTools && getLensFlag("no-lazy-tools") === true) {
          const active = getActiveTools();
          const missing = lazyNames.filter((name) => !active.includes(name));
          if (missing.length > 0) setActiveTools([...active, ...missing]);
        } else if (getActiveTools && setActiveTools) {
          // A fresh conversation starts with no activation memory; a
          // rebuild inherits the parent's.
          if (isFreshSessionStart(sessionReason)) rememberedLazyTools.clear();
          const plan = planToolSet(getActiveTools(), new Set(lazyNames), rememberedLazyTools);
          if (plan.changed) {
            setActiveTools(plan.desired);
            recordToolSetMutation({
              addedCount: plan.addedCount,
              removedCount: plan.removedCount,
              reason: isFreshSessionStart(sessionReason)
                ? "fresh_session_lazy_deactivation"
                : "session_rebuild_restore",
              deferralApplies: supportsDeferredTools(
                // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
                (ctx as { model?: Parameters<typeof supportsDeferredTools>[0] })?.model,
              ),
            });
          }
        }
      } catch (toolSetErr) {
        dbg(
          `dynamic tool set restore failed (older pi host lacking getActiveTools/setActiveTools, or a genuine host error): ${toolSetErr}`,
        );
      }

      // #449 slice 1 / #472: register this process in the cross-process
      // instance registry and fire-and-forget an orphan-LSP sweep. Below the
      // #473 guard deliberately: a concurrent secondary neither re-registers
      // (the pid's entry already exists) nor re-sweeps (a fan-out would run
      // up to maxConcurrent redundant sweeps). Neither call is awaited —
      // registry I/O and the reaper must never delay session start; both are
      // internally best-effort (never throw).
      await configureWarmAttach(ctx.cwd ?? process.cwd());
      void registerInstance(ctx.cwd ?? process.cwd()).catch(() => {
        // best-effort observability — never fail session_start over this
      });
      // #1123 item 2: log a sessionstart.log marker for any registry entry
      // whose owning pid is confirmed dead — this instance vanished without
      // reaching deregisterInstance()'s clean-shutdown removal. MUST read the
      // registry and log BEFORE sweepOrphans (below) prunes exactly these same
      // dead-pid entries out from under it, or the vanished set would already
      // be empty by the time this runs — hence the explicit read here rather
      // than letting sweepOrphans's own internal read race it.
      void readInstanceRegistry()
        .then((registry) => logVanishedInstances(registry))
        .catch(() => {
          // best-effort observability — never fail session_start over this
        })
        .finally(() => {
          void sweepOrphans();
        });
      // #658: registry-INDEPENDENT backstop sweep, running alongside the
      // registry-driven one above. `sweepOrphans` can only ever see pids
      // still listed in some instance's `lspChildren[]`; once that trace is
      // lost (stale-heartbeat entry removal, or a silently-failed
      // `killPidTree`), the child becomes permanently invisible to it. This
      // backstop instead scans the OS process table directly for known
      // choco-pi-lsp-managed binary names and only acts on ones that are BOTH
      // untracked by the current registry snapshot AND have a
      // confirmed-dead parent — never on name alone. Fire-and-forget, same
      // non-blocking/never-throws contract as `sweepOrphans`.
      void sweepUntrackedOrphans();
      // #449 slice 2 (prototype): machine-wide LSP budget check. Reads the
      // same registry, decides locally whether THIS session should skip
      // spawning auxiliary LSP servers, and caches the decision for
      // clients/dispatch/auxiliary-lsp.ts to read on later dispatch calls.
      // Never awaited — a registry read must not delay session start, and
      // dispatch doesn't happen until later in the turn anyway, so the cache
      // is populated well before it's first read in practice.
      void checkCrossProcessLspBudget();
      // #492: child-at-session_start cross-process nudge consumer. Reads
      // `recent-touches.json` (clients/recent-touches.ts) for entries from
      // OTHER choco-pi-lsp instances (pid-excluded) within the 15-minute
      // freshness window whose file still exists, and feeds them into the
      // same #485 accumulator a bus event would use — the first `context`
      // call this session makes (clients/agent-nudge.ts, wired below) then
      // injects one batched provenance message. This is the "child blind to
      // parent" direction from #492: a subagent asked to `git status` right
      // after spawn otherwise sees unexplained `M` files with no
      // explanation. Never awaited-to-block session_start; internally
      // best-effort (recent-touches.ts never throws).
      void readCrossProcessTouchesForSessionStart({
        cwd: ctx.cwd ?? process.cwd(),
      })
        .then((entries) => {
          if (entries.length === 0) return;
          recordCrossProcessTouches(entries.map((e) => ({ path: e.path, reason: e.reason })));
          dbg(
            `session_start: cross-process nudge — ${entries.length} file(s) from other instance(s)`,
          );
        })
        .catch((err) => {
          dbg(`session_start: cross-process nudge read failed: ${err}`);
        });
      updateRuntimeIdentityFromCtx(ctx);
      try {
        await ensureLSPConfigInitialized(ctx.cwd ?? process.cwd());
      } catch (cfgErr) {
        dbg(`lsp config init failed: ${cfgErr}`);
      }

      const bootstrapClientsStartedAt = Date.now();
      const {
        metricsClient,
        todoScanner,
        biomeClient,
        ruffClient,
        opengrepClient,
        testRunnerClient,
        goClient,
        rustClient,
      } = await loadBootstrapClients();
      const bootstrapClientsDurationMs = Date.now() - bootstrapClientsStartedAt;
      const handlerEnteredAt = Date.now();
      await handleSessionStart({
        ctxCwd: ctx.cwd,
        sessionStartFiredAt,
        sessionReason,
        handlerEnteredAt,
        bootstrapClientsStartedAt,
        bootstrapClientsDurationMs,
        getFlag: (name: string) => getLensFlag(name),
        notify: (msg, level) => notifyUi(ctx, msg, level),
        dbg,
        log,
        runtime,
        metricsClient,
        cacheManager,
        todoScanner,
        astGrepClient,
        biomeClient,
        ruffClient,
        opengrepClient,
        testRunnerClient,
        goClient,
        rustClient,
        ensureTool: async (name: string) =>
          (await import("../clients/installer/index.ts")).ensureTool(name),
        cleanStaleTsBuildInfo,
        resetDispatchBaselines,
        resetLSPService,
      });
      if (ctx.ui) updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);

      // Pin the stable identity + reason AFTER handleSessionStart (which ran
      // resetForSession → a fresh random id); the stable id now wins (#190).
      runtime.setSessionLifecycle({
        sessionId: stableSessionId,
        reason: sessionReason,
      });

      // Lifecycle-aware widget state (#190). The "should I rehydrate" signal is
      // NOT the reason — it's whether a persisted snapshot exists for this
      // STABLE session id. A `pi --session <id>` launch fires reason="startup"
      // (not "resume" — that's only an in-process switchSession), so gating on
      // "resume" alone missed the common resume path. So: fork branches from
      // the in-memory stash; reload keeps state; new starts clean; everything
      // else (resume / startup / default) rehydrates IFF a snapshot exists —
      // a brand-new session has a fresh id with no file (→ clean), a
      // resumed/launched one has its prior file (→ rehydrate).
      const reasonLabel = sessionReason ?? "startup";
      const startMode = sessionStartMode(sessionReason, !!activationState.pendingForkSnapshot);
      if (startMode === "fork" && activationState.pendingForkSnapshot) {
        // Branch the forked session from the source's in-memory snapshot, then
        // persist it under the new session id so the fork owns its own copy.
        clearWidgetState();
        importWidgetState(activationState.pendingForkSnapshot);
        const forkedFileCount = activationState.pendingForkSnapshot.files.length;
        activationState.pendingForkSnapshot = undefined;
        // #1041: adopt the source session's read history (staleness-reconciled
        // against current disk) so the fork isn't zero-read-blocked on files
        // the parent already read.
        let forkReadImport: { imported: number; dropped: number } | undefined;
        if (activationState.pendingForkReadGuard) {
          forkReadImport = runtime.readGuard.importState(activationState.pendingForkReadGuard);
          activationState.pendingForkReadGuard = undefined;
        }
        if (stableSessionId) {
          void saveSessionState(
            ctx.cwd ?? process.cwd(),
            stableSessionId,
            exportWidgetState(),
            runtime.readGuard.exportState(),
          );
        }
        dbg(
          `session_start: fork — branched ${forkedFileCount} file(s) from source` +
            (forkReadImport
              ? `, read-guard +${forkReadImport.imported} (dropped ${forkReadImport.dropped})`
              : ""),
        );
      } else if (startMode === "keep") {
        dbg("session_start: reload — keeping widget state");
      } else if (startMode === "clean") {
        activationState.pendingForkSnapshot = undefined;
        activationState.pendingForkReadGuard = undefined;
        clearWidgetState();
        dbg("session_start: new — clean widget");
      } else {
        // maybe-rehydrate: covers resume AND startup (e.g. `pi --session <id>`)
        activationState.pendingForkSnapshot = undefined;
        activationState.pendingForkReadGuard = undefined;
        clearWidgetState();
        if (stableSessionId) {
          const persisted = await loadSessionState(ctx.cwd ?? process.cwd(), stableSessionId);
          if (persisted?.widget) {
            // #180/#190: drop files changed on disk since the snapshot so a
            // resume never surfaces stale diagnostics; they re-scan on edit.
            const fresh = await dropStaleFiles(persisted.widget, persisted.savedAt);
            const dropped = persisted.widget.files.length - fresh.files.length;
            importWidgetState(fresh);
            // #1041: rehydrate the read-before-edit guard's read-set on the
            // SAME path so the first post-resume edit of a previously-read
            // file isn't falsely zero-read-blocked. importState reconciles
            // each read against current disk (drops changed/missing files),
            // so a resume never masks a real staleness.
            const readImport = runtime.readGuard.importState(persisted.readGuard);
            dbg(
              `session_start: ${reasonLabel} ${stableSessionId} — rehydrated ${fresh.files.length} file(s)` +
                (dropped > 0 ? `, dropped ${dropped} stale` : "") +
                (readImport.imported > 0 || readImport.dropped > 0
                  ? `; read-guard +${readImport.imported} read(s) (dropped ${readImport.dropped} stale)`
                  : ""),
            );
          } else {
            dbg(`session_start: ${reasonLabel} ${stableSessionId} — no persisted state (clean)`);
          }
        } else {
          dbg(`session_start: ${reasonLabel} — no stable session id (clean)`);
        }
      }

      if (activationState.lensWidgetVisible) {
        mountLensWidget(ctx.ui, readExtensionMode(ctx));
      }
    } catch (sessionErr) {
      dbg(`session_start crashed: ${sessionErr}`);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
    }
  });

  // #190 Phase 2: capture the source session's diagnostics just before a fork,
  // so the forked session (its `session_start` fires with reason="fork") can
  // branch from them instead of starting empty. In-memory hand-off within the
  // same process; cleared once adopted (or on any non-fork start).
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on("session_before_fork", () => {
    try {
      activationState.pendingForkSnapshot = exportWidgetState();
      // #1041: the source guard is still live here (reset happens in the
      // fork's own session_start, which fires later), so this captures the
      // parent's read-set for the fork to adopt.
      activationState.pendingForkReadGuard = runtime.readGuard.exportState();
      dbg(
        `session_before_fork: stashed ${activationState.pendingForkSnapshot.files.length} file(s) + ${activationState.pendingForkReadGuard.reads.length} read-guard file(s) for the fork`,
      );
    } catch (forkErr) {
      dbg(`session_before_fork crashed: ${forkErr}`);
    }
  });
}

/** Register session_shutdown. */
export function registerSessionShutdown(activation: ExtensionActivation): void {
  const { pi, runtime, contextInjectionHistory } = activation;
  // --- Session shutdown: release all handles so subagent processes exit cleanly ---
  // The LSP idle-reset timer (240s) is unref'd but we cancel it explicitly here
  // so it does not fire after shutdown. resetLSPService shuts down any live clients.
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on("session_shutdown", (_event: RuntimeValue, ctx: RuntimeValue) => {
    // #473: a concurrently-live in-process subagent session shutting down
    // (its sibling primary — the real parent — still active) must NOT run
    // the shared-infra teardown below: no LSP fleet shutdown, no idle-timer
    // cancel that the parent still relies on. Only cheap/idempotent work
    // is safe before that guard. Clear only this owner's context replay first;
    // a secondary then skips the destructive shared-infra teardown below.
    const stableSessionId = (() => {
      try {
        // SAFETY: Pi session-shutdown contexts provide a signature-compatible sessionManager accessor when present.
        return (
          ctx as { sessionManager?: { getSessionId?: () => string } }
        )?.sessionManager?.getSessionId?.();
      } catch {
        return undefined;
      }
    })();
    contextInjectionHistory.clear(stableSessionId);
    const shutdownClassification = noteSessionShutdown(ctx, stableSessionId);
    if (shutdownClassification === "secondary") {
      decrementSecondarySessionCount();
      dbg("session_shutdown: concurrent secondary — skipping shared-infra teardown");
      return;
    }

    // #1654: no drain runs here — see the module comment above
    // `runDeferredMutationDrain` (review round 1, F2/F3/F4/F5) for why a
    // session_shutdown-based safety net was deliberately dropped rather
    // than kept.

    // #1018: drop this (primary) session's prefix baseline now it has ended,
    // so its entry is reclaimed promptly instead of lingering until the LRU
    // evicts it. Respects the #473 guard above (a concurrent-secondary
    // shutdown returned already, so its entry is left for the LRU backstop).
    clearCachePrefixSession(stableSessionId);

    cancelLSPIdleReset();
    // #449 slice 1: SYNC-only deregistration (no child spawns — see the
    // processExiting note below); safe to call unconditionally here.
    deregisterInstance();
    // processExiting: the loop is closing here — killing LSP servers must NOT
    // spawn taskkill, or libuv aborts on uv_async_send to the closing loop
    // (Assertion !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c) — seen
    // on `pi update`. Direct handle-kill only. Grandchildren behind a
    // shell/.cmd wrapper are NOT reaped by the OS (Windows does not kill
    // children when a parent dies) — they rely on stdin EOF, LSP
    // `initialize.processId` self-watchdog compliance, and the #449/#472
    // cross-process instance registry's orphan reaper as the backstop (#472).
    resetLSPService({
      fast: true,
      processExiting: true,
      reason: "session_shutdown",
    });
    // Clear this module graph's idle-eviction timer handles (entries stay
    // warm and re-arm on next use). Their callbacks would otherwise pin a
    // shut-down graph — e.g. one re-evaluated for an in-process session with
    // another cwd — for the full 20-30 minute idle window.
    releaseIdleEvictionTimers();
    // S2d (gap 5, #1432 review): one session_end_bus_rollup row per event
    // name with any activity this session — same primary-only placement as
    // the shared-infra teardown above (a concurrent secondary already
    // returned before reaching here), since the rollup counters are
    // process-wide module state a live secondary would still need.
    emitBusEventRollupAtSessionEnd(runtime.projectRoot);
    // #1123 item 4: dump active handles AFTER teardown — whatever is still
    // alive at this point is exactly what would keep a --print/--no-session
    // process from exiting (the #1097 lesson: what survives IS the leak).
    // No-op unless CHOCO_PI_LSP_DEBUG_HANDLES=1.
    dumpActiveHandles("session_shutdown");
  });
}
