import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { installAgentTools } from "../.pi/extensions/session-bridge.ts";
import {
  isObject,
  reinterpretHostValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";
import { registerGoalTools } from "../.pi/packages/choco-pi-goal/src/tools.ts";
import { createLensDiagnosticsTool } from "../.pi/packages/choco-pi-lsp/tools/diagnostics-report-registration.ts";
import { createLspDiagnosticsTool } from "../.pi/packages/choco-pi-lsp/tools/lsp-diagnostics.ts";
import {
  createModuleReportTool,
  createReadEnclosingTool,
  createReadSymbolTool,
} from "../.pi/packages/choco-pi-lsp/tools/module-report.ts";
import { createProjectReportTool } from "../.pi/packages/choco-pi-lsp/tools/project-report.ts";
import { createSymbolSearchTool } from "../.pi/packages/choco-pi-lsp/tools/symbol-search.ts";
import { loadExtensionFromFactory } from "../.pi/packages/choco-pi-codex/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";

const DESCRIPTION_CHARACTER_LIMIT = 60 * 4;
const PARAMETER_DESCRIPTION_CHARACTER_LIMIT = 25 * 4;
const PROMPT_SNIPPET_WORD_LIMIT = 10;

interface SchemaNode {
  description?: string;
  properties?: Record<string, RuntimeValue>;
  items?: RuntimeValue;
  anyOf?: RuntimeValue[];
  oneOf?: RuntimeValue[];
  allOf?: RuntimeValue[];
}

interface ToolMetadata {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters: RuntimeValue;
}

interface ExtensionModule {
  default?: unknown;
  createMcpAdapter?: unknown;
}

function schemaNode(value: RuntimeValue): SchemaNode | undefined {
  if (!isObject(value) || value === null || Array.isArray(value)) return undefined;
  return reinterpretHostValue<SchemaNode>(value);
}

function parameterDescriptions(value: RuntimeValue, path = "parameters"): string[] {
  const node = schemaNode(value);
  if (!node) return [];
  const failures: string[] = [];
  if (
    node.description !== undefined &&
    node.description.length > PARAMETER_DESCRIPTION_CHARACTER_LIMIT
  ) {
    failures.push(`${path} description has ${node.description.length} characters`);
  }
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    failures.push(...parameterDescriptions(child, `${path}.${name}`));
  }
  if (node.items !== undefined) failures.push(...parameterDescriptions(node.items, `${path}[]`));
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    node[keyword]?.forEach((child, index) => {
      failures.push(...parameterDescriptions(child, `${path}.${keyword}[${index}]`));
    });
  }
  return failures;
}

function captureRegisteredTools(register: (pi: ExtensionAPI) => void): ToolMetadata[] {
  const tools: ToolMetadata[] = [];
  const pi = reinterpretHostValue<ExtensionAPI>({
    registerTool: (tool: ToolMetadata) => tools.push(tool),
  });
  register(pi);
  return tools;
}

function lspTools(): ToolMetadata[] {
  const root = () => process.cwd();
  return [
    createSymbolSearchTool(root),
    createProjectReportTool(root),
    createModuleReportTool(root),
    createReadSymbolTool(root, () => undefined),
    createReadEnclosingTool(root, () => undefined),
    createLspDiagnosticsTool(),
    createLensDiagnosticsTool(
      reinterpretHostValue<Parameters<typeof createLensDiagnosticsTool>[0]>({}),
      root,
    ),
  ];
}

function registeredTools(): ToolMetadata[] {
  const sessionTools = captureRegisteredTools(installAgentTools);
  const goalTools = captureRegisteredTools((pi) =>
    registerGoalTools(pi, reinterpretHostValue<Parameters<typeof registerGoalTools>[1]>({})),
  );
  return [...lspTools(), ...sessionTools, ...goalTools];
}

const FIRST_PARTY_TOOL_INVENTORY = new Map<string, readonly string[]>([
  ["advisor", ["advisor"]],
  [
    "codex",
    [
      "exec",
      "wait",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "view_image",
      "web_run",
      "imagegen",
    ],
  ],
  ["goal", ["get_goal", "create_goal", "update_goal"]],
  [
    "lsp",
    [
      "diagnostics_report",
      "lsp_diagnostics",
      "symbol_search",
      "project_report",
      "module_report",
      "read_symbol",
      "read_enclosing",
      "lsp_activate_tools",
      "ast_grep_search",
      "ast_grep_replace",
      "ast_grep_outline",
      "ast_grep_dump",
      "lsp_navigation",
      "diagnostic_mark",
    ],
  ],
  ["mcp", ["mcpScript", "mcp"]],
  [
    "mcp-figma",
    [
      "figma_configure_auth",
      "figma_parse_url",
      "figma_get_design_context",
      "figma_find_nodes_by_name",
      "figma_find_nodes_by_text",
      "figma_get_node_summary",
      "figma_extract_text",
      "figma_explain_node",
      "figma_get_implementation_context",
      "figma_get_file",
      "figma_get_nodes",
      "figma_get_node_metadata",
      "figma_get_styles",
      "figma_get_variables",
      "figma_get_components",
      "figma_get_component_sets",
      "figma_search_components",
      "figma_render_nodes",
      "figma_extract_assets",
      "figma_find_code_connect_mapping",
      "figma_get_component_implementation_hints",
    ],
  ],
  ["sessions", ["session_create", "session_send", "session_list", "session_read", "session_wait"]],
  ["shells", ["shell_start", "shell_read", "shell_stop", "shell_list"]],
  [
    "subagents",
    [
      "subagent_limits",
      "agent_message",
      "Agent",
      "workflow_run",
      "workflow_update",
      "get_workflow_result",
      "workflow_cancel",
      "set_subagent_fast_mode",
      "get_subagent_result",
      "steer_subagent",
      "stop_subagent",
    ],
  ],
  ["web-access", ["web_search", "source_check", "fetch_content", "get_search_content"]],
]);

