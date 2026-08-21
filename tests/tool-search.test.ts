import assert from "node:assert/strict";
import test from "node:test";
import toolSearch, { ALWAYS_ACTIVE_TOOL_NAMES } from "../.pi/extensions/tool-search.ts";

type McpStatusPayload = { servers: never[] };

test("keeps Agent and core execution gateways always active", async () => {
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("Agent"));

  let active = ["read", "Agent", "deferred_probe"];
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    {
      name: "read",
      description: "Read",
      parameters: {},
      sourceInfo: { source: "builtin", path: "builtin" },
    },
    {
      name: "Agent",
      description: "Spawn a subagent",
      parameters: {},
      sourceInfo: { source: "extension", path: "agents" },
    },
    {
      name: "deferred_probe",
      description: "Deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "probe" },
    },
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: { name: string }) =>
      // SAFETY: The fixture supplies every host member exercised by this test.
      tools.push({ ...tool, sourceInfo: { source: "extension", path: "tool-search" } } as any),
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(active.includes("Agent"));
  assert.ok(active.includes("read"));
  assert.ok(active.includes("tool_search"));
  assert.ok(!active.includes("deferred_probe"));
});

test("keeps the subagent orchestration trio active and out of search results", async () => {
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("get_subagent_result"));
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("steer_subagent"));

  let active = ["read", "Agent", "get_subagent_result", "steer_subagent", "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    {
      name: "read",
      description: "Read",
      parameters: {},
      sourceInfo: { source: "builtin", path: "builtin" },
    },
    {
      name: "Agent",
      description: "Spawn a subagent",
      parameters: {},
      sourceInfo: { source: "extension", path: "agents" },
    },
    {
      name: "get_subagent_result",
      description: "Check status and retrieve results from a background agent",
      parameters: {},
      sourceInfo: { source: "extension", path: "agents" },
    },
    {
      name: "steer_subagent",
      description: "Send a steering message to a running agent",
      parameters: {},
      sourceInfo: { source: "extension", path: "agents" },
    },
    {
      name: "deferred_probe",
      description: "Deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "probe" },
    },
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: any) => {
      searchTool = tool;
    },
    getAllTools: () => [
      ...tools,
      { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } },
    ],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  // Stay active without any search.
  assert.ok(active.includes("get_subagent_result"));
  assert.ok(active.includes("steer_subagent"));

  // Excluded from search results the way other always-active tools are.
  const result = await searchTool.execute("call", {
    query: "agent result steer background",
    limit: 5,
  });
  assert.ok(!result.details.matches.includes("get_subagent_result"));
  assert.ok(!result.details.matches.includes("steer_subagent"));
});

test("an always-active name with no registered tool does not corrupt the active set", async () => {
  let active = ["read", "deferred_probe"];
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    {
      name: "read",
      description: "Read",
      parameters: {},
      sourceInfo: { source: "builtin", path: "builtin" },
    },
    {
      name: "deferred_probe",
      description: "Deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "probe" },
    },
    // get_subagent_result and steer_subagent are in ALWAYS_ACTIVE_TOOL_NAMES
    // but not registered here, simulating @tintinweb/pi-subagents being
    // absent or renaming its tools.
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: { name: string }) =>
      // SAFETY: The fixture supplies every host member exercised by this test.
      tools.push({ ...tool, sourceInfo: { source: "extension", path: "tool-search" } } as any),
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(active.includes("read"));
  assert.ok(active.includes("tool_search"));
  assert.ok(!active.includes("deferred_probe"));
  assert.ok(!active.includes("get_subagent_result"));
  assert.ok(!active.includes("steer_subagent"));
});

test("labels deferred Pi tools as direct calls rather than MCP calls", async () => {
  let active = ["deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const probe = {
    name: "deferred_probe",
    description: "Inspect deferred probe state",
    parameters: {},
    sourceInfo: { source: "extension", path: "probe" },
  };
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: any) => {
      searchTool = tool;
    },
    getAllTools: () => [
      probe,
      { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } },
    ],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await searchTool.execute("call", { query: "deferred probe", limit: 1 });
  const text = result.content[0].text;

  assert.match(text, /Call: deferred_probe directly \(native Pi tool; never use mcp\)/);
  assert.doesNotMatch(text, /mcp\(\{ describe/);
});

