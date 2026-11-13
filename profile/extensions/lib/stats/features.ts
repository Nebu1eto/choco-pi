/**
 * Feature attribution for billed calls.
 *
 * A model call is charged to the thing that triggered it: the tool whose
 * result the model was answering, the summarizer that ran it, or the user
 * when nothing else sits between the prompt and the call. The rule is
 * deterministic and puts every call in exactly one bucket, so the feature
 * view reconciles with the totals; it does not charge a tool for the context
 * its earlier results keep occupying.
 */

export const FEATURE_CONVERSATION = "conversation";
export const FEATURE_SUBAGENTS = "subagents";
export const FEATURE_ORCHESTRATION = "subagents (orchestration)";
export const FEATURE_COMPACTION = "compaction & summaries";
export const FEATURE_CACHE_WARMING = "cache warming";
export const FEATURE_TOOL_INTERNAL = "tool-internal";
export const FEATURE_CODE_MODE = "code mode";
export const FEATURE_WEB = "web";
export const FEATURE_ADVISOR = "advisor";
export const FEATURE_BROWSER = "browser";
export const FEATURE_BUILTIN = "built-in tools";
export const FEATURE_OTHER_TOOLS = "other tools";

const MCP_TOOL_PATTERN = /^mcp__([^_].*?)__./;

const CODE_MODE_TOOLS: ReadonlySet<string> = new Set(["exec", "exec_command", "write_stdin"]);
const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "get_subagent_result",
  "get_subagent_status",
  "steer_subagent",
  "stop_subagent",
  "wait",
  "subagent_tree",
  "subagent_limits",
  "set_subagent_daybreak",
  "set_subagent_fast_mode",
  "workflow_run",
  "workflow_update",
  "workflow_cancel",
  "get_workflow_result",
]);
const WEB_TOOLS: ReadonlySet<string> = new Set([
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
]);
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "find",
  "grep",
  "apply_patch",
  "shell_start",
  "shell_read",
  "shell_stop",
  "shell_list",
]);

/** The MCP server name encoded in an `mcp__<server>__<tool>` tool name. */
export function mcpServerOf(toolName: string): string | undefined {
  const match = MCP_TOOL_PATTERN.exec(toolName);
  return match?.[1];
}

/** The bucket label for an MCP server. */
export function mcpFeature(server: string): string {
  return `MCP: ${server}`;
}

/** The result a call was answering: the tool's name and, for code mode, the MCP servers it reached. */
export type TriggerTool = {
  toolName: string;
  /** MCP servers named by the tool result's nested calls, in order. */
  nestedMcpServers: readonly string[];
  /** For code mode: the calls the script made, as recorded in the result's traces. */
  nestedCalls: readonly NestedCall[];
};

/** The feature bucket of a call whose tree parent is the given tool result. */
export function featureForTool(trigger: TriggerTool): string {
  const name = trigger.toolName;
  const server = mcpServerOf(name);
  if (server !== undefined) return mcpFeature(server);
  if (CODE_MODE_TOOLS.has(name)) {
    const nested = trigger.nestedMcpServers[0];
    return nested === undefined ? FEATURE_CODE_MODE : mcpFeature(nested);
  }
  if (ORCHESTRATION_TOOLS.has(name)) return FEATURE_ORCHESTRATION;
  if (WEB_TOOLS.has(name)) return FEATURE_WEB;
  if (name === "advisor") return FEATURE_ADVISOR;
  if (name === "agent_browser" || name.endsWith("_browser") || name.endsWith("_ui"))
    return FEATURE_BROWSER;
  if (BUILTIN_TOOLS.has(name)) return FEATURE_BUILTIN;
  return `tools: ${name}`;
}

/** True for an MCP server bucket. */
export function isMcpFeature(feature: string): boolean {
  return feature.startsWith("MCP: ");
}

/** True for the per-tool buckets the concise view folds into "other tools". */
export function isNamedToolFeature(feature: string): boolean {
  return feature.startsWith("tools: ");
}

/** The bucket of a call that answered a prompt rather than a tool result. */
export function featureForTrigger(trigger: TriggerTool | undefined): string {
  return trigger === undefined ? FEATURE_CONVERSATION : featureForTool(trigger);
}

/** Buckets a code-mode call splits into, by what the script executed. */
export const CODE_MODE_EXEC = "exec/shell";
export const CODE_MODE_LSP = "LSP";
export const CODE_MODE_FILES = "files";
export const CODE_MODE_BROWSER = "browser";
export const CODE_MODE_WEB = "web";
export const CODE_MODE_SUBAGENTS = "subagents";
export const CODE_MODE_SCRIPT = "script only";
export const CODE_MODE_OTHER = "other";

const CODE_MODE_EXEC_TOOLS: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "shell_start",
  "shell_read",
  "shell_stop",
  "shell_list",
]);
const CODE_MODE_LSP_TOOLS: ReadonlySet<string> = new Set([
  "symbol_search",
  "read_symbol",
  "read_enclosing",
  "module_report",
  "project_report",
  "diagnostics_report",
  "diagnostic_mark",
]);
const CODE_MODE_FILE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "find",
  "grep",
  "view_image",
]);

/** One nested call a code-mode script made, as the tool result recorded it. */
export type NestedCall = {
  name: string;
  /** Visible result size in characters; 0 when the result carried no text. */
  size: number;
};

/** The code-mode bucket of one nested call. */
export function codeModeBucket(name: string): string {
  const server = mcpServerOf(name);
  if (server !== undefined) return mcpFeature(server);
  if (CODE_MODE_EXEC_TOOLS.has(name)) return CODE_MODE_EXEC;
  if (name.startsWith("lsp_") || name.startsWith("ast_grep_") || CODE_MODE_LSP_TOOLS.has(name))
    return CODE_MODE_LSP;
  if (CODE_MODE_FILE_TOOLS.has(name)) return CODE_MODE_FILES;
  if (
    name === "agent_browser" ||
    name === "launch_browser" ||
    name.endsWith("_browser") ||
    name.endsWith("_ui") ||
    name === "wait_for"
  )
    return CODE_MODE_BROWSER;
  if (WEB_TOOLS.has(name)) return CODE_MODE_WEB;
  if (ORCHESTRATION_TOOLS.has(name) || name.includes("subagent")) return CODE_MODE_SUBAGENTS;
  return CODE_MODE_OTHER;
}

/**
 * How a code-mode call's tokens and cost split across buckets: by each nested
 * call's result size, since larger results are what the model then reads;
 * evenly when every result is empty; all to "script only" without nested
 * calls. The weights sum to 1.
 */
export function codeModeSplit(nested: readonly NestedCall[]): Map<string, number> {
  const weights = new Map<string, number>();
  if (nested.length === 0) return new Map([[CODE_MODE_SCRIPT, 1]]);
  const totalSize = nested.reduce((sum, call) => sum + Math.max(0, call.size), 0);
  for (const call of nested) {
    const bucket = codeModeBucket(call.name);
    const weight = totalSize > 0 ? Math.max(0, call.size) / totalSize : 1 / nested.length;
    weights.set(bucket, (weights.get(bucket) ?? 0) + weight);
  }
  return weights;
}
