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

async function activate() {
  const messages: string[] = [];
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
    extensionFactories: [{ name: "stop-cap", factory: chocoPiHooks }],
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
  // The SDK loader owns the API double and exposes the registered production handlers.
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:stop-cap>");
  assert.ok(extension);
  loaded.runtime.sendUserMessage = runtime.sendUserMessage;
  const ctx = { cwd, mode: "json", thinkingLevel: "off", hasUI: false };
  const emit = async (name: string, event: JsonObject) => {
    const handlers = extension.handlers.get(name);
    assert.ok(handlers, name);
    for (const handler of handlers) await handler(event, ctx);
  };
  return {
    messages,
    end: () => emit("agent_end", { messages: [] }),
    input: (source = "interactive") => emit("input", { source, text: "new task", images: [] }),
    dispose: () => loaded.runtime.invalidate(),
  };
}

const contextOutput: HookOutput = { additionalContext: "context continuation" };
const blockedOutput: HookOutput = { decision: "block", reason: "blocked continuation" };

for (const [name, outputs] of [
  ["context-only", [contextOutput]],
  ["blocked reasons", [blockedOutput]],
  ["mixed branches", [contextOutput, blockedOutput]],
] as const) {
  test(`${name} share the Stop cap and a fresh user task resets it`, async (t) => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = "3";
    t.after(() => {
      if (previousCap === undefined) delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
      else process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap;
    });
    const inputs: HookInput[] = [];
    let index = 0;
    t.mock.method(HookEngine.prototype, "run", async (input: HookInput) => {
      if (input.hook_event_name !== "Stop") return mergeResults(input.hook_event_name, []);
      inputs.push(input);
      const output = outputs[index++ % outputs.length];
      assert.ok(output);
      return mergeResults("Stop", [
        {
          source: { id: "test", kind: "session", hooks: {} },
          handler: { type: "command", command: "test" },
          status: "success",
          output,
        },
      ]);
    });
    const hooks = await activate();
    try {
      await hooks.input();
      for (let turn = 0; turn < 6; turn++) {
        await hooks.end();
        if (turn < 2) await hooks.input("extension");
      }
      assert.equal(hooks.messages.length, 2);
      assert.deepEqual(
        inputs.slice(0, 3).map((input) => input.stop_hook_active),
        [false, true, true],
      );
      assert.deepEqual(
        hooks.messages,
        [0, 1].map((turn) => {
          const output = outputs[turn % outputs.length];
          assert.ok(output);
          return output.reason ?? output.additionalContext;
        }),
      );
      await hooks.input();
      await hooks.end();
      assert.equal(inputs.at(-1)?.stop_hook_active, false);
      assert.equal(hooks.messages.length, 3);
      await hooks.end();
      await hooks.end();
      assert.equal(hooks.messages.length, 4);
    } finally {
      hooks.dispose();
    }
  });
}