test("keeps cross-session coordination tools active and out of search results", async () => {
  const sessionTools = [
    "session_create",
    "session_send",
    "session_list",
    "session_read",
    "session_wait",
  ];
  for (const name of sessionTools)
    // SAFETY: The fixture supplies every host member exercised by this test.
    assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay active`);

  let active = [...sessionTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    ...sessionTools.map((name) => ({
      name,
      description: `Coordinate another Pi conversation (${name})`,
      parameters: {},
      sourceInfo: { source: "extension", path: "session-bridge" },
    })),
    {
      name: "deferred_probe",
      description: "Deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "probe" },
    },
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: any) => {
      searchTool = tool;
    },
    getAllTools: () => [
      ...tools,
      { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } },
    ],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  // Eager loading is the point: no search may be required to reach them.
  for (const name of sessionTools)
    assert.ok(active.includes(name), `${name} must remain in the active surface`);

  // Always-active tools are not searchable, so they never consume a result slot.
  const result = await searchTool.execute("call", {
    query: "coordinate another conversation",
    limit: 5,
  });
  const text = result.content[0].text;
  for (const name of sessionTools) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`));
});

test("keeps the choco-pi-lsp mandated funnel and diagnostics gate active and out of search results", async () => {
  const lspTools = [
    "symbol_search",
    "module_report",
    "read_symbol",
    "read_enclosing",
    "lsp_diagnostics",
    "diagnostics_report",
  ];
  for (const name of lspTools)
    // SAFETY: The fixture supplies every host member exercised by this test.
    assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay active`);

  // Situational choco-pi-lsp tools (gated behind the package's own
  // lsp_activate_tools call) are deliberately left out.
  for (const name of [
    "project_report",
    "ast_grep_search",
    "lsp_navigation",
    "lsp_activate_tools",
  ]) {
    // SAFETY: The fixture supplies every host member exercised by this test.
    assert.ok(!ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay deferred`);
  }

  let active = [...lspTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    ...lspTools.map((name) => ({
      name,
      description: `choco-pi-lsp code-exploration tool (${name})`,
      parameters: {},
      sourceInfo: { source: "extension", path: "choco-pi-lsp" },
    })),
    {
      name: "deferred_probe",
      description: "Deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "probe" },
    },
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch({
    registerTool: (tool: any) => {
      searchTool = tool;
    },
    getAllTools: () => [
      ...tools,
      { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } },
    ],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    events: {
      on: (_name: string, handler: (payload: McpStatusPayload) => void) => {
        mcpStatus = handler;
      },
    },
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  // Eager loading is the point: no search may be required to reach them.
  for (const name of lspTools)
    assert.ok(active.includes(name), `${name} must remain in the active surface`);

  // Always-active tools are not searchable, so they never consume a result slot.
  const result = await searchTool.execute("call", {
    query: "symbol module read diagnostics",
    limit: 5,
  });
  const text = result.content[0].text;
  for (const name of lspTools) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`));
});

test("family expansion co-activates deferred same-source siblings", async () => {
  const { expandFamilyActivation } = await import("../.pi/extensions/tool-search.ts");
  const tool = (name: string, path: string) => ({
    target: {
      kind: "pi" as const,
      tool: { name, sourceInfo: { source: "extension", path } },
    },
  });
  const documents = [
    tool("find_roots", "computer-use"),
    tool("observe_ui", "computer-use"),
    tool("act_ui", "computer-use"),
    tool("lonely_tool", "other-pkg"),
  ];
  assert.deepEqual(expandFamilyActivation(["find_roots"], documents, new Set()).sort(), [
    "act_ui",
    "observe_ui",
  ]);
  assert.deepEqual(expandFamilyActivation(["find_roots"], documents, new Set(["act_ui"])), [
    "observe_ui",
  ]);
  assert.deepEqual(expandFamilyActivation(["lonely_tool"], documents, new Set()), []);
  assert.deepEqual(expandFamilyActivation([], documents, new Set()), []);

  const bigFamily = Array.from({ length: 13 }, (_, index) => tool(`big_${index}`, "mega-pkg"));
  assert.deepEqual(expandFamilyActivation(["big_0"], bigFamily, new Set()), []);
});
