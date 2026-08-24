import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  activeRegisteredSessionToolNames,
  scopeCodeModeToolsToSessionPermissions,
  type SessionToolSource,
} from "../src/adapter/code-mode/session-tool-permissions.ts";
import { unavailableToolsGuardPreamble } from "../src/tools/code-mode/tools-namespace.ts";

const CODE_MODE_TOOL_NAMES = [
  "apply_patch",
  "exec_command",
  "write_stdin",
  "view_image",
  "symbol_search",
  "module_report",
  "read_symbol",
  "read_enclosing",
  "lsp_diagnostics",
  "diagnostics_report",
  "project_report",
];

function makeToolSource(
  activeTools: string[],
  registeredTools: string[] = CODE_MODE_TOOL_NAMES,
): SessionToolSource {
  return {
    getActiveTools: () => activeTools,
    getAllTools: () => registeredTools.map((name) => ({ name })),
  };
}

function scopedCodeModeToolNames(activeToolNames: ReadonlySet<string>): string[] {
  return scopeCodeModeToolsToSessionPermissions(
    CODE_MODE_TOOL_NAMES.map((name) => ({ name })),
    activeToolNames,
  ).map((tool) => tool.name);
}

test("native mutation tools follow the session permissions while bridged LSP tools survive", () => {
  const readOnlyNames = scopedCodeModeToolNames(new Set(["read", "bash"]));
  assert.ok(!readOnlyNames.includes("apply_patch"));
  assert.ok(readOnlyNames.includes("exec_command"));
  assert.ok(readOnlyNames.includes("write_stdin"));

  for (const lspTool of [
    "symbol_search",
    "module_report",
    "read_symbol",
    "read_enclosing",
    "lsp_diagnostics",
    "diagnostics_report",
    "project_report",
  ]) {
    assert.ok(readOnlyNames.includes(lspTool), lspTool + " survives read-only scoping");
  }

  for (const mutationTool of ["edit", "write"]) {
    const writableNames = scopedCodeModeToolNames(new Set([mutationTool, "bash"]));
    assert.ok(writableNames.includes("apply_patch"), mutationTool + " permits apply_patch");
  }
});

test("native shell tools require bash without removing bridged tools", () => {
  const names = scopedCodeModeToolNames(new Set(["read"]));
  assert.ok(!names.includes("exec_command"));
  assert.ok(!names.includes("write_stdin"));
  assert.ok(names.includes("module_report"));
  assert.ok(names.includes("lsp_diagnostics"));
});

test("session permissions use the registered pre-adapter tool selection", () => {
  const source = makeToolSource(
    ["exec", "wait", "module_report"],
    ["read", "bash", "edit", "write", "exec", "wait", "module_report"],
  );
  const names = activeRegisteredSessionToolNames(source, [
    "read",
    "bash",
    "edit",
    "write",
    "module_report",
    "unregistered_tool",
  ]);
  assert.deepEqual([...names], ["read", "bash", "edit", "write", "module_report"]);
});

test("the cell preamble explains unavailable tools namespace members", () => {
  const source = `${unavailableToolsGuardPreamble([
    "apply_patch",
    "exec_command",
    "write_stdin",
  ])}tools.module_report({ path: "src/index.ts" });`;

  assert.throws(
    () =>
      runInNewContext(source, {
        ALL_TOOLS: [],
        tools: {
          apply_patch() {},
          exec_command() {},
          write_stdin() {},
        },
      }),
    {
      message:
        '"module_report" is not available in code mode. Available tools: apply_patch, exec_command, write_stdin. If it exists as a regular tool, call it directly as a tool call outside exec.',
    },
  );
});
