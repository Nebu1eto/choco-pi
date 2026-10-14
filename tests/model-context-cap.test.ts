import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildContextCapSection,
  CONTEXT_CAP_ROW_ID,
  contextCapSummary,
  default as modelContextCap,
  readConfig,
  resolvePolicy,
  shouldRequestCompaction,
} from "../.pi/extensions/model-context-cap.ts";
import {
  AUTO_COMPACTION_POINT_KEY,
  CONTEXT_SOFT_CAP_KEY,
  flushAgentPreferenceWrites,
  writeAgentPreference,
} from "../.pi/extensions/lib/agent-preferences.ts";

// Every test reads presets from an isolated agent directory, never the user's.
const agentDir = await mkdtemp(path.join(tmpdir(), "model-context-cap-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

/** Reset both presets to their defaults on disk. */
async function resetPresets(): Promise<void> {
  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, undefined, agentDir);
  await writeAgentPreference(AUTO_COMPACTION_POINT_KEY, undefined, agentDir);
  await flushAgentPreferenceWrites();
}

const settings: Parameters<typeof resolvePolicy>[2] = {
  config: { models: {} },
  softCap: "standard",
  compactionPoint: "standard",
  hostReserve: 16_384,
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

/** A host context whose usage sits past the default 450K compaction point. */
function overThresholdContext(options: { model: Model<Api>; onCompact: () => void }) {
  return {
    cwd: process.cwd(),
    model: options.model,
    modelRegistry: { getAll: () => [options.model] },
    getContextUsage: () => ({ tokens: 550_001, contextWindow: 600_000, percent: 91.7 }),
    compact: options.onCompact,
    ui: { notify: () => {} },
  };
}

test("standard presets cap a one-million-token model at 600K and compact at 450K", () => {
  assert.deepEqual(resolvePolicy(model(1_000_000), 1_000_000, settings), {
    cap: 600_000,
    compactAt: 450_000,
    source: "preset",
  });
});

test("smaller models keep their native window with a headroom-bounded compaction point", () => {
  assert.deepEqual(resolvePolicy(model(272_000), 272_000, settings), {
    cap: 272_000,
    compactAt: 231_200,
    source: "preset",
  });
  assert.deepEqual(resolvePolicy(model(32_000), 32_000, settings), {});
});

test("a per-model override wins over the presets", () => {
  const overridden = {
    ...settings,
    config: { models: { "test-provider/one-million-context-model": { cap: 700_000 } } },
  };
  assert.deepEqual(resolvePolicy(model(1_000_000), 1_000_000, overridden), {
    cap: 700_000,
    compactAt: 450_000,
    source: "override",
  });
  const optedOut = { ...settings, config: { models: { "one-million-context-model": null } } };
  assert.deepEqual(resolvePolicy(model(1_000_000), 1_000_000, optedOut), {});
});

test("policy compaction starts only past the compaction point", () => {
  assert.equal(shouldRequestCompaction(450_000, 450_000), false);
  assert.equal(shouldRequestCompaction(450_001, 450_000), true);
});

test("the shipped profile config has headroom and no legacy keys", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "model-context-cap-cwd-"));
  try {
    assert.deepEqual(await readConfig(empty), {
      headroom: { tokens: 100_000, ratio: 0.15 },
      models: {},
      legacyKeys: [],
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

/** A cwd whose `.pi/extensions/context-cap.json` holds `config`. */
async function withProjectConfig(
  config: Record<string, RuntimeValue>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "model-context-cap-cwd-"));
  try {
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "extensions", "context-cap.json"),
      JSON.stringify(config),
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("legacy static-cap keys are accepted, ignored, and noticed once per session", async () => {
  await resetPresets();
  await withProjectConfig(
    { defaultCap: 600_000, defaultCompactAt: 550_000, appliesOver: 999_999, models: {} },
    async (cwd) => {
      const config = await readConfig(cwd);
      assert.deepEqual(config.legacyKeys, ["defaultCap", "defaultCompactAt", "appliesOver"]);

      const handlers = registerCap();
      const activeModel = model(1_000_000);
      const notices: [string, string][] = [];
      const context = {
        cwd,
        model: activeModel,
        modelRegistry: { getAll: () => [activeModel] },
        getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
        compact: () => {},
        ui: { notify: (message: string, level: string) => notices.push([message, level]) },
      };
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
      // The legacy 550K point is ignored: standard presets govern.
      assert.equal(activeModel.contextWindow, 600_000);
      await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, context);
      await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
      assert.equal(notices.length, 1);
      assert.equal(notices[0][1], "warning");
      assert.match(notices[0][0], /defaultCap, defaultCompactAt, appliesOver/);
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
    },
  );
});

test("changing a preset re-applies the cap without a restart", async (t) => {
  await resetPresets();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = registerCap();
  const activeModel = model(1_000_000);
  let registryModel = activeModel;
  const context = {
    cwd: process.cwd(),
    model: activeModel,
    modelRegistry: { getAll: () => [registryModel] },
    getContextUsage: () => ({ tokens: 0, contextWindow: 600_000, percent: 0 }),
    compact: () => {},
    ui: { notify: () => {} },
  };
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  assert.equal(activeModel.contextWindow, 600_000);

  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, "strict", agentDir);
  assert.equal(activeModel.contextWindow, 400_000);
  await writeAgentPreference(AUTO_COMPACTION_POINT_KEY, "strictest", agentDir);
  // SAFETY: The fixture supplies every host member exercised by this test.
  const summary = contextCapSummary(context as never);
  assert.equal(summary, "1,000,000 → 400,000 · compact at 200,000 (Strict / Strictest)");

  // A scheduled re-application uses the live presets, not ones captured at session start.
  registryModel = model(1_000_000);
  t.mock.timers.tick(2_000);
  assert.equal(registryModel.contextWindow, 400_000);

  // After a session switch the old context no longer follows preference changes.
  handlers.get("session_before_switch")?.({ type: "session_before_switch" }, context);
  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, "permissive", agentDir);
  assert.equal(activeModel.contextWindow, 400_000);
  t.mock.timers.tick(20_000);
  assert.equal(registryModel.contextWindow, 400_000);
  await resetPresets();
});

