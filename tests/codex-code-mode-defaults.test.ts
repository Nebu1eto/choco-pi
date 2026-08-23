import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { resolveCodexRuntimePlan } from "../.pi/packages/choco-pi-codex/src/adapter/activation/runtime-plan.ts";
import { openAICodexModelsWithDaybreak } from "../.pi/packages/choco-pi-codex/src/providers/openai-codex/model-catalog.ts";
import { buildCodexSystemPrompt } from "../.pi/packages/choco-pi-codex/src/prompt/build-system-prompt.ts";
import {
  buildCodeModeToolsPrompt,
  EXEC_DESCRIPTION,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/custom-tool-prompt.ts";
import type { CodeModeToolDefinition } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/types.ts";

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

test("Code Mode guidance canonicalizes legacy rules without losing execution semantics", () => {
  const legacy = [
    "Use tools.exec_command for shell commands; prefer rg and rg --files",
    "For tools.exec_command cmd, use String.raw only without backticks or ${}; avoid nested quoting; split independent commands into separate calls",
    "Long command: keep tools.exec_command awaited inside exec; resume the yielded cell_id with wait near completion. Do not request a short child yield and poll its session_id with tools.write_stdin",
    "Use tty=true only for input or persistent processes",
    "Use tools.apply_patch(patch) for file edits; split large patches; reserve shell/Python for formatting or bulk rewrites",
  ];
  const prompt = buildCodexSystemPrompt(
    `Guidelines:\n${legacy.map((line) => `- ${line}`).join("\n")}\n\nCurrent date: 2026-03-16`,
    { mode: "code" },
  );

  for (const line of legacy) assert.ok(!prompt.includes(line));
  assert.match(prompt, /String\.raw \(no backticks\/\$\{\}\)/);
  assert.match(prompt, /never short-yield then poll exec_command via write_stdin/);
  assert.match(prompt, /tools\.apply_patch\(patch\) for edits/);
});

test("Code Mode tool guidance is compact and retains callable forms and discovery guard", () => {
  const tools: CodeModeToolDefinition[] = [
    {
      name: "apply_patch",
      usage: "long apply_patch schema",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "exec_command",
      usage: "long exec_command schema",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "web_run",
      usage: "long web__run schema",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "write_stdin",
      usage: "long write_stdin schema",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
  ];
  const guidance = buildCodeModeToolsPrompt(tools, "/tmp/CUSTOM-TOOLS.md");

  assert.match(guidance, /await tools\.apply_patch\(patch\).*Begin Patch/);
  assert.match(guidance, /await tools\.exec_command\(\{cmd, workdir\?, shell\?, tty\?/);
  assert.match(
    guidance,
    /await tools\.web__run\(\{search_query\?, image_query\?, open\?, click\?, find\?\}\)/,
  );
  assert.match(
    guidance,
    /await tools\.write_stdin\(\{session_id, chars\?, yield_time_ms\?, max_output_tokens\?\}\)/,
  );
  assert.match(
    guidance,
    /To create or edit a custom tool, read .*not Pi docs or tool discovery\/calls/,
  );
  assert.ok(guidance.length < 700);
  assert.match(EXEC_DESCRIPTION, /JavaScript source only; no JSON\/fences/);
  assert.match(EXEC_DESCRIPTION, /Code: fresh restricted JS/);
  assert.match(EXEC_DESCRIPTION, /Notebook: persistent shared Deno TypeScript globals/);
  assert.match(EXEC_DESCRIPTION, /text\(value\) serializes output/);
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
