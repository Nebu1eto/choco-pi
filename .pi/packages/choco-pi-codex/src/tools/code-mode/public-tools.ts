import { isNumberValue, isObjectValue, isStringValue } from "../boundary.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getExperimentalToolSampling } from "../tool-sampling.ts";
import { DEFAULT_CODE_MODE_OUTPUT_TOKENS, MAX_CODE_MODE_OUTPUT_TOKENS } from "./host-protocol.js";
import { EXEC_DESCRIPTION, WAIT_DESCRIPTION } from "./custom-tool-prompt.js";
import { createCodeModeRenderTracker } from "./render-tracker.js";
import { renderExecCall, renderWaitCall } from "./call-rendering.js";
import { renderTrackedCodeModeResult } from "./result-rendering.js";
import type { SharedCodeModeRuntime } from "./shared-runtime.js";
import { formatRunningExecSessionGuidance, toCodeModeToolResult } from "./tool-result.js";
import type { CodeModeRenderContext, CodeModeRenderTheme, ToolExecutionContext } from "./types.js";
import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING } from "./exec-contract.js";
import {
  registerCodeModePreflightBroker,
  runCodeModeToolPreflight,
} from "./nested-tool-preflight.js";

const DEFAULT_WAIT_MS = 10_000;
const MIN_ADAPTIVE_WAIT_MS = 5_000;
const MAX_ADAPTIVE_WAIT_MS = 1_800_000;
type RenderTracker = ReturnType<typeof createCodeModeRenderTracker>;
interface WriteStdinResumeInput {
  session_id: number;
  yield_time_ms: number;
  max_output_tokens?: number | undefined;
}
const EXEC_PARAMETERS = Type.Object({
  code: Type.String(),
});
const WAIT_PARAMETERS = Type.Object({
  cell_id: Type.String(),
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: DEFAULT_WAIT_MS,
    }),
  ),
  max_tokens: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_CODE_MODE_OUTPUT_TOKENS,
      default: DEFAULT_CODE_MODE_OUTPUT_TOKENS,
    }),
  ),
  terminate: Type.Optional(Type.Boolean()),
});

export function registerPublicCodeModeTools(
  pi: ExtensionAPI,
  runtime: SharedCodeModeRuntime,
): void {
  const tracker = createCodeModeRenderTracker();
  const waitAttempts = new Map<string, number>();
  const renderResult = createResultRenderer(runtime, tracker);
  const preflight = registerCodeModePreflightBroker(pi).run;
  pi.registerTool(createExecTool(runtime, tracker, renderResult, preflight));
  pi.registerTool(createWaitTool(runtime, tracker, renderResult, waitAttempts, preflight));
}

function createExecTool(
  runtime: SharedCodeModeRuntime,
  tracker: RenderTracker,
  renderResult: ReturnType<typeof createResultRenderer>,
  preflight: NonNullable<ToolExecutionContext["preflight"]>,
): ToolDefinition<typeof EXEC_PARAMETERS> {
  // SAFETY: renderExecCall and createResultRenderer implement this registered tool's renderer callback shapes; assertions bridge SDK generic variance only.
  return {
    name: "exec",
    label: "Exec",
    description: EXEC_DESCRIPTION,
    promptSnippet: "Compose tools with JavaScript",
    parameters: EXEC_PARAMETERS,
    constrainedSampling: CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
    async execute(id, params, signal, onUpdate, ctx) {
      tracker.start(id);
      try {
        const response = await (
          await runtime.getClient(ctx)
        ).execute(
          params.code,
          { cwd: ctx.cwd, toolCallId: id, extensionContext: ctx, preflight, onUpdate },
          signal,
          runtime.collectTools(ctx),
        );
        tracker.finish(id, response.kind === "yielded" ? "yielded" : "done");
        return toCodeModeToolResult(response);
      } catch (error) {
        tracker.finish(id);
        throw error;
      }
    },
    renderCall: ((
      args: { code?: unknown },
      theme: CodeModeRenderTheme,
      context: CodeModeRenderContext,
    ) => renderExecCall(args, theme, context, tracker, runtime.useRichRendering())) as any,
    renderResult: renderResult as any,
  };
}

