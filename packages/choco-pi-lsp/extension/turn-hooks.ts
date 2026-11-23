import { adoptProjectTrustFromPorts } from "../clients/project-trust.ts";
import { readExtensionMode } from "../clients/extension-mode.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { exportWidgetState } from "../clients/widget-state.ts";
import { saveSessionState } from "../clients/session-state-store.ts";
import { resetFormatService } from "../clients/format-service.ts";
import { recordCrossProcessTouches } from "../clients/agent-nudge.ts";
import { readCrossProcessTouchesForTurnStart } from "../clients/recent-touches.ts";
import { resetLSPService } from "../clients/lsp/index.ts";
import { buildMemorySample, shouldEmitMemorySample } from "../clients/memory-sampler.ts";
import {
  checkSmellsAndNoteOnce,
  countRecentSmells,
  shouldCheckSmellsThisTurn,
} from "../clients/smells-rollup.ts";
import {
  clearLastAnalyzedStateCache,
  flushDebouncedToolResults,
} from "../clients/runtime-tool-result.ts";
import { handleTurnEnd } from "../clients/runtime-turn.ts";
import { setAmbientAbortSignal } from "../clients/safe-spawn.ts";
import {
  getLastLoggedPhase,
  getRecentLoggedPhases,
  logLatency,
} from "../clients/latency-logger.ts";
import { emitBounded } from "../clients/bounded-telemetry.ts";
import {
  getEventLoopStats,
  resetEventLoopMonitor,
  shouldLogLoopBlock,
  shouldLogWorstBlock,
} from "../clients/event-loop-monitor.ts";
import type { ExtensionActivation } from "./activation.ts";
import { processState } from "./process-state.ts";
import { dbg, getStableSessionId, notifyUi } from "./shared.ts";

const LOOP_BLOCK_IDENTITY = "<choco-pi-lsp>";

export function registerTurnHooks(activation: ExtensionActivation): void {
  const {
    pi,
    hostPorts,
    runtime,
    contextInjectionHistory,
    cacheManager,
    activationState,
    getLensFlag,
    rememberOwnEventCtx,
    updateLspStatus,
    captureLspStatusRepaint,
    mountLensWidget,
  } = activation;
  pi.on("turn_start", (_event: any, ctx) => {
    rememberOwnEventCtx(ctx);
    adoptProjectTrustFromPorts(hostPorts);
    if (
      activationState.lensWidgetVisible &&
      ctx?.ui &&
      (activationState.mountedLensWidgetUi === undefined ||
        activationState.mountedLensWidgetUi !== ctx.ui)
    ) {
      mountLensWidget(ctx.ui, readExtensionMode(ctx));
    }
    runtime.beginTurn();
    clearLastAnalyzedStateCache();

    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    void readCrossProcessTouchesForTurnStart({ cwd })
      .then((entries) => {
        if (entries.length === 0) return;
        recordCrossProcessTouches(entries.map((e) => ({ path: e.path, reason: e.reason })));
        dbg(`turn_start: cross-process nudge — ${entries.length} file(s) from other instance(s)`);
      })
      .catch((err) => {
        dbg(`turn_start: cross-process nudge read failed: ${err}`);
      });
  });

  pi.on("agent_end", async (_event, ctx) => {
    contextInjectionHistory.clear(getStableSessionId(ctx));
    if (!activationState.lensEnabled) return;
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
    try {
      await flushDebouncedToolResults();
      if (ctx.ui) updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
    } catch (agentEndErr) {
      dbg(`agent_end crashed: ${agentEndErr}`);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      dbg(`agent_end crash stack: ${(agentEndErr as Error).stack}`);
    } finally {
      setAmbientAbortSignal(undefined);
    }
  });

  pi.on("turn_end", async (_event: any, ctx) => {
    if (!activationState.lensEnabled) return;
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
    try {
      const repaintLspStatus = captureLspStatusRepaint(ctx);
      const elStats = getEventLoopStats();
      const loopMaxMs = elStats?.maxMs ?? 0;
      const suspectSystemStall = elStats?.suspectSystemStall ?? false;
      if (shouldLogLoopBlock(loopMaxMs)) {
        const lastPhase = getLastLoggedPhase();
        const recentPhases = getRecentLoggedPhases(3);
        const isNewSessionWorst = shouldLogWorstBlock(
          loopMaxMs,
          processState.lastLoggedLoopWorstMs,
        );
        emitBounded("loop_block", LOOP_BLOCK_IDENTITY, {
          type: "phase",
          durationMs: Math.round(loopMaxMs),
          metadata: {
            worstSoFar: isNewSessionWorst,
            turnIndex: runtime.turnIndex,
            suspectSystemStall,
            windowCpuMs: elStats?.windowCpuMs,
            windowWallMs: elStats?.windowWallMs,
            lastPhase: lastPhase?.phase,
            lastPhaseAt: lastPhase?.ts,
            recentPhases,
          },
        });
        if (suspectSystemStall) {
          processState.sessionSuspectedStalls += 1;
        } else if (isNewSessionWorst) {
          processState.lastLoggedLoopWorstMs = loopMaxMs;
          processState.sessionWorstRealBlockMs = Math.max(
            processState.sessionWorstRealBlockMs,
            loopMaxMs,
          );
        }
      }
      resetEventLoopMonitor();

      if (shouldEmitMemorySample(runtime.turnIndex)) {
        try {
          const sample = buildMemorySample(runtime.wordIndex);
          logLatency({
            type: "phase",
            filePath: "<choco-pi-lsp>",
            phase: "memory_sample",
            durationMs: 0,
            // SAFETY: buildMemorySample produces the latency logger's recursively serializable metadata values.
            metadata: { turnIndex: runtime.turnIndex, ...sample } as Parameters<
              typeof logLatency
            >[0]["metadata"],
          });
        } catch {}
      }

      if (shouldCheckSmellsThisTurn(runtime.turnIndex)) {
        try {
          for (const note of checkSmellsAndNoteOnce(
            countRecentSmells(undefined, runtime.sessionStartedAt),
          )) {
            notifyUi(ctx, note, "warning");
          }
        } catch {}
      }

      await flushDebouncedToolResults();
      const { testRunnerClient } = await loadBootstrapClients();
      await handleTurnEnd({
        ctxCwd: ctx.cwd,
        getFlag: (name: string) => getLensFlag(name),
        dbg,
        runtime,
        cacheManager,
        testRunnerClient,
        resetLSPService: () => {
          try {
            resetLSPService({ reason: "idle" });
          } finally {
            repaintLspStatus?.();
          }
        },
        resetFormatService,
      });
      repaintLspStatus?.();

      if (runtime.hasStableSessionId) {
        void saveSessionState(
          ctx.cwd ?? process.cwd(),
          runtime.telemetrySessionId,
          exportWidgetState(),
          runtime.readGuard.exportState(),
        );
      }
    } catch (turnEndErr) {
      dbg(`turn_end crashed: ${turnEndErr}`);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
    } finally {
      setAmbientAbortSignal(undefined);
    }
  });
}
