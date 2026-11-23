import assert from "node:assert/strict";
import test from "node:test";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  compactionBackendProviders,
  firstForegroundAnswer,
  type ForegroundCompactHandler,
  isCompactionBackendEnabled,
  registerCompactionBackendProvider,
  registeredForegroundHandlers,
} from "../src/background-host/backend-registry.ts";
import {
  type BackendOwnerSpec,
  resolveBackends,
  selectBackendId,
} from "../src/background-host/backends.ts";
import type { Backend } from "../src/background/contract.ts";
import { parseBackgroundSettings } from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";

const MODEL: Model<Api> = {
  id: "acme-model",
  name: "Acme Model",
  api: "openai-completions",
  provider: "acme",
  baseUrl: "https://api.acme.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const SETTINGS = parseBackgroundSettings(
  JSON.stringify({ enabled: true, text: true, codexNative: false, anthropicNative: false }),
  "test",
).settings;

function backend(id: string, supported: boolean): Backend {
  return {
    id,
    capability: async () =>
      supported ? { supported: true } : { supported: false, reason: "unsupported" },
    isLegalCut: () => ({ legal: false, reason: "unsupported" }),
    prepare: async () => ({ ok: false, reason: "unsupported", retryable: false }),
  };
}

async function specFor(allowForeign: boolean, reports: string[]): Promise<BackendOwnerSpec> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  return {
    ownerKey: "main-session:backend-registry",
    ownerGeneration: 1,
    sessionId: "session-backend-registry",
    model: MODEL,
    modelRegistry: new ModelRegistry(runtime),
    thinkingLevel: "off",
    retryPolicy: undefined,
    codexCompaction: undefined,
    settings: SETTINGS,
    scope: { provider: "acme", baseUrl: MODEL.baseUrl, model: MODEL.id, authMode: "api-key" },
    allowAnthropic: false,
    allowForeign,
    report: (message) => reports.push(message),
  };
}

test("nothing registered: no provider lanes, unknown ids stay disabled", () => {
  assert.deepEqual(compactionBackendProviders(), []);
  assert.deepEqual(registeredForegroundHandlers(), []);
  assert.equal(isCompactionBackendEnabled("acme-native", SETTINGS), false);
  assert.equal(isCompactionBackendEnabled(TEXT_BACKEND_ID, SETTINGS), true);
});

test("a built-in id cannot be registered", () => {
  for (const id of ["text", "anthropic-native", "codex-native-v2", "xai-native", ""]) {
    assert.throws(() => registerCompactionBackendProvider({ id }), id);
  }
});

test("a registered backend is enabled, resolved for foreign-allowed owners, and selected when capable", async () => {
  const supported = { value: true };
  const unregister = registerCompactionBackendProvider({
    id: "acme-native",
    backendFactory: () => backend("acme-native", supported.value),
    enabled: (settings) => settings.text,
  });
  try {
    assert.equal(isCompactionBackendEnabled("acme-native", SETTINGS), true);
    assert.equal(isCompactionBackendEnabled("acme-native", { ...SETTINGS, enabled: false }), false);
    assert.equal(isCompactionBackendEnabled("acme-native", { ...SETTINGS, text: false }), false);

    const reports: string[] = [];
    const foreign = await specFor(true, reports);
    const backends = await resolveBackends(foreign, { createTextSummarizer: () => undefined });
    assert.ok(backends.has("acme-native"));
    assert.ok(backends.has(TEXT_BACKEND_ID));
    assert.equal(await selectBackendId(foreign, backends), "acme-native");
    supported.value = false;
    const declined = await resolveBackends(foreign, { createTextSummarizer: () => undefined });
    assert.equal(await selectBackendId(foreign, declined), TEXT_BACKEND_ID);

    const local = await specFor(false, reports);
    const localBackends = await resolveBackends(local, { createTextSummarizer: () => undefined });
    assert.equal(
      localBackends.has("acme-native"),
      false,
      "the foreign switch gates provider lanes",
    );
    assert.deepEqual(reports, []);
  } finally {
    unregister();
  }
  assert.equal(isCompactionBackendEnabled("acme-native", SETTINGS), false, "unregistered");
});

test("foreground handlers answer in order after earlier ones decline", async () => {
  const calls: string[] = [];
  const handler = (name: string, answer: string | undefined) => async (event: string) => {
    calls.push(name + ":" + event);
    return answer;
  };
  assert.equal(
    await firstForegroundAnswer([handler("a", undefined), handler("b", undefined)], "e", 0),
    undefined,
  );
  assert.deepEqual(calls, ["a:e", "b:e"]);
  calls.length = 0;
  assert.equal(
    await firstForegroundAnswer(
      [handler("a", undefined), handler("b", "B"), handler("c", "C")],
      "e",
      0,
    ),
    "B",
  );
  assert.deepEqual(calls, ["a:e", "b:e"], "a later handler never runs after an answer");
});

test("registered foreground handlers: newest per id, and a stale unregister keeps the newer", () => {
  const older: ForegroundCompactHandler = async () => ({ cancel: true });
  const newer: ForegroundCompactHandler = async () => undefined;
  const first = registerCompactionBackendProvider({
    id: "acme-foreground",
    foregroundCompact: older,
  });
  const second = registerCompactionBackendProvider({
    id: "acme-foreground",
    foregroundCompact: newer,
  });
  try {
    assert.deepEqual(registeredForegroundHandlers(), [newer]);
    first();
    first();
    assert.deepEqual(registeredForegroundHandlers(), [newer]);
  } finally {
    first();
    second();
  }
  assert.deepEqual(compactionBackendProviders(), []);
});

test("the same provider registered twice keeps one lease after an idempotent first unregister", () => {
  const provider = { id: "acme-twice" };
  const first = registerCompactionBackendProvider(provider);
  const second = registerCompactionBackendProvider(provider);
  try {
    first();
    first();
    assert.deepEqual(compactionBackendProviders(), [provider]);
    second();
    assert.deepEqual(compactionBackendProviders(), []);
  } finally {
    first();
    second();
  }
});

test("a blank backend id is rejected before the shared table changes", () => {
  const unregister = registerCompactionBackendProvider({ id: "acme-intact" });
  try {
    for (const id of ["", "   "]) {
      assert.throws(() => registerCompactionBackendProvider({ id }), /must not be empty/);
    }
    assert.deepEqual(
      compactionBackendProviders().map((provider) => provider.id),
      ["acme-intact"],
    );
  } finally {
    unregister();
  }
});
