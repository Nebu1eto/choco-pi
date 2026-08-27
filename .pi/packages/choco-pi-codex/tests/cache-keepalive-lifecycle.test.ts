import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  ExtensionRunner,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  handleCodexAgentSettled,
  registerCodexEvents,
  registerSessionReplacementEvents,
} from "../src/extension/events.ts";
import { withLiveCtx } from "../src/extension/live-context.ts";
import { createCodexExtensionRuntime } from "../src/extension/runtime.ts";
import {
  installRegisteredToolCapture,
  registeredToolRunner,
  resetRegisteredToolCapture,
} from "../src/tools/code-mode/registered-tool-bridge.ts";

type HostBoundaryValue = {} | null | undefined;
type RegisteredHandler = (
  event?: HostBoundaryValue,
  ctx?: ExtensionContext,
) => void | Promise<void>;

function reinterpretHostValue<Target>(value: HostBoundaryValue): Target {
  // SAFETY: Test fixtures deliberately provide only the host members reached by each test.
  return value as Target;
}

function extensionApiFixture(): ExtensionAPI {
  // SAFETY: Keepalive scheduling does not inspect the ExtensionAPI until prewarm begins, which the fixtures prevent.
  return {} as ExtensionAPI;
}

function contextFixture(isIdle: () => boolean, notify: () => void): ExtensionContext {
  return reinterpretHostValue<ExtensionContext>({ isIdle, ui: { notify } });
}

test("session_start resets only the transport lane for the starting session", async () => {
  const handlers = new Map<string, RegisteredHandler>();
  const registrationFixture = {
    on(event: string, handler: RegisteredHandler) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };
  // SAFETY: Event registration and adapter activation use only the fixture members above.
  const pi = reinterpretHostValue<ExtensionAPI>(registrationFixture);
  const runtime = createCodexExtensionRuntime(pi);
  const resets: Array<string | undefined> = [];
  runtime.resetTransport = (sessionId) => resets.push(sessionId);
  runtime.configureDiagnostics = () => Promise.resolve();
  runtime.execEnv = () => ({});
  runtime.startPrewarm = () => undefined;
  const tools = reinterpretHostValue<Parameters<typeof registerCodexEvents>[2]>({
    ensureOptionalTools() {},
  });
  const ui = reinterpretHostValue<Parameters<typeof registerCodexEvents>[3]>({
    invalidateUsageStatus() {},
    refreshUsageStatus: () => Promise.resolve(),
  });
  const codeMode = reinterpretHostValue<Parameters<typeof registerCodexEvents>[4]>({
    prepare: () => Promise.resolve(),
    refreshPromptTools: (prompt: string) => prompt,
  });
  const proxyProvider = reinterpretHostValue<Parameters<typeof registerCodexEvents>[5]>({
    applyConfig() {},
  });
  const startContext = (sessionId: string) =>
    reinterpretHostValue<ExtensionContext>({
      cwd: process.cwd(),
      getSystemPrompt: () => "test system prompt",
      hasUI: false,
      isProjectTrusted: () => false,
      model: undefined,
      modelRegistry: {},
      sessionManager: { getSessionId: () => sessionId },
    });

  registerCodexEvents(pi, runtime, tools, ui, codeMode, proxyProvider);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({ reason: "resume" }, startContext("parent-session"));
  await sessionStart({ reason: "resume" }, startContext("child-session"));

  assert.deepEqual(resets, ["parent-session", "child-session"]);
  assert.ok(resets.every((sessionId) => sessionId !== undefined));
});

