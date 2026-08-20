import * as path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

type HostBoundaryValue = {} | null | undefined;
interface HostObject {
  path?: HostBoundaryValue;
  codeMode?: HostBoundaryValue;
  traces?: HostBoundaryValue;
  name?: HostBoundaryValue;
  status?: HostBoundaryValue;
  input?: HostBoundaryValue;
  result?: HostBoundaryValue;
  content?: HostBoundaryValue;
  details?: HostBoundaryValue;
  isError?: HostBoundaryValue;
  createdFiles?: HostBoundaryValue;
  changedFiles?: HostBoundaryValue;
}

const ContentItemSchema = Type.Object({
  type: Type.String(),
  text: Type.Optional(Type.String()),
});
type ContentItem = Static<typeof ContentItemSchema>;

interface CodeModeDetails {
  codeMode: true;
  traces: HostBoundaryValue[];
}

interface CompletedTraceResult extends HostObject {
  content: HostBoundaryValue[];
}

interface CompletedTrace {
  name: string;
  status: "done";
  input?: HostBoundaryValue;
  result: CompletedTraceResult;
}

function isHostObject(value: HostBoundaryValue): value is HostObject {
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

function parseCompletedTrace(value: HostBoundaryValue): CompletedTrace | undefined {
  if (!isHostObject(value) || value.status !== "done" || !Value.Check(Type.String(), value.name)) {
    return undefined;
  }
  if (!isHostObject(value.result) || !Array.isArray(value.result.content)) return undefined;
  return {
    name: value.name,
    status: "done",
    input: value.input,
    result: {
      content: value.result.content,
      details: value.result.details,
      isError: value.result.isError,
    },
  };
}

export interface DispatchableToolResult {
  toolName: "edit" | "write";
  input: { path: string } & HostObject;
  content: ContentItem[];
  details?: unknown;
  isError?: boolean;
}

function absolutePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/**
 * Expand completed mutation tools recorded by Pi code mode inside an outer
 * `exec` result. Synthetic paths are absolute because nested traces do not have
 * their own host `tool_call` event from which path attribution can be recorded.
 */
export function codeModeMutationToolResults(
  event: { details?: HostBoundaryValue },
  cwd: string,
): DispatchableToolResult[] {
  const details = parseCodeModeDetails(event.details);
  if (!details) return [];

  const events: DispatchableToolResult[] = [];
  for (const value of details.traces) {
    const trace = parseCompletedTrace(value);
    if (!trace) continue;
    const content = trace.result.content.filter((item): item is ContentItem =>
      Value.Check(ContentItemSchema, item),
    );

    if (trace.name === "edit" || trace.name === "write") {
      if (!isHostObject(trace.input)) continue;
      const inputPath = trace.input.path;
      if (!Value.Check(Type.String(), inputPath)) continue;
      events.push({
        toolName: trace.name,
        input: { ...trace.input, path: absolutePath(inputPath, cwd) },
        content,
        details: trace.result.details,
        isError: trace.result.isError === true,
      });
      continue;
    }

    if (trace.name !== "apply_patch") continue;
    const patchDetails = trace.result.details;
    if (!isHostObject(patchDetails) || patchDetails.status !== "success") continue;
    const patchResult = patchDetails.result;
    if (!isHostObject(patchResult)) continue;
    const createdFiles = patchResult.createdFiles;
    const changedFiles = patchResult.changedFiles;
    const created = new Set(
      Array.isArray(createdFiles)
        ? createdFiles.filter((filePath): filePath is string =>
            Value.Check(Type.String(), filePath),
          )
        : [],
    );
    const changed = Array.isArray(changedFiles)
      ? changedFiles.filter((filePath): filePath is string => Value.Check(Type.String(), filePath))
      : [];
    for (const filePath of new Set([...changed, ...created])) {
      events.push({
        toolName: created.has(filePath) ? "write" : "edit",
        input: { path: absolutePath(filePath, cwd) },
        content,
        details: patchDetails,
      });
    }
  }
  return events;
}