function createWaitTool(
  runtime: SharedCodeModeRuntime,
  tracker: RenderTracker,
  renderResult: ReturnType<typeof createResultRenderer>,
  waitAttempts: Map<string, number>,
  preflight: NonNullable<ToolExecutionContext["preflight"]>,
): ToolDefinition<typeof WAIT_PARAMETERS> {
  const constrainedSampling = getExperimentalToolSampling("wait");
  // SAFETY: renderWaitCall and createResultRenderer implement this registered tool's renderer callback shapes; assertions bridge SDK generic variance only.
  const tool: ToolDefinition<typeof WAIT_PARAMETERS> = {
    name: "wait",
    label: "Wait",
    description: WAIT_DESCRIPTION,
    promptSnippet: "Resume or terminate an exec cell",
    parameters: WAIT_PARAMETERS,
    async execute(id, params, signal, onUpdate, ctx) {
      tracker.start(id);
      try {
        const client = await runtime.getClient(ctx);
        const context = {
          cwd: ctx.cwd,
          toolCallId: id,
          extensionContext: ctx,
          preflight,
          onUpdate,
        };
        const attempt = waitAttempts.get(params.cell_id) ?? 0;
        const response = params.terminate
          ? await client.terminate(params.cell_id, context, signal)
          : await client.wait(
              params.cell_id,
              adaptiveWaitMs(params.yield_time_ms ?? DEFAULT_WAIT_MS, attempt),
              context,
              signal,
            );
        const recovered =
          !params.terminate && response.missingCell === true
            ? await continueExecSessionFromMistakenWait(
                params.cell_id,
                params.yield_time_ms ?? DEFAULT_WAIT_MS,
                params.max_tokens,
                runtime,
                context,
                signal,
              )
            : undefined;
        if (recovered) {
          waitAttempts.delete(params.cell_id);
          tracker.finish(id, recovered.running ? "yielded" : "done");
          return recovered.result;
        }
        if (response.missingCell === true) {
          waitAttempts.delete(params.cell_id);
          tracker.finish(id, "done");
          return {
            content: [
              {
                type: "text",
                text: params.terminate
                  ? `Exec cell "${params.cell_id}" is already gone.`
                  : `Exec cell "${params.cell_id}" does not exist in this session. Exec cells do not survive a session restart and cannot be referenced across sessions. Re-run the script with exec instead of waiting.`,
              },
            ],
            details: {
              codeMode: true,
              cellId: params.cell_id,
              status: params.terminate ? "terminated" : "result",
            },
          };
        }
        if (response.kind === "yielded") waitAttempts.set(params.cell_id, attempt + 1);
        else waitAttempts.delete(params.cell_id);
        tracker.finish(id, response.kind === "yielded" ? "yielded" : "done");
        return toCodeModeToolResult(response, params.max_tokens);
      } catch (error) {
        waitAttempts.delete(params.cell_id);
        tracker.finish(id);
        throw error;
      }
    },
    renderCall: ((
      args: { cell_id?: unknown; terminate?: unknown },
      theme: CodeModeRenderTheme,
      context: CodeModeRenderContext,
    ) => renderWaitCall(args, theme, context, tracker, runtime.useRichRendering())) as any,
    renderResult: renderResult as any,
  };
  if (constrainedSampling) tool.constrainedSampling = constrainedSampling;
  return tool;
}

async function continueExecSessionFromMistakenWait(
  cellId: string,
  yieldTimeMs: number,
  maxOutputTokens: number | undefined,
  runtime: SharedCodeModeRuntime,
  context: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<
  | {
      running: boolean;
      result: {
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
      };
    }
  | undefined
> {
  if (!/^\d+$/.test(cellId)) return undefined;
  const sessionId = Number(cellId);
  if (!Number.isSafeInteger(sessionId) || String(sessionId) !== cellId) return undefined;
  const writeStdin = runtime
    .collectTools(context.extensionContext)
    .find((tool) => tool.name === "write_stdin" && "invoke" in tool);
  if (!writeStdin || !("invoke" in writeStdin)) return undefined;
  const input: WriteStdinResumeInput = {
    session_id: sessionId,
    yield_time_ms: yieldTimeMs,
  };
  if (maxOutputTokens !== undefined) input.max_output_tokens = maxOutputTokens;
  const nestedSignal = signal ?? new AbortController().signal;
  await runCodeModeToolPreflight(writeStdin.name, input, context, nestedSignal);
  nestedSignal.throwIfAborted();
  let value: unknown;
  try {
    value = await writeStdin.invoke(input, context, nestedSignal);
  } catch (fallbackError) {
    const fallbackMessage =
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    if (/unknown process id/i.test(fallbackMessage)) return undefined;
    throw fallbackError;
  }
  if (!value || !isObjectValue(value) || !("output" in value)) return undefined;
  const output = isStringValue(value.output) ? value.output : "";
  const exitCode =
    "exit_code" in value && isNumberValue(value.exit_code) ? value.exit_code : undefined;
  const running = "session_id" in value && isNumberValue(value.session_id);
  return {
    running,
    result: {
      content: [
        {
          type: "text",
          text: `Recovered wait cell_id ${cellId} as exec_command session_id ${sessionId} and continued it with write_stdin`,
        },
        ...(output ? [{ type: "text" as const, text: output }] : []),
        ...(exitCode === undefined
          ? []
          : [
              {
                type: "text" as const,
                text: `Process exited with code ${exitCode}`,
              },
            ]),
        ...(running
          ? [
              {
                type: "text" as const,
                text: formatRunningExecSessionGuidance(sessionId),
              },
            ]
          : []),
      ],
      details: value,
    },
  };
}

function adaptiveWaitMs(requestedMs: number, previousIncompleteWaits: number): number {
  const multiplier = 2 ** previousIncompleteWaits;
  const grown = requestedMs * multiplier * 2;
  const adaptive = Math.min(
    MAX_ADAPTIVE_WAIT_MS,
    Math.max(MIN_ADAPTIVE_WAIT_MS * multiplier, grown),
  );
  return Math.max(requestedMs, adaptive);
}

function createResultRenderer(runtime: SharedCodeModeRuntime, tracker: RenderTracker) {
  return (
    result: Parameters<typeof renderTrackedCodeModeResult>[0],
    options: Parameters<typeof renderTrackedCodeModeResult>[1],
    theme: CodeModeRenderTheme,
    context: CodeModeRenderContext,
  ) =>
    renderTrackedCodeModeResult(
      result,
      options,
      theme,
      context,
      tracker,
      runtime.collectRenderTools(),
      runtime.useRichRendering(),
    );
}
