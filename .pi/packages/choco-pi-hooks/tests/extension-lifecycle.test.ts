import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";
import type { RuntimeValue } from "../src/validation.ts";

type Handler = (...args: RuntimeValue[]) => RuntimeValue;

interface ExtensionApiDouble {
  registerFlag(): void;
  registerCommand(): void;
  registerTool(): void;
  registerMarkdownTransformer(): void;
  on(event: string, handler: Handler): void;
  events: {
    on(event: string, handler: Handler): () => void;
    emit(): void;
  };
}

interface ShutdownContextDouble {
  readonly cwd: string;
  readonly mode: "json";
  readonly thinkingLevel: "off";
}

interface ActivatedHooks {
  extensionHandlers: Map<string, Handler[]>;
  eventHandlers: Map<string, Handler[]>;
}

function extensionApi(value: ExtensionApiDouble): ExtensionAPI {
  // SAFETY: The lifecycle test supplies every ExtensionAPI registration method used during activation.
  const api = {} as ExtensionAPI;
  Object.assign(api, value);
  return api;
}

function extensionContext(value: ShutdownContextDouble): ExtensionContext {
  // SAFETY: The lifecycle test supplies every ExtensionContext getter used by SessionEnd dispatch.
  return value as ExtensionContext;
}

function activateHooks(): ActivatedHooks {
  const extensionHandlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Handler[]>();
  const addHandler = (handlers: Map<string, Handler[]>, event: string, handler: Handler) => {
    const registered = handlers.get(event) ?? [];
    registered.push(handler);
    handlers.set(event, registered);
  };
  chocoPiHooks(
    extensionApi({
      registerFlag() {},
      registerCommand() {},
      registerTool() {},
      registerMarkdownTransformer() {},
      on(event, handler) {
        addHandler(extensionHandlers, event, handler);
      },
      events: {
        on(event: string, handler: Handler) {
          addHandler(eventHandlers, event, handler);
          return () => {};
        },
        emit() {},
      },
    }),
  );
  return { extensionHandlers, eventHandlers };
}

function lifecycleContext(cwd: string | Error = process.cwd()): ExtensionContext {
  return extensionContext({
    get cwd() {
      if (cwd instanceof Error) throw cwd;
      return cwd;
    },
    mode: "json",
    thinkingLevel: "off",
  });
}

function setSupplementalContext(handlers: Map<string, Handler[]>, ctx: ExtensionContext): void {
  const settled = handlers.get("agent_settled")?.[0];
  assert.ok(settled);
  settled({}, ctx);
}

test("session shutdown synchronously disposes producers and snapshots context", async () => {
  const extensionHandlers = new Map<string, Handler[]>();
  let activeEventProducers = 0;
  const addExtensionHandler = (event: string, handler: Handler) => {
    const handlers = extensionHandlers.get(event) ?? [];
    handlers.push(handler);
    extensionHandlers.set(event, handlers);
  };
  const api = extensionApi({
    registerFlag() {},
    registerCommand() {},
    registerTool() {},
    registerMarkdownTransformer() {},
    on: addExtensionHandler,
    events: {
      on() {
        activeEventProducers += 1;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          activeEventProducers -= 1;
        };
      },
      emit() {},
    },
  });
  chocoPiHooks(api);
  assert.ok(activeEventProducers > 0);
  const shutdown = extensionHandlers.get("session_shutdown")?.[0];
  assert.ok(shutdown);

  let stale = false;
  const snapshot = <Value>(value: Value): Value => {
    if (stale) throw new Error("stale getter was touched");
    return value;
  };
  const ctx = extensionContext({
    get cwd() {
      return snapshot(process.cwd());
    },
    get mode() {
      return snapshot("json" as const);
    },
    get thinkingLevel() {
      return snapshot("off" as const);
    },
  });
  const completion = Promise.resolve(shutdown({ reason: "other" }, ctx));

  assert.equal(activeEventProducers, 0);
  stale = true;
  await completion;
});

test("repo-root completion runs once across context replacement, stale cancellation, and failure", async () => {
  const { extensionHandlers, eventHandlers } = activateHooks();
  const registerRoot = eventHandlers.get("choco-pi-hooks:register-repo-root")?.[0];
  assert.ok(registerRoot);

  const oldContext = lifecycleContext();
  setSupplementalContext(extensionHandlers, oldContext);
  let changedDone = 0;
  const changedCompletion = Promise.resolve(
    registerRoot({ directory: "/tmp/repo", done: () => (changedDone += 1) }),
  );
  setSupplementalContext(extensionHandlers, lifecycleContext());
  await changedCompletion;
  assert.equal(changedDone, 1);

  const stale = new Error("This extension ctx is stale after session replacement or reload.");
  setSupplementalContext(extensionHandlers, lifecycleContext(stale));
  let staleDone = 0;
  await Promise.resolve(registerRoot({ directory: "/tmp/repo", done: () => (staleDone += 1) }));
  assert.equal(staleDone, 1);

  const failure = new Error("unrelated dispatch failure");
  setSupplementalContext(extensionHandlers, lifecycleContext(failure));
  let failedDone = 0;
  await assert.rejects(
    Promise.resolve(registerRoot({ directory: "/tmp/repo", done: () => (failedDone += 1) })),
    (error) => error === failure,
  );
  assert.equal(failedDone, 1);
});

test("claimed worktree removal completes once across success, stale cancellation, and failure", async () => {
  const { extensionHandlers, eventHandlers } = activateHooks();
  const removeWorktree = eventHandlers.get("subagents:worktree-remove")?.[0];
  assert.ok(removeWorktree);

  for (const [name, dispatchError] of [
    ["success", undefined],
    ["stale", new Error("This extension ctx is stale after session replacement or reload.")],
    ["failure", new Error("unrelated dispatch failure")],
  ] as const) {
    setSupplementalContext(extensionHandlers, lifecycleContext(dispatchError));
    let claims = 0;
    let completions = 0;
    const completion = Promise.resolve(
      removeWorktree({
        path: "/tmp/worktree",
        claim: () => (claims += 1),
        done: () => (completions += 1),
      }),
    );
    if (name === "failure") await assert.rejects(completion, (error) => error === dispatchError);
    else await completion;
    assert.equal(claims, 1, name);
    assert.equal(completions, 1, name);
  }
});
