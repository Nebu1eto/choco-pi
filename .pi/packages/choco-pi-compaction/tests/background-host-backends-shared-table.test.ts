import assert from "node:assert/strict";
import test from "node:test";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type BackendOwnerSpec,
  resolveBackends,
  selectBackendId,
} from "../src/background-host/backends.ts";
import type { Backend } from "../src/background/contract.ts";
import { CODEX_BACKEND_SETTING_ID, parseBackgroundSettings } from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";
import type { CodexCompactionSnapshot } from "../src/ownership.ts";

const MODEL: Model<Api> = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

/**
 * Pi loads every extension copy as its own module instance, so a subagent
 * child's copy of backends.ts resolves through the default factories the main
 * session's copy registered first. The resolving-owner table must be shared,
 * or the text backend fails with "No background compaction owner ... is
 * resolving backends".
 */
test("a second module copy resolves the text backend registered by the first", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const reports: string[] = [];
  const spec: BackendOwnerSpec = {
    ownerKey: "subagent-child:test",
    ownerGeneration: 1,
    sessionId: "session-test",
    model: MODEL,
    modelRegistry: new ModelRegistry(runtime),
    thinkingLevel: "off",
    retryPolicy: undefined,
    codexCompaction: undefined,
    settings: parseBackgroundSettings(
      JSON.stringify({ enabled: true, text: true, codexNative: false, anthropicNative: false }),
      "test",
    ).settings,
    scope: {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-5-5",
      authMode: "oauth",
    },
    allowAnthropic: false,
    allowForeign: false,
    report: (message) => reports.push(message),
  };
  const options = { createTextSummarizer: () => undefined };

  // The first copy registers the process-global default factories.
  await resolveBackends(spec, options);
  // A fresh module instance stands in for the subagent child's copy.
  const copy: typeof import("../src/background-host/backends.ts") = await import(
    `../src/background-host/backends.ts?copy=${Date.now()}`
  );
  const backends = await copy.resolveBackends(spec, options);

  assert.deepEqual(reports, []);
  assert.ok(backends.has(TEXT_BACKEND_ID));
});

/** A backend that only carries its id; selection never calls it for these lanes. */
function stubBackend(id: string): Backend {
  return {
    id,
    capability: async () => ({ supported: false, reason: "unsupported" }),
    isLegalCut: () => ({ legal: false, reason: "unsupported" }),
    prepare: async () => ({ ok: false, reason: "unsupported", retryable: false }),
  };
}

const CODEX_MODEL: Model<Api> = {
  ...MODEL,
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};

/**
 * A Codex transport is Codex-owned only while Codex's native compaction is on.
 * With `responsesCompaction` off Codex's handler abstains, so the text lane
 * serves the session instead of no lane at all.
 */
test("a Codex transport selects the text lane with native off and the Codex lane with native on", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const reports: string[] = [];
  const specFor = (codexCompaction: CodexCompactionSnapshot | undefined): BackendOwnerSpec => ({
    ownerKey: "main-session:test",
    ownerGeneration: 1,
    sessionId: "session-test",
    model: CODEX_MODEL,
    modelRegistry: new ModelRegistry(runtime),
    thinkingLevel: "off",
    retryPolicy: undefined,
    codexCompaction,
    settings: parseBackgroundSettings(
      JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
      "test",
    ).settings,
    scope: {
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-test",
      authMode: "oauth",
    },
    allowAnthropic: false,
    allowForeign: true,
    report: (message) => reports.push(message),
  });
  const both = new Map<string, Backend>([
    [TEXT_BACKEND_ID, stubBackend(TEXT_BACKEND_ID)],
    [CODEX_BACKEND_SETTING_ID, stubBackend(CODEX_BACKEND_SETTING_ID)],
  ]);
  const textOnly = new Map<string, Backend>([[TEXT_BACKEND_ID, stubBackend(TEXT_BACKEND_ID)]]);
  const off = { responsesCompaction: false, additionalProviders: [] };
  const on = { responsesCompaction: true, additionalProviders: [] };

  assert.equal(await selectBackendId(specFor(off), both), TEXT_BACKEND_ID);
  assert.equal(await selectBackendId(specFor(off), textOnly), TEXT_BACKEND_ID);
  assert.equal(await selectBackendId(specFor(on), both), CODEX_BACKEND_SETTING_ID);
  assert.equal(
    await selectBackendId(specFor(on), textOnly),
    undefined,
    "Codex's handler would replace a text checkpoint, so no other lane applies",
  );
  assert.equal(
    await selectBackendId(specFor(undefined), both),
    CODEX_BACKEND_SETTING_ID,
    "no loaded Codex configuration keeps the Codex abstention",
  );
  assert.deepEqual(reports, []);
});