test("a stale keepalive context exception is contained and does not re-arm", async () => {
  const runtime = createCodexExtensionRuntime(extensionApiFixture(), {
    cacheKeepaliveIntervalMs: 5,
  });
  runtime.state.config.openai.cacheKeepalive = true;
  let idleChecks = 0;
  let notifications = 0;
  const ctx = contextFixture(
    () => {
      idleChecks += 1;
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
    () => {
      notifications += 1;
    },
  );

  runtime.armCacheKeepalive(ctx);
  await delay(25);

  assert.equal(idleChecks, 1);
  assert.equal(notifications, 0);
});

test("the live-context guard contains stale promise continuations only", async () => {
  const stale = await withLiveCtx(() =>
    Promise.reject(new Error("This extension ctx is stale after session replacement or reload.")),
  );
  assert.equal(stale, undefined);
  await assert.rejects(() => withLiveCtx(() => Promise.reject(new Error("different failure"))), {
    message: "different failure",
  });
});

test("session_before_switch cancels an armed keepalive before it fires", async () => {
  const handlers = new Map<string, RegisteredHandler>();
  const registrationFixture = {
    on(event: string, handler: RegisteredHandler) {
      handlers.set(event, handler);
    },
  };
  // SAFETY: The registration helper exercises only the fixture's on method.
  const pi = registrationFixture as ExtensionAPI;
  const runtime = createCodexExtensionRuntime(extensionApiFixture(), {
    cacheKeepaliveIntervalMs: 5,
  });
  runtime.state.config.openai.cacheKeepalive = true;
  let idleChecks = 0;
  const ctx = contextFixture(
    () => {
      idleChecks += 1;
      return true;
    },
    () => {},
  );

  registerSessionReplacementEvents(pi, runtime);
  runtime.armCacheKeepalive(ctx);
  const beforeSwitch = handlers.get("session_before_switch");
  assert.ok(beforeSwitch);
  await beforeSwitch(undefined, ctx);
  await delay(25);

  assert.equal(idleChecks, 0);
});

test("a settled stale child context cannot escape through usage refresh", () => {
  const runtime = createCodexExtensionRuntime(extensionApiFixture());
  let keepaliveArms = 0;
  let refreshes = 0;
  const settledRuntime = {
    state: runtime.state,
    armCacheKeepalive() {
      keepaliveArms += 1;
    },
  };
  const ui = {
    refreshUsageStatus() {
      refreshes += 1;
      return Promise.resolve();
    },
  };
  const ctx = reinterpretHostValue<ExtensionContext>({
    get hasUI() {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  });

  assert.doesNotThrow(() => handleCodexAgentSettled(settledRuntime, ui, ctx));
  assert.equal(refreshes, 0);
  assert.equal(keepaliveArms, 0);
});

test("session replacement drops the old registered-tool runner and captures the next one", async () => {
  resetRegisteredToolCapture();
  installRegisteredToolCapture();
  const oldSessionManager = {};
  const oldRunnerContext = reinterpretHostValue<ExtensionContext>({
    sessionManager: oldSessionManager,
    isIdle: () => true,
  });
  const oldRunnerFixture = { extensions: [], createContext: () => oldRunnerContext };
  const oldRunner = reinterpretHostValue<ExtensionRunner>(oldRunnerFixture);
  ExtensionRunner.prototype.getAllRegisteredTools.call(oldRunner);
  assert.equal(registeredToolRunner(), oldRunner);

  let childStale = false;
  const childRunnerContext = reinterpretHostValue<ExtensionContext>({
    sessionManager: {},
    isIdle() {
      if (childStale)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      return true;
    },
  });
  const childRunnerFixture = { extensions: [], createContext: () => childRunnerContext };
  const childRunner = reinterpretHostValue<ExtensionRunner>(childRunnerFixture);
  ExtensionRunner.prototype.getAllRegisteredTools.call(childRunner);
  assert.equal(registeredToolRunner(), childRunner);
  childStale = true;
  assert.equal(registeredToolRunner(), oldRunner);

  const handlers = new Map<string, RegisteredHandler>();
  const registrationFixture = {
    on(event: string, handler: RegisteredHandler) {
      handlers.set(event, handler);
    },
  };
  // SAFETY: The registration helper exercises only the fixture's on method.
  const pi = registrationFixture as ExtensionAPI;
  const runtime = createCodexExtensionRuntime(extensionApiFixture());
  registerSessionReplacementEvents(pi, runtime);
  const beforeSwitch = handlers.get("session_before_switch");
  assert.ok(beforeSwitch);
  await beforeSwitch(undefined, oldRunnerContext);
  assert.equal(registeredToolRunner(), undefined);

  const nextRunnerContext = reinterpretHostValue<ExtensionContext>({
    sessionManager: {},
    isIdle: () => true,
  });
  const nextRunnerFixture = { extensions: [], createContext: () => nextRunnerContext };
  const nextRunner = reinterpretHostValue<ExtensionRunner>(nextRunnerFixture);
  ExtensionRunner.prototype.getAllRegisteredTools.call(nextRunner);
  assert.equal(registeredToolRunner(), nextRunner);
  resetRegisteredToolCapture();
});
