import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolSearch, {
  ALWAYS_ACTIVE_TOOL_NAMES,
  LEAN_SURFACE_SYMBOL,
  type LeanSurfacePolicy,
} from "../.pi/extensions/tool-search.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";

const MCP_STATUS_CHANNEL = "pi-mcp-adapter/status/v1";

test("settles the lean surface synchronously before the first request", async () => {
  const events = createEventBus();
  let active = ["deferred_probe"];
  let availableNames = ["deferred_probe"];
  let sessionStart: (() => void) | undefined;
  let beforeAgentStart: (() => void) | undefined;
  const commits: string[][] = [];
  const registered: { name: string; description: string; parameters: object }[] = [];
  // SAFETY: The fixture supplies every host member exercised by this test.
  toolSearch(
    reinterpretHostValue<Parameters<typeof toolSearch>[0]>({
      registerTool: (tool: { name: string; description: string; parameters: object }) => {
        registered.push(tool);
      },
      getAllTools: () =>
        [...availableNames, ...registered.map((tool) => tool.name)].map((name) => ({
          name,
          description: name,
          parameters: {},
          sourceInfo: { source: "extension", path: name },
        })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        commits.push([...names]);
        active = names;
      },
      events,
      on: (name: string, handler: () => void) => {
        if (name === "session_start") sessionStart = handler;
        if (name === "before_agent_start") beforeAgentStart = handler;
      },
    }),
  );

  sessionStart?.();
  availableNames = ["deferred_probe", "read", "exec_command", "apply_patch"];
  active = [...active, "read", "exec_command", "apply_patch"];
  beforeAgentStart?.();
  assert.equal(commits.length, 1);
  assert.deepEqual(active, ["read", "apply_patch", "exec_command", "tool_search"]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commits.length, 1, "the cancelled deferred commit must not run");

  beforeAgentStart?.();
  assert.equal(commits.length, 1, "an unchanged surface must not be recommitted");

  active = ["tool_search"];
  beforeAgentStart?.();
  assert.equal(commits.length, 1, "the locked surface must not be repaired after request one");
  assert.deepEqual(active, ["tool_search"]);

  beforeAgentStart?.();
  assert.equal(commits.length, 1, "the locked surface must not be recommitted");
});

test("returns exec bridge calls without changing the locked tool surface", async () => {
  type SearchResult = {
    content: Array<{ type: string; text: string }>;
    details: { added: string[] };
  };
  type SearchExecutor = {
    execute(
      toolCallId: string,
      params: { query: string; limit?: number },
      signal?: AbortSignal,
      onUpdate?: undefined,
      context?: ExtensionContext,
    ): Promise<SearchResult>;
  };

  let active = ["read", "deferred_probe"];
  const events = createEventBus();
  let searchTool: SearchExecutor | undefined;
  let sessionStart: (() => void) | undefined;
  let beforeAgentStart: (() => void) | undefined;
  const commits: string[][] = [];
  const tools = ["read", "deferred_probe", "ast_grep_search"].map((name) => ({
    name,
    description: name === "deferred_probe" ? "Inspect deferred probe state" : name,
    parameters: {},
    sourceInfo: { source: "extension", path: name },
  }));

  toolSearch(
    reinterpretHostValue<Parameters<typeof toolSearch>[0]>({
      registerTool: (tool: SearchExecutor & { name: string }) => {
        searchTool = tool;
        tools.push({
          name: tool.name,
          description: "Search deferred tools",
          parameters: {},
          sourceInfo: { source: "extension", path: "tool-search" },
        });
      },
      getAllTools: () => tools,
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        commits.push([...names]);
        active = names;
      },
      events,
      on: (name: string, handler: () => void) => {
        if (name === "session_start") sessionStart = handler;
        if (name === "before_agent_start") beforeAgentStart = handler;
      },
    }),
  );

  sessionStart?.();
  beforeAgentStart?.();
  assert.deepEqual(active, ["read", "tool_search"]);

  active = [...active, "ast_grep_search"];
  beforeAgentStart?.();
  assert.deepEqual(active, ["read", "tool_search", "ast_grep_search"]);
  const afterExternalActivation = commits.length;
  beforeAgentStart?.();
  assert.equal(
    commits.length,
    afterExternalActivation,
    "an unchanged external tool must not rewrite",
  );

  const beforeSearch = commits.length;
  const result = await searchTool?.execute("call", { query: "deferred probe", limit: 1 });
  assert.deepEqual(result?.details.added, []);
  assert.match(result?.content[0]?.text ?? "", /await tools\.deferred_probe\(\{ \.\.\.args \}\)/);
  assert.equal(commits.length, beforeSearch, "tool_search must not mutate the locked surface");
  assert.deepEqual(active, ["read", "tool_search", "ast_grep_search"]);

  beforeAgentStart?.();
  assert.equal(commits.length, beforeSearch, "the following turn must not reorder tools");

  const nativeResult = await searchTool?.execute(
    "native-call",
    { query: "deferred probe", limit: 1 },
    undefined,
    undefined,
    reinterpretHostValue<ExtensionContext>({
      model: {
        provider: "openai-codex",
        compat: { supportsAdditionalTools: false, supportsToolSearch: true },
      },
    }),
  );
  assert.deepEqual(nativeResult?.details.added, ["deferred_probe"]);
  assert.match(
    nativeResult?.content[0]?.text ?? "",
    /deferred_probe directly \(native provider tool search\)/,
  );
  assert.equal(
    commits.length,
    beforeSearch + 1,
    "native provider tool search keeps its message-based schema loading path",
  );
});

