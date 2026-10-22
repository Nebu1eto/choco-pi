import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createEventBus,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import toolSearch, {
  ALWAYS_ACTIVE_TOOL_NAMES,
  LEAN_SURFACE_SYMBOL,
  type LeanSurfacePolicy,
} from "../.pi/extensions/tool-search.ts";
import { isPrefixLocked } from "../.pi/extensions/lib/prefix-lock.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";

interface FakeTool {
  name: string;
  exposure?: ToolExposure;
}

interface FakeHost {
  tools: FakeTool[];
  active: string[];
  commits: string[][];
  registered: string[];
  emit(event: "session_start" | "before_agent_start" | "model_select"): void;
}

function fakeHost(tools: FakeTool[], active: string[]): FakeHost {
  const handlers = new Map<string, () => void>();
  const host: FakeHost = {
    tools,
    active,
    commits: [],
    registered: [],
    emit: (event) => handlers.get(event)?.(),
  };
  toolSearch(
    // SAFETY: The fixture supplies every host member the policy reads.
    reinterpretHostValue<ExtensionAPI>({
      registerTool: (tool: { name: string }) => host.registered.push(tool.name),
      getAllTools: () =>
        host.tools.map((tool) => ({
          name: tool.name,
          description: tool.name,
          parameters: {},
          exposure: tool.exposure ?? "direct",
          sourceInfo: { source: "extension", path: tool.name },
        })),
      getActiveTools: () => host.active,
      setActiveTools: (names: string[]) => {
        host.commits.push([...names]);
        host.active = [...names];
      },
      events: createEventBus(),
      on: (name: string, handler: () => void) => handlers.set(name, handler),
    }),
  );
  return host;
}

const builtinSearch: FakeTool = { name: "tool_search", exposure: "model-only" };

test("registers no tool of its own; Pi's built-in owns tool_search", () => {
  const host = fakeHost([builtinSearch], []);
  assert.deepEqual(host.registered, []);
});

test("activates the built-in tool_search with the lean surface before the first request", async () => {
  // Pi registers the built-in inactive (defaultActive: false).
  const host = fakeHost(
    [{ name: "read" }, { name: "deferred_probe" }, { name: "apply_patch" }, builtinSearch],
    ["deferred_probe"],
  );
  host.emit("session_start");
  host.emit("before_agent_start");
  assert.deepEqual(host.active, ["read", "apply_patch", "tool_search"]);
  assert.equal(host.commits.length, 1);
  assert.equal(isPrefixLocked(), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.commits.length, 1, "the cancelled deferred commit must not run");
});

test("omits tool_search when the built-in is not registered", () => {
  const host = fakeHost([{ name: "read" }], []);
  host.emit("session_start");
  host.emit("before_agent_start");
  assert.deepEqual(host.active, ["read"]);
});

test("built-in search loads after the lock survive later turns and model changes", async () => {
  const host = fakeHost(
    [{ name: "read" }, builtinSearch, { name: "mcp__radius__issues", exposure: "deferred" }],
    [],
  );
  host.emit("session_start");
  host.emit("before_agent_start");
  assert.deepEqual(host.active, ["read", "tool_search"]);

  // What the built-in tool_search does on a match: an additive activation.
  host.active = [...host.active, "mcp__radius__issues"];
  const commits = host.commits.length;
  host.emit("before_agent_start");
  assert.equal(host.commits.length, commits, "the locked surface is never rewritten");

  host.emit("model_select");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.active, ["read", "mcp__radius__issues", "tool_search"]);
});

test("a fresh session start carries search-loaded tools but not inactive-by-policy direct tools", () => {
  // A resumed transcript restores both a tool the search loaded and a direct
  // tool the lean surface defers.
  const host = fakeHost(
    [
      { name: "read" },
      builtinSearch,
      { name: "mcp__radius__issues", exposure: "deferred" },
      { name: "symbol_search" },
      { name: "probe_hidden", exposure: "hidden" },
    ],
    ["read", "symbol_search", "mcp__radius__issues", "probe_hidden"],
  );
  host.emit("session_start");
  host.emit("before_agent_start");
  assert.deepEqual(host.active, ["read", "mcp__radius__issues", "tool_search"]);
});

test("removes disabled grep from the surface", () => {
  const host = fakeHost([{ name: "read" }, { name: "grep" }, builtinSearch], ["read", "grep"]);
  host.emit("session_start");
  host.emit("before_agent_start");
  assert.ok(!host.active.includes("grep"));
});

test("an always-active name with no registered tool does not corrupt the active set", () => {
  const host = fakeHost([{ name: "read" }, builtinSearch], []);
  host.emit("session_start");
  host.emit("before_agent_start");
  for (const name of host.active) {
    assert.ok(
      host.tools.some((tool) => tool.name === name),
      `${name} is registered`,
    );
  }
});

test("publishes the lean surface for sub-agents under a stable symbol", () => {
  fakeHost([], []);
  const policy = Object.getOwnPropertyDescriptor(globalThis, LEAN_SURFACE_SYMBOL)?.value;
  // SAFETY: The descriptor was just written by publishLeanSurface.
  const typed = reinterpretHostValue<LeanSurfacePolicy>(policy);
  assert.equal(LEAN_SURFACE_SYMBOL, Symbol.for("choco-pi.tool-search.lean-surface"));
  assert.ok(typed.alwaysActive().includes("tool_search"));
  for (const name of ["session_create", "symbol_search", "shell_stop"]) {
    assert.ok(!typed.alwaysActive().includes(name), `${name} must be bridge-only`);
  }
});

