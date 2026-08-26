import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runInChildSessionContext } from "../src/child-context.ts";
import subagentsExtension from "../src/index.ts";

type RuntimeValue = {} | null | undefined;
type LifecycleResult = RuntimeValue | Promise<RuntimeValue>;
type LifecycleHandler = (...args: RuntimeValue[]) => LifecycleResult;

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

test("root activation wires the live manager into a persisted turn-start status handler", async () => {
  const key = Symbol.for("pi-subagents:manager");
  type RegistryEntry = {
    hasRunning(): boolean;
    spawn(
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      type: string,
      prompt: string,
      options: { description: string; isBackground: boolean; isolated: boolean },
    ): string;
  };
  // SAFETY: This test reads only its symbol-keyed registry entry from the actual activation.
  const registry = globalThis as typeof globalThis & {
    [registryKey: symbol]: RegistryEntry | undefined;
  };
  const root = piFixture();
  subagentsExtension(root.pi);
  const rootEntry = registry[key];
  assert.ok(rootEntry);

  try {
    // The manager inserts the running record synchronously; the deliberately
    // incomplete context may then make the detached child setup settle as an error.
    rootEntry.spawn(
      root.pi,
      reinterpretHostValue<ExtensionContext>({ cwd: process.cwd() }),
      "implementer",
      "hold activity for the status probe",
      { description: "status probe", isBackground: true, isolated: true },
    );
    assert.equal(rootEntry.hasRunning(), true);

    const beforeAgentStart = root.handlers.get("before_agent_start");
    assert.ok(beforeAgentStart, "index.ts must register the root status handler");
    const result = reinterpretHostValue<{
      message: { customType: string; content: string; display: boolean };
    }>(await beforeAgentStart({ prompt: "next turn", systemPrompt: "system" }));
    assert.equal(result.message.customType, "subagent-status");
    assert.equal(result.message.display, false);
    assert.match(
      result.message.content,
      /^<system-reminder>Turn-start subagent snapshot \(historical after this turn\): 1 scheduled \/ cap (?:unlimited|\d+); 1 in tree; inherited depth ceiling \d+<\/system-reminder>$/,
    );
  } finally {
    const shutdown = root.handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
  assert.equal(registry[key], undefined);
});
