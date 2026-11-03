import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, type Static, str } from "@earendil-works/pi-schema";

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

const ToolContentSchema = obj({ type: str(), text: opt(str()) }, { open: true });
export type ToolContent = Static<typeof ToolContentSchema>;

// Host tool-call payloads are in-process JSON-like objects; compiled guards keep
// the former TypeBox accept/reject behaviour (open objects, no coercion).
const isStringValue = compile(str()).check;
const isToolContent = compile(ToolContentSchema).check;

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
  if (!isHostObject(value) || value.status !== "done" || !isStringValue(value.name)) {
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

  if (isStringValue(pathValue)) parsed.path = pathValue;
  if (isStringValue(workdirValue)) parsed.workdir = workdirValue;
  if (isStringValue(cwdValue)) parsed.cwd = cwdValue;
  if (isStringValue(workingDirectoryValue)) {
    parsed.working_directory = workingDirectoryValue;
  }
  if (isStringValue(commandValue)) parsed.command = commandValue;
  if (isStringValue(cmdValue)) parsed.cmd = cmdValue;

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
    const content = trace.result.content.filter((item): item is ToolContent => isToolContent(item));
    events.push({
      toolName: trace.name,
      input: parseDiscoveryToolInput(trace.input),
      content,
    });
  }
  return events;
}
