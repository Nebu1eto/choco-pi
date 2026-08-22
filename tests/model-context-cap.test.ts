import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildContextCapSection,
  CONTEXT_CAP_ROW_ID,
  default as modelContextCap,
  resolvePolicy,
  shouldRequestCompaction,
} from "../.pi/extensions/model-context-cap.ts";

const config: Parameters<typeof resolvePolicy>[2] = {
  defaultCap: 600_000,
  defaultCompactAt: 550_000,
  appliesOver: 999_999,
  models: {},
};

function model(contextWindow: number): Model<Api> {
  return {
    id: "one-million-context-model",
    name: "One Million Context Model",
    provider: "test-provider",
    api: "openai-responses",
    baseUrl: "https://example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 100_000,
  };
}

test("one-million-token models use the 600K cap and 550K compaction threshold", () => {
  assert.deepEqual(resolvePolicy(model(1_000_000), 1_000_000, config), {
    cap: 600_000,
    compactAt: 550_000,
  });
});

test("models below one million tokens keep their native context window", () => {
  assert.deepEqual(resolvePolicy(model(999_999), 999_999, config), {});
});

test("policy compaction starts only after 550K tokens", () => {
  assert.equal(shouldRequestCompaction(550_000, 550_000), false);
  assert.equal(shouldRequestCompaction(550_001, 550_000), true);
});

test("compaction is requested only after the agent run settles", async () => {
  const handlers = new Map<
    string,
    (event: RuntimeValue, context: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
      handlers.set(event, handler),
    registerCommand: () => {},
  });
  modelContextCap(pi);

  assert.equal(handlers.has("turn_end"), false);
  assert.equal(handlers.has("agent_settled"), true);

  const activeModel = model(1_000_000);
  let compactionRequests = 0;
  const context = {
    cwd: process.cwd(),
    model: activeModel,
    modelRegistry: { getAll: () => [activeModel] },
    getContextUsage: () => ({ tokens: 550_001, contextWindow: 600_000, percent: 91.7 }),
    compact: () => {
      compactionRequests++;
    },
    ui: { notify: () => {} },
  };

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactionRequests, 1);
});

test("caps are re-applied to models replaced by a catalog refresh", async () => {
  const handlers = new Map<
    string,
    (event: RuntimeValue, context: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
      handlers.set(event, handler),
    registerCommand: () => {},
  });
  modelContextCap(pi);

  const startupModel = model(1_000_000);
  let registryModel = startupModel;
  const context = {
    cwd: process.cwd(),
    model: startupModel,
    modelRegistry: { getAll: () => [registryModel] },
    getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
    compact: () => {},
    ui: { notify: () => {} },
  };

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  assert.equal(startupModel.contextWindow, 600_000);

  // A catalog refresh replaces the registry entry with an uncapped object.
  registryModel = model(1_000_000);
  handlers.get("before_agent_start")?.({ type: "before_agent_start" }, context);
  assert.equal(registryModel.contextWindow, 600_000);

  const selectedModel = model(1_000_000);
  context.model = selectedModel;
  handlers.get("model_select")?.(
    { type: "model_select", model: selectedModel, source: "set" },
    context,
  );
  assert.equal(selectedModel.contextWindow, 600_000);
});

test("a replaced session cancels pending re-applications instead of crashing Pi", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<
    string,
    (event: RuntimeValue, context: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
      handlers.set(event, handler),
    registerCommand: () => {},
  });
  modelContextCap(pi);

  const startupModel = model(1_000_000);
  let stale = false;
  let registryReads = 0;
  const context = {
    cwd: process.cwd(),
    model: startupModel,
    // Pi's real context throws from this getter once the session is replaced.
    get modelRegistry() {
      if (stale)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      registryReads += 1;
      return { getAll: () => [startupModel] };
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
    compact: () => {},
    ui: { notify: () => {} },
  };

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  assert.equal(startupModel.contextWindow, 600_000);

  stale = true;
  const readsBeforeStaleTick = registryReads;
  // A timer firing against a replaced session must not escape as an uncaught
  // exception, and the remaining retries must stop touching that context.
  assert.doesNotThrow(() => t.mock.timers.tick(2_000));
  assert.doesNotThrow(() => t.mock.timers.tick(20_000));
  assert.equal(registryReads, readsBeforeStaleTick);
});

test("session shutdown stops scheduled re-applications", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<
    string,
    (event: RuntimeValue, context: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
      handlers.set(event, handler),
    registerCommand: () => {},
  });
  modelContextCap(pi);

  const startupModel = model(1_000_000);
  let registryReads = 0;
  const context = {
    cwd: process.cwd(),
    model: startupModel,
    modelRegistry: {
      getAll: () => {
        registryReads += 1;
        return [startupModel];
      },
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
    compact: () => {},
    ui: { notify: () => {} },
  };

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  const readsAfterStart = registryReads;
  handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  t.mock.timers.tick(20_000);
  assert.equal(registryReads, readsAfterStart);
});

test("the cap is a Model preference row instead of a command", async () => {
  const handlers = new Map<
    string,
    (event: RuntimeValue, context: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  const commands: string[] = [];
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
      handlers.set(event, handler),
    registerCommand: (name: string) => commands.push(name),
  });
  modelContextCap(pi);
  assert.deepEqual(commands, [], "the retired /context-cap command must not come back");

  const activeModel = model(1_000_000);
  const context = {
    cwd: process.cwd(),
    model: activeModel,
    modelRegistry: { getAll: () => [activeModel] },
    getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
    compact: () => {},
    ui: { notify: () => {} },
  };
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);

  // SAFETY: The fixture supplies every host member exercised by this test.
  const section = buildContextCapSection(context as never);
  assert.equal(section.mergeInto, "model");
  const [row] = section.buildItems();
  assert.equal(row.id, CONTEXT_CAP_ROW_ID);
  assert.equal(row.currentValue, "1,000,000 → 600,000 · compact at 550,000");
  assert.equal(row.values, undefined, "the row reports the policy rather than editing it");
});
