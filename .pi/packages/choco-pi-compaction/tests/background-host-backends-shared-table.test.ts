import assert from "node:assert/strict";
import test from "node:test";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type BackendOwnerSpec, resolveBackends } from "../src/background-host/backends.ts";
import { parseBackgroundSettings } from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";

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
