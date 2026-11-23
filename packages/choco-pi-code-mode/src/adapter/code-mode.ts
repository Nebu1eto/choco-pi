import { conditionalProperties, isJsonObject } from "./runtime-values.ts";
import { isNumber, isString } from "../value-guards.ts";
import type { JsonObject, BoundaryValue } from "./runtime-values.ts";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatRunningExecSessionGuidance } from "../tools/code-mode/tool-result.ts";
import {
  type CodeModeRegistration,
  registerCodeModeTools,
  registerCustomTools,
} from "../tools/code-mode/tools.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../tools/code-mode/types.ts";
import {
  collectBridgedTools,
  installRegisteredToolCapture,
  registeredToolRunner,
} from "../tools/code-mode/registered-tool-bridge.ts";
import { prepareCodeModeApplyPatchInput } from "../tools/apply-patch/code-mode-input.ts";
import { createApplyPatchTool } from "../tools/apply-patch/tool.ts";
import { createExecCommandTool } from "../tools/exec/command-tool.ts";
import { MAX_CODE_MODE_WAIT_MS } from "../tools/exec/shell.ts";
import { createWriteStdinTool } from "../tools/exec/write-stdin-tool.ts";
import { createViewImageTool } from "../tools/view-image/tool.ts";
import { supportsViewImageInputs } from "./tool-support.ts";
import { codeModeImageResult, toNestedTool } from "./code-mode/nested-tool-adapter.ts";
import {
  activeRegisteredSessionToolNames,
  codeModeExecutionKindForPermissions,
  scopeCodeModeToolsToSessionPermissions,
} from "./code-mode/session-tool-permissions.ts";
import type { CodeModeHost } from "./code-mode/ports.ts";

export type {
  AsyncCodeModeCallHook,
  CodeModeHost,
  CodeModePorts,
  CodeModeRuntimePolicy,
  CodeModeToolConfig,
  ImageDescribeFallbackPort,
  OptionalNestedToolsPort,
} from "./code-mode/ports.ts";

const LONG_RUNNING_TOOL_OUTER_YIELD_MS = MAX_CODE_MODE_WAIT_MS;

export async function registerCodexCodeMode(
  pi: ExtensionAPI,
  runtime: CodeModeHost,
): Promise<CodeModeRegistration> {
  const { policy, consumeAsyncCall } = runtime.codeMode;
  const isActive = (ctx: BoundaryValue) =>
    // SAFETY: registerCodeModeTools invokes isActive with Pi's current ExtensionContext.
    policy.isActive(ctx as ExtensionContext);
  installRegisteredToolCapture();
  const customToolsRuntime = await registerCustomTools(pi, undefined, {
    isActive,
  });
  const programmaticRuntime = await registerCodeModeTools(pi, {
    // SAFETY: registerCodeModeTools supplies either Pi's current ExtensionContext or no context.
    getTools: (ctx) =>
      createNestedTools(
        runtime,
        activeRegisteredSessionToolNames(pi, runtime.state.previousToolNames),
        ctx as ExtensionContext | undefined,
      ),
    isActive,
    executionKind: (ctx) =>
      // SAFETY: registerCodeModeTools invokes executionKind with Pi's current ExtensionContext.
      codeModeExecutionKindForPermissions(
        policy.executionKind(ctx as ExtensionContext),
        activeRegisteredSessionToolNames(pi, runtime.state.previousToolNames),
      ),
    notebookOptions: () => ({
      maxHeapMiB: runtime.state.config.notebook.maxHeapMiB,
      agentDir: getAgentDir(),
      ...conditionalProperties(Boolean(runtime.state.config.notebook.profile), {
        profile: runtime.state.config.notebook.profile,
      }),
    }),
    providesRenderers: true,
    richRendering: () =>
      runtime.state.executionMode === "notebook" || runtime.state.config.ui.codeModeDetails,
    ...conditionalProperties(consumeAsyncCall !== undefined, {
      consumeAsyncCall: (owner: string, toolCallId: string) =>
        consumeAsyncCall?.(owner, toolCallId) === true,
    }),
  });
  return {
    prepare: (ctx) => programmaticRuntime.prepare(ctx),
    refreshPromptTools: (systemPrompt, ctx) =>
      programmaticRuntime.refreshPromptTools(systemPrompt, ctx),
    checkpointNotebook: () => programmaticRuntime.checkpointNotebook(),
    shutdownHost: () => programmaticRuntime.shutdownHost(),
    async shutdown() {
      await programmaticRuntime.shutdown();
      await customToolsRuntime.shutdown();
    },
  };
}

