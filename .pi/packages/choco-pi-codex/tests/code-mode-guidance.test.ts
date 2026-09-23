import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildCodeModeToolsPrompt,
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

test("root capabilities receive a shell example built from exec_command", () => {
  const prompt = buildCodeModeToolsPrompt([
    tool("exec_command"),
    tool("write_stdin"),
    tool("module_report", true),
    tool("lsp_diagnostics", true),
  ]);

  assert.match(
    prompt,
    /text\(await Promise\.all\(\[tools\.exec_command\(\{description:"List files"/,
  );
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
  assert.equal(once.match(/<code_mode_tools>/g)?.length, 1);
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
  assert.match(child, /^module_report: Deferred/m);
  assert.doesNotMatch(child, /tools\.exec_command\(/);
  assert.doesNotMatch(child, /tools\.apply_patch\(/);
  assert.equal(child.match(new RegExp(prose, "g"))?.length, 1);
});

test("guidance refreshes when read_text becomes available and stays idempotent", () => {
  const withoutReadText = injectCodeModeToolsPrompt("BASE", [tool("exec_command")]);
  const withReadText = injectCodeModeToolsPrompt(withoutReadText, [
    tool("exec_command"),
    tool("read_text", true),
  ]);
  const repeated = injectCodeModeToolsPrompt(withReadText, [
    tool("exec_command"),
    tool("read_text", true),
  ]);

  assert.doesNotMatch(withoutReadText, /read_text/);
  assert.match(withReadText, /^read_text: /m);
  assert.equal(withReadText.match(/<code_mode_tools>/g)?.length, 1);
  assert.equal(repeated, withReadText);
});

test("an old composition marker in unrelated prose cannot freeze generated routing", () => {
  const prompt = injectCodeModeToolsPrompt(
    "BASE\nLegacy note: one exec block per coherent step, not one wrapper per call",
    [tool("module_report", true), tool("lsp_diagnostics", true)],
  );

  assert.match(prompt, /<code_mode_tools>/);
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
  assert.match(refreshed.systemPrompt, /^module_report: /m);
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
    /\ndiagnostics_report: Review current diagnostics across every edited file before…\nmodule_report: Describe a module\.\nsession_send: Send a message to another session\.\nunknown: Deferred Pi tool/,
  );
});