async function loadFirstPartyTools(): Promise<Map<string, ToolMetadata[]>> {
  const extensionPaths = new Map<string, string>([
    ["advisor", "../.pi/packages/choco-pi-advisor/src/index.ts"],
    ["codex", "../.pi/packages/choco-pi-codex/src/index.ts"],
    ["goal", "../.pi/packages/choco-pi-goal/src/index.ts"],
    ["lsp", "../.pi/packages/choco-pi-lsp/index.ts"],
    ["mcp-figma", "../.pi/packages/choco-pi-mcp/figma/index.ts"],
    ["sessions", "../.pi/extensions/session-bridge.ts"],
    ["shells", "../.pi/packages/choco-pi-shells/src/index.ts"],
    ["subagents", "../.pi/packages/choco-pi-subagents/src/index.ts"],
    ["web-access", "../.pi/packages/choco-pi-web-access/index.ts"],
  ]);
  const factories = new Map<string, ExtensionFactory>();
  for (const [packageName, path] of extensionPaths) {
    factories.set(packageName, await loadExtensionFactory(path));
  }
  const mcpModule = await loadExtensionModule("../.pi/packages/choco-pi-mcp/index.ts");
  const createMcpAdapter = mcpModule.createMcpAdapter;
  if (!(createMcpAdapter instanceof Function)) throw new Error("MCP factory export is missing");
  const mcpFactory =
    reinterpretHostValue<
      (options: {
        config: { mcpServers: Record<string, never>; settings: Record<string, never> };
      }) => ExtensionFactory
    >(createMcpAdapter);
  factories.set("mcp", mcpFactory({ config: { mcpServers: {}, settings: {} } }));
  const toolsByPackage = new Map<string, ToolMetadata[]>();
  for (const [packageName, factory] of factories) {
    const extension = await loadExtensionFromFactory(
      factory,
      process.cwd(),
      createEventBus(),
      createExtensionRuntime(),
      `schema-budget:${packageName}`,
    );
    toolsByPackage.set(
      packageName,
      [...extension.tools.values()].map((registered) => registered.definition),
    );
  }
  return toolsByPackage;
}

async function loadExtensionModule(path: string): Promise<ExtensionModule> {
  const moduleValue: unknown = await import(path);
  if (!isObject(moduleValue) || moduleValue === null || Array.isArray(moduleValue)) {
    throw new Error(`Extension module ${path} did not return an object`);
  }
  return reinterpretHostValue<ExtensionModule>(moduleValue);
}

async function loadExtensionFactory(path: string): Promise<ExtensionFactory> {
  const module = await loadExtensionModule(path);
  const factory = module.default;
  if (!(factory instanceof Function)) throw new Error(`Extension module ${path} has no default`);
  return reinterpretHostValue<ExtensionFactory>(factory);
}

test("first-party tool schemas stay within provider prompt budgets", () => {
  const failures: string[] = [];
  for (const tool of registeredTools()) {
    if (tool.description.length > DESCRIPTION_CHARACTER_LIMIT) {
      failures.push(`${tool.name} description has ${tool.description.length} characters`);
    }
    const snippetWords = tool.promptSnippet?.trim().split(/\s+/).filter(Boolean).length ?? 0;
    if (snippetWords === 0) failures.push(`${tool.name} has no promptSnippet`);
    if (snippetWords > PROMPT_SNIPPET_WORD_LIMIT) {
      failures.push(`${tool.name} promptSnippet has ${snippetWords} words`);
    }
    failures.push(
      ...parameterDescriptions(tool.parameters).map((failure) => `${tool.name} ${failure}`),
    );
  }
  assert.deepEqual(failures, []);
});

test("every first-party package tool has a bounded catalog snippet", async () => {
  const toolsByPackage = await loadFirstPartyTools();
  const failures: string[] = [];
  for (const [packageName, expectedNames] of FIRST_PARTY_TOOL_INVENTORY) {
    const tools = toolsByPackage.get(packageName) ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      expectedNames,
      `${packageName} tool inventory changed`,
    );
    for (const tool of tools) {
      const snippetWords = tool.promptSnippet?.trim().split(/\s+/).filter(Boolean).length ?? 0;
      if (snippetWords === 0) failures.push(`${packageName}.${tool.name} has no promptSnippet`);
      if (snippetWords > PROMPT_SNIPPET_WORD_LIMIT) {
        failures.push(`${packageName}.${tool.name} promptSnippet has ${snippetWords} words`);
      }
    }
  }
  const shellStart = toolsByPackage.get("shells")?.find((tool) => tool.name === "shell_start");
  assert.match(
    shellStart?.description ?? "",
    /Exit is delivered as a shell-completion notification/,
  );
  assert.match(shellStart?.description ?? "", /do not poll/i);

  const agent = toolsByPackage.get("subagents")?.find((tool) => tool.name === "Agent");
  assert.match(
    agent?.description ?? "",
    /Available types: advisor, explore, general, handoff, implementer, planner, reviewer/,
  );
  const agentParameters = schemaNode(agent?.parameters);
  const runInBackground = schemaNode(agentParameters?.properties?.run_in_background);
  const schedule = schemaNode(agentParameters?.properties?.schedule);
  assert.equal(
    runInBackground?.description,
    "true: return an ID and notify on completion; false: block until the agent finishes.",
  );
  assert.match(schedule?.description ?? "", /refused with run_in_background:false/);
  assert.match(schedule?.description ?? "", /incompatible with inherit_context\/resume/);
  assert.deepEqual(failures, []);
});
