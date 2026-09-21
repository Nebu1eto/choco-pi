/**
 * Ownership of the compaction summary.
 *
 * The codex package registers its own native compaction and runs after this
 * one, so its result would replace anything produced here. Abstaining avoids a
 * wasted provider call.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { type CodexCompactionSnapshot, resolveOwner } from "../src/ownership.ts";
import { ordinaryCut } from "./fixtures.ts";
import { compactionExtension, createCompactionHost } from "./host-harness.ts";

function model(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
    ...overrides,
  };
}

test("an openai-codex provider leaves the summary to the codex package", () => {
  assert.equal(
    resolveOwner({ model: model({ provider: "openai-codex", api: "openai-codex-responses" }) }),
    "codex-native",
  );
});

test("a canonical codex subscription base URL is codex-owned", () => {
  assert.equal(
    resolveOwner({
      model: model({
        provider: "custom",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
    }),
    "codex-native",
  );
});

test("an anthropic-messages model is summarized locally", () => {
  assert.equal(resolveOwner({ model: model({}) }), "local");
  assert.equal(
    resolveOwner({ model: model({ provider: "openai", api: "openai-responses" }) }),
    "local",
    "a non-codex responses model is still summarized locally",
  );
});

const CONFIGURED: CodexCompactionSnapshot = {
  responsesCompaction: true,
  additionalProviders: ["openrouter"],
};

test("a codex-configured extra provider on a responses model is codex-owned", () => {
  const ctx = { model: model({ provider: "OpenRouter", api: "openai-responses" }) };
  assert.equal(resolveOwner(ctx, CONFIGURED), "codex-native");
  assert.equal(
    resolveOwner(ctx, { ...CONFIGURED, responsesCompaction: false }),
    "local",
    "codex produces no native summary with the flag off",
  );
  assert.equal(
    resolveOwner(ctx, { responsesCompaction: true, additionalProviders: [] }),
    "local",
    "a provider codex was not configured for stays local",
  );
  assert.equal(resolveOwner(ctx), "local", "no snapshot leaves only the transport rule");
});

test("the configured-provider rule needs a responses model", () => {
  assert.equal(
    resolveOwner({ model: model({ provider: "openrouter" }) }, CONFIGURED),
    "local",
    "an anthropic-messages model never reaches codex's responses compaction",
  );
});

test("a codex transport is codex-owned regardless of the codex config", () => {
  assert.equal(
    resolveOwner(
      { model: model({ provider: "openai-codex", api: "openai-codex-responses" }) },
      { responsesCompaction: false, additionalProviders: [] },
    ),
    "codex-native",
  );
});

test("no selected model means no owner", () => {
  assert.equal(resolveOwner({ model: undefined }), "none");
  assert.equal(resolveOwner({ model: undefined }, CONFIGURED), "none");
});

test("on a codex transport the handler abstains and the host summarizes", async () => {
  const host = await createCompactionHost({
    provider: "openai-codex",
    keepRecentTokens: 200,
    reserveTokens: 4_000,
    contextWindow: 200_000,
    maxTokens: 2_000,
    extensionFactories: [compactionExtension()],
  });
  try {
    const fixture = ordinaryCut(host.sessionManager);
    await host.session.compact();

    assert.equal(host.calls.length, 1);
    const prompt = host.calls[0]?.promptText ?? "";
    assert.ok(prompt.startsWith("<conversation>"), "the host's own prompt was used");
    assert.equal(prompt.includes("<current-state-evidence>"), false);
    const committed = host.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "compaction")
      .at(-1);
    assert.ok(committed);
    assert.notEqual(committed.fromHook, true);
    for (const sentinel of fixture.completionSentinels) {
      assert.equal(prompt.includes(sentinel), false);
    }
  } finally {
    await host.dispose();
  }
});