test("the native tier contains only core calls and rich-artifact tools", () => {
  assert.deepEqual(
    [...ALWAYS_ACTIVE_TOOL_NAMES],
    [
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
    ],
  );
});

interface SdkSession {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  close(): Promise<void>;
}

async function sdkSession(factories: ExtensionFactory[]): Promise<SdkSession> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-tool-search-"));
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  });
  await session.bindExtensions({});
  return {
    session,
    modelRuntime,
    close: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runToolSearch(session: AgentSession, query: string): Promise<string[]> {
  const definition = session.getToolDefinition("tool_search");
  assert.ok(definition, "tool_search is registered");
  const result = await definition.execute(
    "search",
    { query },
    undefined,
    undefined,
    // SAFETY: The built-in tool_search ignores its context.
    reinterpretHostValue<Parameters<typeof definition.execute>[4]>({}),
  );
  const details = reinterpretHostValue<{ loaded: string[] }>(result.details);
  return details.loaded;
}

test("real Pi session: built-in tool_search is active on turn one and loads late deferred tools", async () => {
  let registerLate: (() => void) | undefined;
  const lateDeferred: ExtensionFactory = (pi) => {
    // A built-in MCP server connects after session_start and registers its
    // tools with deferred exposure.
    registerLate = () =>
      pi.registerTool({
        name: "mcp__radius__list_issues",
        label: "list issues",
        description: "List Radius issues for a project",
        parameters: Type.Object({}),
        exposure: "deferred",
        execute: async () => ({ content: [{ type: "text", text: "issues" }], details: {} }),
      });
  };
  const fixture = await sdkSession([toolSearch, createToolSearchExtension(), lateDeferred]);
  try {
    const { session } = fixture;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(session.getActiveToolNames().includes("tool_search"));
    assert.ok(!session.getActiveToolNames().includes("mcp__radius__list_issues"));

    registerLate?.();
    assert.ok(
      session.getCallableToolNames().includes("mcp__radius__list_issues"),
      "a deferred tool is callable through ctx.executeTool() without activation",
    );
    assert.deepEqual(await runToolSearch(session, "radius issues"), ["mcp__radius__list_issues"]);
    assert.ok(session.getActiveToolNames().includes("mcp__radius__list_issues"));
  } finally {
    await fixture.close();
  }
});

test("real Pi session: /tree keeps the lean surface instead of activating unrecorded tools", async () => {
  const extraDirect: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "extra_direct",
      label: "extra direct",
      description: "A direct tool the lean surface leaves inactive",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "extra" }], details: {} }),
    });
  };
  const fixture = await sdkSession([toolSearch, createToolSearchExtension(), extraDirect]);
  try {
    const { session } = fixture;
    await new Promise((resolve) => setImmediate(resolve));
    const lean = session.getActiveToolNames();
    assert.ok(lean.includes("tool_search"));
    assert.ok(!lean.includes("extra_direct"));

    // What Pi records with the first request: the declared loadout as a system message.
    session.sessionManager.appendMessage({
      role: "system",
      content: "",
      toolsAdded: lean.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
      timestamp: Date.now(),
    });
    const target = session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    });

    const result = await session.navigateTree(target, { summarize: false });
    assert.equal(result.cancelled, false);
    assert.deepEqual(session.getActiveToolNames(), lean);
  } finally {
    await fixture.close();
  }
});

test("real Pi session: a recorded tool registered after /tree is active on the next request", async () => {
  const faux = createFauxCore({
    provider: "faux-tree",
    api: "faux-tree-api",
    models: [{ id: "m" }],
  });
  let registerLate: (() => void) | undefined;
  const fixtureTools: ExtensionFactory = (pi) => {
    pi.registerProvider("faux-tree", {
      baseUrl: "http://127.0.0.1.invalid",
      apiKey: "inert",
      api: faux.api,
      authHeader: false,
      models: faux.models.map((model) => ({ ...model, name: model.id })),
      streamSimple: faux.streamSimple,
    });
    pi.registerTool({
      name: "extra_direct",
      label: "extra direct",
      description: "A direct tool the lean surface leaves inactive",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "extra" }], details: {} }),
    });
    // An MCP server still connecting at the navigation registers its tool later.
    registerLate = () =>
      pi.registerTool({
        name: "mcp__late__probe",
        label: "late probe",
        description: "A recorded tool whose server connects late",
        parameters: Type.Object({}),
        exposure: "deferred",
        execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
      });
  };
  const fixture = await sdkSession([toolSearch, createToolSearchExtension(), fixtureTools]);
  try {
    const { session, modelRuntime } = fixture;
    const model = modelRuntime.getModel("faux-tree", "m");
    assert.ok(model);
    await session.setModel(model);
    await new Promise((resolve) => setImmediate(resolve));
    const lean = session.getActiveToolNames();

    const declared = [...lean, "mcp__late__probe"];
    session.sessionManager.appendMessage({
      role: "system",
      content: "",
      toolsAdded: declared.map((name) => ({
        name,
        description: name,
        parameters: Type.Object({}),
      })),
      timestamp: Date.now(),
    });
    const target = session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    });

    assert.equal((await session.navigateTree(target, { summarize: false })).cancelled, false);
    assert.deepEqual(session.getActiveToolNames(), lean);

    registerLate?.();
    faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
    await session.prompt("go");
    const active = session.getActiveToolNames();
    assert.ok(active.includes("mcp__late__probe"), "the recorded tool is active once registered");
    assert.ok(!active.includes("extra_direct"), "the unrecorded tool stays inactive");
  } finally {
    await fixture.close();
  }
});
