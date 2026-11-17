import assert from "node:assert/strict";
import test from "node:test";
import { openAICodexModelsWithDaybreak } from "../src/providers/openai-codex/model-catalog.ts";

test("OpenAI Codex catalog exposes the host GPT-6 Astra entry exactly once", () => {
  const models = openAICodexModelsWithDaybreak();
  const entries = models.filter(({ id }) => id === "gpt-6-astra");
  const astra = entries[0];

  assert.equal(entries.length, 1);
  assert.ok(astra);
  assert.equal(astra.provider, "openai-codex");
  assert.equal(astra.api, "openai-codex-responses");
  assert.deepEqual(astra.input, ["text", "image"]);
  assert.equal(astra.thinkingLevelMap?.minimal, "low");
  // Daybreak models remain a choco-pi addition until the host catalog carries them.
  assert.ok(models.some(({ id }) => id === "gpt-daybreak-blue-latest"));
});

test("OpenAI Codex catalog exposes GPT-6.2 Astra and Sol exactly once with Codex limits", () => {
  const models = openAICodexModelsWithDaybreak();
  for (const [id, contextWindow, input] of [
    ["gpt-6.2-astra", 272_000, 8],
    ["gpt-6.2-sol", 500_000, 2],
  ] as const) {
    const entries = models.filter((model) => model.id === id);
    const model = entries[0];
    assert.equal(entries.length, 1, id);
    assert.ok(model);
    assert.equal(model.provider, "openai-codex");
    assert.equal(model.api, "openai-codex-responses");
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.maxTokens, 128_000);
    assert.equal(model.cost.input, input);
    assert.equal(model.thinkingLevelMap?.off, null);
    assert.equal(model.thinkingLevelMap?.minimal, "low");
    assert.equal(model.thinkingLevelMap?.max, "max");
  }
});
