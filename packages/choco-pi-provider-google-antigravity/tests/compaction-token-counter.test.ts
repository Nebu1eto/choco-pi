import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import googleAntigravityProvider from "../extensions/provider/index.ts";
import {
  ANTIGRAVITY_COUNT_TOKENS_ENV,
  antigravityCompactionTokenCounter,
} from "../src/compaction/token-counter.ts";

const SLOT = Symbol.for("choco-pi:compaction-token-counters/v1");

function isRegistered(): boolean {
  const table: unknown = Object.getOwnPropertyDescriptor(globalThis, SLOT)?.value;
  if (!(table instanceof Map)) return false;
  const counters: unknown = table.get("google");
  return Array.isArray(counters) && counters.includes(antigravityCompactionTokenCounter);
}

test("activation registers the compaction counter; shutdown removes it and session_start restores it", async () => {
  const extension = await loadExtensionFromFactory(
    googleAntigravityProvider,
    "/tmp/choco-pi-antigravity-token-counter",
    createEventBus(),
    createExtensionRuntime(),
    "<inline:antigravity-provider>",
  );
  const emit = async (event: string) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, {});
  };
  try {
    assert.equal(isRegistered(), true);
    await emit("session_shutdown");
    assert.equal(isRegistered(), false);
    await emit("session_start");
    await emit("session_start");
    assert.equal(isRegistered(), true);
  } finally {
    await emit("session_shutdown");
  }
  assert.equal(isRegistered(), false);
});

test("the counter is opt-in and skips a key that is not the packed OAuth credential", async () => {
  assert.equal(antigravityCompactionTokenCounter.optInEnv, ANTIGRAVITY_COUNT_TOKENS_ENV);
  const fetch: typeof globalThis.fetch = () => Promise.reject(new Error("unexpected fetch"));
  const outcome = await antigravityCompactionTokenCounter.countTokens({
    model: {
      id: "gemini-3.8-flash",
      name: "gemini-3.8-flash",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    },
    system: "SYSTEM",
    promptText: "PROMPT",
    signal: new AbortController().signal,
    apiKey: "AIzaFAKE-gemini-api-key-for-tests",
    headers: undefined,
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    fetch,
    timeoutMs: 1_000,
  });
  assert.deepEqual(outcome, { skipped: true });
});
