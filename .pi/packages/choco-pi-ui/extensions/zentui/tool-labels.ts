/**
 * Working-line labels for tools.
 *
 * Pi reports the registered tool name (`apply_patch`), which is an API
 * identifier rather than something to show a reader mid-turn. These labels
 * describe what the tool is doing instead, as `Category: Doing [Object]`:
 * a family prefix so a reader can tell delegation from file work at a
 * glance, then the present-participle voice the working line already uses
 * ("Delegation: Steering", "LSP: Analysing Module"). Every label stays
 * inside `MAX_WORKING_LINE_TOOL_CELLS` so the row never truncates it.
 *
 * A tool call outlives the work it describes, so each label also has a
 * completed form in the past tense Pi's own settled rows use ("Ran",
 * "Explored"): `Delegation: Steered`, `LSP: Analysed Module`. The working
 * line only ever shows a running tool and therefore reads the in-progress
 * table; a transcript row that has already settled reads the finished one.
 *
 * A name with no entry falls back to the registered name, so a newly
 * installed extension still shows something useful.
 */
export const DEFAULT_TOOL_LABELS = {
  // Files — Pi built-ins and choco-pi-codex's patch tool
  read: "File: Reading",
  write: "File: Writing",
  edit: "File: Editing",
  apply_patch: "File: Patching",
  ls: "File: Listing",
  find: "File: Finding Files",
  grep: "File: Searching",

  // Shell — Pi built-ins and choco-pi-codex's exec session tools
  bash: "Shell: Running",
  exec: "Shell: Running",
  exec_command: "Shell: Running",
  wait: "Shell: Waiting",
  write_stdin: "Shell: Sending Input",

  // Web
  web_run: "Web: Browsing",
  web_search: "Web: Searching",
  source_check: "Web: Checking Sources",
  fetch_content: "Web: Fetching Content",
  get_search_content: "Web: Reading Content",
  synthetic_web_search: "Web: Searching",

  // Images
  imagegen: "Image: Generating",
  view_image: "Image: Viewing",

  // Tool discovery and MCP
  tool_search: "Tools: Searching",
  mcp: "MCP: Calling",
  mcpScript: "MCP: Scripting",

  // Sub-agents
  Agent: "Delegation: Launching",
  get_subagent_result: "Delegation: Retrieving",
  steer_subagent: "Delegation: Steering",

  // Sub-agent workflows
  workflow_run: "Workflow: Running",
  workflow_update: "Workflow: Updating",
  workflow_cancel: "Workflow: Ending",
  get_workflow_result: "Workflow: Retrieving",

  // Sibling conversations
  session_create: "Session: Opening",
  session_send: "Session: Messaging",
  session_list: "Session: Listing",
  session_read: "Session: Reading",
  session_wait: "Session: Awaiting",

  // Goals
  create_goal: "Goal: Creating",
  update_goal: "Goal: Updating",
  get_goal: "Goal: Reading",

  // choco-pi-lsp
  lsp_diagnostics: "LSP: Diagnosing Files",
  diagnostics_report: "LSP: Reporting Issues",
  diagnostic_mark: "LSP: Marking Finding",
  lsp_navigation: "LSP: Navigating Code",
  symbol_search: "LSP: Searching Symbols",
  module_report: "LSP: Analysing Module",
  project_report: "LSP: Mapping Project",
  read_symbol: "LSP: Reading Symbol",
  read_enclosing: "LSP: Reading Enclosing",
  ast_grep_search: "LSP: Searching AST",
  ast_grep_replace: "LSP: Rewriting AST",
  ast_grep_outline: "LSP: Outlining AST",
  ast_grep_dump: "LSP: Dumping AST",
  lsp_activate_tools: "LSP: Activating Tools",
} satisfies Readonly<Record<string, string>>;

/** Registered tool names this package ships a label for. */
export type KnownToolName = keyof typeof DEFAULT_TOOL_LABELS;

