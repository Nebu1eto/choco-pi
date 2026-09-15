import type {
  CodeModeToolDefinition,
  CodeModeToolMetadata,
  CustomToolDefinition,
} from "./types.ts";

export const CODE_MODE_DEFAULT_ROUTING =
  "Use code mode by default for bounded tool workflows, including independent reads, searches, checks, and programmatic result aggregation; use one exec block per coherent step, not one wrapper per call";
export const CODE_MODE_DIRECT_EXCEPTIONS =
  "Use direct tools only for approvals, native artifacts, citations, a decision requiring inspection of one individual result before continuing, or capabilities unavailable in code mode";

export const EXEC_DESCRIPTION = `Run JavaScript source only; no JSON/fences
${CODE_MODE_DEFAULT_ROUTING}
${CODE_MODE_DIRECT_EXCEPTIONS}
Code: fresh restricted JS in every cell with no Deno, console, imports, Node, filesystem/network, or browser globals. Notebook: persistent shared Deno TypeScript globals with console, imports/npm, Deno, and Web APIs
Source preflight rejects malformed restricted JavaScript, unsupported restricted globals, and unconditional top-level tools.<name> typos absent from both code mode and direct Pi tools; guarded or real unbridged references run to the runtime guard; command strings and non-zero exec_command exits are not rewritten
Optional // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}; defaults 30000 ms/10000 tokens
Optional first-line // @description: short intent for the collapsed code call; otherwise the first exec_command description labels it
Await work; bare values are discarded. Restricted globals: tools, image, generatedImage, store, load, exit, setTimeout, clearTimeout, ALL_TOOLS; do not declare a local tools variable that shadows the injected namespace. text(value) and notify(value) EMIT output and return nothing — never nest them in an expression, use String()/JSON.stringify() to build one; yield_control() yields`;

export const WAIT_DESCRIPTION =
  "Resume or terminate a yielded exec JavaScript cell in this session. Restricted cells retain state only while that yielded cell lives; notebook cells resume persistent shared Deno state. Cell IDs do not survive restart; exec_command session IDs belong to write_stdin.";

const BUNDLED_TOOLS_HEADING = "Tools available in exec:";
const CUSTOM_TOOLS_HEADING = "Configured custom tools:";
const DEFERRED_CUSTOM_TOOLS_GUIDANCE = "Deferred custom tools: find by name in ALL_TOOLS";
const BRIDGED_TOOLS_HEADING = "Pi tools callable in exec";
const CUSTOM_TOOL_DOCUMENTATION_MARKER = "To create or edit a custom tool, read";
const CUSTOM_TOOLS_GUIDANCE = "Prefer custom tools for command-backed capabilities";
const CODE_MODE_PROMPT_START = "<code_mode_tools>";
const CODE_MODE_PROMPT_END = "</code_mode_tools>";
const CODE_MODE_ROUTING_GUIDANCE = `Composition: ${CODE_MODE_DEFAULT_ROUTING}.
Run only independent calls concurrently (usually with Promise.all); await decision-dependent work in sequence. Preserve failed outcomes when aggregating; Promise.allSettled is appropriate for independent read-only calls when every outcome matters, but do not add generic catch/retry wrappers or a batching framework.
${CODE_MODE_DIRECT_EXCEPTIONS}. Discover an unfamiliar tool by selecting its entry from ALL_TOOLS and inspect only that schema; do not dump all schemas.
Use only capabilities actually listed here. Filesystem reads must use an available filesystem-capable tool or a direct read outside code mode; UI tools require UI references/state and never accept filesystem paths as a substitute.
Do not repeat successful writes blindly. For long-running work, start a managed shell/process or retain an exec_command session handle; do not keep a cell alive solely to wait or poll.`;

const READ_ONLY_EXAMPLES = new Map<string, string>([
  ["module_report", 'tools.module_report({path: "src/example.ts", view: "summary"})'],
  ["symbol_search", 'tools.symbol_search({query: "target symbol", limit: 5})'],
  ["lsp_diagnostics", 'tools.lsp_diagnostics({path: "src/example.ts", severity: "error"})'],
]);

function buildCapabilityExample(tools: CodeModeToolDefinition[]): string {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.has("exec_command"))
    return 'Pattern: const [files, todos] = await Promise.all([tools.exec_command({description: "List source files", cmd: "rg --files src"}), tools.exec_command({description: "Find pending work", cmd: "rg -n TODO src"})]); text(JSON.stringify({files, todos}))';
  const calls = [...READ_ONLY_EXAMPLES]
    .filter(([name]) => names.has(name))
    .slice(0, 2)
    .map(([, call]) => call);
  if (calls.length < 2) return "";
  return `Pattern: const outcomes = await Promise.allSettled([${calls.join(", ")}]); text(JSON.stringify(outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome : {status: "rejected", reason: String(outcome.reason)})))`;
}

