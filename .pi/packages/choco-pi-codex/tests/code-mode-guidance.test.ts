import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildCodeModeToolsPrompt,
  EXEC_DESCRIPTION,
  injectCodeModeToolsPrompt,
  replaceCodeModeToolsPrompt,
} from "../src/tools/code-mode/custom-tool-prompt.ts";
import type {
  CodeModeToolDefinition,
  ProgrammaticCodeModeToolDefinition,
} from "../src/tools/code-mode/types.ts";

function tool(
  name: string,
  deferLoading = false,
  summary?: string,
  description?: string,
): ProgrammaticCodeModeToolDefinition {
  return {
    name,
    usage: `await tools.${name}({})`,
    summary,
    description,
    deferLoading,
    kind: "function",
    async invoke() {
      return undefined;
    },
  };
}

test("root capabilities receive strong code-mode routing with a valid shell example", () => {
  const prompt = buildCodeModeToolsPrompt([
    tool("exec_command"),
    tool("write_stdin"),
    tool("module_report", true),
    tool("lsp_diagnostics", true),
  ]);

  assert.match(prompt, /Use code mode by default for bounded tool workflows/);
  assert.match(prompt, /one exec block per coherent step/);
  assert.match(
    prompt,
    /text\(await Promise\.all\(\[tools\.exec_command\(\{description:"List files"/,
  );
  assert.match(prompt, /Preserve Promise\.allSettled failures/);
  assert.match(prompt, /sequence dependent work/);
  assert.match(prompt, /Inspect one unfamiliar schema in ALL_TOOLS/);
  assert.match(prompt, /keep cells alive only to poll/);
});

test("restricted child example preserves successful and failed read-only outcomes", async () => {
  const tools: CodeModeToolDefinition[] = [
    tool("module_report", true),
    tool("lsp_diagnostics", true),
  ];
  const prompt = buildCodeModeToolsPrompt(tools);

  assert.match(prompt, /Promise\.allSettled\(\[tools\.module_report/);
  assert.match(prompt, /tools\.lsp_diagnostics/);
  assert.doesNotMatch(prompt, /tools\.exec_command\(/);
  assert.doesNotMatch(prompt, /tools\.read(?:\(|\b)/);
  assert.doesNotMatch(prompt, /read_text/);
  assert.match(prompt, /UI refs are not file paths/);

  const example = prompt
    .split("\n")
    .find((line) => line.startsWith("Pattern: "))
    ?.slice("Pattern: ".length);
  assert.ok(example);
  let successfulCalls = 0;
  let rendered = "";
  await runInNewContext(`(async () => { ${example} })()`, {
    tools: {
      module_report() {
        successfulCalls += 1;
        return Promise.resolve({ path: "src/example.ts" });
      },
      lsp_diagnostics() {
        return Promise.reject(new Error("diagnostics unavailable"));
      },
    },
    text(value: string) {
      rendered = value;
    },
  });

  assert.equal(successfulCalls, 1);
  assert.deepEqual(JSON.parse(rendered), [
    { status: "fulfilled", value: { path: "src/example.ts" } },
    { status: "rejected", reason: "Error: diagnostics unavailable" },
  ]);
});

test("prompt injection is idempotent and remains useful with minimal permissions", () => {
  const tools: CodeModeToolDefinition[] = [tool("module_report", true)];
  const once = injectCodeModeToolsPrompt("BASE\nCurrent shell: zsh", tools);
  const twice = injectCodeModeToolsPrompt(once, tools);

  assert.equal(twice, once);
  assert.equal(once.match(/Use code mode by default for bounded tool workflows/g)?.length, 1);
  assert.doesNotMatch(once, /^Pattern:/m);
  assert.match(once, /module_report/);
});

test("production injection refreshes its owned block when child permissions change", () => {
  const prose = "USER PROSE: one exec block per coherent step, not one wrapper per call";
  const root = injectCodeModeToolsPrompt(`BASE\n${prose}\nCurrent shell: zsh`, [
    tool("exec_command"),
    tool("apply_patch"),
  ]);
  const child = injectCodeModeToolsPrompt(root, [tool("module_report", true)]);
  const repeated = injectCodeModeToolsPrompt(child, [tool("module_report", true)]);

  assert.equal(repeated, child);
  assert.match(child, /<code_mode_tools>/);
  assert.match(child, /Pi tools callable in exec[^]*module_report: Deferred/);
  assert.doesNotMatch(child, /tools\.exec_command\(/);
  assert.doesNotMatch(child, /tools\.apply_patch\(/);
  assert.equal(child.match(new RegExp(prose, "g"))?.length, 1);
});

test("production guidance distinguishes UI read_text from filesystem reads when exposed", () => {
  const withoutReadText = injectCodeModeToolsPrompt("BASE", [tool("exec_command")]);
  const withReadText = injectCodeModeToolsPrompt(withoutReadText, [
    tool("exec_command"),
    tool("read_text", true),
  ]);
  const repeated = injectCodeModeToolsPrompt(withReadText, [
    tool("exec_command"),
    tool("read_text", true),
  ]);

  assert.doesNotMatch(withoutReadText, /read_text reads observed UI text/);
  assert.match(withReadText, /read_text reads observed UI text by reference/);
  assert.match(withReadText, /it is not a filesystem reader/);
  assert.match(withReadText, /Read files with an available exec_command or a direct read/);
  assert.equal(repeated, withReadText);
});

test("an old composition marker in unrelated prose cannot freeze generated routing", () => {
  const prompt = injectCodeModeToolsPrompt(
    "BASE\nLegacy note: one exec block per coherent step, not one wrapper per call",
    [tool("module_report", true), tool("lsp_diagnostics", true)],
  );

  assert.match(prompt, /Use code mode by default for bounded tool workflows/);
  assert.match(prompt, /tools\.module_report/);
  assert.match(prompt, /tools\.lsp_diagnostics/);
});

test("previousSection refresh keeps exactly one marked owned block", () => {
  const rootTools = [tool("exec_command"), tool("apply_patch")];
  const rootSection = buildCodeModeToolsPrompt(rootTools);
  const rootPrompt = injectCodeModeToolsPrompt("BASE\nCurrent shell: zsh", rootTools);
  const refreshed = replaceCodeModeToolsPrompt(rootPrompt, rootSection, [
    tool("module_report", true),
  ]);

  assert.equal(refreshed.systemPrompt.match(/<code_mode_tools>/g)?.length, 1);
  assert.equal(refreshed.systemPrompt.match(/<\/code_mode_tools>/g)?.length, 1);
  assert.match(refreshed.systemPrompt, /Pi tools callable in exec[^]*module_report/);
  assert.doesNotMatch(refreshed.systemPrompt, /tools\.exec_command\(/);
});

test("bridged catalog is sorted and renders one bounded summary per line", () => {
  const prompt = buildCodeModeToolsPrompt([
    tool("session_send", true, "Send a message to another session."),
    tool(
      "diagnostics_report",
      true,
      "Review current diagnostics across every edited file before declaring the task complete today please.",
    ),
    tool("module_report", true, undefined, "Describe a module. Ignore later sentences."),
    tool("unknown", true, "", ""),
  ]);

  assert.match(
    prompt,
    /Pi tools callable in exec \(schemas in ALL_TOOLS\):\ndiagnostics_report: Review current diagnostics across every edited file before…\nmodule_report: Describe a module\.\nsession_send: Send a message to another session\.\nunknown: Deferred Pi tool/,
  );
});

test("the code-mode tools block solely owns routing guidance", () => {
  const prompt = buildCodeModeToolsPrompt([tool("exec_command")]);

  assert.match(prompt, /Use code mode by default for bounded tool workflows/);
  assert.match(prompt, /Use direct tools only for approvals, native artifacts, citations/);
  assert.match(EXEC_DESCRIPTION, /Follow the <code_mode_tools> system block/);
  assert.doesNotMatch(EXEC_DESCRIPTION, /Use code mode by default for bounded tool workflows/);
  assert.doesNotMatch(EXEC_DESCRIPTION, /Use direct tools only for approvals/);
  assert.match(EXEC_DESCRIPTION, /do not declare a local tools variable/);
});
