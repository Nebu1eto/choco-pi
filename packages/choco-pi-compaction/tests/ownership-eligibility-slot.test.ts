/**
 * Codex ownership parity (D12): the Codex package's published eligibility slot
 * is authoritative for `resolveOwner` and `selectBackendId`; a missing or
 * malformed slot falls back to the snapshot heuristic; the host's eligibility
 * watcher journals one `config-change` record and replaces the main owner once
 * per changed decision, and does nothing after shutdown.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { type BackendOwnerSpec, selectBackendId } from "../src/background-host/backends.ts";
import type { Backend } from "../src/background/contract.ts";
import { laneRecordsOf } from "../src/background/lane-journal.ts";
import { getCoordinator, registerBackendFactory } from "../src/background/registry.ts";
import { CODEX_BACKEND_SETTING_ID, parseBackgroundSettings } from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibilityModel,
  mainOwnerKey,
  publishedCodexResponsesCompaction,
  readCodexEligibility,
  resolveOwner,
} from "../src/ownership.ts";
import { createHost } from "./host-boundary-fixture.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const CODEX_MODEL: Model<Api> = {
  id: "gpt-6-luna",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};
const RESPONSES_MODEL: Model<Api> = {
  ...CODEX_MODEL,
  id: "corp-large",
  api: "openai-responses",
  provider: "corp",
  baseUrl: "https://corp.example/v1",
};

/** A fake Codex slot: `native` decides, `bump` advances the revision and notifies. */
interface SlotOptions {
  readonly published?: boolean;
  /** Codex's live `compaction.responsesCompaction`; absent: the field is not published. */
  readonly responsesCompaction?: boolean;
}

function installSlot(native: (model: CodexEligibilityModel) => boolean, options: SlotOptions = {}) {
  const listeners = new Set<(revision: number) => void>();
  const control = { native, revision: 0, responsesCompaction: options.responsesCompaction };
  const slot = {
    version: 1,
    get revision() {
      return control.revision;
    },
    isNativeCompactionOwner: (model: CodexEligibilityModel) => control.native(model),
    subscribe: (listener: (revision: number) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  if (options.published !== undefined)
    Object.defineProperty(slot, "published", { value: options.published, enumerable: true });
  if (options.responsesCompaction !== undefined)
    Object.defineProperty(slot, "responsesCompaction", {
      get: () => control.responsesCompaction,
      enumerable: true,
    });
  Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, { value: slot, configurable: true });
  return {
    control,
    listeners,
    bump(next: (model: CodexEligibilityModel) => boolean): void {
      control.native = next;
      control.revision += 1;
      for (const listener of Array.from(listeners)) listener(control.revision);
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, CODEX_ELIGIBILITY_SLOT);
});

const ON = { responsesCompaction: true, additionalProviders: [] };
const OFF = { responsesCompaction: false, additionalProviders: [] };

test("slot absent: the snapshot heuristic decides", () => {
  assert.equal(readCodexEligibility(), undefined);
  assert.equal(resolveOwner({ model: CODEX_MODEL }), "codex-native");
  assert.equal(resolveOwner({ model: CODEX_MODEL }, ON), "codex-native");
  assert.equal(resolveOwner({ model: CODEX_MODEL }, OFF), "local");
});

test("malformed slot: ignored, the heuristic decides", () => {
  for (const value of [
    { version: 2, revision: 0, isNativeCompactionOwner: () => false, subscribe: () => () => {} },
    { version: 1, revision: -1, isNativeCompactionOwner: () => false, subscribe: () => () => {} },
    { version: 1, revision: 0, isNativeCompactionOwner: () => false },
    { version: 1, revision: 0, isNativeCompactionOwner: "no", subscribe: () => () => {} },
    "not an object",
  ]) {
    Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, { value, configurable: true });
    assert.equal(readCodexEligibility(), undefined, JSON.stringify(value));
    assert.equal(resolveOwner({ model: CODEX_MODEL }, ON), "codex-native");
    assert.equal(resolveOwner({ model: CODEX_MODEL }, OFF), "local");
  }
});

test("slot present: authoritative over the snapshot, both ways", () => {
  const slot = installSlot(() => false);
  // Codex says no (e.g. voice-only or extras): local even though the snapshot says native.
  assert.equal(resolveOwner({ model: CODEX_MODEL }, ON), "local");
  assert.equal(resolveOwner({ model: CODEX_MODEL }), "local");
  // Codex says yes for a configured Responses provider the snapshot does not list.
  slot.control.native = (model) => model.provider === "corp";
  assert.equal(resolveOwner({ model: RESPONSES_MODEL }, OFF), "codex-native");
  assert.equal(resolveOwner({ model: CODEX_MODEL }, ON), "local");
  // Other owners still apply when Codex declines.
  slot.control.native = () => false;
  assert.equal(
    resolveOwner({ model: { ...CODEX_MODEL, api: "anthropic-messages" } }, ON, {
      anthropicServerSide: true,
    }),
    "anthropic-native",
  );
});

