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
import type { PromptMetadata, ServerEntry } from "../.pi/packages/choco-pi-mcp/types.ts";

const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const STALE_PI_MESSAGE = "This extension pi is stale after session replacement or reload.";
const COMMANDS_URL_SUFFIX = "/.pi/packages/choco-pi-mcp/commands.ts";
const INIT_URL_SUFFIX = "/.pi/packages/choco-pi-mcp/init.ts";
const PROMPTS_URL_SUFFIX = "/.pi/packages/choco-pi-mcp/prompts.ts";
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

function waitForAbort<T>(signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  assert.ok(signal);
  return new Promise<T>((_resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

const commandLoadGate = deferred<void>();
const promptLoadGate = deferred<void>();
const promptLoadStarted = deferred<void>();
const commandActions: string[] = [];
const commandHooks = {
  commandLoadGate,
  promptLoadGate,
  promptLoadStarted,
  commandActions,
  createPromptState: (owner: ReturnType<typeof createMcpRuntimeOwner>) =>
    createPromptState({
      owner,
      connected: true,
      getPrompt: async () => ({
        messages: [{ role: "user", content: { type: "text", text: "current prompt" } }],
      }),
    }),
};
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
    if (url.endsWith(INIT_URL_SUFFIX)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
const hooks = globalThis.__mcpCommandLifecycleHooks;
export async function initializeMcp(_pi, _ctx, owner) { return hooks.createPromptState(owner); }
export function updateStatusBar() {}
export function flushMetadataCache() {}
export async function lazyConnect(state, serverName, signal) {
  const existing = state.manager.getConnection(serverName);
  if (existing?.status === "connected") return true;
  if (existing?.status === "needs-auth") return false;
  const definition = state.config.mcpServers[serverName];
  if (!definition || definition.disabled === true) return false;
  const connection = await state.manager.connect(serverName, definition, signal);
  return connection.status === "connected";
}
`,
      };
    }
    const loaded = nextLoad(url, context);
    if (url.includes(MCP_PACKAGE_PATH) && url.endsWith(".ts") && loaded.source !== undefined) {
      const source = ts.transpileModule(String(loaded.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return {
        ...loaded,
        source: url.endsWith(PROMPTS_URL_SUFFIX)
          ? `const promptHooks = globalThis.__mcpCommandLifecycleHooks;\npromptHooks.promptLoadStarted.resolve();\nawait promptHooks.promptLoadGate.promise;\n${source}`
          : source,
      };
    }
    return loaded;
  },
});

const { createMcpAdapter } = await import("../.pi/packages/choco-pi-mcp/index.ts");
const { createMcpRuntimeOwner } = await import("../.pi/packages/choco-pi-mcp/runtime-owner.ts");

async function loadCreatePromptCommand() {
  return (await import("../.pi/packages/choco-pi-mcp/prompts.ts")).createPromptCommand;
}

type LifecycleHandler = (
  event: Record<string, never>,
  ctx: ExtensionContext,
) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;

function createExtensionApi() {
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const commandHandlers = new Map<string, CommandHandler>();
  let stale = false;
  let accesses = 0;
  const sent: string[] = [];
  // SAFETY: The adapter only uses the ExtensionAPI members supplied by this focused fixture.
  const target = Object.assign(Object.create(null) as ExtensionAPI, {
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
    sendUserMessage(text: string) {
      sent.push(text);
    },
  });
  const pi = new Proxy(target, {
    get(proxyTarget, property) {
      accesses += 1;
      if (stale) throw new Error(STALE_PI_MESSAGE);
      // SAFETY: The proxy target is an ExtensionAPI, so its runtime property keys index that interface.
      return proxyTarget[property as keyof ExtensionAPI];
    },
  });

  return {
    pi,
    sent,
    invoke(event: string, ctx: ExtensionContext) {
      return lifecycleHandlers.get(event)?.({}, ctx);
    },
    command(name: string) {
      const handler = commandHandlers.get(name);
      assert.ok(handler, `/${name} was registered`);
      return handler;
    },
    markStale() {
      stale = true;
    },
    accessCount: () => accesses,
  };
}

function createContext(hasUI = false, signal?: AbortSignal) {
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
      return read(signal);
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

function createPromptApi() {
  let stale = false;
  let accesses = 0;
  const sent: string[] = [];
  // SAFETY: The proxy supplies the only ExtensionAPI member exercised by prompt commands.
  const pi = new Proxy(Object.create(null) as ExtensionAPI, {
    get(_target, property) {
      accesses += 1;
      if (stale) throw new Error("This extension pi is stale after session replacement or reload.");
      if (property === "sendUserMessage") {
        return (text: string) => sent.push(text);
      }
      return undefined;
    },
  });
  return {
    pi,
    sent,
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
  connect?: (signal?: AbortSignal) => Promise<{
    status: "needs-auth";
    tools: [];
    resources: [];
    prompts: [];
  }>;
  getPrompt?: (signal?: AbortSignal) => Promise<{
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
        ? async (_serverName: string, _definition: ServerEntry, signal?: AbortSignal) => {
            const result = await options.connect?.(signal);
            connection = result;
            return result;
          }
        : undefined,
      getPrompt: options.getPrompt
        ? async (
            _serverName: string,
            _promptName: string,
            _args: Record<string, string> | undefined,
            signal?: AbortSignal,
          ) => options.getPrompt?.(signal)
        : undefined,
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

test("deferred prompt imports ignore stale contexts and pi while serving the current owner", async () => {
  const oldApi = createExtensionApi();
  createMcpAdapter({ config: { mcpServers: {} } })(oldApi.pi);
  const oldContext = createContext(true);

  await oldApi.invoke("session_start", oldContext.ctx);
  await oldApi.invoke("input", oldContext.ctx);
  const oldPending = oldApi.command(promptMetadata.commandName)("", oldContext.ctx);
  await promptLoadStarted.promise;

  await oldApi.invoke("session_shutdown", createContext().ctx);
  oldContext.markStale();
  oldApi.markStale();
  const oldContextAccesses = oldContext.accessCount();
  const oldPiAccesses = oldApi.accessCount();

  const currentApi = createExtensionApi();
  createMcpAdapter({ config: { mcpServers: {} } })(currentApi.pi);
  const currentContext = createContext(true);
  await currentApi.invoke("session_start", currentContext.ctx);
  await currentApi.invoke("input", currentContext.ctx);
  const currentPending = currentApi.command(promptMetadata.commandName)("", currentContext.ctx);

  promptLoadGate.resolve();
  await assert.doesNotReject(() => Promise.all([oldPending, currentPending]));

  assert.equal(oldContext.accessCount(), oldContextAccesses);
  assert.equal(oldApi.accessCount(), oldPiAccesses);
  assert.deepEqual(currentApi.sent, ["current prompt"]);
});

test("prompt commands stop after an invalidated deferred connection", async () => {
  const createPromptCommand = await loadCreatePromptCommand();
  let connectionAborted = false;
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({
    owner,
    connect: (signal) =>
      waitForAbort(signal, () => {
        connectionAborted = true;
      }),
  });
  const context = createContext(true);
  const api = createPromptApi();
  const pending = createPromptCommand(api.pi, () => state, promptMetadata).handler("", context.ctx);

  await owner.stop("test owner invalidated");
  context.markStale();
  api.markStale();
  const contextAccesses = context.accessCount();
  const piAccesses = api.accessCount();

  await assert.doesNotReject(() => pending);
  assert.equal(connectionAborted, true);
  assert.equal(context.accessCount(), contextAccesses);
  assert.equal(api.accessCount(), piAccesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(api.sent, []);

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
  const currentApi = createPromptApi();
  const currentPending = createPromptCommand(
    currentApi.pi,
    () => currentState,
    promptMetadata,
  ).handler("", currentContext.ctx);
  currentConnectGate.resolve({ status: "needs-auth", tools: [], resources: [], prompts: [] });
  await currentPending;
  assert.match(currentContext.notifications.at(-1)?.[0] ?? "", /needs authentication/);
});

test("prompt commands stop after an invalidated deferred prompt and send for the current owner", async () => {
  const createPromptCommand = await loadCreatePromptCommand();
  let promptAborted = false;
  const promptStarted = deferred<void>();
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({
    owner,
    connected: true,
    getPrompt: (signal) => {
      promptStarted.resolve();
      return waitForAbort(signal, () => {
        promptAborted = true;
      });
    },
  });
  const context = createContext(true);
  const api = createPromptApi();
  const pending = createPromptCommand(api.pi, () => state, promptMetadata).handler("", context.ctx);

  await promptStarted.promise;
  await owner.stop("test owner invalidated");
  context.markStale();
  api.markStale();
  const contextAccesses = context.accessCount();
  const piAccesses = api.accessCount();

  await assert.doesNotReject(() => pending);
  assert.equal(promptAborted, true);
  assert.equal(context.accessCount(), contextAccesses);
  assert.equal(api.accessCount(), piAccesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(api.sent, []);

  const currentOwner = createMcpRuntimeOwner();
  const currentState = createPromptState({
    owner: currentOwner,
    connected: true,
    getPrompt: async () => ({
      messages: [{ role: "user", content: { type: "text", text: "current" } }],
    }),
  });
  const currentApi = createPromptApi();
  await createPromptCommand(currentApi.pi, () => currentState, promptMetadata).handler(
    "",
    createContext(true).ctx,
  );
  assert.deepEqual(currentApi.sent, ["current"]);
});

test("prompt command signal abort cancels a deferred connection without stale access", async () => {
  const createPromptCommand = await loadCreatePromptCommand();
  let connectionAborted = false;
  const controller = new AbortController();
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({
    owner,
    connect: (signal) =>
      waitForAbort(signal, () => {
        connectionAborted = true;
      }),
  });
  const context = createContext(true, controller.signal);
  const api = createPromptApi();
  const pending = createPromptCommand(api.pi, () => state, promptMetadata).handler("", context.ctx);

  context.markStale();
  api.markStale();
  const contextAccesses = context.accessCount();
  const piAccesses = api.accessCount();
  controller.abort(new DOMException("Command cancelled", "AbortError"));

  await assert.doesNotReject(() => pending);
  assert.equal(connectionAborted, true);
  assert.equal(context.accessCount(), contextAccesses);
  assert.equal(api.accessCount(), piAccesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(api.sent, []);
  await owner.stop("test complete");
});

test("prompt command signal abort cancels deferred prompt retrieval without stale access", async () => {
  const createPromptCommand = await loadCreatePromptCommand();
  let promptAborted = false;
  const controller = new AbortController();
  const owner = createMcpRuntimeOwner();
  const state = createPromptState({
    owner,
    connected: true,
    getPrompt: (signal) =>
      waitForAbort(signal, () => {
        promptAborted = true;
      }),
  });
  const context = createContext(true, controller.signal);
  const api = createPromptApi();
  const pending = createPromptCommand(api.pi, () => state, promptMetadata).handler("", context.ctx);

  context.markStale();
  api.markStale();
  const contextAccesses = context.accessCount();
  const piAccesses = api.accessCount();
  controller.abort(new DOMException("Command cancelled", "AbortError"));

  await assert.doesNotReject(() => pending);
  assert.equal(promptAborted, true);
  assert.equal(context.accessCount(), contextAccesses);
  assert.equal(api.accessCount(), piAccesses);
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(api.sent, []);
  await owner.stop("test complete");
});
