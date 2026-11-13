/**
 * The advisor tool spawns the internal `advisor` agent through the registry
 * entry's `spawnInternal`. Caller-supplied paths (`spawn`, which RPC shares,
 * the Agent tool, schedules, mentions) keep treating it as unknown.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  getFallbackSubagent,
  resolveInternalSpawnTypeIn,
  resolveSpawnTypeIn,
  setFallbackSubagent,
} from "../src/agent-types.ts";
import subagentsExtension from "../src/index.ts";
import type { AgentConfig, AgentRecord } from "../src/types.ts";

type RuntimeValue = {} | null | undefined;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;

function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: RuntimeValue covers the host fixtures; each caller supplies the slice the activation reaches.
  return value as Target;
}

interface SpawnOptions {
  description: string;
  isBackground: boolean;
}
interface RegistryEntry {
  getAllRecords(): AgentRecord[];
  stop(id: string): boolean;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: SpawnOptions,
  ): string;
  spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: SpawnOptions,
  ): string;
}

const KEY = Symbol.for("pi-subagents:manager");

async function activate(): Promise<{
  pi: ExtensionAPI;
  entry: RegistryEntry;
  shutdown: () => Promise<void>;
}> {
  const handlers = new Map<string, LifecycleHandler>();
  const noop = () => undefined;
  const pi = reinterpretHostValue<ExtensionAPI>({
    events: { emit: noop, on: () => noop },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: noop,
    appendEntry: noop,
    sendMessage: noop,
  });
  await subagentsExtension(pi);
  // SAFETY: the test reads only its own symbol-keyed registry slot.
  const slots = globalThis as typeof globalThis & { [key: symbol]: RegistryEntry | undefined };
  const entry = slots[KEY];
  assert.ok(entry, "the root activation publishes the registry entry");
  return {
    pi,
    entry,
    shutdown: async () => {
      await handlers.get("session_shutdown")?.();
    },
  };
}

function config(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    extensions: false,
    skills: false,
    systemPrompt: name,
    promptMode: "replace",
    ...extra,
  };
}

test("internal resolution takes only the exact name of an enabled internal agent", () => {
  const registry = new Map<string, AgentConfig>([
    ["advisor", config("advisor", { internal: true })],
    ["retired", config("retired", { internal: true, enabled: false })],
    ["general", config("general")],
  ]);
  const previous = getFallbackSubagent();
  setFallbackSubagent("general");
  try {
    assert.deepEqual(resolveInternalSpawnTypeIn(registry, "advisor"), {
      ok: true,
      type: "advisor",
    });
    for (const name of ["Advisor", " advisor", "advizor", "retired", "general", ""]) {
      const resolution = resolveInternalSpawnTypeIn(registry, name);
      assert.equal(resolution.ok, false, name);
      if (!resolution.ok) assert.match(resolution.message, /internal agent type/);
    }
    // The caller-supplied path still hides it and applies the fallback.
    assert.deepEqual(resolveSpawnTypeIn(registry, "advisor"), {
      ok: true,
      type: "general",
      fellBackFrom: "advisor",
    });
  } finally {
    setFallbackSubagent(previous);
  }
});

test("the registry entry spawns the advisor as advisor even with fallbackSubagent general", async () => {
  const { pi, entry, shutdown } = await activate();
  const previous = getFallbackSubagent();
  const ctx = reinterpretHostValue<ExtensionContext>({ cwd: process.cwd() });
  const options = { description: "Advisor consult", isBackground: true };
  try {
    setFallbackSubagent("general");
    const id = entry.spawnInternal(pi, ctx, "advisor", "question", options);
    const record = entry.getAllRecords().find((candidate) => candidate.id === id);
    assert.equal(record?.type, "advisor");
    entry.stop(id);

    // A misspelt internal type errors instead of running general.
    const before = entry.getAllRecords().length;
    assert.throws(
      () => entry.spawnInternal(pi, ctx, "advizor", "question", options),
      /Unknown or disabled internal agent type: "advizor"/,
    );
    assert.throws(() => entry.spawnInternal(pi, ctx, "general", "question", options), /internal/);
    assert.equal(entry.getAllRecords().length, before, "nothing spawned");

    // `spawn` (shared with cross-extension RPC) never dispatches the internal type.
    const fellBack = entry.spawn(pi, ctx, "advisor", "question", options);
    const fallbackRecord = entry.getAllRecords().find((candidate) => candidate.id === fellBack);
    assert.equal(fallbackRecord?.type, "general");
    entry.stop(fellBack);

    setFallbackSubagent("none");
    assert.throws(
      () => entry.spawn(pi, ctx, "advisor", "question", options),
      /Unknown or disabled agent type: "advisor"/,
    );
  } finally {
    setFallbackSubagent(previous);
    await shutdown();
  }
});
