/**
 * Working-line labels for tools.
 *
 * Pi reports the registered tool name (`apply_patch`), which is an API
 * identifier rather than something to show a reader mid-turn. These labels
 * describe what the tool is doing instead, in the same present-participle
 * voice the working line already uses, and stay inside
 * `MAX_WORKING_LINE_TOOL_CELLS` so the row never truncates them.
 *
 * A name with no entry falls back to the registered name, so a newly
 * installed extension still shows something useful.
 */
export const DEFAULT_TOOL_LABELS = {
  // Pi built-ins
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  bash: "Running",
  grep: "Searching",
  find: "Finding files",
  ls: "Listing",

  // choco-pi-codex
  apply_patch: "Patching",
  exec_command: "Running",
  write_stdin: "Sending input",
  web_run: "Browsing",
  imagegen: "Generating image",
  view_image: "Viewing image",

  // Tool discovery and MCP
  tool_search: "Finding tools",
  mcp: "Calling MCP",
  mcpScript: "Scripting MCP",
  synthetic_web_search: "Searching web",

  // Sub-agents, conversations, and workflows
  Agent: "Delegating",
  get_subagent_result: "Collecting agent",
  steer_subagent: "Steering agent",
  workflow_run: "Running workflow",
  workflow_update: "Updating workflow",
  workflow_cancel: "Ending workflow",
  get_workflow_result: "Collecting flow",
  session_create: "Opening session",
  session_send: "Messaging session",
  session_list: "Listing sessions",
  session_read: "Reading session",
  session_wait: "Awaiting session",

  // Goals
  create_goal: "Creating goal",
  update_goal: "Updating goal",
  get_goal: "Reading goal",

  // choco-pi-lsp
  lsp_diagnostics: "Checking code",
  diagnostics_report: "Reporting issues",
  lsp_navigation: "Navigating code",
  symbol_search: "Searching symbols",
  module_report: "Outlining module",
  read_symbol: "Reading symbol",
  read_enclosing: "Reading symbol",
  ast_grep_search: "Searching AST",
  ast_grep_replace: "Rewriting AST",
  ast_grep_outline: "Outlining AST",
  ast_grep_dump: "Dumping AST",
  lsp_activate_tools: "Activating tools",
} satisfies Readonly<Record<string, string>>;

/** Registered tool names this package ships a label for. */
export type KnownToolName = keyof typeof DEFAULT_TOOL_LABELS;

const MCP_TOOL_PREFIX = "mcp__";

function knownLabel(name: string): string | undefined {
  // SAFETY: the `Object.hasOwn` guard on this expression establishes the key before the lookup.
  return Object.hasOwn(DEFAULT_TOOL_LABELS, name)
    ? DEFAULT_TOOL_LABELS[name as KnownToolName]
    : undefined;
}

/**
 * Resolves the label shown for a tool: a user override first, then the
 * built-in table, then a readable form of an `mcp__server_tool` name, and
 * finally the registered name itself.
 */
export function resolveToolLabel(
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  const override = overrides?.[name];
  if (override !== undefined && override.trim() !== "") return override;
  const known = knownLabel(name);
  if (known !== undefined) return known;
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const server = name.slice(MCP_TOOL_PREFIX.length).split("_")[0];
    if (server) return `MCP ${server}`;
  }
  return name;
}
