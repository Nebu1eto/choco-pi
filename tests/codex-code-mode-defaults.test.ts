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

test("Code Mode activates on non-OpenAI models without changing their transport", () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  const models = [
    { provider: "anthropic", id: "claude-sonnet-5" },
    { provider: "synthetic", id: "hf:moonshotai/Kimi-K3" },
  ];

  for (const model of models) {
    // SAFETY: Runtime planning reads only provider/id/api/baseUrl, and this case exercises the provider-agnostic path that needs only provider and id.
    const plan = resolveCodexRuntimePlan({ model: model as never }, config);
    assert.equal(plan.kind, "code", `${model.provider}/${model.id} should use Code Mode`);
    assert.ok(plan.toolNames.includes("exec"), `${model.provider}/${model.id} should expose exec`);
    assert.equal(plan.transport, "responses", "the model keeps its native provider transport");
  }
});

test("the choco-pi profile keeps appended prompts and concise Code Mode results", () => {
  const profile = JSON.parse(
    readFileSync(new URL("../.pi/choco-pi-codex.json", import.meta.url), "utf8"),
  );

  assert.equal(profile.executionMode, "code");
  assert.equal(profile.prompt.heavySystemPromptOverwrite, false);
  assert.equal(profile.ui.codeModeDetails, false);
});
