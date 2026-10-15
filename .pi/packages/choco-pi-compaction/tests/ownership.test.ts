/**
 * Ownership of the compaction summary.
 *
 * The codex package registers its own native compaction and runs after this
 * one, so its result would replace anything produced here. Abstaining avoids a
 * wasted provider call. Codex's handler only summarizes with its
 * `responsesCompaction` flag on; with it off a codex transport is summarized
 * here (the former unconditional codex-transport abstention is gone).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { getCodexConversionConfigPath } from "../../choco-pi-codex/src/adapter/activation/config-store.ts";
import { parseLocalCompactionDetails } from "../src/details.ts";
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

test("an openai-codex provider abstains while no codex configuration is loaded, since codex may compact natively", () => {
  assert.equal(
    resolveOwner({ model: model({ provider: "openai-codex", api: "openai-codex-responses" }) }),
    "codex-native",
  );
});

test("a canonical codex subscription base URL is codex-owned while no codex configuration is loaded", () => {
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

// Replaces the former "codex-owned regardless of the codex config" rule: codex's
// handler abstains with native compaction off, so the summary is local there.
test("a codex transport is codex-owned only while codex native compaction is on", () => {
  const codex = { model: model({ provider: "openai-codex", api: "openai-codex-responses" }) };
  assert.equal(
    resolveOwner(codex, { responsesCompaction: false, additionalProviders: [] }),
    "local",
  );
  assert.equal(
    resolveOwner(codex, { responsesCompaction: true, additionalProviders: [] }),
    "codex-native",
  );
  assert.equal(
    resolveOwner(
      {
        model: model({
          provider: "custom",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      },
      { responsesCompaction: false, additionalProviders: [] },
    ),
    "local",
    "a canonical subscription base URL follows the same flag",
  );
});

test("no selected model means no owner", () => {
  assert.equal(resolveOwner({ model: undefined }), "none");
  assert.equal(resolveOwner({ model: undefined }, CONFIGURED), "none");
  assert.equal(
    resolveOwner({ model: undefined }, CONFIGURED, { anthropicServerSide: true }),
    "none",
  );
});

test("server-side mode claims anthropic-messages models only after every Codex rule", () => {
  const serverSide = { anthropicServerSide: true };
  assert.equal(resolveOwner({ model: model({}) }, undefined, serverSide), "anthropic-native");
  assert.equal(resolveOwner({ model: model({}) }, CONFIGURED, serverSide), "anthropic-native");
  assert.equal(
    resolveOwner({ model: model({}) }, undefined, { anthropicServerSide: false }),
    "local",
    "choco-pi mode stays local",
  );
  assert.equal(resolveOwner({ model: model({}) }), "local", "the summarizer's own view is local");
  // Codex keeps winning wherever it owns the summary (an absent snapshot keeps
  // the codex-transport abstention).
  assert.equal(
    resolveOwner(
      { model: model({ provider: "openai-codex", api: "openai-codex-responses" }) },
      undefined,
      serverSide,
    ),
    "codex-native",
  );
  assert.equal(
    resolveOwner(
      { model: model({ provider: "OpenRouter", api: "openai-responses" }) },
      CONFIGURED,
      serverSide,
    ),
    "codex-native",
  );
  assert.equal(
    resolveOwner(
      { model: model({ provider: "openai", api: "openai-responses" }) },
      undefined,
      serverSide,
    ),
    "local",
    "a non-Anthropic API is never claimed",
  );
  assert.equal(
    resolveOwner(
      { model: model({ provider: "openai-codex", api: "openai-codex-responses" }) },
      { responsesCompaction: false, additionalProviders: [] },
      serverSide,
    ),
    "local",
    "a codex transport with native off is local, never anthropic-native",
  );
});

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Run with a temporary agent directory holding a codex config, so
 * `session_start` reads this flag instead of the developer's real one.
 */
async function withCodexConfig(
  responsesCompaction: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-compaction-codex-"));
  const previous = process.env[AGENT_DIR_ENV];
  try {
    await writeFile(
      getCodexConversionConfigPath(agentDir),
      JSON.stringify({ compaction: { responsesCompaction } }),
    );
    process.env[AGENT_DIR_ENV] = agentDir;
    await run();
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** A codex-provider host whose `session_start` has read the codex config. */
async function codexHost() {
  const host = await createCompactionHost({
    provider: "openai-codex",
    keepRecentTokens: 200,
    reserveTokens: 4_000,
    contextWindow: 200_000,
    maxTokens: 2_000,
    extensionFactories: [compactionExtension()],
  });
  try {
    await host.session.bindExtensions({});
  } catch (error) {
    await host.dispose();
    throw error;
  }
  return host;
}

test("on a codex transport with native compaction on the handler abstains and the host summarizes", async () => {
  await withCodexConfig(true, async () => {
    const host = await codexHost();
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
});

test("on a codex transport with native compaction off the reconciled summarizer answers", async () => {
  await withCodexConfig(false, async () => {
    const host = await codexHost();
    try {
      ordinaryCut(host.sessionManager);
      await host.session.compact();

      assert.equal(host.calls.length, 1);
      const prompt = host.calls[0]?.promptText ?? "";
      assert.ok(prompt.includes("<current-state-evidence>"), "the reconciled prompt was used");
      const committed = host.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "compaction")
        .at(-1);
      assert.ok(committed);
      assert.equal(committed.fromHook, true);
      assert.equal(parseLocalCompactionDetails(committed)?.strategy, "local-reconciled");
    } finally {
      await host.dispose();
    }
  });
});
