import type { BoundaryValue } from "../boundary.ts";
import { isNumberValue, isObjectValue, isStringValue } from "../boundary.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderWriteStdinCall } from "../../ui/tool-rendering/codex-rendering.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./session-manager.ts";
import { formatUnifiedExecResult } from "./format.ts";
import { renderTerminalOutput } from "./output.ts";

const WRITE_STDIN_PARAMETERS = Type.Object({
  session_id: Type.Number({ description: "Session ID" }),
  chars: Type.Optional(Type.String({ description: "Input. Empty polls" })),
  yield_time_ms: Type.Optional(Type.Number({ description: "Wait ms" })),
  max_output_tokens: Type.Optional(Type.Number({ description: "Truncate" })),
});

interface WriteStdinParams {
  session_id: number;
  chars?: string | undefined;
  yield_time_ms?: number | undefined;
  max_output_tokens?: number | undefined;
}

interface FormattedExecTranscript {
  output: string;
  sessionId?: number | undefined;
  exitCode?: number | undefined;
}

function parseFormattedExecTranscript(text: string): FormattedExecTranscript {
  const marker = "\nOutput:\n";
  const markerIndex = text.indexOf(marker);
  const output = markerIndex !== -1 ? text.slice(markerIndex + marker.length) : text;
  const metadata = markerIndex !== -1 ? text.slice(0, markerIndex) : text;
  const sessionMatch = metadata.match(
    /(?:Process running with session ID|Call write_stdin\(\{ session_id:) (\d+)(?: \}\))?/,
  );
  const exitCodeMatch = metadata.match(/Process exited with code (-?\d+)/);
  return {
    output,
    sessionId: sessionMatch ? Number(sessionMatch[1]!) : undefined,
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]!) : undefined,
  };
}

function getResultState(result: {
  details?: unknown | undefined;
  content: Array<{ type: string; text?: string | undefined }>;
}): FormattedExecTranscript {
  const details = isUnifiedExecResult(result.details) ? result.details : undefined;
  const content = result.content.find((item) => item.type === "text");
  if (details) {
    return {
      output: details.output,
      sessionId: details.session_id,
      exitCode: details.exit_code,
    };
  }
  if (content?.type === "text") {
    return parseFormattedExecTranscript(content.text ?? "");
  }
  return { output: "" };
}

function parseWriteStdinParams(params: BoundaryValue): WriteStdinParams {
  if (
    !params ||
    !isObjectValue(params) ||
    !("session_id" in params) ||
    !isNumberValue(params.session_id)
  ) {
    throw new Error("write_stdin requires numeric 'session_id'");
  }
  const chars = "chars" in params && isStringValue(params.chars) ? params.chars : undefined;
  const yield_time_ms =
    "yield_time_ms" in params && isNumberValue(params.yield_time_ms)
      ? params.yield_time_ms
      : undefined;
  const max_output_tokens =
    "max_output_tokens" in params && isNumberValue(params.max_output_tokens)
      ? params.max_output_tokens
      : undefined;
  return { session_id: params.session_id, chars, yield_time_ms, max_output_tokens };
}

function isUnifiedExecResult(details: BoundaryValue): details is UnifiedExecResult {
  return isObjectValue(details) && details !== null && isStringValue(details.output);
}

function createEmptyResultComponent(): Container {
  return new Container();
}

export function createWriteStdinTool(
  sessions: ExecSessionManager,
  options: {
    promptSnippet?: boolean | undefined;
    showOutputWhenCollapsed?: boolean | undefined;
  } = {},
) {
  const tool: Parameters<ExtensionAPI["registerTool"]>[0] = {
    name: "write_stdin",
    label: "write_stdin",
    description: "Write/poll exec session",
    parameters: WRITE_STDIN_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate) {
      const typed = parseWriteStdinParams(params);
      const command = sessions.getSessionCommand(typed.session_id) ?? "";
      let result: UnifiedExecResult;
      try {
        const toToolResult = (partial: UnifiedExecResult) => ({
          content: [{ type: "text" as const, text: formatUnifiedExecResult(partial, command) }],
          details: partial,
        });
        result = await sessions.write(
          typed,
          signal,
          onUpdate ? (partial) => onUpdate(toToolResult(partial)) : undefined,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`write_stdin failed: ${message}`);
      }
      return {
        content: [{ type: "text", text: formatUnifiedExecResult(result, command) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      const inputArgs = isObjectValue(args) ? args : {};
      const sessionId = isNumberValue(inputArgs.session_id) ? inputArgs.session_id : "?";
      const input = isStringValue(inputArgs.chars) ? inputArgs.chars : undefined;
      const command = isNumberValue(sessionId) ? sessions.getSessionCommand(sessionId) : undefined;
      return new Text(renderWriteStdinCall(sessionId, input, command, theme), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const state = getResultState(result);
      if (!expanded) {
        if (!isPartial || !options.showOutputWhenCollapsed) return createEmptyResultComponent();
        const output = renderTerminalOutput(state.output).trimEnd();
        const tail = output.slice(-8_000).split("\n").slice(-5).join("\n");
        const status =
          state.sessionId === undefined ? "" : `Session ${state.sessionId} still running`;
        return new Text(
          theme.fg("dim", [tail, status].filter(Boolean).join("\n") || "Waiting for output"),
          0,
          0,
        );
      }
      const output = renderTerminalOutput(state.output);
      let text = theme.fg("dim", output || "(no output)");
      if (state.sessionId !== undefined) {
        text += `\n${theme.fg("accent", `Session ${state.sessionId} still running`)}`;
      }
      if (state.exitCode !== undefined) {
        text += `\n${theme.fg("muted", `Exit code: ${state.exitCode}`)}`;
      }
      return new Text(text, 0, 0);
    },
  };
  if (options.promptSnippet !== false) tool.promptSnippet = "Write to exec session";
  return tool;
}

export function registerWriteStdinTool(
  pi: ExtensionAPI,
  sessions: ExecSessionManager,
  options: {
    promptSnippet?: boolean | undefined;
    showOutputWhenCollapsed?: boolean | undefined;
  } = {},
): void {
  // SAFETY: createWriteStdinTool is typed from ExtensionAPI.registerTool; the assertion only bridges the SDK's generic details variance.
  pi.registerTool(createWriteStdinTool(sessions, options) as any);
}