test("slot with nothing published: the heuristic decides", () => {
  installSlot(() => false, { published: false });
  assert.equal(resolveOwner({ model: CODEX_MODEL }, ON), "codex-native");
});

test("publishedCodexResponsesCompaction: the live slot value, undefined when unknown", () => {
  assert.equal(publishedCodexResponsesCompaction(), undefined, "no slot");
  installSlot(() => false);
  assert.equal(publishedCodexResponsesCompaction(), undefined, "a slot without the field");
  const slot = installSlot(() => false, { responsesCompaction: false });
  assert.equal(publishedCodexResponsesCompaction(), false);
  slot.control.responsesCompaction = true;
  assert.equal(publishedCodexResponsesCompaction(), true);
  installSlot(() => false, { published: false, responsesCompaction: true });
  assert.equal(publishedCodexResponsesCompaction(), undefined, "nothing published");
  Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, {
    value: {
      version: 1,
      revision: 0,
      responsesCompaction: "yes",
      isNativeCompactionOwner: () => true,
      subscribe: () => () => {},
    },
    configurable: true,
  });
  assert.equal(publishedCodexResponsesCompaction(), undefined, "a malformed field");
});

function stubBackend(id: string): Backend {
  return {
    id,
    capability: async () => ({ supported: false, reason: "unsupported" }),
    isLegalCut: () => ({ legal: false, reason: "unsupported" }),
    prepare: async () => ({ ok: false, reason: "unsupported", retryable: false }),
  };
}

test("selectBackendId follows the slot: no codex-native-v2 for an ineligible Codex transport", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const spec: BackendOwnerSpec = {
    ownerKey: "main-session:slot",
    ownerGeneration: 1,
    sessionId: "slot",
    model: CODEX_MODEL,
    modelRegistry: new ModelRegistry(runtime),
    thinkingLevel: "off",
    retryPolicy: undefined,
    codexCompaction: ON,
    settings: parseBackgroundSettings(
      JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
      "test",
    ).settings,
    scope: {
      provider: CODEX_MODEL.provider,
      baseUrl: CODEX_MODEL.baseUrl,
      model: CODEX_MODEL.id,
      authMode: "oauth",
    },
    allowAnthropic: false,
    allowForeign: true,
    report: () => {},
  };
  const both = new Map<string, Backend>([
    [TEXT_BACKEND_ID, stubBackend(TEXT_BACKEND_ID)],
    [CODEX_BACKEND_SETTING_ID, stubBackend(CODEX_BACKEND_SETTING_ID)],
  ]);
  const slot = installSlot(() => false);
  assert.equal(await selectBackendId(spec, both), TEXT_BACKEND_ID);
  slot.control.native = () => true;
  assert.equal(await selectBackendId(spec, both), CODEX_BACKEND_SETTING_ID);
});

// ---------------------------------------------------------------------------
// The watcher, through a real host session
// ---------------------------------------------------------------------------

// First-wins: a probe stands in for the Codex lane in this process; it counts its instantiations.
const codexFactory = { calls: 0 };
registerBackendFactory(CODEX_BACKEND_SETTING_ID, () => {
  codexFactory.calls += 1;
  return stubBackend(CODEX_BACKEND_SETTING_ID);
});

const STALE = "This extension ctx is stale after session replacement or reload.";

/** Set to make the next owner restart fail (thrown from the settings-path option). */
interface RestartFailure {
  error: Error | undefined;
}

async function watchedHost() {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-eligibility-watch-"));
  const settingsFile = join(dir, "background-compaction.json");
  await writeFile(
    settingsFile,
    JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
  );
  const notices: string[] = [];
  const failure: RestartFailure = { error: undefined };
  const extension = (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background: {
        settingsPaths: () => {
          if (failure.error !== undefined) throw failure.error;
          return [settingsFile];
        },
      },
    });
  };
  const slot = installSlot(() => true);
  const host = await createHost({
    dir,
    modelIdentity: { api: CODEX_MODEL.api, provider: CODEX_MODEL.provider, id: CODEX_MODEL.id },
    extensions: [extension],
  });
  await host.session.prompt("ELIGIBILITY-GO");
  const ownerKey = mainOwnerKey(host.manager.getSessionId());
  // The session-start owner resolves its backends asynchronously: wait until it is current.
  await waitFor(() => getCoordinator(ownerKey) !== undefined, "the main owner started");
  const records = () =>
    laneRecordsOf(host.manager.getBranch()).filter((record) => record.route === "config-change");
  const generation = () => getCoordinator(ownerKey)?.ownerGeneration;
  return {
    host,
    slot,
    notices,
    failure,
    records,
    generation,
    async cleanup() {
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Poll until `condition` holds (2 s cap), so slow machines do not fail on fixed sleeps. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await tick();
  }
}

