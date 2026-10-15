import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  default as modelContextCap,
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
  });
});

test("smaller models keep their native window with a headroom-bounded compaction point", () => {
  assert.deepEqual(resolvePolicy(model(272_000), 272_000, settings), {
    cap: 272_000,
    compactAt: 231_200,
  });
  assert.deepEqual(resolvePolicy(model(32_000), 32_000, settings), {});
});

test("policy compaction starts only past the compaction point", () => {
  assert.equal(shouldRequestCompaction(450_000, 450_000), false);
  assert.equal(shouldRequestCompaction(450_001, 450_000), true);
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

test("a context-cap.json left in a project is ignored without a notice", async () => {
  await resetPresets();
  await withProjectConfig(
    {
      defaultCap: 200_000,
      headroom: { tokens: 10_000, ratio: 0.5 },
      models: { "test-provider/one-million-context-model": { cap: 700_000, compactAt: 500_000 } },
    },
    async (cwd) => {
      const handlers = registerCap();
      const activeModel = model(1_000_000);
      const notices: [string, string][] = [];
      let tokens = 0;
      let compactionRequests = 0;
      const context = {
        cwd,
        model: activeModel,
        modelRegistry: { getAll: () => [activeModel] },
        getContextUsage: () => ({ tokens, contextWindow: 600_000, percent: 0 }),
        compact: () => {
          compactionRequests++;
        },
        ui: { notify: (message: string, level: string) => notices.push([message, level]) },
      };
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
      // Standard presets govern: neither the override cap nor its point applies.
      assert.equal(activeModel.contextWindow, 600_000);
      tokens = 500_001;
      await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
      assert.equal(compactionRequests, 1, "the preset 450K point, not the 500K override, applies");
      assert.deepEqual(notices, []);
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
  let tokens = 0;
  let compactionRequests = 0;
  const context = {
    cwd: process.cwd(),
    model: activeModel,
    modelRegistry: { getAll: () => [registryModel] },
    getContextUsage: () => ({ tokens, contextWindow: 600_000, percent: 0 }),
    compact: (options: { onComplete?: () => void }) => {
      compactionRequests++;
      options.onComplete?.();
    },
    ui: { notify: () => {} },
  };
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  assert.equal(activeModel.contextWindow, 600_000);

  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, "strict", agentDir);
  assert.equal(activeModel.contextWindow, 400_000);
  await writeAgentPreference(AUTO_COMPACTION_POINT_KEY, "strictest", agentDir);
  // The strictest point (200K) now triggers compaction below the old 450K point.
  tokens = 200_000;
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactionRequests, 0);
  tokens = 200_001;
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactionRequests, 1);

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
  handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  // Shutdown itself reads the registry once to restore native windows.
  const readsAfterShutdown = registryReads;
  t.mock.timers.tick(20_000);
  assert.equal(registryReads, readsAfterShutdown);
});

test("session end restores native windows so a reloaded module sees them", async () => {
  await resetPresets();
  const handlers = registerCap();
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
  assert.equal(activeModel.contextWindow, 600_000);

  // Pi emits session_shutdown before it re-evaluates extensions on /reload.
  handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, context);
  assert.equal(activeModel.contextWindow, 1_000_000);

  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, "permissive", agentDir);
  const reloadedHandlers = await registerReloadedCap("after-shutdown");
  await reloadedHandlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    context,
  );
  assert.equal(activeModel.contextWindow, 800_000);
  reloadedHandlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  await resetPresets();
});

test("a reloaded module never takes a capped window for the native one", async () => {
  await resetPresets();
  const handlers = registerCap();
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
  assert.equal(activeModel.contextWindow, 600_000);

  // Even when the old module's shutdown never ran (a crash or a host that
  // skips the event), the recorded native window on the object survives.
  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, "permissive", agentDir);
  const reloadedHandlers = await registerReloadedCap("without-shutdown");
  await reloadedHandlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    context,
  );
  assert.equal(activeModel.contextWindow, 800_000);
  reloadedHandlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  await resetPresets();
});

test("the cap registers no command; the presets are its only configuration", () => {
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
  assert.ok(handlers.has("session_start"));
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

const CapModuleSchema = Type.Object({ default: Type.Function([Type.Unknown()], Type.Unknown()) });

function isCapModule<Candidate>(
  value: Candidate,
): value is Candidate & { default: typeof modelContextCap } {
  return Value.Check(CapModuleSchema, value);
}

/**
 * A fresh instance of the extension module with empty state, as Pi's
 * per-extension loader produces after a reload. The query string defeats the
 * ESM module cache.
 */
async function registerReloadedCap(tag: string): Promise<Map<string, CapHandler>> {
  const specifier = new URL(`../.pi/extensions/model-context-cap.ts?reload=${tag}`, import.meta.url)
    .href;
  const loaded: RuntimeValue = await import(specifier);
  assert.ok(isCapModule(loaded), "the reloaded module exports the extension factory");
  const handlers = new Map<string, CapHandler>();
  loaded.default(
    reinterpretHostValue<ExtensionAPI>({
      on: (event: string, handler: CapHandler) => handlers.set(event, handler),
      registerCommand: () => {},
    }),
  );
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
