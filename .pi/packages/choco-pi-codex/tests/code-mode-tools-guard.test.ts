import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { unavailableToolsGuardPreamble } from "../src/tools/code-mode/tools-namespace.ts";

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