/** Give an asynchronous restart that must NOT happen a fair chance to show up. */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step++) await tick();
}

test("a changed decision journals one config-change record and replaces the main owner once", async () => {
  const rig = await watchedHost();
  try {
    assert.equal(rig.slot.listeners.size, 1, "one subscription per registration");
    const before = rig.generation();
    assert.ok(before !== undefined);
    // An unchanged decision: nothing journaled, no restart.
    rig.slot.bump(() => true);
    await settle();
    assert.equal(rig.generation(), before);
    assert.equal(rig.records().length, 0);
    // Codex turns native compaction off for this model.
    rig.slot.bump(() => false);
    await waitFor(() => rig.generation() === before + 1, "the owner restarted");
    await settle();
    assert.equal(rig.generation(), before + 1, "restarted exactly once");
    const records = rig.records();
    assert.equal(records.length, 1);
    assert.deepEqual(
      { event: records[0]?.event, from: records[0]?.from, to: records[0]?.to },
      { event: "yield", from: "codex-native-v2", to: "local" },
    );
    // And back on.
    rig.slot.bump(() => true);
    await waitFor(() => rig.generation() === before + 2, "the owner restarted again");
    await settle();
    assert.equal(rig.generation(), before + 2);
    assert.equal(rig.records().length, 2);
    assert.equal(rig.records()[1]?.to, "codex-native-v2");
    assert.deepEqual(
      rig.notices.filter((notice) => /eligibility/.test(notice)),
      [],
    );
  } finally {
    await rig.cleanup();
  }
});

test("a restart failure is reported, a stale-context failure is not", async () => {
  const rig = await watchedHost();
  try {
    rig.failure.error = new Error(STALE);
    rig.slot.bump(() => false);
    await settle();
    assert.deepEqual(
      rig.notices.filter((notice) => /eligibility/.test(notice)),
      [],
    );
    rig.failure.error = new Error("settings exploded");
    rig.slot.bump(() => true);
    await waitFor(
      () => rig.notices.some((notice) => notice.includes("settings exploded")),
      "the failure was reported",
    );
    await settle();
    const reported = rig.notices.filter((notice) => /eligibility/.test(notice));
    assert.equal(reported.length, 1);
    assert.match(reported[0] ?? "", /Codex eligibility refresh failed: settings exploded/);
  } finally {
    rig.failure.error = undefined;
    await rig.cleanup();
  }
});

test("after shutdown a bump does nothing: unsubscribed, no restart, no record", async () => {
  const rig = await watchedHost();
  const before = rig.generation();
  const records = rig.records().length;
  await rig.cleanup();
  assert.equal(rig.slot.listeners.size, 0, "the watcher was disposed at shutdown");
  rig.slot.bump(() => false);
  await settle();
  assert.equal(rig.records().length, records);
  assert.ok(rig.generation() === before || rig.generation() === undefined);
});

test("an eligibility restart derives the OpenAI lane from the live slot, not the stale snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-eligibility-derive-"));
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  // The session-start snapshot: Codex native compaction off. No sidecar anywhere.
  await writeFile(
    join(dir, "choco-pi-codex.json"),
    JSON.stringify({ compaction: { responsesCompaction: false } }),
  );
  process.env[AGENT_DIR_ENV] = dir;
  const slot = installSlot(() => false, { responsesCompaction: false });
  const extension = (pi: ExtensionAPI): void => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background: { settingsPaths: () => [join(dir, "absent-background-compaction.json")] },
    });
  };
  let host: Awaited<ReturnType<typeof createHost>> | undefined;
  try {
    host = await createHost({
      dir,
      modelIdentity: { api: CODEX_MODEL.api, provider: CODEX_MODEL.provider, id: CODEX_MODEL.id },
      extensions: [extension],
    });
    await host.session.prompt("DERIVE-GO");
    await settle();
    const ownerKey = mainOwnerKey(host.manager.getSessionId());
    const calls = codexFactory.calls;
    const before = getCoordinator(ownerKey)?.ownerGeneration;
    // `/codex` turns Responses compaction on: the slot flips, the snapshot stays false.
    slot.control.responsesCompaction = true;
    slot.bump(() => true);
    await waitFor(
      () => (getCoordinator(ownerKey)?.ownerGeneration ?? 0) > (before ?? 0),
      "the owner restarted",
    );
    await waitFor(() => codexFactory.calls > calls, "the Codex lane was instantiated");
    assert.ok(codexFactory.calls >= calls + 1);
  } finally {
    await host?.dispose();
    if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, AGENT_DIR_ENV);
    else process.env[AGENT_DIR_ENV] = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
