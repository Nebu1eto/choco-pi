import type {
  CodeModeToolDefinition,
  CodeModeToolMetadata,
  CustomToolDefinition,
} from "./types.ts";

export const EXEC_DESCRIPTION = `Run JavaScript source only; no JSON/fences
Batch several tools.* calls per block: Promise.all for independent ones, in-code filtering/aggregation; do not emit one exec toolCall per wrapped call
Code: fresh restricted JS with no console, imports, Node, or browser APIs. Notebook: persistent shared Deno TypeScript globals with console, imports/npm, Deno, and Web APIs
Optional // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}; defaults 30000 ms/10000 tokens
Await work; bare values are discarded. Globals: tools, image, generatedImage, store, load, exit, setTimeout, clearTimeout, ALL_TOOLS; text(value) and notify(value) EMIT output and return nothing — never nest them in an expression, use String()/JSON.stringify() to build one; yield_control() yields`;

export const WAIT_DESCRIPTION = "Resume or terminate a yielded exec cell";

const BUNDLED_TOOLS_HEADING = "Tools available in exec:";
const CUSTOM_TOOLS_HEADING = "Configured custom tools:";
const DEFERRED_CUSTOM_TOOLS_GUIDANCE = "Deferred custom tools: find by name in ALL_TOOLS";
const BRIDGED_TOOLS_HEADING = "Pi tools callable in exec";
const CUSTOM_TOOL_DOCUMENTATION_MARKER = "To create or edit a custom tool, read";
const CUSTOM_TOOLS_GUIDANCE = "Prefer custom tools for command-backed capabilities";
const CODE_MODE_COMPOSITION_MARKER = "one exec block per step, not one per tools.* call";
const CODE_MODE_COMPOSITION_GUIDANCE = `Composition: ${CODE_MODE_COMPOSITION_MARKER} — batch independent calls with Promise.all, chain dependent ones with await, then filter/aggregate results in code and text() only the digest the next step needs
Pattern: const [a, b] = await Promise.all([tools.exec_command({cmd: "rg --files src"}), tools.exec_command({cmd: "rg -n TODO src"})]); text(a.output + b.output)`;

const COMPACT_BUNDLED_TOOL_USAGE = new Map([
  [
    "apply_patch",
    "await tools.apply_patch(patch) // envelope: *** Begin Patch … *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path; *** Move to: path immediately follows its *** Update File: path header; pure moves need a nonempty @@ hunk with one unchanged context line; hunks in file order; @@ is context, not a line range",
  ],
  [
    "exec_command",
    "await tools.exec_command({cmd, workdir?, shell?, tty?, yield_time_ms?, max_output_tokens?, login?}) // returns output, session_id?, exit_code?",
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
  existingPrompt = "",
): string {
  const bundled = tools.filter((tool) => !isConfiguredCustomTool(tool) && !tool.deferLoading);
  const custom = tools.filter(isConfiguredCustomTool);
  const promotedCustom = custom.filter((tool) => !tool.deferLoading);
  const bridgedLine = existingPrompt.includes(BRIDGED_TOOLS_HEADING)
    ? ""
    : buildBridgedToolsLine(tools);
  const sections = [
    existingPrompt.includes(BUNDLED_TOOLS_HEADING)
      ? undefined
      : buildUsageSection(BUNDLED_TOOLS_HEADING, bundled, true),
    bundled.length > 0 && !existingPrompt.includes(CODE_MODE_COMPOSITION_MARKER)
      ? CODE_MODE_COMPOSITION_GUIDANCE
      : undefined,
    bridgedLine || undefined,
    existingPrompt.includes(CUSTOM_TOOLS_HEADING)
      ? undefined
      : buildUsageSection(CUSTOM_TOOLS_HEADING, promotedCustom),
    custom.some((tool) => tool.deferLoading) &&
    !existingPrompt.includes(DEFERRED_CUSTOM_TOOLS_GUIDANCE)
      ? DEFERRED_CUSTOM_TOOLS_GUIDANCE
      : undefined,
    documentationPath && !existingPrompt.includes(CUSTOM_TOOL_DOCUMENTATION_MARKER)
      ? `${CUSTOM_TOOL_DOCUMENTATION_MARKER} ${documentationPath} only when creating or editing a custom tool; never for discovering or calling tools; do not read Pi docs`
      : undefined,
    custom.length > 0 && !existingPrompt.includes(CUSTOM_TOOLS_GUIDANCE)
      ? CUSTOM_TOOLS_GUIDANCE
      : undefined,
  ].filter(Boolean);
  return sections.join("\n");
}

export function injectCodeModeToolsPrompt(
  systemPrompt: string,
  tools: CodeModeToolDefinition[],
  documentationPath?: string,
): string {
  const section = buildCodeModeToolsPrompt(tools, documentationPath, systemPrompt);
  if (!section) return systemPrompt;
  const markers = ["\nCurrent shell:", "\nCurrent date:"]
    .map((marker) => systemPrompt.indexOf(marker))
    .filter((index) => index !== -1);
  const insertAt = markers.length > 0 ? Math.min(...markers) : systemPrompt.length;
  return `${systemPrompt.slice(0, insertAt).trimEnd()}\n\n${section}${systemPrompt.slice(insertAt)}`;
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
