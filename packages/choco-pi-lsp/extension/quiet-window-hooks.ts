import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeFunction } from "../tools/runtime-values.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { reconcileCascadeNeighborLspErrors } from "../clients/widget-state.ts";
import { getFormatService } from "../clients/format-service.ts";
import { registerCascadeTierReconcileTask } from "../clients/lsp/cascade-tier.ts";
import { buildResolvedFoundCascadeRun } from "../clients/cascade-format.ts";
import { getLSPService } from "../clients/lsp/index.ts";
import { dumpActiveHandles } from "../clients/debug-handles.ts";
import { handleAgentEnd } from "../clients/runtime-agent-end.ts";
import { classifyCurrentSessionEmission } from "../clients/session-lifecycle.ts";
import {
  registerBuiltinQuietWindowTasks,
  registerQuietWindowTask,
  runQuietWindow,
} from "../clients/quiet-window.ts";
import { setAmbientAbortSignal } from "../clients/safe-spawn.ts";
import { logLatency } from "../clients/latency-logger.ts";
import { toRunnerDisplayPath } from "../clients/dispatch/runner-context.ts";
import { formatTurnSummaryLine, TURN_SUMMARY_CUSTOM_TYPE } from "../clients/turn-summary.ts";
import { renderTurnSummaryMessage } from "../clients/turn-summary-render.ts";
import type { ExtensionActivation } from "./activation.ts";
import { processState } from "./process-state.ts";
import { dbg, getStableSessionId, isStaleExtensionCtxError, notifyUi } from "./shared.ts";
import type { LspStatusTheme } from "./widget-status.ts";

export function registerTurnSummaryRenderer(activation: ExtensionActivation): void {
  const { pi } = activation;
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  if (isRuntimeFunction((pi as { registerMessageRenderer?: unknown }).registerMessageRenderer)) {
    try {
      pi.registerMessageRenderer(TURN_SUMMARY_CUSTOM_TYPE, renderTurnSummaryMessage);
    } catch (registerRendererErr) {
      dbg(`turn-summary renderer registration failed: ${registerRendererErr}`);
    }
  }
}

