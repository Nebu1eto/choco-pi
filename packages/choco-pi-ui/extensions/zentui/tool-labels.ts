export const DEFAULT_TOOL_LABELS = {
  read: "File: Reading",
  write: "File: Writing",
  edit: "File: Editing",
  apply_patch: "File: Patching",
  ls: "File: Listing",
  find: "File: Finding Files",
  grep: "File: Searching",

  bash: "Shell: Running",
  exec: "Shell: Running",
  exec_command: "Shell: Running",
  shell_start: "Shell: Starting",
  shell_read: "Shell: Reading",
  shell_stop: "Shell: Stopping",
  shell_list: "Shell: Listing",
  wait: "Shell: Waiting",
  write_stdin: "Shell: Sending Input",

  web_run: "Web: Browsing",
  web_search: "Web: Searching",
  source_check: "Web: Checking Sources",
  fetch_content: "Web: Fetching Content",
  get_search_content: "Web: Reading Content",
  synthetic_web_search: "Web: Searching",
  agent_browser: "Browser: Automating",

  imagegen: "Image: Generating",
  image_gen__imagegen: "Image: Generating",
  view_image: "Image: Viewing",

  tool_search: "Tools: Searching",

  Agent: "Delegation: Launching",
  advisor: "Delegation: Advising",
  get_subagent_result: "Delegation: Retrieving",
  steer_subagent: "Delegation: Steering",
  stop_subagent: "Delegation: Stopping",

  workflow_run: "Workflow: Running",
  workflow_update: "Workflow: Updating",
  workflow_cancel: "Workflow: Ending",
  get_workflow_result: "Workflow: Retrieving",

  session_create: "Session: Opening",
  session_send: "Session: Messaging",
  session_list: "Session: Listing",
  session_read: "Session: Reading",
  session_wait: "Session: Awaiting",

  create_goal: "Goal: Creating",
  update_goal: "Goal: Updating",
  get_goal: "Goal: Reading",

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

export type KnownToolName = keyof typeof DEFAULT_TOOL_LABELS;

export const DEFAULT_FINISHED_TOOL_LABELS = {
  read: "File: Read",
  write: "File: Wrote",
  edit: "File: Edited",
  apply_patch: "File: Patched",
  ls: "File: Listed",
  find: "File: Found Files",
  grep: "File: Searched",

  bash: "Shell: Ran",
  exec: "Shell: Ran",
  exec_command: "Shell: Ran",
  shell_start: "Shell: Started",
  shell_read: "Shell: Read",
  shell_stop: "Shell: Stopped",
  shell_list: "Shell: Listed",
  wait: "Shell: Waited",
  write_stdin: "Shell: Sent Input",

  web_run: "Web: Browsed",
  web_search: "Web: Searched",
  source_check: "Web: Checked Sources",
  fetch_content: "Web: Fetched Content",
  get_search_content: "Web: Read Content",
  synthetic_web_search: "Web: Searched",
  agent_browser: "Browser: Automated",

  imagegen: "Image: Generated",
  image_gen__imagegen: "Image: Generated",
  view_image: "Image: Viewed",

  tool_search: "Tools: Searched",

  Agent: "Delegation: Launched",
  advisor: "Delegation: Advised",
  get_subagent_result: "Delegation: Retrieved",
  steer_subagent: "Delegation: Steered",
  stop_subagent: "Delegation: Stopped",

  workflow_run: "Workflow: Ran",
  workflow_update: "Workflow: Updated",
  workflow_cancel: "Workflow: Ended",
  get_workflow_result: "Workflow: Retrieved",

  session_create: "Session: Opened",
  session_send: "Session: Messaged",
  session_list: "Session: Listed",
  session_read: "Session: Read",
  session_wait: "Session: Awaited",

  create_goal: "Goal: Created",
  update_goal: "Goal: Updated",
  get_goal: "Goal: Read",

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
  return Object.entries(table).find(([key]) => key === name)?.[1];
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
    const server = name.slice(MCP_TOOL_PREFIX.length).split("__")[0];
    if (server) return `MCP: ${server}`;
  }
  return name;
}

export function resolveToolLabel(
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  return resolve(DEFAULT_TOOL_LABELS, name, overrides);
}

export function resolveFinishedToolLabel(
  name: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  return resolve(DEFAULT_FINISHED_TOOL_LABELS, name, overrides);
}
