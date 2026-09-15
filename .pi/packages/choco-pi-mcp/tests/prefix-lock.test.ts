import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "../../../extensions/lib/runtime-values.ts";
import type { ServerEntry } from "../types.ts";

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const agentDirectory = await mkdtemp(join(tmpdir(), "mcp-prefix-lock-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
const [{ computeServerHash }, { createMcpAdapter }] = await Promise.all([
  import("../metadata-cache.ts"),
  import("../index.ts"),
]);

test.after(async () => {
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  await rm(agentDirectory, { recursive: true, force: true });
});

const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");
const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

type LifecycleHandler = (
  event: Record<string, never>,
  context: ExtensionContext,
) => void | Promise<void>;

const context = reinterpretHostValue<ExtensionContext>({
  cwd: process.cwd(),
  mode: "print",
  hasUI: false,
  model: undefined,
  modelRegistry: {},
  signal: undefined,
});

interface PrefixLockFixture {
  handlers: Map<string, LifecycleHandler>;
  registeredTools: string[];
  pi: ExtensionAPI;
}

function installFixture(locked: () => boolean): PrefixLockFixture {
  const handlers = new Map<string, LifecycleHandler>();
  const registeredTools: string[] = [];
  let activeTools: string[] = [];
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: locked },
  });
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: LifecycleHandler) => handlers.set(event, handler),
    events: { on: () => () => {}, emit: () => undefined },
    registerFlag: () => undefined,
    registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
    registerCommand: () => undefined,
    getAllTools: () =>
      registeredTools.map((name) => ({
        name,
        description: name,
        parameters: {},
        sourceInfo: { source: "extension", path: name },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    getFlag: () => undefined,
  });
  return { handlers, registeredTools, pi };
}

test("new direct tool registration is deferred while locked until session_start", async () => {
  let locked = true;
  const server = {
    command: "fixture",
    directTools: true,
    exposeResources: false,
  } satisfies ServerEntry;
  await writeFile(
    join(agentDirectory, "mcp-cache.json"),
    JSON.stringify({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(server),
          cachedAt: Date.now(),
          tools: [{ name: "ping", description: "Ping the fixture", inputSchema: {} }],
          resources: [],
        },
      },
    }),
  );
  const fixture = installFixture(() => locked);

  createMcpAdapter({
    config: {
      mcpServers: { demo: server },
      settings: { disableProxyTool: true },
    },
  })(fixture.pi);
  assert.deepEqual(fixture.registeredTools, ["mcpScript"]);

  locked = false;
  const sessionStart = fixture.handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({}, context);
  assert.deepEqual(fixture.registeredTools, ["mcpScript", "demo_ping"]);
});

test("first proxy registration is deferred while the prefix is locked", () => {
  const fixture = installFixture(() => true);
  createMcpAdapter({ config: { mcpServers: {} } })(fixture.pi);
  assert.deepEqual(fixture.registeredTools, ["mcpScript"]);
});

test("model_select replays a deferred proxy surface", async () => {
  let locked = true;
  const fixture = installFixture(() => locked);
  createMcpAdapter({ config: { mcpServers: {} } })(fixture.pi);
  assert.deepEqual(fixture.registeredTools, ["mcpScript"]);

  locked = false;
  const modelSelect = fixture.handlers.get("model_select");
  assert.ok(modelSelect);
  await modelSelect({}, context);
  assert.deepEqual(fixture.registeredTools, ["mcpScript", "mcp"]);
});

test("does not reactivate the MCP proxy after the prefix locks", async () => {
  let locked = false;
  let activeTools = ["mcp"];
  const commits: string[][] = [];
  const handlers = new Map<string, LifecycleHandler>();
  const registeredTools: string[] = [];
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: () => locked },
  });
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    events: { on: () => () => {}, emit: () => undefined },
    registerFlag: () => undefined,
    registerTool: (tool: { name: string }) => {
      registeredTools.push(tool.name);
    },
    registerCommand: () => undefined,
    getAllTools: () =>
      registeredTools.map((name) => ({
        name,
        description: name,
        parameters: {},
        sourceInfo: { source: "extension", path: name },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
      commits.push([...names]);
    },
    getFlag: () => undefined,
  });
  createMcpAdapter({ config: { mcpServers: {} } })(pi);
  activeTools = [];
  locked = true;

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart(
    {},
    reinterpretHostValue<ExtensionContext>({
      cwd: process.cwd(),
      mode: "print",
      hasUI: false,
      model: undefined,
      modelRegistry: {},
      signal: undefined,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(commits, []);

  locked = false;
  await sessionStart(
    {},
    reinterpretHostValue<ExtensionContext>({
      cwd: process.cwd(),
      mode: "print",
      hasUI: false,
      model: undefined,
      modelRegistry: {},
      signal: undefined,
    }),
  );
  assert.deepEqual(commits, [["mcp"]]);
});

test("keeps the proxy registered but inactive under a bridge-only lean surface", () => {
  let activeTools = ["mcp"];
  Object.defineProperty(globalThis, LEAN_SURFACE_SYMBOL, {
    configurable: true,
    value: { alwaysActive: () => ["exec", "tool_search"] },
  });
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: () => undefined,
    events: { on: () => () => {}, emit: () => undefined },
    registerFlag: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    getAllTools: () => [],
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    getFlag: () => undefined,
  });

  createMcpAdapter({ config: { mcpServers: {} } })(pi);
  assert.deepEqual(activeTools, []);
  delete reinterpretHostValue<{ [LEAN_SURFACE_SYMBOL]?: unknown }>(globalThis)[LEAN_SURFACE_SYMBOL];
});