test("keeps Agent and core execution gateways always active", async () => {
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("Agent"));

  const events = createEventBus();
  let active = ["read", "Agent", "deferred_probe"];
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(active.includes("Agent"));
  assert.ok(active.includes("read"));
  assert.ok(active.includes("tool_search"));
  assert.ok(!active.includes("deferred_probe"));
});

test("restores registered always-active tools after model selection without widening", async () => {
  const events = createEventBus();
  let active = ["previously_loaded"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let modelSelect: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
      if (name === "model_select") modelSelect = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
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
  const events = createEventBus();
  let active = ["grep", "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
  let modelSelect: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
      if (name === "model_select") modelSelect = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
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

test("keeps shell start and read native while deferring inventory and cleanup", async () => {
  const events = createEventBus();
  const shellTools = ["shell_start", "shell_read", "shell_stop", "shell_list"];
  const nativeShellTools = ["shell_start", "shell_read"];
  const bridgedShellTools = ["shell_stop", "shell_list"];
  let active = [...shellTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  // SAFETY: toolSearch synchronously publishes this typed policy before registering tools.
  const policy = Object.getOwnPropertyDescriptor(globalThis, LEAN_SURFACE_SYMBOL)
    ?.value as LeanSurfacePolicy;
  for (const name of nativeShellTools) {
    assert.ok(policy.alwaysActive().includes(name), `${name} must be published`);
  }
  for (const name of bridgedShellTools) {
    assert.ok(!policy.alwaysActive().includes(name), `${name} must be deferred`);
  }

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  for (const name of nativeShellTools) {
    assert.ok(active.includes(name), `${name} must remain active`);
  }
  for (const name of bridgedShellTools)
    assert.ok(!active.includes(name), `${name} must be bridged`);
  assert.ok(!active.includes("deferred_probe"));

  const result = await searchTool.execute("call", {
    query: "manage background shell",
    limit: 5,
  });
  for (const name of nativeShellTools) assert.ok(!result.details.matches.includes(name));
  for (const name of bridgedShellTools) assert.ok(result.details.matches.includes(name));
});

test("keeps the subagent orchestration trio active and out of search results", async () => {
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("get_subagent_result"));
  assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("steer_subagent"));

  const events = createEventBus();
  let active = ["read", "Agent", "get_subagent_result", "steer_subagent", "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
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
  const events = createEventBus();
  let active = ["read", "deferred_probe"];
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(active.includes("read"));
  assert.ok(active.includes("tool_search"));
  assert.ok(!active.includes("deferred_probe"));
  assert.ok(!active.includes("get_subagent_result"));
  assert.ok(!active.includes("steer_subagent"));
});

test("labels deferred Pi tools as direct calls rather than MCP calls", async () => {
  const events = createEventBus();
  let active = ["deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await searchTool.execute("call", { query: "deferred probe", limit: 1 });
  const text = result.content[0].text;

  assert.match(text, /Call: await tools\.deferred_probe\(\{ \.\.\.args \}\)/);
  assert.doesNotMatch(text, /mcp\(\{ describe/);
});

test("keeps cross-session coordination tools bridge-only and discoverable", async () => {
  const events = createEventBus();
  const sessionTools = [
    "session_create",
    "session_send",
    "session_list",
    "session_read",
    "session_wait",
  ];
  for (const name of sessionTools)
    // SAFETY: The fixture supplies every host member exercised by this test.
    assert.ok(!ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must be bridge-only`);

  let active = [...sessionTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  for (const name of sessionTools)
    assert.ok(!active.includes(name), `${name} must stay outside the native surface`);

  const result = await searchTool.execute("call", {
    query: "coordinate another conversation",
    limit: 5,
  });
  const text = result.content[0].text;
  for (const name of sessionTools) assert.match(text, new RegExp(`\\b${name}\\b`));
});

test("keeps the LSP funnel bridge-only and discoverable", async () => {
  const events = createEventBus();
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
    assert.ok(!ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must be bridge-only`);

  // Situational choco-pi-lsp tools (gated behind the package's own
  // lsp_activate_tools call) are deliberately left out.
  for (const name of ["ast_grep_search", "lsp_navigation", "lsp_activate_tools"]) {
    // SAFETY: The fixture supplies every host member exercised by this test.
    assert.ok(!ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay deferred`);
  }

  let active = [...lspTools, "deferred_probe"];
  let searchTool: any;
  let sessionStart: (() => void) | undefined;
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
    events,
    on: (name: string, handler: () => void) => {
      if (name === "session_start") sessionStart = handler;
    },
  } as any);

  sessionStart?.();
  events.emit(MCP_STATUS_CHANNEL, { servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  for (const name of lspTools)
    assert.ok(!active.includes(name), `${name} must stay outside the native surface`);

  const result = await searchTool.execute("call", {
    query: "symbol module read diagnostics",
    limit: 10,
  });
  const text = result.content[0].text;
  for (const name of lspTools) assert.match(text, new RegExp(`\\b${name}\\b`));
});

test("does not expose family activation helpers", async () => {
  const toolSearchModule = await import("../.pi/extensions/tool-search.ts");
  assert.equal("expandFamilyActivation" in toolSearchModule, false);
  assert.equal("toolFamilyKey" in toolSearchModule, false);
});

test("the native tier contains only core calls and rich-artifact tools", () => {
  const expected = [
    "read",
    "bash",
    "edit",
    "write",
    "exec",
    "wait",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "shell_start",
    "shell_read",
    "find",
    "ls",
    "Agent",
    "get_subagent_result",
    "steer_subagent",
    "stop_subagent",
    "tool_search",
    "agent_browser",
    "view_image",
    "image_gen__imagegen",
  ];
  assert.deepEqual([...ALWAYS_ACTIVE_TOOL_NAMES], expected);
});
