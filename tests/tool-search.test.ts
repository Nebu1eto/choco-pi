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
  type FileEntry,
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

/** The context members the policy reads: a fresh session with no recorded tools. */
interface FakeContext {
  sessionManager: { getBranch(): [] };
}

interface FakeHost {
  tools: FakeTool[];
  active: string[];
  commits: string[][];
  registered: string[];
  emit(event: "session_start" | "before_agent_start" | "model_select"): void;
}

function fakeHost(tools: FakeTool[], active: string[]): FakeHost {
  const handlers = new Map<string, (event: { type: string }, ctx: FakeContext) => void>();
  const ctx: FakeContext = { sessionManager: { getBranch: () => [] } };
  const host: FakeHost = {
    tools,
    active,
    commits: [],
    registered: [],
    emit: (event) => handlers.get(event)?.({ type: event }, ctx),
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
      on: (name: string, handler: (event: { type: string }, ctx: FakeContext) => void) =>
        handlers.set(name, handler),
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

async function sdkSession(
  factories: ExtensionFactory[],
  entries?: FileEntry[],
): Promise<SdkSession> {
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
    sessionManager: SessionManager.inMemory(root, undefined, entries),
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

interface LateToolFixture {
  session: AgentSession;
  /** The active tools once the session has started. */
  started: string[];
  /** Registers the recorded deferred tool, as an MCP server connecting late would. */
  registerLate(): void;
  /** Sends a prompt the faux model answers without tool calls. */
  prompt(text: string): Promise<void>;
  close(): Promise<void>;
}

const LATE_TOOL = "mcp__late__probe";
const UNRECORDED_TOOL = "extra_direct";

interface LateToolOptions {
  /** Entries of an earlier session to resume. */
  resume?: FileEntry[];
  /** Load choco-pi's tool-search policy; off for a Pi-only control. */
  toolSearch?: boolean;
}

async function lateToolFixture(options: LateToolOptions = {}): Promise<LateToolFixture> {
  const faux = createFauxCore({
    provider: "faux-tree",
    api: "faux-tree-api",
    models: [{ id: "m" }],
  });
  let registerLate = (): void => assert.fail("fixture extension did not load");
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
      name: UNRECORDED_TOOL,
      label: "extra direct",
      description: "A direct tool the lean surface leaves inactive",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "extra" }], details: {} }),
    });
    registerLate = () =>
      pi.registerTool({
        name: LATE_TOOL,
        label: "late probe",
        description: "A recorded tool whose server connects late",
        parameters: Type.Object({}),
        exposure: "deferred",
        execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
      });
  };
  const policy = options.toolSearch === false ? [] : [toolSearch];
  const fixture = await sdkSession(
    [...policy, createToolSearchExtension(), fixtureTools],
    options.resume,
  );
  const { session, modelRuntime } = fixture;
  const model = modelRuntime.getModel("faux-tree", "m");
  assert.ok(model, "faux model registered");
  await session.setModel(model);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    session,
    started: session.getActiveToolNames(),
    registerLate: () => registerLate(),
    prompt: async (text) => {
      faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
      await session.prompt(text);
    },
    close: fixture.close,
  };
}

/** Records `declared` the way Pi does with a request: as a system message's added tools. */
function recordTools(sessionManager: SessionManager, declared: readonly string[]): void {
  sessionManager.appendMessage({
    role: "system",
    content: "",
    toolsAdded: declared.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
    timestamp: Date.now(),
  });
}

function appendUserTurn(sessionManager: SessionManager, text: string): string {
  return sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

/** Records `declared`, adds two user turns, and navigates back to the first one. */
async function recordAndNavigateBack(session: AgentSession, declared: string[]): Promise<void> {
  recordTools(session.sessionManager, declared);
  const target = appendUserTurn(session.sessionManager, "first");
  appendUserTurn(session.sessionManager, "second");
  assert.equal((await session.navigateTree(target, { summarize: false })).cancelled, false);
}

/** Entries of an earlier session whose transcript recorded `declared`, then `removed`. */
function sessionThatRecorded(
  declared: readonly string[],
  removed: readonly string[] = [],
): FileEntry[] {
  const sessionManager = SessionManager.inMemory();
  recordTools(sessionManager, declared);
  appendUserTurn(sessionManager, "earlier turn");
  if (removed.length > 0) {
    sessionManager.appendMessage({
      role: "system",
      content: "",
      toolsRemoved: removed.map((name) => ({ name })),
      timestamp: Date.now(),
    });
    appendUserTurn(sessionManager, "later turn");
  }
  const header = sessionManager.getHeader();
  assert.ok(header);
  return [header, ...sessionManager.getEntries()];
}

test("real Pi session: /tree keeps the lean surface instead of activating unrecorded tools", async () => {
  const fixture = await lateToolFixture();
  try {
    const lean = fixture.started;
    assert.ok(lean.includes("tool_search"));
    assert.ok(!lean.includes(UNRECORDED_TOOL));
    await recordAndNavigateBack(fixture.session, lean);
    assert.deepEqual(fixture.session.getActiveToolNames(), lean);
  } finally {
    await fixture.close();
  }
});

test("real Pi session: a recorded tool registered after /tree is active on the next request", async () => {
  const fixture = await lateToolFixture();
  try {
    await recordAndNavigateBack(fixture.session, [...fixture.started, LATE_TOOL]);
    assert.deepEqual(fixture.session.getActiveToolNames(), fixture.started);

    fixture.registerLate();
    await fixture.prompt("go");
    const active = fixture.session.getActiveToolNames();
    assert.ok(active.includes(LATE_TOOL), "the recorded tool is active once registered");
    assert.ok(!active.includes(UNRECORDED_TOOL), "the unrecorded tool stays inactive");
  } finally {
    await fixture.close();
  }
});

test("real Pi session: a recorded tool still unregistered at the next request expires", async () => {
  const fixture = await lateToolFixture();
  try {
    await recordAndNavigateBack(fixture.session, [...fixture.started, LATE_TOOL]);
    // Like Pi's pending tools, the restored name is dropped once a request records the loadout.
    await fixture.prompt("before registration");
    fixture.registerLate();
    await fixture.prompt("after registration");
    assert.ok(!fixture.session.getActiveToolNames().includes(LATE_TOOL));
  } finally {
    await fixture.close();
  }
});

// On resume, MCP servers are still connecting when the lean surface first commits, and that
// commit clears Pi's pending recorded tools. The control shows Pi alone keeps the tool.
for (const toolSearchLoaded of [false, true]) {
  const subject = toolSearchLoaded ? "with the lean surface" : "Pi alone (control)";
  test(`real Pi session: ${subject} keeps a searched tool that registers after resume`, async () => {
    const fixture = await lateToolFixture({
      resume: sessionThatRecorded(["read", "tool_search", LATE_TOOL]),
      toolSearch: toolSearchLoaded,
    });
    try {
      assert.ok(!fixture.started.includes(LATE_TOOL), "the tool is not registered at startup");
      fixture.registerLate();
      await fixture.prompt("go");
      assert.ok(fixture.session.getActiveToolNames().includes(LATE_TOOL));
    } finally {
      await fixture.close();
    }
  });
}

test("real Pi session: a tool the transcript removed stays inactive after resume", async () => {
  const fixture = await lateToolFixture({
    resume: sessionThatRecorded(["read", "tool_search", LATE_TOOL], [LATE_TOOL]),
  });
  try {
    fixture.registerLate();
    await fixture.prompt("go");
    assert.ok(!fixture.session.getActiveToolNames().includes(LATE_TOOL));
  } finally {
    await fixture.close();
  }
});