test("a per-model override is reported as such in the summary", async () => {
  await resetPresets();
  await withProjectConfig(
    { models: { "test-provider/one-million-context-model": { cap: 700_000, compactAt: 500_000 } } },
    async (cwd) => {
      const handlers = registerCap();
      const activeModel = model(1_000_000);
      const context = {
        cwd,
        model: activeModel,
        modelRegistry: { getAll: () => [activeModel] },
        getContextUsage: () => ({ tokens: 0, contextWindow: 700_000, percent: 0 }),
        compact: () => {},
        ui: { notify: () => {} },
      };
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
      // SAFETY: The fixture supplies every host member exercised by this test.
      const summary = contextCapSummary(context as never);
      assert.equal(summary, "1,000,000 → 700,000 · compact at 500,000 (per-model override)");
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
    },
  );
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
  assert.equal(row.currentValue, "1,000,000 → 600,000 · compact at 450,000 (Standard / Standard)");
  assert.equal(row.values, undefined, "the row reports the policy rather than editing it");
});

type CapHandler = (
  event: RuntimeValue,
  context: RuntimeValue,
) => RuntimeValue | Promise<RuntimeValue>;

/** Register the cap against a minimal host and return its event handlers. */
function registerCap(): Map<string, CapHandler> {
  const handlers = new Map<string, CapHandler>();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: CapHandler) => handlers.set(event, handler),
    registerCommand: () => {},
  });
  modelContextCap(pi);
  return handlers;
}

const ADOPTION_SLOT = Symbol.for("choco-pi:compaction-background-adoption");

/** What a test publishes on the slot; a foreign value may omit `adoptReady`. */
interface AdoptionSlotValue {
  readonly version: number;
  readonly adoptReady?: (
    sessionId: string,
    ctx: RuntimeValue,
    settle: (adopted: boolean) => void,
  ) => boolean;
}

/** Publish `value` on the background-adoption slot for the duration of `run`. */
async function withAdoptionSlot(value: AdoptionSlotValue, run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, ADOPTION_SLOT);
  Object.defineProperty(globalThis, ADOPTION_SLOT, { configurable: true, value });
  try {
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, ADOPTION_SLOT, previous);
    else Reflect.deleteProperty(globalThis, ADOPTION_SLOT);
  }
}

test("a ready background candidate takes the cap's compaction instead of the summarizer", async () => {
  const handlers = registerCap();
  const routed: { sessionId: string; settle: (adopted: boolean) => void }[] = [];
  let ready = true;
  const signal: AdoptionSlotValue = {
    version: 1,
    adoptReady: (sessionId, _ctx, settle) => {
      if (!ready) return false;
      routed.push({ sessionId, settle });
      return true;
    },
  };
  let compactionRequests = 0;
  const context = {
    ...overThresholdContext({
      model: model(1_000_000),
      onCompact: () => {
        compactionRequests++;
      },
    }),
    sessionManager: { getSessionId: () => "session-1" },
  };

  await withAdoptionSlot(signal, async () => {
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
    assert.equal(compactionRequests, 0, "the host summarizer was not requested");
    assert.deepEqual(
      routed.map((entry) => entry.sessionId),
      ["session-1"],
    );

    // While adoption is in flight the cap does not request a second compaction.
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
    assert.equal(routed.length, 1);
    assert.equal(compactionRequests, 0);

    // A refused adoption settles false; with no ready candidate left the cap
    // falls back to its existing ctx.compact() path.
    routed[0]?.settle(false);
    ready = false;
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
    assert.equal(compactionRequests, 1);
  });
});

test("a foreign adoption slot is ignored and the cap compacts as before", async () => {
  const handlers = registerCap();
  let compactionRequests = 0;
  const context = overThresholdContext({
    model: model(1_000_000),
    onCompact: () => {
      compactionRequests++;
    },
  });
  await withAdoptionSlot({ version: 2 }, async () => {
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
    assert.equal(compactionRequests, 1);
  });
});
