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
  assert.match(prompt, /Keep exec code mode bounded/);
  assert.match(prompt, /commands expected to exceed about 30 seconds to shell_start/);
  assert.match(prompt, /use direct calls when one call suffices/);
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
  assert.match(
    prompt,
    /route persistent processes and commands expected to exceed about 30 seconds to shell_start/,
  );
  assert.match(prompt, /tools\.apply_patch\(patch\) for edits/);
  assert.match(prompt, /Every tools\.exec_command requires a short 3-7 word description/);
});

test("Code Mode canonicalizes legacy composition guidance into bounded routing rules", () => {
  const legacy = [
    "Await dependencies; use Promise.all for independent calls",
    "Use text() only for concise final output",
  ];
  const prompt = buildCodexSystemPrompt(
    `Guidelines:\n${legacy.map((line) => `- ${line}`).join("\n")}\n\nCurrent date: 2026-03-16`,
    { mode: "code" },
  );

  for (const line of legacy) assert.ok(!prompt.includes(line));
  assert.equal(prompt.match(/Use code mode only for bounded multi-call stages/g)?.length, 1);
});

test("Code Mode tool guidance is compact and retains callable patch, web, and custom-tool guidance", () => {
  const longApplyPatchUsage =
    "await tools.apply_patch(patch) // *** Begin Patch / *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path | *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk (use one unchanged context line for a pure move); Update hunks MUST follow file order; copy exact context; @@ text is context, not a line range; reread a file before patching if it changed since your last read";
  const longWebRunUsage =
    'await tools.web__run({ search_query?: [{ q: string, recency?: number, domains?: string[] }], image_query?: [{ q: string }], open?: [{ ref_id: string, lineno?: number }], click?: [{ ref_id: string, id: number }], find?: [{ ref_id: string, pattern: string }], response_length?: "short" | "medium" | "long" }) // turn… ref_ids only for web__run; final answers cite result URLs with Markdown links, never turn… or cite…';
  const tools: CodeModeToolDefinition[] = [
    {
      name: "apply_patch",
      usage: longApplyPatchUsage,
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "exec_command",
      usage:
        "await tools.exec_command({ cmd: string, workdir?: string, shell?: string, tty?: boolean, yield_time_ms?: number, max_output_tokens?: number, login?: boolean }) // returns { output: string, session_id?: number, exit_code?: number }",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "web__run",
      usage: longWebRunUsage,
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "write_stdin",
      usage:
        "await tools.write_stdin({ session_id: number, chars: string, yield_time_ms?: number, max_output_tokens?: number })",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
  ];
  const guidance = buildCodeModeToolsPrompt(tools, "/tmp/CUSTOM-TOOLS.md");
  const applyPatchGuidance = guidance
    .split("\n")
    .find((line) => line.includes("tools.apply_patch"))!;
  const webRunGuidance = guidance.split("\n").find((line) => line.includes("tools.web__run"))!;

  assert.match(applyPatchGuidance, /envelope: \*\*\* Begin Patch … \*\*\* End Patch/);
  assert.match(
    applyPatchGuidance,
    /actions: \*\*\* Add File: path \| \*\*\* Update File: path \| \*\*\* Delete File: path/,
  );
  assert.match(
    applyPatchGuidance,
    /\*\*\* Move to: path immediately follows its \*\*\* Update File: path header/,
  );
  assert.match(
    applyPatchGuidance,
    /pure moves need a nonempty @@ hunk with one unchanged context line/,
  );
  assert.match(applyPatchGuidance, /hunks in file order/);
  assert.match(applyPatchGuidance, /@@ is context, not a line range/);
  assert.ok(applyPatchGuidance.length < longApplyPatchUsage.length);
  assert.match(
    guidance,
    /await tools\.exec_command\(\{description, cmd, workdir\?, shell\?, tty\?/,
  );
  assert.match(guidance, /description: required 3-7 word intent for collapsed display/);
  assert.match(
    webRunGuidance,
    /\{search_query\?: \[\{q, recency\?, domains\?\}\], image_query\?: \[\{q\}\], open\?: \[\{ref_id, lineno\?\}\], click\?: \[\{ref_id, id\}\], find\?: \[\{ref_id, pattern\}\], response_length\?\}/,
  );
  assert.match(webRunGuidance, /final answers cite result URLs/);
  assert.match(webRunGuidance, /never emit internal turn… or cite… citation artifacts/);
  assert.ok(webRunGuidance.length < longWebRunUsage.length);
  assert.match(
    guidance,
    /await tools\.write_stdin\(\{session_id, chars\?, yield_time_ms\?, max_output_tokens\?\}\)/,
  );
  assert.match(
    guidance,
    /Composition: one exec block per step, not one per tools\.\* call — for a bounded processing step, batch independent calls with Promise\.all/,
  );
  assert.match(
    guidance,
    /Pattern: const \[a, b\] = await Promise\.all\(\[tools\.exec_command\(\{description: "List source files", cmd: "rg --files src"\}\), tools\.exec_command\(\{description: "Find pending work", cmd: "rg -n TODO src"\}\)\]\); text\(a\.output \+ b\.output\)/,
  );
  assert.match(
    guidance,
    /To create or edit a custom tool, read .* only when creating or editing a custom tool; never for discovering or calling tools; do not read Pi docs/,
  );
  assert.match(EXEC_DESCRIPTION, /JavaScript source only; no JSON\/fences/);
  assert.match(EXEC_DESCRIPTION, /bounded multi-call workflows that filter or aggregate results/);
  assert.match(EXEC_DESCRIPTION, /first-line \/\/ @description: short intent/);
  assert.match(EXEC_DESCRIPTION, /first exec_command description labels it/);
  assert.match(EXEC_DESCRIPTION, /prefer direct calls when one call suffices/);
  assert.match(EXEC_DESCRIPTION, /Code: fresh restricted JS/);
  assert.match(EXEC_DESCRIPTION, /Notebook: persistent shared Deno TypeScript globals/);
  // text()/notify() emit and return undefined; the description must not imply
  // that text(value) yields a string, which reads as safe to nest in an expression.
  assert.match(
    EXEC_DESCRIPTION,
    /text\(value\) and notify\(value\) EMIT output and return nothing/,
  );
  assert.doesNotMatch(EXEC_DESCRIPTION, /serializes output/);
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
