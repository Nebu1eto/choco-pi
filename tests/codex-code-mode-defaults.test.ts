import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { resolveCodexRuntimePlan } from "../.pi/packages/choco-pi-codex/src/adapter/activation/runtime-plan.ts";
import { openAICodexModelsWithDaybreak } from "../.pi/packages/choco-pi-codex/src/providers/openai-codex/model-catalog.ts";
import { buildCodexSystemPrompt } from "../.pi/packages/choco-pi-codex/src/prompt/build-system-prompt.ts";

test("Code Mode is the append-style default for every OpenAI Codex model", () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);

  assert.equal(config.executionMode, "code");
  assert.equal(config.prompt.heavySystemPromptOverwrite, false);
  assert.equal(config.ui.codeModeDetails, false);

  for (const model of openAICodexModelsWithDaybreak()) {
    const plan = resolveCodexRuntimePlan({ model }, config);
    assert.equal(plan.kind, "code", `${model.id} should use Code Mode`);
    assert.ok(plan.toolNames.includes("exec"), `${model.id} should expose the exec tool`);
  }

  const prompt = buildCodexSystemPrompt("BASE PROMPT", { mode: "code" });
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /Use tools\.exec_command for shell commands/);
});

test("the choco-pi profile keeps appended prompts and concise Code Mode results", () => {
  const profile = JSON.parse(
    readFileSync(new URL("../.pi/choco-pi-codex.json", import.meta.url), "utf8"),
  );

  assert.equal(profile.executionMode, "code");
  assert.equal(profile.prompt.heavySystemPromptOverwrite, false);
  assert.equal(profile.ui.codeModeDetails, false);
});
