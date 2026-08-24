import { conditionalProperties } from "./runtime-values.ts";
import type { JsonObject, BoundaryValue } from "./runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ExecInputSchema = Type.Object({ cmd: Type.String() });
const PartialFailureDetailsSchema = Type.Object({ status: Type.Literal("partial_failure") });
const RunningExecDetailsSchema = Type.Object({ session_id: Type.Number() });
const CompletedExecDetailsSchema = Type.Object({ output: Type.String() });
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CodexExtensionRuntime } from "../extension/runtime.ts";
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
} from "../tools/code-mode/registered-tool-bridge.ts";
import { createApplyPatchTool } from "../tools/apply-patch/tool.ts";
import { createExecCommandTool } from "../tools/exec/command-tool.ts";
import { createWriteStdinTool } from "../tools/exec/write-stdin-tool.ts";
import { createImageGenerationTool } from "../tools/imagegen/tool.ts";
import { createViewImageTool } from "../tools/view-image/tool.ts";
import { createWebSearchTool } from "../tools/web-run/tool.ts";
import { supportsNativeImageGeneration, supportsViewImageInputs } from "./tool-support.ts";
import { isCodeModeRuntime, resolveCodexRuntimePlanForState } from "./activation/runtime-plan.ts";
import {
  codeModeImageResult,
  codeModeWebResult,
  toNestedTool,
} from "./code-mode/nested-tool-adapter.ts";
import {
  activeRegisteredSessionToolNames,
  codeModeExecutionKindForPermissions,
  scopeCodeModeToolsToSessionPermissions,
} from "./code-mode/session-tool-permissions.ts";

const LONG_RUNNING_TOOL_OUTER_YIELD_MS = 1_800_000;

export async function registerCodexCodeMode(
  pi: ExtensionAPI,
  runtime: CodexExtensionRuntime,
): Promise<CodeModeRegistration> {
  const isActive = (ctx: BoundaryValue) =>
    // SAFETY: registerCodeModeTools invokes isActive with Pi's current ExtensionContext.
    isCodeModeRuntime(resolveCodexRuntimePlanForState(ctx as ExtensionContext, runtime.state));
  // Capture Pi's runner so every registered tool can be bridged into the
  // tools namespace; harmless when the bridge is never used.
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
        resolveCodexRuntimePlanForState(ctx as ExtensionContext, runtime.state).kind === "notebook"
          ? "notebook"
          : "code",
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

function createNestedTools(
  runtime: CodexExtensionRuntime,
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
  const allowConfiguredProvider = (model: ExtensionContext["model"]) => {
    const plan = resolveCodexRuntimePlanForState({ model }, runtime.state);
    return isCodeModeRuntime(plan) && plan.configuredProvider && !plan.codexTransport;
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
        prepareInput(input) {
          if (!Value.Check(Type.String(), input))
            throw new Error("apply_patch expects a patch string");
          return { input };
        },
        resultError(result) {
          if (Value.Check(PartialFailureDetailsSchema, result.details))
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
          const cmd = Value.Check(ExecInputSchema, input) ? input.cmd : "";
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
  if (!ctx || supportsViewImageInputs(ctx.model) || runtime.state.config.tools.viewImageFallback) {
    const imageCapable = !ctx || supportsViewImageInputs(ctx.model);
    tools.push(
      toNestedTool(
        createViewImageTool({
          customRustBinariesDir: runtime.state.config.tools.customRustBinariesDir,
          describeForTextModels: runtime.state.config.tools.viewImageFallback,
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
  if (runtime.state.config.tools.webRun) {
    tools.push(
      toNestedTool(
        createWebSearchTool("web__run", {
          customRustBinariesDir: runtime.state.config.tools.customRustBinariesDir,
          model: () => runtime.state.config.openai.webSearchModel,
          allowConfiguredProvider,
          promptSnippet: false,
          customRendering: runtime.state.config.ui.toolRenaming,
        }),
        'await tools.web__run({ search_query?: [{ q: string, recency?: number, domains?: string[] }], image_query?: [{ q: string }], open?: [{ ref_id: string, lineno?: number }], click?: [{ ref_id: string, id: number }], find?: [{ ref_id: string, pattern: string }], response_length?: "short" | "medium" | "long" }) // turn… ref_ids only for web__run; final answers cite result URLs with Markdown links, never turn… or cite…',
        {},
        { toolName: { namespace: "web", name: "run" }, resultValue: codeModeWebResult },
      ),
    );
  }
  if (
    runtime.state.config.tools.imageGeneration &&
    (!ctx || supportsNativeImageGeneration(ctx.model) || allowConfiguredProvider(ctx.model))
  ) {
    const imagegen = createImageGenerationTool({
      customRustBinariesDir: runtime.state.config.tools.customRustBinariesDir,
      allowConfiguredProvider,
      promptSnippet: false,
      customRendering: runtime.state.config.ui.toolRenaming,
    });
    tools.push(
      toNestedTool(
        { ...imagegen, name: "image_gen__imagegen", label: "image_gen__imagegen" },
        'await tools.image_gen__imagegen({ prompt: string, action?: "generate" | "edit", images?: string[] })',
        {},
        {
          toolName: { namespace: "image_gen", name: "imagegen" },
          resultValue(result) {
            const outputHint =
              result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n") || undefined;
            return codeModeImageResult(result, outputHint);
          },
        },
      ),
    );
  }
  // Everything else Pi has registered (LSP, MCP, sub-agents, sessions, goals,
  // web access) rides along as deferred tools: no prompt cost, callable as
  // tools.<name>(...) inside a block, discoverable through ALL_TOOLS.
  tools.push(...collectBridgedTools());
  return scopeCodeModeToolsToSessionPermissions(tools, activeToolNames);
}

function isRunningExecResult<T>(details: T): details is T & JsonObject & { session_id: number } {
  return Value.Check(RunningExecDetailsSchema, details);
}

function isExecResult<T>(details: T): details is T & JsonObject & { output: string } {
  return Value.Check(CompletedExecDetailsSchema, details);
}