const COMPACT_BUNDLED_TOOL_USAGE = new Map([
  [
    "apply_patch",
    "await tools.apply_patch(patch) // envelope: *** Begin Patch … *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path; *** Move to: path immediately follows its *** Update File: path header; pure moves need a nonempty @@ hunk with one unchanged context line; hunks in file order; @@ is context, not a line range",
  ],
  [
    "exec_command",
    "await tools.exec_command({description, cmd, workdir?, shell?, tty?, yield_time_ms?, max_output_tokens?, login?}) // description: required 3-7 word intent for collapsed display; returns output, session_id?, exit_code?",
  ],
  [
    "web__run",
    "await tools.web__run({search_query?: [{q, recency?, domains?}], image_query?: [{q}], open?: [{ref_id, lineno?}], click?: [{ref_id, id}], find?: [{ref_id, pattern}], response_length?}) // refs from web__run; final answers cite result URLs; never emit internal turn… or cite… citation artifacts",
  ],
  [
    "web_run",
    "await tools.web__run({search_query?: [{q, recency?, domains?}], image_query?: [{q}], open?: [{ref_id, lineno?}], click?: [{ref_id, id}], find?: [{ref_id, pattern}], response_length?}) // refs from web__run; final answers cite result URLs; never emit internal turn… or cite… citation artifacts",
  ],
  [
    "write_stdin",
    "await tools.write_stdin({session_id, chars?, yield_time_ms?, max_output_tokens?})",
  ],
]);

function isConfiguredCustomTool(tool: CodeModeToolDefinition): tool is CustomToolDefinition {
  return "command" in tool;
}

export function formatCodeModeToolHelp(tool: CodeModeToolMetadata): string {
  return [
    `Usage: ${tool.usage}`,
    tool.description,
    tool.output ? `Output: ${tool.output}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUsageSection(
  heading: string,
  tools: CodeModeToolMetadata[],
  compactBundledUsage = false,
): string {
  if (tools.length === 0) return "";
  return `${heading}\n${[...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (tool) =>
        `- ${compactBundledUsage ? (COMPACT_BUNDLED_TOOL_USAGE.get(tool.name) ?? tool.usage) : tool.usage}`,
    )
    .join("\n")}`;
}

export function buildBridgedToolsLine(tools: CodeModeToolDefinition[]): string {
  const names = tools
    .filter((tool) => !isConfiguredCustomTool(tool) && tool.deferLoading)
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) return "";
  return (
    BRIDGED_TOOLS_HEADING +
    " (deferred; call as tools.<name>(args), schemas in ALL_TOOLS): " +
    names.join(", ")
  );
}

export function buildCodeModeToolsPrompt(
  tools: CodeModeToolDefinition[],
  documentationPath?: string,
  _existingPrompt = "",
): string {
  const bundled = tools.filter((tool) => !isConfiguredCustomTool(tool) && !tool.deferLoading);
  const custom = tools.filter(isConfiguredCustomTool);
  const promotedCustom = custom.filter((tool) => !tool.deferLoading);
  const bridgedLine = buildBridgedToolsLine(tools);
  const sections = [
    buildUsageSection(BUNDLED_TOOLS_HEADING, bundled, true),
    [CODE_MODE_ROUTING_GUIDANCE, buildCapabilityExample(tools)].filter(Boolean).join("\n"),
    bridgedLine || undefined,
    buildUsageSection(CUSTOM_TOOLS_HEADING, promotedCustom),
    custom.some((tool) => tool.deferLoading) ? DEFERRED_CUSTOM_TOOLS_GUIDANCE : undefined,
    documentationPath
      ? `${CUSTOM_TOOL_DOCUMENTATION_MARKER} ${documentationPath} only when creating or editing a custom tool; never for discovering or calling tools; do not read Pi docs`
      : undefined,
    custom.length > 0 ? CUSTOM_TOOLS_GUIDANCE : undefined,
  ].filter(Boolean);
  return sections.join("\n");
}

export function injectCodeModeToolsPrompt(
  systemPrompt: string,
  tools: CodeModeToolDefinition[],
  documentationPath?: string,
): string {
  const start = systemPrompt.indexOf(CODE_MODE_PROMPT_START);
  const end = start === -1 ? -1 : systemPrompt.indexOf(CODE_MODE_PROMPT_END, start);
  const basePrompt =
    start !== -1 && end !== -1
      ? `${systemPrompt.slice(0, start).trimEnd()}${systemPrompt.slice(end + CODE_MODE_PROMPT_END.length)}`
      : systemPrompt;
  const section = buildCodeModeToolsPrompt(tools, documentationPath, basePrompt);
  if (!section) return systemPrompt;
  const markers = ["\nCurrent shell:", "\nCurrent date:"]
    .map((marker) => basePrompt.indexOf(marker))
    .filter((index) => index !== -1);
  const insertAt = markers.length > 0 ? Math.min(...markers) : basePrompt.length;
  return `${basePrompt.slice(0, insertAt).trimEnd()}\n\n${CODE_MODE_PROMPT_START}\n${section}\n${CODE_MODE_PROMPT_END}${basePrompt.slice(insertAt)}`;
}

export interface ReplacedCodeModeToolsPrompt {
  systemPrompt: string;
  section: string;
}

export function replaceCodeModeToolsPrompt(
  systemPrompt: string,
  previousSection: string | undefined,
  nextTools: CodeModeToolDefinition[],
  documentationPath?: string,
): ReplacedCodeModeToolsPrompt {
  const hasPrevious = Boolean(previousSection && systemPrompt.includes(previousSection));
  const basePrompt = hasPrevious ? systemPrompt.replace(previousSection!, "") : systemPrompt;
  const section = buildCodeModeToolsPrompt(nextTools, documentationPath, basePrompt);
  return {
    systemPrompt: hasPrevious
      ? systemPrompt.replace(previousSection!, section)
      : injectCodeModeToolsPrompt(systemPrompt, nextTools, documentationPath),
    section,
  };
}
