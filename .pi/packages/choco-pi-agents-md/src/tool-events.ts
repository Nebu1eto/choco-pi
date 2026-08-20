import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

type HostBoundaryValue = {} | null | undefined;
interface HostToolInput {
  path?: HostBoundaryValue;
  workdir?: HostBoundaryValue;
  cwd?: HostBoundaryValue;
  working_directory?: HostBoundaryValue;
  command?: HostBoundaryValue;
  cmd?: HostBoundaryValue;
  codeMode?: HostBoundaryValue;
  traces?: HostBoundaryValue;
  status?: HostBoundaryValue;
  name?: HostBoundaryValue;
  input?: HostBoundaryValue;
  result?: HostBoundaryValue;
  content?: HostBoundaryValue;
}

const ToolContentSchema = Type.Object(
  {
    type: Type.String(),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type ToolContent = Static<typeof ToolContentSchema>;

interface CodeModeDetails {
  codeMode: true;
  traces: HostBoundaryValue[];
}

interface CompletedCodeModeTrace {
  name: string;
  input: HostToolInput;
  status: "done";
  result: {
    content: HostBoundaryValue[];
  };
}

function isHostObject(value: HostBoundaryValue): value is HostToolInput {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

function parseCodeModeDetails(value: HostBoundaryValue): CodeModeDetails | undefined {
  if (!isHostObject(value) || value.codeMode !== true || !Array.isArray(value.traces)) {
    return undefined;
  }
  return { codeMode: true, traces: value.traces };
}

function parseCompletedCodeModeTrace(value: HostBoundaryValue): CompletedCodeModeTrace | undefined {
  if (!isHostObject(value) || value.status !== "done" || !Value.Check(Type.String(), value.name)) {
    return undefined;
  }
  if (!isHostObject(value.input) || !isHostObject(value.result)) return undefined;
  if (!Array.isArray(value.result.content)) return undefined;
  return {
    name: value.name,
    input: value.input,
    status: "done",
    result: { content: value.result.content },
  };
}

export interface DiscoveryToolInput {
  path?: string;
  workdir?: string;
  cwd?: string;
  working_directory?: string;
  command?: string;
  cmd?: string;
}

export interface DiscoveryToolResultEvent {
  toolName: string;
  input: DiscoveryToolInput;
  content: ToolContent[];
}

function parseDiscoveryToolInput(input: HostToolInput): DiscoveryToolInput {
  const parsed: DiscoveryToolInput = {};
  const pathValue = input["path"];
  const workdirValue = input["workdir"];
  const cwdValue = input["cwd"];
  const workingDirectoryValue = input["working_directory"];
  const commandValue = input["command"];
  const cmdValue = input["cmd"];

  if (Value.Check(Type.String(), pathValue)) parsed.path = pathValue;
  if (Value.Check(Type.String(), workdirValue)) parsed.workdir = workdirValue;
  if (Value.Check(Type.String(), cwdValue)) parsed.cwd = cwdValue;
  if (Value.Check(Type.String(), workingDirectoryValue)) {
    parsed.working_directory = workingDirectoryValue;
  }
  if (Value.Check(Type.String(), commandValue)) parsed.command = commandValue;
  if (Value.Check(Type.String(), cmdValue)) parsed.cmd = cmdValue;

  return parsed;
}

/**
 * Expand a host tool result into the outer event plus completed nested tools
 * recorded by Pi code mode in `details.traces`.
 */
export function codeModeDiscoveryEvents(event: ToolResultEvent): DiscoveryToolResultEvent[] {
  const events: DiscoveryToolResultEvent[] = [
    {
      toolName: event.toolName,
      input: parseDiscoveryToolInput(event.input),
      content: event.content,
    },
  ];
  const details = parseCodeModeDetails(event.details);
  if (!details) return events;

  for (const value of details.traces) {
    const trace = parseCompletedCodeModeTrace(value);
    if (!trace) continue;
    const content = trace.result.content.filter((item): item is ToolContent =>
      Value.Check(ToolContentSchema, item),
    );
    events.push({
      toolName: trace.name,
      input: parseDiscoveryToolInput(trace.input),
      content,
    });
  }
  return events;
}
