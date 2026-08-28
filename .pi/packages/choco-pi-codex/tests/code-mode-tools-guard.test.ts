import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";

import {
  activeRegisteredSessionToolNames,
  codeModeExecutionKindForPermissions,
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
    (error: Error) => {
      assert.match(error.message, /\[unavailable_tool\]/);
      assert.match(error.message, /tools\.module_report is not available in this cell/);
      assert.match(error.message, /Available tools: apply_patch, exec_command, write_stdin/);
      assert.match(error.message, /Close matches:/);
      assert.match(error.message, /Outside code mode: no/);
      return true;
    },
  );
});

test("the runtime guard leaves unavailable tools in untaken branches untouched", () => {
  let executed = false;
  const source = `${unavailableToolsGuardPreamble([
    "exec_command",
  ])}if (false) { tools.module_report({ path: "a" }); } else { tools.exec_command({ cmd: "ls" }); }`;
  runInNewContext(source, {
    tools: {
      exec_command() {
        executed = true;
      },
    },
  });
  assert.equal(executed, true);
});

test("the runtime guard identifies real tools registered only outside code mode", () => {
  const source = `${unavailableToolsGuardPreamble(
    ["exec_command"],
    ["get_subagent_result"],
  )}tools.get_subagent_result({ agent_id: "a" });`;
  assert.throws(
    () => runInNewContext(source, { tools: { exec_command() {} } }),
    (error: Error) => {
      assert.match(error.message, /\[unavailable_tool\]/);
      assert.match(error.message, /Outside code mode: yes/);
      assert.match(error.message, /get_subagent_result is registered as a direct Pi tool/);
      return true;
    },
  );
});

test("the namespace guard can be installed repeatedly in a persistent notebook context", () => {
  const context = createContext({ tools: { exec_command() {} } });
  const preamble = unavailableToolsGuardPreamble(["exec_command"]);
  assert.doesNotThrow(() => {
    runInContext(preamble, context);
    runInContext(preamble, context);
  });
});

test("a session without write or shell permissions cannot reach the notebook", () => {
  const readOnly = new Set(["read", "grep", "exec"]);
  const withShell = new Set(["read", "grep", "bash", "exec"]);
  const writable = new Set(["read", "edit", "write", "exec"]);

  // Notebook cells run on shared Deno globals, so `Deno.writeTextFile` would
  // reopen the write path that scoping the tools namespace just closed.
  assert.equal(codeModeExecutionKindForPermissions("notebook", readOnly), "code");
  assert.equal(codeModeExecutionKindForPermissions("notebook", withShell), "notebook");
  assert.equal(codeModeExecutionKindForPermissions("notebook", writable), "notebook");
  assert.equal(codeModeExecutionKindForPermissions("code", writable), "code");
});
