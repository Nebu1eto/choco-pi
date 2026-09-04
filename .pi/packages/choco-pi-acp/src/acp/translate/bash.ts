import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { type BoundaryValue, isBoundaryRecord, isNumber, isString } from "../../boundary.ts";
import {
  stringField,
  toolResultText,
  type PiToolArguments,
  type PiToolResult,
} from "../../pi-rpc/protocol.ts";

/** Nested containers Pi has been observed to wrap bash arguments in. */
const BASH_COMMAND_CONTAINERS = ["args", "input", "rawInput", "toolInput", "details"] as const;

/** Terminal identity metadata Zed reads to render an execute tool as a terminal. */
export type BashTerminalInfo = {
  terminal_id: string;
  cwd: string;
};

/** Incremental terminal output metadata for one bash tool call. */
export type BashTerminalOutput = {
  terminal_id: string;
  data: string;
};

/** Terminal completion metadata for one bash tool call. */
export type BashTerminalExit = {
  terminal_id: string;
  exit_code: number;
  signal: null;
};

export type BashTerminalInfoMeta = { terminal_info: BashTerminalInfo };
export type BashTerminalOutputMeta = { terminal_output: BashTerminalOutput };
export type BashTerminalExitMeta = { terminal_exit: BashTerminalExit };

export function isBashTool(toolName: string): boolean {
  return toolName.toLowerCase() === "bash";
}

/** Read `key` from an undecoded value without deciding what the field holds. */
function propertyValue(value: BoundaryValue, key: string): BoundaryValue {
  return isBoundaryRecord(value) ? value[key] : undefined;
}

/** First field that is present (neither `null` nor `undefined`), in caller order. */
function firstPresent(candidates: readonly BoundaryValue[]): BoundaryValue {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

export function bashCommand(value: PiToolArguments): string | undefined {
  const candidates: BoundaryValue[] = [
    propertyValue(value, "command"),
    propertyValue(value, "cmd"),
  ];
  for (const container of BASH_COMMAND_CONTAINERS) {
    const nested = propertyValue(value, container);
    candidates.push(propertyValue(nested, "command"), propertyValue(nested, "cmd"));
  }

  const command = firstPresent(candidates);
  return isString(command) && command.trim() ? command : undefined;
}

export function bashResultText(result: PiToolResult): string {
  const blocks = toolResultText(result);
  if (blocks) return blocks;

  const details = propertyValue(result, "details");
  const stdout =
    stringField(details, "stdout") ??
    stringField(result, "stdout") ??
    stringField(details, "output") ??
    stringField(result, "output");
  const stderr = stringField(details, "stderr") ?? stringField(result, "stderr");

  return [stdout, stderr].filter((part) => part !== undefined && part.length > 0).join("\n");
}

export function bashExitCode(result: PiToolResult, isError: boolean): number {
  const details = propertyValue(result, "details");
  const exitCode = firstPresent([
    propertyValue(details, "exitCode"),
    propertyValue(result, "exitCode"),
    propertyValue(details, "code"),
    propertyValue(result, "code"),
  ]);
  if (isNumber(exitCode)) return exitCode;
  return isError ? 1 : 0;
}

export function bashOutputDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

export function bashTerminalContent(toolCallId: string): ToolCallContent[] {
  return [{ type: "terminal", terminalId: toolCallId }] satisfies ToolCallContent[];
}

export function bashTerminalInfoMeta(toolCallId: string, cwd: string): BashTerminalInfoMeta {
  // Zed renders ACP `execute` tools as display-only terminals when paired with
  // terminal content plus terminal metadata. See ACP execute tool schema:
  // https://agentclientprotocol.com/protocol/schema#param-execute
  return { terminal_info: { terminal_id: toolCallId, cwd } };
}

export function bashTerminalOutputMeta(toolCallId: string, data: string): BashTerminalOutputMeta {
  return { terminal_output: { terminal_id: toolCallId, data } };
}

export function bashTerminalExitMeta(toolCallId: string, exitCode: number): BashTerminalExitMeta {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } };
}
