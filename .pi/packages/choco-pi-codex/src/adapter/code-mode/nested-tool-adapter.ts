import { conditionalProperties } from "../runtime-values.ts";
import { isBoundaryValue, JsonObjectSchema, type BoundaryValue } from "../runtime-values.ts";
import { Value } from "typebox/value";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const WebRunDetailsSchema = Type.Object({ webRun: Type.Unknown() });
import type {
  ProgrammaticCodeModeToolDefinition,
  CodeModeToolIdentity,
  ToolExecutionContext,
} from "../../tools/code-mode/types.ts";

interface NestedToolLifecycle {
  start?(id: string, input: BoundaryValue): void;
  end?(id: string): void;
}

interface NestedToolContract<TDetails> {
  kind?: "function" | "freeform";
  /** Deferred tools stay out of the prompt and are discovered through ALL_TOOLS. */
  deferLoading?: boolean;
  toolName?: CodeModeToolIdentity;
  yieldTimeMs?: number;
  prepareInput?(input: BoundaryValue): BoundaryValue;
  resultError?(result: AgentToolResult<TDetails>): string | undefined;
  resultValue?(result: AgentToolResult<TDetails>): BoundaryValue;
}

export function toNestedTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  usage: string,
  lifecycle: NestedToolLifecycle = {},
  contract: NestedToolContract<TDetails> = {},
): ProgrammaticCodeModeToolDefinition {
  const kind = contract.kind ?? "function";
  const prepareInput = (input: BoundaryValue) =>
    contract.prepareInput ? contract.prepareInput(input) : input;
  return {
    name: tool.name,
    label: tool.label,
    usage,
    description: tool.description,
    deferLoading: contract.deferLoading === true,
    kind,
    ...conditionalProperties(Boolean(contract.toolName), { toolName: contract.toolName }),
    ...conditionalProperties(contract.yieldTimeMs !== undefined, {
      yieldTimeMs: contract.yieldTimeMs,
    }),
    ...conditionalProperties(kind === "function", { inputSchema: tool.parameters }),
    ...conditionalProperties<Pick<ProgrammaticCodeModeToolDefinition, "renderCall">>(
      Boolean(tool.renderCall),
      {
        renderCall: (input, theme, context) => {
          const parsedInput = isBoundaryValue(input) ? input : undefined;
          // SAFETY: The shallow boundary guard preserves renderer input without traversing live values.
          return tool.renderCall!(
            prepareInput(parsedInput) as never,
            theme as never,
            context as never,
          );
        },
      },
    ),
    ...conditionalProperties<Pick<ProgrammaticCodeModeToolDefinition, "renderResult">>(
      Boolean(tool.renderResult),
      {
        renderResult: (result, options, theme, context) =>
          // SAFETY: Code mode forwards Pi's RuntimeToolResult and render context unchanged to the registered tool renderer.
          tool.renderResult!(result as never, options, theme as never, context as never),
      },
    ),
    async invoke(input, context, signal) {
      if (signal.aborted) throw new Error(`${tool.name} aborted`);
      const extensionContext = requireExtensionContext(context);
      const parsedInput = isBoundaryValue(input) ? input : undefined;
      const toolInput = prepareInput(parsedInput);
      const prepared = tool.prepareArguments ? tool.prepareArguments(toolInput) : toolInput;
      if (signal.aborted) throw new Error(`${tool.name} aborted`);
      const toolCallId = context.toolCallId ?? `code-mode-${tool.name}`;
      const lifecycleInput = isBoundaryValue(prepared) ? prepared : undefined;
      lifecycle.start?.(toolCallId, lifecycleInput);
      context.refreshTrace?.();
      try {
        const result = await tool.execute(
          toolCallId,
          // SAFETY: tool.prepareArguments produced the argument for this same tool definition and parameter schema.
          prepared as never,
          signal,
          (update) => forwardUpdate(update, context),
          extensionContext,
        );
        const resultError = contract.resultError?.(result);
        if (resultError) throw new Error(resultError);
        context.captureResult?.(result);
        return contract.resultValue?.(result) ?? compactNestedResult(result);
      } finally {
        lifecycle.end?.(toolCallId);
      }
    },
  };
}

export function codeModeImageResult<TDetails>(
  result: AgentToolResult<TDetails>,
  outputHint?: string,
): BoundaryValue {
  const image = result.content.find((item) => item.type === "image");
  if (!image || image.type !== "image") return compactNestedResult(result);
  const detail =
    "detail" in image && Value.Check(Type.String(), image.detail) ? image.detail : "high";
  return {
    image_url: `data:${image.mimeType};base64,${image.data}`,
    detail,
    ...conditionalProperties(Boolean(outputHint), { output_hint: outputHint }),
  };
}

export function codeModeWebResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const details = result.details;
  if (Value.Check(WebRunDetailsSchema, details)) {
    const webRun = details.webRun;
    if (webRun && (Value.Check(JsonObjectSchema, webRun) || Array.isArray(webRun))) return webRun;
  }
  return compactNestedResult(result);
}

function requireExtensionContext(context: ToolExecutionContext): ExtensionContext {
  if (!context.extensionContext) throw new Error("Code-mode Pi context is unavailable");
  return context.extensionContext;
}

function forwardUpdate<TDetails>(
  update: AgentToolResult<TDetails>,
  context: ToolExecutionContext,
): void {
  const content = update.content
    .filter((item) => item.type === "text" || item.type === "image")
    .map((item) => ({ ...item }));
  context.onUpdate?.({ content, details: update.details });
}

function compactNestedResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const images = result.content.filter((item) => item.type === "image");
  if (images.length > 0) return { content: result.content, details: result.details };
  if (Value.Check(JsonObjectSchema, result.details) && "output" in result.details)
    return result.details;
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return text || "(no output)";
}
