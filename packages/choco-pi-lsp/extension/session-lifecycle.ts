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
  pi.on("resources_discover", async (_event, _ctx) => {
    const skillsDir = resolvePackagePath(import.meta.url, "skills");

    return {
      skillPaths: [skillsDir],
    };
  });

  pi.on("session_start", async (event, ctx) => {
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

      const trustState = adoptProjectTrustFromPorts(hostPorts);
      if (trustState !== "unknown") {
        dbg(`session_start: project trust = ${trustState}`);
      }
      if (trustState === "untrusted") {
        dbg(
          "session_start: untrusted project — tool auto-install and LSP spawns are disabled for this session",
        );
      }

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

      await configureWarmAttach(ctx.cwd ?? process.cwd());
      void registerInstance(ctx.cwd ?? process.cwd()).catch(() => {});
      void readInstanceRegistry()
        .then((registry) => logVanishedInstances(registry))
        .catch(() => {})
        .finally(() => {
          void sweepOrphans();
        });
      void sweepUntrackedOrphans();
      void checkCrossProcessLspBudget();
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

      runtime.setSessionLifecycle({
        sessionId: stableSessionId,
        reason: sessionReason,
      });

      const reasonLabel = sessionReason ?? "startup";
      const startMode = sessionStartMode(sessionReason, !!activationState.pendingForkSnapshot);
      if (startMode === "fork" && activationState.pendingForkSnapshot) {
        clearWidgetState();
        importWidgetState(activationState.pendingForkSnapshot);
        const forkedFileCount = activationState.pendingForkSnapshot.files.length;
        activationState.pendingForkSnapshot = undefined;
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
        activationState.pendingForkSnapshot = undefined;
        activationState.pendingForkReadGuard = undefined;
        clearWidgetState();
        if (stableSessionId) {
          const persisted = await loadSessionState(ctx.cwd ?? process.cwd(), stableSessionId);
          if (persisted?.widget) {
            const fresh = await dropStaleFiles(persisted.widget, persisted.savedAt);
            const dropped = persisted.widget.files.length - fresh.files.length;
            importWidgetState(fresh);
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

  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on("session_before_fork", () => {
    try {
      activationState.pendingForkSnapshot = exportWidgetState();
      activationState.pendingForkReadGuard = runtime.readGuard.exportState();
      dbg(
        `session_before_fork: stashed ${activationState.pendingForkSnapshot.files.length} file(s) + ${activationState.pendingForkReadGuard.reads.length} read-guard file(s) for the fork`,
      );
    } catch (forkErr) {
      dbg(`session_before_fork crashed: ${forkErr}`);
    }
  });
}

export function registerSessionShutdown(activation: ExtensionActivation): void {
  const { pi, runtime, contextInjectionHistory } = activation;
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on("session_shutdown", (_event: RuntimeValue, ctx: RuntimeValue) => {
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

    clearCachePrefixSession(stableSessionId);

    cancelLSPIdleReset();
    deregisterInstance();
    resetLSPService({
      fast: true,
      processExiting: true,
      reason: "session_shutdown",
    });
    releaseIdleEvictionTimers();
    emitBusEventRollupAtSessionEnd(runtime.projectRoot);
    dumpActiveHandles("session_shutdown");
  });
}
