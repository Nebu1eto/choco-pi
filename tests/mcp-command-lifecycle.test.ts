import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "../.pi/packages/choco-pi-mcp/node_modules/typescript/lib/typescript.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "../.pi/packages/choco-pi-mcp/state.ts";
import type { PromptMetadata } from "../.pi/packages/choco-pi-mcp/types.ts";

const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const COMMANDS_URL_SUFFIX = "/.pi/packages/choco-pi-mcp/commands.ts";
const MCP_PACKAGE_PATH = "/.pi/packages/choco-pi-mcp/";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const commandLoadGate = deferred<void>();
const commandActions: string[] = [];
const commandHooks = { commandLoadGate, commandActions };
// SAFETY: The test owns this process-local loader hook key and assigns the declared fixture shape.
(
  globalThis as typeof globalThis & {
    __mcpCommandLifecycleHooks: typeof commandHooks;
  }
).__mcpCommandLifecycleHooks = commandHooks;

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(COMMANDS_URL_SUFFIX)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
const hooks = globalThis.__mcpCommandLifecycleHooks;
await hooks.commandLoadGate.promise;
export async function showTools() { hooks.commandActions.push("tools"); }
export async function authenticateServer() { hooks.commandActions.push("authenticate"); return { ok: false }; }
export async function logoutServer() {}
export async function openMcpPanel() {}
export async function openMcpSetup() {}
export async function reconnectServers() {}
export async function showPrompts() {}
export async function showStatus() {}
export async function openMcpAuthPanel() {}
export async function reconnectServer() {}
`,
      };
    }
    const loaded = nextLoad(url, context);
    if (url.includes(MCP_PACKAGE_PATH) && url.endsWith(".ts") && loaded.source !== undefined) {
      return {
        ...loaded,
        source: ts.transpileModule(String(loaded.source), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      };
    }
    return loaded;
  },
});

const { createMcpAdapter } = await import("../.pi/packages/choco-pi-mcp/index.ts");
const { createPromptCommand } = await import("../.pi/packages/choco-pi-mcp/prompts.ts");
const { createMcpRuntimeOwner } = await import("../.pi/packages/choco-pi-mcp/runtime-owner.ts");

type LifecycleHandler = (
  event: Record<string, never>,
  ctx: ExtensionContext,
) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;

function createExtensionApi() {
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const commandHandlers = new Map<string, CommandHandler>();
  // SAFETY: The adapter only uses the ExtensionAPI members supplied by this focused fixture.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    on(event: string, handler: LifecycleHandler) {
      lifecycleHandlers.set(event, handler);
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    registerFlag() {},
    registerTool() {},
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commandHandlers.set(name, command.handler);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    getFlag: () => undefined,
  });

  return {
    pi,
    invoke(event: string, ctx: ExtensionContext) {
      return lifecycleHandlers.get(event)?.({}, ctx);
    },
    command(name: string) {
      const handler = commandHandlers.get(name);
      assert.ok(handler, `/${name} was registered`);
      return handler;
    },
  };
}

function createContext(hasUI = false) {
  let stale = false;
  let accesses = 0;
  const notifications: Array<[string, string | undefined]> = [];
  const read = <T>(value: T): T => {
    accesses += 1;
    if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
    return value;
  };
  const ui = {
    notify(message: string, level?: string) {
      if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
      notifications.push([message, level]);
    },
    setStatus() {},
    theme: { fg: (_color: string, text: string) => text },
  };
  const fixture = {
    get cwd() {
      return read(process.cwd());
    },
    get hasUI() {
      return read(hasUI);
    },
    get mode() {
      return read("print" as const);
    },
    get model() {
      return read(undefined);
    },
    get modelRegistry() {
      return read(undefined);
    },
    get signal() {
      return read(undefined);
    },
    get ui() {
      return read(ui);
    },
    get reload() {
      return read(async () => {});
    },
  };

  // SAFETY: The fixture supplies every ExtensionContext member exercised by initialization and commands.
  const ctx = Object.assign(
    Object.create(null) as ExtensionContext & ExtensionCommandContext,
    fixture,
  );

  return {
    ctx,
    notifications,
    markStale() {
      stale = true;
    },
    accessCount: () => accesses,
  };
}

const promptMetadata: PromptMetadata = {
  serverName: "demo",
  originalName: "brief",
  commandName: "mcp__demo__brief",
  description: "Create a brief",
  arguments: [],
};

function createPromptState(options: {
  owner: ReturnType<typeof createMcpRuntimeOwner>;
  connect?: () => Promise<{
    status: "needs-auth";
    tools: [];
    resources: [];
    prompts: [];
  }>;
  getPrompt?: () => Promise<{
    messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
  }>;
  connected?: boolean;
}): McpExtensionState {
  let connection = options.connected
    ? { status: "connected", tools: [], resources: [], prompts: [] }
    : undefined;
  // SAFETY: The prompt path only exercises the state members supplied by this focused fixture.
  return Object.assign(Object.create(null) as McpExtensionState, {
    owner: options.owner,
    config: { mcpServers: { demo: { disabled: options.connected === true } } },
    manager: {
      getConnection: () => connection,
      connect: options.connect
        ? async () => {
            const result = await options.connect?.();
            connection = result;
            return result;
          }
        : undefined,
      getPrompt: options.getPrompt,
    },
    lifecycle: { markKeepAlive() {} },
    promptMetadata: new Map([["demo", [promptMetadata]]]),
    promptMetadataLive: new Set<string>(),
    toolMetadata: new Map(),
    resourceCounts: new Map(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    failureMessages: new Map(),
  });
}

test("deferred /mcp command imports ignore stale contexts and serve the current owner", async () => {
  const api = createExtensionApi();
  createMcpAdapter({ config: { mcpServers: {} } })(api.pi);
  const oldContext = createContext();

  await api.invoke("session_start", oldContext.ctx);
  await api.invoke("input", oldContext.ctx);
  const oldMcp = api.command("mcp")("tools", oldContext.ctx);
  const oldAuth = api.command("mcp-auth")("demo", oldContext.ctx);

  await api.invoke("session_shutdown", createContext().ctx);
  oldContext.markStale();
  const oldAccesses = oldContext.accessCount();

  const currentContext = createContext();
  await api.invoke("session_start", currentContext.ctx);
  await api.invoke("input", currentContext.ctx);
  const currentMcp = api.command("mcp")("tools", currentContext.ctx);
  const currentAuth = api.command("mcp-auth")("demo", currentContext.ctx);

  commandLoadGate.resolve();
  await assert.doesNotReject(() => Promise.all([oldMcp, oldAuth, currentMcp, currentAuth]));

  assert.equal(oldContext.accessCount(), oldAccesses);
  assert.deepEqual(commandActions.sort(), ["authenticate", "tools"]);
});

test("prompt commands stop after an invalidated deferred connection", async () => {
  const connectGate = deferred<{
    status: "needs-auth";
    tools: [];
    resources: [];
    prompts: [];
  }>();
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({ owner, connect: () => connectGate.promise });
  const context = createContext(true);
  const sent: string[] = [];
  // SAFETY: Prompt commands only use sendUserMessage on this ExtensionAPI fixture.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    sendUserMessage(text: string) {
      sent.push(text);
    },
  });
  const pending = createPromptCommand(pi, () => state, promptMetadata).handler("", context.ctx);

  await owner.stop("test owner invalidated");
  context.markStale();
  const accesses = context.accessCount();
  connectGate.resolve({ status: "needs-auth", tools: [], resources: [], prompts: [] });

  await assert.doesNotReject(() => pending);
  assert.equal(context.accessCount(), accesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(sent, []);

  const currentConnectGate = deferred<{
    status: "needs-auth";
    tools: [];
    resources: [];
    prompts: [];
  }>();
  const currentOwner = createMcpRuntimeOwner();
  const currentState = createPromptState({
    owner: currentOwner,
    connect: () => currentConnectGate.promise,
  });
  const currentContext = createContext(true);
  const currentPending = createPromptCommand(pi, () => currentState, promptMetadata).handler(
    "",
    currentContext.ctx,
  );
  currentConnectGate.resolve({ status: "needs-auth", tools: [], resources: [], prompts: [] });
  await currentPending;
  assert.match(currentContext.notifications.at(-1)?.[0] ?? "", /needs authentication/);
});

test("prompt commands stop after an invalidated deferred prompt and send for the current owner", async () => {
  const promptGate = deferred<{
    messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
  }>();
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({ owner, connected: true, getPrompt: () => promptGate.promise });
  const context = createContext(true);
  const sent: string[] = [];
  // SAFETY: Prompt commands only use sendUserMessage on this ExtensionAPI fixture.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    sendUserMessage(text: string) {
      sent.push(text);
    },
  });
  const pending = createPromptCommand(pi, () => state, promptMetadata).handler("", context.ctx);

  await owner.stop("test owner invalidated");
  context.markStale();
  const accesses = context.accessCount();
  promptGate.resolve({ messages: [{ role: "user", content: { type: "text", text: "stale" } }] });

  await assert.doesNotReject(() => pending);
  assert.equal(context.accessCount(), accesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(sent, []);

  const currentOwner = createMcpRuntimeOwner();
  const currentState = createPromptState({
    owner: currentOwner,
    connected: true,
    getPrompt: async () => ({
      messages: [{ role: "user", content: { type: "text", text: "current" } }],
    }),
  });
  await createPromptCommand(pi, () => currentState, promptMetadata).handler(
    "",
    createContext(true).ctx,
  );
  assert.deepEqual(sent, ["current"]);
});
