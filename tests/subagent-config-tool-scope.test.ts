/**
 * Child tool scope after the move to Pi's built-in tool_search (ledger M1/M2).
 *
 * A real AgentSession runs a scripted faux model through the production
 * boundaries: the child's scoped built-in `tool_search`, the `tool_call`
 * guard (which also sees nested `ctx.executeTool()` calls), the turn_end
 * renarrow, and choco-pi-codex's exec bridge adapter including its direct
 * `execute()` fallback for tools `ctx.executeTool()` cannot reach.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { publishLeanSurface } from "../.pi/extensions/lib/tool-surface.ts";
import { toNestedTool } from "../.pi/packages/choco-pi-codex/src/adapter/code-mode/nested-tool-adapter.ts";
import {
  createChildToolSearchExtension,
  installExtensionToolScope,
  restrictSessionToolScope,
} from "../.pi/packages/choco-pi-subagents/src/agent-runner.ts";

const PROVIDER = "faux-tool-scope";
const DENIED = new Set(["mcp__denied__probe", "direct_denied_probe"]);

interface Harness {
  session: AgentSession;
  executed: string[];
  bridgeResults: string[];
  setResponses: ReturnType<typeof createFauxCore>["setResponses"];
  close(): Promise<void>;
}

function probe(name: string, exposure: "deferred" | "direct", executed: string[]): ToolDefinition {
  const tool: ToolDefinition = {
    name,
    label: name,
    description: `Inspect widget probe state (${name})`,
    parameters: Type.Object({}),
    exposure,
    execute: async () => {
      executed.push(name);
      return { content: [{ type: "text", text: `${name} ran` }], details: {} };
    },
  };
  // A direct tool the lean surface leaves inactive: only a bridge could run it.
  if (exposure === "direct") tool.defaultActive = false;
  return tool;
}

/** Late-bound reachability, filled once the scope is installed. */
interface ScopeSlot {
  isReachable?: (name: string) => boolean;
}