export const registerCodeMode = registerCodexCodeMode;

export function createNestedTools(
  runtime: CodeModeHost,
  activeToolNames: ReadonlySet<string>,
  ctx?: ExtensionContext,
): ProgrammaticCodeModeToolDefinition[] {
  const options = {
    describeImagesForTextModels: runtime.state.config.tools.viewImageFallback,
    promptSnippet: false,
    customRendering: runtime.state.config.ui.toolRenaming,
    showOutputWhenCollapsed: true,
    compactTools: runtime.state.config.ui.compactTools,
  };
  const tools: ProgrammaticCodeModeToolDefinition[] = [
    toNestedTool(
      createApplyPatchTool({
        customRustBinariesDir: runtime.state.config.tools.customRustBinariesDir,
        promptSnippet: false,
        showDiffWhenCollapsed: !runtime.state.config.ui.compactTools,
      }),
      "await tools.apply_patch(patch) // *** Begin Patch / *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path; *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk (use one unchanged context line for a pure move); Update hunks MUST follow file order; copy exact context; @@ text is context, not a line range; reread a file before patching if it changed since your last read",
      {},
      {
        kind: "freeform",
        prepareInput: prepareCodeModeApplyPatchInput,
        resultError(result) {
          if (isJsonObject(result.details) && result.details["status"] === "partial_failure")
            return (
              result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n") || "apply_patch partially failed"
            );
          return undefined;
        },
      },
    ),
    toNestedTool(
      createExecCommandTool(runtime.tracker, runtime.sessions, options),
      "await tools.exec_command({ cmd: string, workdir?: string, shell?: string, tty?: boolean, yield_time_ms?: number, max_output_tokens?: number, login?: boolean }) // returns { output: string, session_id?: number, exit_code?: number }",
      {
        start(id, input) {
          const inputCmd = isJsonObject(input) ? input["cmd"] : undefined;
          const cmd = isString(inputCmd) ? inputCmd : "";
          if (cmd) runtime.tracker.recordStart(id, cmd);
        },
        end: (id) => runtime.tracker.recordEnd(id),
      },
      {
        yieldTimeMs: LONG_RUNNING_TOOL_OUTER_YIELD_MS,
        resultValue(result) {
          const details = result.details;
          if (result.content.some((item) => item.type === "image")) {
            const outputHint = isExecResult(details)
              ? details.output
              : result.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n") || undefined;
            return codeModeImageResult(result, outputHint);
          }
          if (isRunningExecResult(details))
            return {
              ...details,
              continuation: formatRunningExecSessionGuidance(details.session_id),
            };
          if (isExecResult(details)) return details;
          return (
            result.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n") || "(no output)"
          );
        },
      },
    ),
    toNestedTool(
      createWriteStdinTool(runtime.sessions, options),
      "await tools.write_stdin({ session_id: number, chars?: string, yield_time_ms?: number, max_output_tokens?: number })",
      {},
      { yieldTimeMs: LONG_RUNNING_TOOL_OUTER_YIELD_MS },
    ),
  ];
  const describeImage = runtime.state.config.tools.viewImageFallback
    ? runtime.codeMode.describeImage
    : undefined;
  if (!ctx || supportsViewImageInputs(ctx.model) || describeImage) {
    const imageCapable = !ctx || supportsViewImageInputs(ctx.model);
    tools.push(
      toNestedTool(
        createViewImageTool({
          customRustBinariesDir: runtime.state.config.tools.customRustBinariesDir,
          describeForTextModels: runtime.state.config.tools.viewImageFallback,
          describeImage,
          promptSnippet: false,
          customRendering: runtime.state.config.ui.toolRenaming,
        }),
        imageCapable
          ? 'const result = await tools.view_image({ path: string, detail?: "original" }); image(result)'
          : "const description = await tools.view_image({ path: string }); text(description)",
        {},
        imageCapable ? { resultValue: codeModeImageResult } : {},
      ),
    );
  }
  if (runtime.codeMode.optionalNestedTools)
    tools.push(...runtime.codeMode.optionalNestedTools(ctx));
  tools.push(...collectBridgedTools(registeredToolRunner(ctx), ctx?.hasUI ?? false));
  return scopeCodeModeToolsToSessionPermissions(tools, activeToolNames);
}

function isRunningExecResult<T>(details: T): details is T & JsonObject & { session_id: number } {
  return isJsonObject(details) && isNumber(details["session_id"]);
}

function isExecResult<T>(details: T): details is T & JsonObject & { output: string } {
  return isJsonObject(details) && isString(details["output"]);
}