export function registerQuietWindowHooks(activation: ExtensionActivation): void {
  const {
    pi,
    runtime,
    cacheManager,
    activationState,
    getLensFlag,
    getLensFlagSource,
    updateLspStatus,
  } = activation;
  type DeferredDrainCtx = {
    cwd?: string;
    signal?: AbortSignal;
    ui?: {
      setStatus?: (id: string, text: string | undefined) => void;
      theme?: LspStatusTheme;
    };
  };

  async function runDeferredMutationDrain(ctx: DeferredDrainCtx): Promise<void> {
    const currentSessionId = getStableSessionId(ctx);
    const emission = classifyCurrentSessionEmission(ctx, currentSessionId);
    if (emission === "concurrent-secondary") {
      dbg(
        `deferred_mutation_drain: concurrent secondary session detected — skipping (sessionId=${currentSessionId})`,
      );
      logLatency({
        type: "phase",
        filePath: ctx.cwd ?? "<choco-pi-lsp>",
        phase: "agent_end_concurrent_secondary_skip",
        durationMs: 0,
        metadata: { sessionId: currentSessionId },
      });
      return;
    }
    await handleAgentEnd({
      ctxCwd: ctx.cwd,
      getFlag: (name: string, filePath?: string) => getLensFlag(name, filePath),
      getFlagSource: (name: string, filePath?: string) => getLensFlagSource(name, filePath),
      notify: (msg, level) => notifyUi(ctx, msg, level),
      dbg,
      runtime,
      cacheManager,
      getFormatService: () => getFormatService(runtime.telemetrySessionId, true),
      getAutofixClients: async () => {
        const { biomeClient, ruffClient } = await loadBootstrapClients();
        return { biomeClient, ruffClient };
      },
      currentSessionId,
    });
    if (ctx.ui?.setStatus && ctx.ui.theme) {
      updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
    }
  }

  registerBuiltinQuietWindowTasks(() => runtime);
  registerCascadeTierReconcileTask(() => getLSPService(), {
    onResolvedFound: ({ filePath, diagnostics }) => {
      const run = buildResolvedFoundCascadeRun(runtime.projectRoot, {
        filePath,
        diagnostics,
      });
      if (run) runtime.appendCascadeRun(run);
    },
    onResolvedClean: ({ filePath, publishedAt }) => {
      reconcileCascadeNeighborLspErrors(filePath, [], undefined, publishedAt);
    },
  });
  processState.turnSummaryEmitCtx = {
    pi,
    getLensFlag: (name: string) => getLensFlag(name),
    isLensEnabled: () => activationState.lensEnabled,
  };
  if (!processState.turnSummaryEmitRegistered) {
    processState.turnSummaryEmitRegistered = true;
    registerQuietWindowTask("turn_summary_emit", () => {
      const emitCtx = processState.turnSummaryEmitCtx;
      if (!emitCtx || !emitCtx.isLensEnabled()) return;
      let turnSummaryEnabled: boolean | string | undefined;
      try {
        turnSummaryEnabled = emitCtx.getLensFlag("lens-turn-summary");
      } catch (err) {
        if (isStaleExtensionCtxError(err)) {
          dbg(
            "turn_summary_emit: skipped — captured pi ctx is stale (session replaced/reloaded before the quiet window ran)",
          );
          return;
        }
        throw err;
      }
      if (!turnSummaryEnabled) return;
      if (runtime.turnSummary.isEmpty()) return;
      const summaryStart = Date.now();
      const cwd = runtime.projectRoot || process.cwd();
      const details = runtime.turnSummary.consume(runtime.turnIndex, (fp) =>
        toRunnerDisplayPath(cwd, fp),
      );
      const line = formatTurnSummaryLine(details);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      const sendMessage = (emitCtx.pi as { sendMessage?: (msg: RuntimeValue) => void }).sendMessage;
      if (isRuntimeFunction(sendMessage)) {
        try {
          sendMessage.call(emitCtx.pi, {
            customType: TURN_SUMMARY_CUSTOM_TYPE,
            content: line,
            display: true,
            details,
          });
        } catch (sendErr) {
          if (isStaleExtensionCtxError(sendErr)) {
            dbg("turn_summary_emit: skipped emit — pi ctx went stale (session replaced/reloaded)");
            return;
          }
          dbg(`turn-summary sendMessage failed: ${sendErr}`);
        }
      } else {
        dbg("turn-summary: pi.sendMessage unavailable on this host, skipping emit");
      }
      logLatency({
        type: "phase",
        toolName: "agent_settled",
        filePath: cwd,
        phase: "turn_summary",
        durationMs: Date.now() - summaryStart,
        metadata: {
          files: details.files.length,
          diagnostics: details.counts.diagnostics,
          autofixes: details.counts.autofixes,
          formats: details.counts.formats,
        },
      });
    });
  }
  try {
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    (pi as any).on("agent_settled", async (_event: RuntimeValue, ctx: DeferredDrainCtx) => {
      if (!activationState.lensEnabled) return;
      setAmbientAbortSignal(ctx?.signal);
      try {
        await runDeferredMutationDrain(ctx);
      } catch (drainErr) {
        dbg(`agent_settled deferred_mutation_drain crashed: ${drainErr}`);
      } finally {
        setAmbientAbortSignal(undefined);
      }
      void runQuietWindow({
        runtime,
        dbg,
        cwd: ctx?.cwd,
      }).catch((err) => {
        dbg(`quiet_window crashed: ${err}`);
      });
      dumpActiveHandles("agent_settled");
    });
  } catch (registerErr) {
    dbg(`agent_settled registration failed (older pi host?): ${registerErr}`);
  }
}
