import assert from "node:assert/strict";
import test from "node:test";
import toolSearch, {
  ALWAYS_ACTIVE_TOOL_NAMES,
  LEAN_SURFACE_SYMBOL,
  type LeanSurfacePolicy,
} from "../.pi/extensions/tool-search.ts";

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

test("restores registered always-active tools after model selection without widening", async () => {
  let active = ["previously_loaded"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let modelSelect: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    ...["bash", "edit", "write"].map((name) => ({
      name,
      description: `Core execution gateway (${name})`,
      parameters: {},
      sourceInfo: { source: "builtin", path: "builtin" },
    })),
    {
      name: "previously_loaded",
      description: "Previously loaded probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "loaded-probe" },
    },
    {
      name: "still_deferred",
      description: "Still deferred probe",
      parameters: {},
      sourceInfo: { source: "extension", path: "deferred-probe" },
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
      if (name === "model_select") modelSelect = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  for (const name of ["bash", "edit", "write", "tool_search"]) {
    assert.ok(active.includes(name), `${name} must be restored`);
  }
  assert.ok(!active.includes("still_deferred"));
  assert.ok(!active.includes("exec_command"), "unregistered eager tools must not be added");

  const result = await searchTool.execute("call", { query: "previously loaded probe", limit: 1 });
  assert.deepEqual(result.details.added, ["previously_loaded"]);
  assert.ok(active.includes("previously_loaded"));

  active = active.filter((name) => !["bash", "edit", "write"].includes(name));
  modelSelect?.();
  await new Promise((resolve) => setImmediate(resolve));
  const afterModelSelect = [...active];

  for (const name of ["bash", "edit", "write", "tool_search", "previously_loaded"]) {
    assert.ok(active.includes(name), `${name} must survive model selection`);
  }
  assert.ok(!active.includes("still_deferred"));
  assert.ok(!active.includes("exec_command"));

  modelSelect?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(active, afterModelSelect);
});

test("removes disabled grep from initialization, model selection, and tool search", async () => {
  let active = ["grep", "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let modelSelect: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    {
      name: "grep",
      description: "Search file contents for a pattern",
      parameters: {},
      sourceInfo: { source: "builtin", path: "builtin" },
    },
    {
      name: "deferred_probe",
      description: "Normal deferred probe",
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
      if (name === "model_select") modelSelect = handler;
    },
  } as any);

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(!active.includes("grep"));
  assert.ok(!active.includes("deferred_probe"));

  const grepResult = await searchTool.execute("call", { query: "grep", limit: 5 });
  assert.ok(!grepResult.details.matches.includes("grep"));
  assert.ok(!grepResult.details.added.includes("grep"));
  assert.ok(!active.includes("grep"));

  const probeResult = await searchTool.execute("call", {
    query: "normal deferred probe",
    limit: 1,
  });
  assert.deepEqual(probeResult.details.matches, ["deferred_probe"]);
  assert.deepEqual(probeResult.details.added, ["deferred_probe"]);
  assert.ok(active.includes("deferred_probe"));

  active = [...active, "grep"];
  modelSelect?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!active.includes("grep"));
  assert.ok(active.includes("deferred_probe"));
});

test("publishes background shells and keeps them active through lean filtering", async () => {
  const shellTools = ["shell_start", "shell_read", "shell_stop", "shell_list"];
  let active = [...shellTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let mcpStatus: ((payload: McpStatusPayload) => void) | undefined;
  const tools = [
    ...shellTools.map((name) => ({
      name,
      description: `Manage a background shell (${name})`,
      parameters: {},
      sourceInfo: { source: "extension", path: "choco-pi-shells" },
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

  // SAFETY: toolSearch synchronously publishes this typed policy before registering tools.
  const policy = Object.getOwnPropertyDescriptor(globalThis, LEAN_SURFACE_SYMBOL)
    ?.value as LeanSurfacePolicy;
  for (const name of shellTools) {
    assert.ok(policy.alwaysActive().includes(name), `${name} must be published`);
  }

  sessionStart?.();
  mcpStatus?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  for (const name of shellTools) {
    assert.ok(active.includes(name), `${name} must remain active`);
  }
  assert.ok(!active.includes("deferred_probe"));

  const result = await searchTool.execute("call", {
    query: "manage background shell",
    limit: 5,
  });
  for (const name of shellTools) assert.ok(!result.details.matches.includes(name));
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
  for (const name of ["ast_grep_search", "lsp_navigation", "lsp_activate_tools"]) {
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

test("the eager surface covers discovery, delegation, goals, research, and the code funnel", () => {
  const eager = [
    // Pi execution and path discovery.
    "read",
    "bash",
    "edit",
    "write",
    "find",
    "ls",
    "exec",
    "wait",
    // Dependent delegation, collected and cancelled from the same path.
    "workflow_run",
    "workflow_update",
    "get_workflow_result",
    "workflow_cancel",
    // Goal mode, which the system prompt requires in the turn the user asks.
    "get_goal",
    "create_goal",
    "update_goal",
    // A lookup and the calls that read what it returned.
    "web_search",
    "source_check",
    "fetch_content",
    "get_search_content",
    // Repository-scope entry to the choco-pi-lsp funnel.
    "project_report",
  ];
  for (const name of eager) {
    // SAFETY: The list is a literal set of tool names checked against the export.
    assert.ok(
      ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never),
      `${name} must be eager, not deferred`,
    );
  }
  assert.equal(
    new Set(ALWAYS_ACTIVE_TOOL_NAMES).size,
    ALWAYS_ACTIVE_TOOL_NAMES.length,
    "the eager surface must not repeat a name",
  );
});