/** The same tools once their call has settled, in the past tense. */
export const DEFAULT_FINISHED_TOOL_LABELS = {
  // Files
  read: "File: Read",
  write: "File: Wrote",
  edit: "File: Edited",
  apply_patch: "File: Patched",
  ls: "File: Listed",
  find: "File: Found Files",
  grep: "File: Searched",

  // Shell
  bash: "Shell: Ran",
  exec: "Shell: Ran",
  exec_command: "Shell: Ran",
  wait: "Shell: Waited",
  write_stdin: "Shell: Sent Input",

  // Web
  web_run: "Web: Browsed",
  web_search: "Web: Searched",
  source_check: "Web: Checked Sources",
  fetch_content: "Web: Fetched Content",
  get_search_content: "Web: Read Content",
  synthetic_web_search: "Web: Searched",

  // Images
  imagegen: "Image: Generated",
  view_image: "Image: Viewed",

  // Tool discovery and MCP
  tool_search: "Tools: Searched",
  mcp: "MCP: Called",
  mcpScript: "MCP: Scripted",

  // Sub-agents
  Agent: "Delegation: Launched",
  get_subagent_result: "Delegation: Retrieved",
  steer_subagent: "Delegation: Steered",

  // Sub-agent workflows
  workflow_run: "Workflow: Ran",
  workflow_update: "Workflow: Updated",
  workflow_cancel: "Workflow: Ended",
  get_workflow_result: "Workflow: Retrieved",

  // Sibling conversations
  session_create: "Session: Opened",
  session_send: "Session: Messaged",
  session_list: "Session: Listed",
  session_read: "Session: Read",
  session_wait: "Session: Awaited",

  // Goals
  create_goal: "Goal: Created",
  update_goal: "Goal: Updated",
  get_goal: "Goal: Read",

  // choco-pi-lsp
  lsp_diagnostics: "LSP: Diagnosed Files",
  diagnostics_report: "LSP: Reported Issues",
  diagnostic_mark: "LSP: Marked Finding",
  lsp_navigation: "LSP: Navigated Code",
  symbol_search: "LSP: Searched Symbols",
  module_report: "LSP: Analysed Module",
  project_report: "LSP: Mapped Project",
  read_symbol: "LSP: Read Symbol",
  read_enclosing: "LSP: Read Enclosing",
  ast_grep_search: "LSP: Searched AST",
  ast_grep_replace: "LSP: Rewrote AST",
  ast_grep_outline: "LSP: Outlined AST",
  ast_grep_dump: "LSP: Dumped AST",
  lsp_activate_tools: "LSP: Activated Tools",
} satisfies Readonly<Record<KnownToolName, string>>;

const MCP_TOOL_PREFIX = "mcp__";

function knownLabel(
  table: Readonly<Record<KnownToolName, string>>,
  name: string,
): string | undefined {
  // SAFETY: the `Object.hasOwn` guard on this expression establishes the key before the lookup.
  return Object.hasOwn(table, name) ? table[name as KnownToolName] : undefined;
}

function resolve(
  table: Readonly<Record<KnownToolName, string>>,
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  const override = overrides?.[name];
  if (override !== undefined && override.trim() !== "") return override;
  const known = knownLabel(table, name);
  if (known !== undefined) return known;
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const server = name.slice(MCP_TOOL_PREFIX.length).split("_")[0];
    if (server) return `MCP: ${server}`;
  }
  return name;
}

/**
 * Resolves the label shown while a tool is running: a user override first,
 * then the built-in table, then a readable form of an `mcp__server_tool`
 * name, and finally the registered name itself.
 */
export function resolveToolLabel(
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  return resolve(DEFAULT_TOOL_LABELS, name, overrides);
}

/**
 * Resolves the label for a tool whose call has settled, in the past tense.
 * An override wins here too: a reader who renamed a tool means that word in
 * both states.
 */
export function resolveFinishedToolLabel(
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  return resolve(DEFAULT_FINISHED_TOOL_LABELS, name, overrides);
}
