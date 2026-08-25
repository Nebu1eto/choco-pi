import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runInChildSessionContext } from "../src/child-context.ts";
import subagentsExtension from "../src/index.ts";

type LifecycleResult = void | Promise<void>;
type LifecycleHandler = (...args: never[]) => LifecycleResult;
type RuntimeValue = {} | null | undefined;

function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: RuntimeValue exhaustively covers JavaScript values, and callers establish the exact Target invariant at this host boundary.
  return value as Target;
}

interface PiFixture {
  pi: ExtensionAPI;
  handlers: Map<string, LifecycleHandler>;
}

interface ExtensionHostFixture extends Pick<ExtensionAPI, "registerCommand"> {
  events: { emit(): undefined; on(): () => undefined };
  on(name: string, handler: LifecycleHandler): Map<string, LifecycleHandler>;
  registerMessageRenderer(): undefined;
  registerTool(): undefined;
  appendEntry(): undefined;
  sendMessage(): undefined;
}

function asExtensionAPI(fixture: ExtensionHostFixture): ExtensionAPI {
  return reinterpretHostValue<ExtensionAPI>(fixture);
}

function piFixture(): PiFixture {
  const handlers = new Map<string, LifecycleHandler>();
  const noop = () => undefined;
  const fixture = {
    events: { emit: noop, on: () => noop },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: noop,
    appendEntry: noop,
    sendMessage: noop,
  };
  return { pi: asExtensionAPI(fixture), handlers };
}

test("root registry capabilities survive a child activation", async () => {
  const key = Symbol.for("pi-subagents:manager");
  type RegistryEntry = {
    hasFleetRows?: () => boolean;
    isFleetActive?: () => boolean;
  };
  // SAFETY: This test reads only its symbol-keyed optional registry slot on the global object.
  const registry = globalThis as typeof globalThis & {
    [registryKey: symbol]: RegistryEntry | undefined;
  };
  const getEntry = (): RegistryEntry | undefined => registry[key];
  assert.equal(getEntry(), undefined);
  const root = piFixture();
  subagentsExtension(root.pi);
  const rootEntry = getEntry();
  assert.ok(rootEntry);

  try {
    assert.equal(rootEntry.hasFleetRows?.(), false);
    assert.equal(rootEntry.isFleetActive?.(), false);
    const child = piFixture();
    await runInChildSessionContext(async () => subagentsExtension(child.pi));
    assert.strictEqual(getEntry(), rootEntry);
    assert.equal(child.handlers.has("session_shutdown"), false);
  } finally {
    const shutdown = root.handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
  assert.equal(getEntry(), undefined);
});
