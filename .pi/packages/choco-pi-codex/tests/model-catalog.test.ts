import assert from "node:assert/strict";
import test from "node:test";
import { openAICodexModelsWithDaybreak } from "../src/providers/openai-codex/model-catalog.ts";

test("OpenAI Codex catalog includes GPT-6 Astra", () => {
  const astra = openAICodexModelsWithDaybreak().find(({ id }) => id === "gpt-6-astra");

  assert.ok(astra);
  assert.equal(astra.provider, "openai-codex");
  assert.equal(astra.api, "openai-codex-responses");
  assert.equal(astra.contextWindow, 1_050_000);
  assert.equal(astra.maxTokens, 128_000);
  assert.deepEqual(astra.input, ["text", "image"]);
  assert.equal(astra.thinkingLevelMap?.minimal, "low");
});
