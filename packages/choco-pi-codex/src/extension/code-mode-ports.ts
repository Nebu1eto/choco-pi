/**
 * code-mode-ports.ts — The Codex side of the Code Mode ports.
 *
 * The provider-neutral Code Mode layer (`src/adapter/code-mode*`,
 * `src/tools/code-mode/`, ...) never imports OpenAI Codex code; this
 * composition-root module implements its ports with the Codex runtime plan,
 * the OpenAI view_image fallback, native async exec calls, and the Codex-only
 * nested tools (web__run, image_gen__imagegen).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import {
  isCodeModeRuntime,
  resolveCodexRuntimePlanForState,
  usesCodexProviderFallback,
} from "../adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import {
  codeModeImageResult,
  codeModeWebResult,
  toNestedTool,
} from "@choco-pi/code-mode/adapter/code-mode/nested-tool-adapter";
import type { CodeModePorts } from "@choco-pi/code-mode/ports";
import { supportsNativeImageGeneration } from "../adapter/tool-support.ts";
import { consumeAsyncCodeModeCall } from "../providers/openai-codex/native-features.ts";
import { openAIImageDescribeFallback } from "../providers/openai-codex/view-image-fallback.ts";
import type { ProgrammaticCodeModeToolDefinition } from "@choco-pi/code-mode/tools/code-mode/types";
import { createImageGenerationTool } from "../tools/imagegen/tool.ts";
import { createWebSearchTool, type WebSearchToolOptions } from "../tools/web-run/tool.ts";

const WEB_RUN_USAGE =
  'await tools.web__run({ search_query?: [{ q: string, recency?: number, domains?: string[] }], image_query?: [{ q: string }], open?: [{ ref_id: string, lineno?: number }], click?: [{ ref_id: string, id: number }], find?: [{ ref_id: string, pattern: string }], response_length?: "short" | "medium" | "long" }) // turn… ref_ids only for web__run; final answers cite result URLs with Markdown links, never turn… or cite…';
const IMAGEGEN_USAGE =
  'await tools.image_gen__imagegen({ prompt: string, action?: "generate" | "edit", images?: string[] })';

/** The standalone Code Mode `web__run` tool, cross-provider through the Codex fallback. */
export function createCodeModeWebSearchTool(
  config: CodexConversionConfig,
  allowConfiguredProvider: NonNullable<WebSearchToolOptions["allowConfiguredProvider"]>,
) {
  return createWebSearchTool("web__run", {
    customRustBinariesDir: config.tools.customRustBinariesDir,
    model: () => config.openai.webSearchModel,
    allowConfiguredProvider,
    allowCodexProviderFallback: usesCodexProviderFallback(config),
    promptSnippet: false,
    customRendering: config.ui.toolRenaming,
  });
}

/** Codex nested tools appended after the core tools, in their established order. */
export function createCodexOptionalNestedTools(
  state: AdapterState,
  ctx: ExtensionContext | undefined,
): ProgrammaticCodeModeToolDefinition[] {
  const config = state.config;
  const allowConfiguredProvider = (model: ExtensionContext["model"]) => {
    const plan = resolveCodexRuntimePlanForState({ model }, state);
    return isCodeModeRuntime(plan) && plan.configuredProvider && !plan.codexTransport;
  };
  const tools: ProgrammaticCodeModeToolDefinition[] = [];
  if (config.tools.webRun && !state.canonicalSearch) {
    tools.push(
      toNestedTool(
        createCodeModeWebSearchTool(config, allowConfiguredProvider),
        WEB_RUN_USAGE,
        {},
        { toolName: { namespace: "web", name: "run" }, resultValue: codeModeWebResult },
      ),
    );
  }
  if (
    config.tools.imageGeneration &&
    (!ctx || supportsNativeImageGeneration(ctx.model) || allowConfiguredProvider(ctx.model))
  ) {
    const imagegen = createImageGenerationTool({
      customRustBinariesDir: config.tools.customRustBinariesDir,
      allowConfiguredProvider,
      promptSnippet: false,
      customRendering: config.ui.toolRenaming,
    });
    tools.push(
      toNestedTool(
        { ...imagegen, name: "image_gen__imagegen", label: "image_gen__imagegen" },
        IMAGEGEN_USAGE,
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
  return tools;
}

/** Implement every Code Mode port against the live adapter state. */
export function createCodexCodeModePorts(state: () => AdapterState): CodeModePorts {
  return {
    policy: {
      isActive: (ctx) => isCodeModeRuntime(resolveCodexRuntimePlanForState(ctx, state())),
      executionKind: (ctx) =>
        resolveCodexRuntimePlanForState(ctx, state()).kind === "notebook" ? "notebook" : "code",
    },
    describeImage: openAIImageDescribeFallback,
    optionalNestedTools: (ctx) => createCodexOptionalNestedTools(state(), ctx),
    consumeAsyncCall: consumeAsyncCodeModeCall,
  };
}
