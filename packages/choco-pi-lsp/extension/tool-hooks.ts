/**
 * tool_call and tool_result hooks.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { resetLSPService } from "../clients/lsp/index.ts";
import { codeModeMutationToolResults } from "../clients/code-mode-tool-results.ts";
import { handleToolCall } from "../clients/runtime-tool-call.ts";
import { handleToolResult } from "../clients/runtime-tool-result.ts";
import { setAmbientAbortSignal } from "../clients/safe-spawn.ts";
import { logLatency } from "../clients/latency-logger.ts";
import type { ExtensionActivation } from "./activation.ts";
import { ensureLSPConfigInitialized } from "./process-state.ts";
import { dbg, getStableSessionId } from "./shared.ts";

/** Register tool_call and tool_result. */
export function registerToolHooks(activation: ExtensionActivation): void {
  const {
    pi,
    runtime,
    cacheManager,
    activationState,
    getLensFlag,
    getLensFlagSource,
    rememberOwnEventCtx,
    updateLspStatus,
    updateRuntimeIdentityFromCtx,
  } = activation;
  pi.on("tool_call", async (event, ctx) => {
    return handleToolCall({
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      event: event as Parameters<typeof handleToolCall>[0]["event"],
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      ctx: ctx as Parameters<typeof handleToolCall>[0]["ctx"],
      lensEnabled: activationState.lensEnabled,
      getFlag: (name: string) => getLensFlag(name),
      dbg,
      runtime,
      cacheManager,
      ensureLSPConfigInitialized,
      updateLspStatus,
      resetLSPService,
    });
  });

  // Real-time feedback on file writes/edits
  // biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on("tool_result", async (event: any, ctx: any) => {
    rememberOwnEventCtx(ctx);
    if (!activationState.lensEnabled) return;
    updateRuntimeIdentityFromCtx(ctx);
    // Publish this turn's abort signal so the dispatch's linter/type-check
    // child processes are killed if the agent is interrupted (#197 ctx.signal).
    setAmbientAbortSignal(ctx?.signal);
    const nestedMutations = codeModeMutationToolResults(
      event,
      ctx?.cwd ?? runtime.projectRoot ?? process.cwd(),
    );
    const dispatchEvents = [event, ...nestedMutations];
    try {
      const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
        await loadBootstrapClients();
      let outerResult: Awaited<ReturnType<typeof handleToolResult>> = undefined;
      const nestedContent: Array<{ type: string; text?: string }> = [];
      let nestedIsError = false;
      for (const [index, dispatchEvent] of dispatchEvents.entries()) {
        // Earliest possible marker for the edit pipeline: code mode emits the
        // actual edit as a nested trace inside an outer `exec` result, so log
        // each expanded mutation rather than inspecting only the outer event.
        if (dispatchEvent.toolName === "edit" || dispatchEvent.toolName === "write") {
          logLatency({
            type: "phase",
            phase: "tool_result_received",
            filePath: dispatchEvent.input?.path ?? "<unknown>",
            durationMs: 0,
            metadata: {
              toolName: dispatchEvent.toolName,
              nestedCodeMode: index > 0,
            },
          });
        }
        const result = await handleToolResult({
          // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
          event: dispatchEvent as any,
          getFlag: (name: string, filePath?: string) => getLensFlag(name, filePath),
          getFlagSource: (name: string, filePath?: string) => getLensFlagSource(name, filePath),
          dbg,
          runtime,
          cacheManager,
          biomeClient,
          ruffClient,
          metricsClient,
          resetLSPService,
          readGuard: runtime.readGuard,
          agentBehaviorRecord: (toolName, filePath) =>
            agentBehaviorClient.recordToolCall(toolName, filePath),
          // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
          formatBehaviorWarnings: (warnings) => agentBehaviorClient.formatWarnings(warnings as any),
          // #791: tags any deferred-format record queued from this tool_result
          // with the STABLE session id of the ctx that produced it, so a
          // later agent_end can tell its own queued work apart from a
          // concurrent in-process secondary session's.
          sessionId: getStableSessionId(ctx),
        });
        if (index === 0) {
          outerResult = result;
        } else if (result) {
          nestedContent.push(...result.content.slice(dispatchEvent.content.length));
          nestedIsError ||= result.isError === true;
        }
      }
      if (nestedContent.length === 0) return outerResult;
      return {
        content: [...(outerResult?.content ?? event.content), ...nestedContent],
        isError: outerResult?.isError === true || nestedIsError || undefined,
      };
    } finally {
      setAmbientAbortSignal(undefined);
    }
  });
}