async function harness(): Promise<Harness> {
  publishLeanSurface();
  const root = await mkdtemp(join(tmpdir(), "choco-pi-child-scope-"));
  const executed: string[] = [];
  const bridgeResults: string[] = [];
  const faux = createFauxCore({
    provider: PROVIDER,
    api: `${PROVIDER}-api`,
    models: [{ id: "m" }],
  });
  const probes = new Map<string, ToolDefinition>(
    [
      probe("mcp__allowed__probe", "deferred", executed),
      probe("mcp__denied__probe", "deferred", executed),
      probe("direct_denied_probe", "direct", executed),
    ].map((tool) => [tool.name, tool]),
  );
  const slot: ScopeSlot = {};

  const tools: ExtensionFactory = (pi) => {
    pi.registerProvider(PROVIDER, {
      baseUrl: "http://127.0.0.1.invalid",
      apiKey: "inert",
      api: faux.api,
      authHeader: false,
      models: faux.models.map((model) => ({ ...model, name: model.id })),
      streamSimple: faux.streamSimple,
    });
    for (const tool of probes.values()) pi.registerTool(tool);
    // The exec bridge's dispatch for a registered tool, exactly as code mode wraps it.
    pi.registerTool({
      name: "bridge",
      label: "bridge",
      description: "Run a registered tool through the code-mode bridge adapter",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const target = probes.get(params.name);
        if (!target) throw new Error(`unknown ${params.name}`);
        const nested = toNestedTool(target, "", {}, { dispatch: "session" });
        try {
          await nested.invoke(
            {},
            { cwd: root, toolCallId, extensionContext: ctx },
            signal ?? new AbortController().signal,
          );
          bridgeResults.push(`${params.name}:ok`);
        } catch (error) {
          bridgeResults.push(`${params.name}:${error instanceof Error ? error.message : "error"}`);
        }
        return { content: [{ type: "text", text: "bridged" }], details: {} };
      },
    });
    // Any other extension issuing a nested call through ctx.executeTool().
    pi.registerTool({
      name: "raw_bridge",
      label: "raw_bridge",
      description: "Run a tool through ctx.executeTool",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const outcome = await ctx.executeTool(params.name, {});
        bridgeResults.push(`raw:${params.name}:${outcome.isError ? "blocked" : "ok"}`);
        return { content: [{ type: "text", text: "raw" }], details: {} };
      },
    });
  };

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
    extensionFactories: [
      tools,
      createChildToolSearchExtension((name) => slot.isReachable?.(name) === true),
    ],
  });
  await loader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "inert" }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  });
  await session.bindExtensions({});
  const model = modelRuntime.getModel(PROVIDER, "m");
  assert.ok(model, "faux model registered");
  await session.setModel(model);

  // A tool-denied child: the probes' extension loads, two of its tools are denied.
  const isReachable = installExtensionToolScope(session, {
    loader,
    toolNames: ["read", "bridge", "raw_bridge"],
    disallowedSet: DENIED,
    extNames: new Set(),
    narrowing: new Map(),
    nestedToolNames: new Set(),
    alwaysToolNames: new Set(),
  });
  slot.isReachable = isReachable;
  restrictSessionToolScope(session.sessionManager, isReachable);

  return {
    session,
    executed,
    bridgeResults,
    setResponses: (responses) => faux.setResponses(responses),
    close: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a tool-denied child reaches allowed deferred tools and never denied ones", async () => {
  const h = await harness();
  try {
    const active = h.session.getActiveToolNames();
    assert.ok(active.includes("tool_search"), "built-in tool_search is active on turn one");
    assert.ok(!active.some((name) => name.startsWith("mcp__")), "deferred tools start undeclared");

    h.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "inspect widget probe" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [
          fauxToolCall("mcp__denied__probe", {}),
          fauxToolCall("bridge", { name: "mcp__denied__probe" }),
          fauxToolCall("bridge", { name: "direct_denied_probe" }),
          fauxToolCall("raw_bridge", { name: "mcp__denied__probe" }),
          fauxToolCall("raw_bridge", { name: "direct_denied_probe" }),
          fauxToolCall("bridge", { name: "mcp__allowed__probe" }),
          fauxToolCall("raw_bridge", { name: "mcp__allowed__probe" }),
          fauxToolCall("mcp__allowed__probe", {}),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await h.session.prompt("go");

    const searchResult = h.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "tool_search",
    );
    assert.ok(searchResult && searchResult.role === "toolResult");
    const searchText = searchResult.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n");
    assert.match(searchText, /mcp__allowed__probe/);
    assert.doesNotMatch(searchText, /denied/, "search never names a denied tool");

    assert.deepEqual(
      [...new Set(h.executed)].sort(),
      ["mcp__allowed__probe"],
      "no denied tool executed directly, through the bridge, or through ctx.executeTool",
    );
    // Tool calls of one turn run in parallel, so compare without order.
    assert.deepEqual([...h.bridgeResults].sort(), [
      "direct_denied_probe:Code mode tool error [not_available]: direct_denied_probe is not available to this session.",
      "mcp__allowed__probe:ok",
      "mcp__denied__probe:Code mode tool error [not_available]: mcp__denied__probe is not available to this session.",
      "raw:direct_denied_probe:blocked",
      "raw:mcp__allowed__probe:ok",
      "raw:mcp__denied__probe:blocked",
    ]);

    const finalActive = h.session.getActiveToolNames();
    assert.ok(
      finalActive.includes("mcp__allowed__probe"),
      "turn_end renarrow keeps a reachable tool the search loaded",
    );
    assert.ok(!finalActive.includes("mcp__denied__probe"));
  } finally {
    await h.close();
  }
});

test("renarrow withdraws a deferred tool activated outside the child's reach", async () => {
  const h = await harness();
  try {
    // Something other than the scoped search activates a denied deferred tool.
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "mcp__denied__probe"]);
    h.setResponses([fauxAssistantMessage([fauxText("done")])]);
    await h.session.prompt("go");
    assert.ok(!h.session.getActiveToolNames().includes("mcp__denied__probe"));
  } finally {
    await h.close();
  }
});
