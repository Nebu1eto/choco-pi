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
