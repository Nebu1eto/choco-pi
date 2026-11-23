import {
  type PiToolArguments,
  type PiToolResult,
  stringField,
  type PiAssistantToolCall,
} from "../pi-rpc/protocol.ts";
import type { SessionUpdate, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { EditorToolPresentation } from "../translate/tool-presentation.ts";
import {
  bashCommand,
  bashExitCode,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  type BashTerminalInfo,
  type BashTerminalOutput,
  type BashTerminalExit,
} from "./translate/bash.ts";
import {
  type BoundaryValue,
  isBoundaryRecord,
  isString,
  parseJsonLine,
  isBoundaryArray,
  isObjectValue,
} from "../boundary.ts";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { MAX_EXTENSION_UI_TEXT_LENGTH } from "./session-extension-ui.ts";

export type RawInputTruncation = {
  truncated: true;
  originalCharacters?: number;
  limitCharacters: number;
};

export type BoundedToolRawInput = {
  rawInput: PiToolArguments;
  truncation?: RawInputTruncation;
};

export type ToolCallUpdateNotification = Extract<
  SessionUpdate,
  { sessionUpdate: "tool_call_update" }
>;

export type ToolCallMeta = {
  editorToolPresentation: EditorToolPresentation;
  piAcp?: { rawInputTruncation: RawInputTruncation };
};

export type BashToolCallMeta = {
  terminal_info: BashTerminalInfo;
  editorToolPresentation: EditorToolPresentation | undefined;
};

export type BashOutputMeta = {
  terminal_output?: BashTerminalOutput;
  terminal_exit?: BashTerminalExit;
  editorToolPresentation: EditorToolPresentation | undefined;
};

export type ParsedEdit = {
  oldText: string;
  newText: string;
};

export function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined;

  const first = text.indexOf(needle);
  if (first < 0) return undefined;

  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return undefined;

  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function getToolPath(args: PiToolArguments): string | undefined {
  return stringField(args, "path") ?? stringField(args, "file_path");
}

export function editEntries(args: PiToolArguments): BoundaryValue[] {
  if (!isBoundaryRecord(args)) return [];
  const edits = args.edits;
  const decoded = isString(edits) ? parseJsonLine(edits) : edits;
  return isBoundaryArray(decoded) ? decoded : [];
}

export function getParsedEdits(args: PiToolArguments): ParsedEdit[] {
  const parsed: ParsedEdit[] = [];

  const rootOldText = stringField(args, "oldText");
  const rootNewText = stringField(args, "newText");
  if (rootOldText !== undefined && rootNewText !== undefined) {
    parsed.push({ oldText: rootOldText, newText: rootNewText });
  }

  for (const edit of editEntries(args)) {
    const oldText = stringField(edit, "oldText");
    const newText = stringField(edit, "newText");
    if (oldText !== undefined && newText !== undefined) parsed.push({ oldText, newText });
  }

  return parsed;
}

export function getEditOldTexts(args: PiToolArguments): string[] {
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);

  const rootOldText = stringField(args, "oldText");
  if (rootOldText !== undefined && !oldTexts.includes(rootOldText)) oldTexts.push(rootOldText);

  for (const edit of editEntries(args)) {
    const oldText = stringField(edit, "oldText");
    if (oldText !== undefined && !oldTexts.includes(oldText)) oldTexts.push(oldText);
  }

  return oldTexts;
}

export function toToolCallLocations(
  args: PiToolArguments,
  cwd: string,
  line?: number,
): ToolCallLocation[] | undefined {
  const path = getToolPath(args);
  if (!path) return undefined;

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  const location: ToolCallLocation = { path: resolvedPath };
  if (line !== undefined) location.line = line;
  return [location];
}

export function streamedToolArguments(toolCall: PiAssistantToolCall | undefined): PiToolArguments {
  const args = toolCall?.arguments;
  if (isObjectValue(args) || isBoundaryArray(args)) return args;

  const partialArgs = toolCall?.partialArgs ?? "";
  if (!partialArgs) return undefined;
  const parsed = parseJsonLine(partialArgs);
  return parsed === undefined ? { partialArgs } : parsed;
}

export function boundedToolRawInput(value: PiToolArguments): BoundedToolRawInput {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      rawInput: { preview: "Raw input could not be serialized." },
      truncation: { truncated: true, limitCharacters: MAX_EXTENSION_UI_TEXT_LENGTH },
    };
  }
  if (serialized === undefined || serialized.length <= MAX_EXTENSION_UI_TEXT_LENGTH) {
    return { rawInput: value };
  }

  const indicator = "\n…[truncated]";
  return {
    rawInput: {
      preview: `${serialized.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH - indicator.length)}${indicator}`,
    },
    truncation: {
      truncated: true,
      originalCharacters: serialized.length,
      limitCharacters: MAX_EXTENSION_UI_TEXT_LENGTH,
    },
  };
}

export function toolCallMeta(
  presentation: EditorToolPresentation,
  boundedInput: BoundedToolRawInput,
): ToolCallMeta {
  const meta: ToolCallMeta = { editorToolPresentation: presentation };
  const truncation = boundedInput.truncation;
  if (truncation) meta.piAcp = { rawInputTruncation: truncation };
  return meta;
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

export type BashToolCallParams = {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  toolName: string;
  args: PiToolArguments;
  status: "pending" | "in_progress";
  locations?: ToolCallLocation[];
  includeTerminal: boolean;
  presentation?: EditorToolPresentation;
};

export function bashToolCallUpdate(params: BashToolCallParams, cwd: string): SessionUpdate {
  const title = bashCommand(params.args) ?? params.toolName;

  if (params.includeTerminal) {
    const meta: BashToolCallMeta = {
      terminal_info: bashTerminalInfoMeta(params.toolCallId, cwd).terminal_info,
      editorToolPresentation: params.presentation,
    };
    return {
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title,
      kind: "execute",
      status: params.status,
      locations: params.locations,
      content: bashTerminalContent(params.toolCallId),
      _meta: meta,
    };
  }

  return {
    sessionUpdate: params.sessionUpdate,
    toolCallId: params.toolCallId,
    title,
    kind: "execute",
    status: params.status,
    locations: params.locations,
  };
}

export type BashOutputParams = {
  toolCallId: string;
  status: "in_progress" | "completed" | "failed";
  result: PiToolResult;
  textOverride?: string;
  isError?: boolean;
  presentation?: EditorToolPresentation;
  locations?: ToolCallLocation[];
};

export function bashOutputUpdate(params: BashOutputParams, delta: string): SessionUpdate {
  const meta: BashOutputMeta = { editorToolPresentation: params.presentation };
  if (delta) {
    meta.terminal_output = bashTerminalOutputMeta(params.toolCallId, delta).terminal_output;
  }
  if (params.status === "completed" || params.status === "failed") {
    meta.terminal_exit = bashTerminalExitMeta(
      params.toolCallId,
      bashExitCode(params.result, Boolean(params.isError)),
    ).terminal_exit;
  }

  return {
    sessionUpdate: "tool_call_update",
    toolCallId: params.toolCallId,
    status: params.status,
    locations: params.locations,
    _meta: meta,
  };
}
