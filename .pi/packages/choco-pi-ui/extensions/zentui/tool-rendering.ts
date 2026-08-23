import {
  AgentSession,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import {
  type BoundaryRecord,
  type BoundaryValue,
  isBoolean,
  isBoundaryRecord,
  isNumber,
  isString,
  parseBoundaryValue,
} from "./runtime-values";
import { DEFAULT_TOOL_LABELS, resolveFinishedToolLabel, resolveToolLabel } from "./tool-labels";

type RenderContextLike = {
  isPartial?: boolean | undefined;
  isError?: boolean | undefined;
  expanded?: boolean | undefined;
  lastComponent?: Component | undefined;
};

type ToolResultLike = {
  content: BoundaryValue[];
  details?: BoundaryValue | undefined;
};

type PatchedSessionPrototype = AgentSession & {
  __chocoPiZentuiToolRenderingApplied?: boolean;
};

const decorations = new WeakMap<object, ToolDefinition>();

function compact(value: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

function record(value: BoundaryValue): BoundaryRecord | undefined {
  return isBoundaryRecord(value) ? value : undefined;
}

function stringField(value: BoundaryRecord | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (isString(candidate) && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function numberField(value: BoundaryRecord | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return isNumber(candidate) && Number.isFinite(candidate) ? candidate : undefined;
}

function booleanField(value: BoundaryRecord | undefined, key: string): boolean | undefined {
  const candidate = value?.[key];
  return isBoolean(candidate) ? candidate : undefined;
}

function arrayCount(value: BoundaryRecord | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return Array.isArray(candidate) ? candidate.length : undefined;
}

function join(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function idSummary(
  args: BoundaryRecord | undefined,
  key: string,
  label: string,
): string | undefined {
  const id = stringField(args, key);
  return id ? `${label} ${compact(id, 48)}` : undefined;
}

function pathSummary(args: BoundaryRecord | undefined): string | undefined {
  const path = stringField(args, "path");
  if (path) return compact(path, 100);
  const paths = args?.["paths"];
  return Array.isArray(paths) ? `${paths.length} paths` : undefined;
}

/** Concise, producer-aware argument text. Never serializes the argument object. */
export function summarizeToolInput(name: string, value: BoundaryValue): string {
  const args = record(value);
  switch (name) {
    case "tool_search":
      return join([
        compact(stringField(args, "query") ?? "", 100),
        numberField(args, "limit") ? `limit ${numberField(args, "limit")}` : undefined,
      ]);
    case "get_subagent_result":
      return join([
        idSummary(args, "agent_id", "Agent"),
        booleanField(args, "wait") ? "wait" : undefined,
        booleanField(args, "verbose") ? "verbose" : undefined,
      ]);
    case "steer_subagent":
      return join([
        idSummary(args, "agent_id", "Agent"),
        compact(stringField(args, "message") ?? "", 90),
      ]);
    case "workflow_run":
      return join([
        stringField(args, "name"),
        arrayCount(args, "steps") !== undefined ? `${arrayCount(args, "steps")} steps` : undefined,
        booleanField(args, "dynamic") ? "dynamic" : undefined,
      ]);
    case "workflow_update":
      return join([
        idSummary(args, "workflow_id", "Workflow"),
        arrayCount(args, "steps") !== undefined ? `${arrayCount(args, "steps")} steps` : undefined,
        booleanField(args, "finish") ? "finish" : undefined,
      ]);
    case "get_workflow_result":
      return join([
        idSummary(args, "workflow_id", "Workflow"),
        booleanField(args, "wait") ? "wait" : undefined,
      ]);
    case "workflow_cancel":
      return idSummary(args, "workflow_id", "Workflow") ?? "Current workflow";
    case "session_create":
      return join([
        stringField(args, "name") ?? "New conversation",
        stringField(args, "model"),
        stringField(args, "effort"),
        compact(stringField(args, "initial_prompt") ?? "", 80),
      ]);
    case "session_send":
      return join([
        idSummary(args, "session_id", "Session"),
        stringField(args, "mode"),
        compact(stringField(args, "message") ?? "", 80),
      ]);
    case "session_list":
      return "Current project";
    case "session_read":
      return join([
        idSummary(args, "session_id", "Session"),
        numberField(args, "limit") ? `limit ${numberField(args, "limit")}` : undefined,
        booleanField(args, "include_tools") ? "with tools" : undefined,
      ]);
    case "session_wait":
      return join([
        idSummary(args, "session_id", "Session"),
        numberField(args, "timeout_ms") !== undefined
          ? `${numberField(args, "timeout_ms")}ms`
          : undefined,
        stringField(args, "after_cursor") ? "after cursor" : undefined,
      ]);
    case "create_goal":
      return join([
        compact(stringField(args, "objective") ?? "", 100),
        numberField(args, "token_budget")
          ? `${numberField(args, "token_budget")} tokens`
          : undefined,
        booleanField(args, "replace_existing") ? "replace existing" : undefined,
      ]);
    case "update_goal":
      return stringField(args, "status") ?? "Complete current goal";
    case "get_goal":
      return "Current goal";
    case "web_search": {
      const queries = arrayCount(args, "queries");
      return join([
        queries ? `${queries} queries` : compact(stringField(args, "query") ?? "", 100),
        stringField(args, "provider"),
      ]);
    }
    case "source_check":
      return join([
        compact(stringField(args, "claim") ?? "", 100),
        arrayCount(args, "queries") ? `${arrayCount(args, "queries")} queries` : undefined,
      ]);
    case "fetch_content":
      return join([
        arrayCount(args, "urls")
          ? `${arrayCount(args, "urls")} URLs`
          : compact(stringField(args, "url") ?? "", 100),
        stringField(args, "mode"),
      ]);
    case "get_search_content":
      return join([
        compact(stringField(args, "responseId") ?? "", 48),
        stringField(args, "findText")
          ? `find ${compact(stringField(args, "findText")!, 60)}`
          : undefined,
      ]);
    case "symbol_search":
      return join([compact(stringField(args, "query") ?? "", 100), stringField(args, "lang")]);
    case "project_report":
      return join([
        compact(stringField(args, "focus") ?? "Project structure", 90),
        stringField(args, "view"),
      ]);
    case "module_report":
      return join([pathSummary(args), compact(stringField(args, "focus") ?? "", 70)]);
    case "read_symbol":
      return join([pathSummary(args), stringField(args, "symbol")]);
    case "read_enclosing":
      return join([
        pathSummary(args),
        numberField(args, "line") !== undefined ? `line ${numberField(args, "line")}` : undefined,
      ]);
    case "lsp_diagnostics":
      return join([
        pathSummary(args),
        stringField(args, "severity"),
        stringField(args, "serverScope"),
      ]);
    case "diagnostics_report":
      return join([
        stringField(args, "mode") ?? "delta",
        pathSummary(args),
        stringField(args, "severity"),
      ]);
    default:
      return "";
  }
}

function textContent(result: ToolResultLike): string {
  return result.content
    .flatMap((item) => {
      const entry = record(item);
      return entry?.["type"] === "text" && isString(entry["text"]) ? [entry["text"]] : [];
    })
    .join("\n");
}

function parseJsonText(text: string): BoundaryValue | undefined {
  const trimmed = text.trim();
  const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) return undefined;
  try {
    return parseBoundaryValue(JSON.parse(trimmed.slice(start)));
  } catch {
    return undefined;
  }
}

function readableKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function scalar(value: BoundaryValue): string | undefined {
  if (isString(value)) return compact(value, 80);
  if (isNumber(value) || isBoolean(value)) return String(value);
  return undefined;
}

function summarizeRecord(value: BoundaryRecord): string {
  const parts: string[] = [];
  for (const key of [
    "status",
    "name",
    "workflowId",
    "sessionId",
    "id",
    "model",
    "delivered",
    "error",
  ]) {
    const rendered = scalar(value[key]);
    if (rendered) parts.push(`${readableKey(key)} ${rendered}`);
  }
  for (const key of [
    "steps",
    "items",
    "messages",
    "matches",
    "added",
    "sessions",
    "sources",
    "passages",
  ]) {
    const count = Array.isArray(value[key]) ? value[key].length : undefined;
    if (count !== undefined) parts.push(`${count} ${readableKey(key)}`);
  }
  for (const key of ["sourceCount", "passageCount", "messageCount"]) {
    const count = numberField(value, key);
    if (count !== undefined) parts.push(`${readableKey(key)} ${count}`);
  }
  for (const key of ["changed", "timedOut", "dynamic", "sealed"]) {
    const flag = booleanField(value, key);
    if (flag !== undefined) parts.push(`${readableKey(key)} ${flag ? "yes" : "no"}`);
  }
  return parts.slice(0, 4).join(" · ");
}

function semanticText(text: string, expanded: boolean): string {
  const parsed = parseJsonText(text);
  if (Array.isArray(parsed)) return `${parsed.length} items`;
  const parsedRecord = record(parsed);
  if (parsedRecord) return summarizeRecord(parsedRecord) || "Completed";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  return lines
    .slice(0, expanded ? 8 : 2)
    .map((line) => compact(line, 140))
    .join("\n");
}

/** Concise result text. JSON payloads are reduced to named facts and counts. */
export function summarizeToolResult(
  name: string,
  result: ToolResultLike,
  expanded = false,
): string {
  const details = record(result.details);
  if (name === "tool_search") {
    return (
      join([
        arrayCount(details, "matches") !== undefined
          ? `${arrayCount(details, "matches")} matches`
          : undefined,
        arrayCount(details, "added") ? `${arrayCount(details, "added")} activated` : undefined,
      ]) || "No matches"
    );
  }
  if (name === "source_check") {
    return (
      join([
        numberField(details, "sourceCount") !== undefined
          ? `${numberField(details, "sourceCount")} sources`
          : undefined,
        numberField(details, "passageCount") !== undefined
          ? `${numberField(details, "passageCount")} passages`
          : undefined,
        idSummary(details, "responseId", "Response"),
      ]) || "Source check complete"
    );
  }
  if (name === "session_list" && Array.isArray(result.details))
    return `${result.details.length} conversations`;
  if (name.startsWith("session_") && details)
    return summarizeRecord(details) || "Session operation complete";
  if (name.endsWith("goal")) {
    const goal = record(details?.["goal"]);
    return goal
      ? join([stringField(goal, "status"), compact(stringField(goal, "objective") ?? "", 110)])
      : "No active goal";
  }
  const detailSummary = details ? summarizeRecord(details) : "";
  if (detailSummary) return detailSummary;
  return semanticText(textContent(result), expanded) || "Completed";
}

function callRenderer(name: string) {
  return (args: BoundaryValue, theme: Theme, context: RenderContextLike): Component => {
    const label =
      context.isPartial === false ? resolveFinishedToolLabel(name) : resolveToolLabel(name);
    const summary = summarizeToolInput(name, args);
    let text = `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(label))}`;
    if (summary) text += `\n${theme.fg("dim", "  └ ")}${theme.fg("accent", summary)}`;
    return new Text(text, 0, 0);
  };
}

function resultRenderer(name: string) {
  return (
    result: ToolResultLike,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContextLike,
  ): Component => {
    const summary = summarizeToolResult(name, result, options.expanded);
    return new Text(theme.fg(context.isError ? "error" : "toolOutput", summary), 4, 0);
  };
}

/** Adds semantic renderers only where the tool producer supplied none. */
export function decorateToolDefinition(definition: ToolDefinition): ToolDefinition {
  if (!Object.hasOwn(DEFAULT_TOOL_LABELS, definition.name)) return definition;
  if (definition.renderCall && definition.renderResult) return definition;
  const cached = decorations.get(definition);
  if (cached) return cached;

  // SAFETY: the clone preserves the host definition; only missing renderer callbacks are added.
  const next = { ...definition } as ToolDefinition;
  if (!next.renderCall) {
    // SAFETY: the callback uses the documented renderer argument and component shapes.
    next.renderCall = callRenderer(definition.name) as ToolDefinition["renderCall"];
  }
  if (!next.renderResult) {
    // SAFETY: the callback uses the documented renderer argument and component shapes.
    next.renderResult = resultRenderer(definition.name) as ToolDefinition["renderResult"];
  }
  decorations.set(definition, next);
  return next;
}

/** Installs the transcript-only renderer decorator once across extension reloads. */
export function installToolRendering(): void {
  // SAFETY: AgentSession owns getToolDefinition; this guarded patch changes rendering metadata only.
  const prototype = AgentSession.prototype as PatchedSessionPrototype;
  if (prototype.__chocoPiZentuiToolRenderingApplied) return;
  const getToolDefinition = prototype.getToolDefinition;
  prototype.getToolDefinition = function getZentuiToolDefinition(
    this: AgentSession,
    name: string,
  ): ToolDefinition | undefined {
    const definition = getToolDefinition.call(this, name);
    if (!definition) return definition;
    try {
      return decorateToolDefinition(definition);
    } catch {
      return definition;
    }
  };
  prototype.__chocoPiZentuiToolRenderingApplied = true;
}
