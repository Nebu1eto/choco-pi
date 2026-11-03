import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";
import { HookEngine, mergeResults } from "../src/engine.ts";
import type { HookInput, HookOutput, JsonObject } from "../src/types.ts";
import { isStringValue } from "../src/validation.ts";
import {
  readStopState,
  STOP_CONTROL_PROTOCOL,
  STOP_CONTROL_REGISTRY_KEY,
} from "../src/stop-control.ts";

interface StopStateFixture {
  epoch: number;
  closed: boolean;
}

let current: StopStateFixture = { epoch: 0, closed: false };

function installRegistry(): void {
  current = { epoch: 0, closed: false };
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { protocol: STOP_CONTROL_PROTOCOL, state: () => current },
  });
}

async function activate() {
  const messages: string[] = [];
  const notices: string[] = [];
  const runtime = createExtensionRuntime();
  runtime.sendUserMessage = (content, options) => {
    assert.ok(isStringValue(content));
    assert.equal(options?.deliverAs, "followUp");
    messages.push(content);
  };
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "stop-control", factory: chocoPiHooks }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:stop-control>");
  assert.ok(extension);
  loaded.runtime.sendUserMessage = runtime.sendUserMessage;
  const ctx = {
    cwd,
    mode: "json",
    thinkingLevel: "off",
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  };
  const emit = async (name: string, event: JsonObject) => {
    const handlers = extension.handlers.get(name);
    assert.ok(handlers, name);
    for (const handler of handlers) await handler(event, ctx);
  };
  return {
    messages,
    notices,
    end: (stopReason?: string) =>
      emit("agent_end", {
        messages: stopReason === undefined ? [] : [{ role: "assistant", stopReason, content: [] }],
      }),
    dispose: () => loaded.runtime.invalidate(),
  };
}

const blockedOutput: HookOutput = { decision: "block", reason: "blocked continuation" };

function mockStop(t: test.TestContext, beforeReturn?: () => void): HookInput[] {
  const inputs: HookInput[] = [];
  t.mock.method(HookEngine.prototype, "run", async (input: HookInput) => {
    if (input.hook_event_name !== "Stop") return mergeResults(input.hook_event_name, []);
    inputs.push(input);
    beforeReturn?.();
    return mergeResults("Stop", [
      {
        source: { id: "test", kind: "session", hooks: {} },
        handler: { type: "command", command: "test" },
        status: "success",
        output: blockedOutput,
      },
    ]);
  });
  return inputs;
}

test("registry guard: absent, malformed and throwing registries read as open epoch 0", () => {
  Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
  assert.deepEqual(readStopState("s"), { epoch: 0, closed: false });
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    value: { protocol: "other", state: () => ({ epoch: 1, closed: true }) },
  });
  assert.deepEqual(readStopState("s"), { epoch: 0, closed: false });
  Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
});

test("control: an open session still sends the Stop continuation", async (t) => {
  installRegistry();
  t.after(() => Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY));
  mockStop(t);
  const hooks = await activate();
  try {
    await hooks.end();
    assert.deepEqual(hooks.messages, ["blocked continuation"]);
    assert.deepEqual(hooks.notices, []);
  } finally {
    hooks.dispose();
  }
});

test("a closed session skips the Stop hook and notifies once per epoch", async (t) => {
  installRegistry();
  t.after(() => Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY));
  const inputs = mockStop(t);
  const hooks = await activate();
  try {
    current = { epoch: 1, closed: true };
    await hooks.end();
    await hooks.end();
    assert.deepEqual(hooks.messages, []);
    assert.equal(inputs.length, 0);
    assert.deepEqual(hooks.notices, ["Stop hook continuation skipped: session work is stopped."]);

    current = { epoch: 3, closed: true };
    await hooks.end();
    assert.equal(hooks.notices.length, 2);

    // Reopened admission restores the continuation, with a fresh block budget.
    current = { epoch: 4, closed: false };
    await hooks.end();
    assert.deepEqual(hooks.messages, ["blocked continuation"]);
    assert.equal(inputs.at(-1)?.stop_hook_active, false);
  } finally {
    hooks.dispose();
  }
});

test("a stop that lands during the awaited Stop dispatch suppresses the continuation", async (t) => {
  installRegistry();
  t.after(() => Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY));
  let closeDuringDispatch = true;
  const inputs = mockStop(t, () => {
    if (closeDuringDispatch) current = { epoch: 1, closed: true };
    closeDuringDispatch = false;
  });
  const hooks = await activate();
  try {
    await hooks.end();
    assert.equal(inputs.length, 1);
    assert.deepEqual(hooks.messages, []);
    assert.deepEqual(hooks.notices, ["Stop hook continuation skipped: session work is stopped."]);
    // The active flag was reset, so the next run starts a fresh continuation sequence.
    current = { epoch: 2, closed: false };
    await hooks.end();
    assert.equal(inputs.at(-1)?.stop_hook_active, false);
    assert.deepEqual(hooks.messages, ["blocked continuation"]);
  } finally {
    hooks.dispose();
  }
});

test("an Esc-aborted run never dispatches Stop or continues", async (t) => {
  installRegistry();
  t.after(() => Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY));
  const inputs = mockStop(t);
  const hooks = await activate();
  try {
    await hooks.end("aborted");
    assert.equal(inputs.length, 0);
    assert.deepEqual(hooks.messages, []);
    assert.deepEqual(hooks.notices, []);
    await hooks.end("stop");
    assert.equal(inputs.length, 1);
    assert.deepEqual(hooks.messages, ["blocked continuation"]);
  } finally {
    hooks.dispose();
  }
});
