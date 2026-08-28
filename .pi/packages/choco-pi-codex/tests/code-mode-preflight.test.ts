import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSyntheticSourceInfo,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExecutePatchError } from "../src/patch/types.ts";
import { prepareCodeModeApplyPatchInput } from "../src/tools/apply-patch/code-mode-input.ts";
import { enrichApplyPatchContextFailure } from "../src/tools/apply-patch/context-preflight.ts";
import { executeApplyPatch } from "../src/tools/apply-patch/execute.ts";
import { enhanceCodeModeNestedToolError } from "../src/tools/code-mode/nested-tool-errors.ts";
import { collectBridgedTools } from "../src/tools/code-mode/registered-tool-bridge.ts";
import { preflightCodeModeSource } from "../src/tools/code-mode/source-preflight.ts";

const RESTRICTED = {
  mode: "code" as const,
  availableToolNames: ["apply_patch", "exec_command", "get_subagent_results", "text"],
  outsideToolNames: ["get_subagent_result", "read", "edit", "observe_ui"],
};

function messageFromThrown(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected function to throw");
}

test("restricted source preflight names unavailable globals and the notebook alternative", () => {
  const deno = messageFromThrown(() => preflightCodeModeSource("Deno.cwd();", RESTRICTED));
  assert.match(deno, /\[unsupported_global\]/);
  assert.match(deno, /Deno is not available in restricted code mode/);
  assert.match(deno, /notebook cells DO have Deno/);

  const consoleError = messageFromThrown(() =>
    preflightCodeModeSource("console.log('x');", RESTRICTED),
  );
  assert.match(consoleError, /console is not available in restricted code mode/);
  assert.match(consoleError, /use text\(\)\/notify\(\)/);
});

test("source strings and notebook console use do not trigger restricted-global preflight", () => {
  assert.doesNotThrow(() =>
    preflightCodeModeSource(
      'text("Deno console process window tools.get_subagent_result"); // Deno\nconst pattern = /Deno/;',
      RESTRICTED,
    ),
  );
  assert.doesNotThrow(() =>
    preflightCodeModeSource("console.log(Deno.cwd());", {
      ...RESTRICTED,
      mode: "notebook",
    }),
  );
  assert.doesNotThrow(() =>
    preflightCodeModeSource(
      "const Deno = { cwd() { return '.'; } }; const obj = { tools: { missing() {} } }; obj.tools.missing(); text(Deno.cwd());",
      RESTRICTED,
    ),
  );
  assert.match(
    messageFromThrown(() =>
      preflightCodeModeSource("function path(value = Deno.cwd()) { return value; }", RESTRICTED),
    ),
    /Deno is not available/,
  );
});

test("real unbridged and guarded tool references are left to runtime", () => {
  assert.doesNotThrow(() =>
    preflightCodeModeSource("await tools.get_subagent_result({agent_id: 'a'});", RESTRICTED),
  );
  assert.doesNotThrow(() =>
    preflightCodeModeSource(
      'if (ALL_TOOLS.some((tool) => tool.name === "module_report")) { await tools.module_report({path: "a"}); } else { await tools.exec_command({cmd: "ls"}); }',
      RESTRICTED,
    ),
  );
  assert.doesNotThrow(() =>
    preflightCodeModeSource("if (false) await tools.module_report({path: 'a'});", RESTRICTED),
  );
});

test("unconditional top-level tool typos report close matches", () => {
  const message = messageFromThrown(() =>
    preflightCodeModeSource("await tools.get_subagent_reslt({agent_id: 'a'});", RESTRICTED),
  );
  assert.match(message, /\[unknown_tool\]/);
  assert.match(message, /unconditional top-level reference/);
  assert.match(message, /get_subagent_result/);
  assert.match(message, /Outside code mode: no/);
});

test("destructuring, method shorthand, and class fields are valid local bindings", () => {
  for (const source of [
    'const { document } = await tools.read({path:"a"}); text(String(document));',
    "const [process] = [1]; text(String(process));",
    "for (const { location } of []) { text(String(location)); }",
    "const o = { process() { return 1; } }; text(String(o.process()));",
    "class A { process = 1; } text(String(new A().process));",
  ]) {
    assert.doesNotThrow(() => preflightCodeModeSource(source, RESTRICTED), source);
  }
});

test("malformed template interpolation gets a source-level syntax correction", () => {
  const message = messageFromThrown(() =>
    preflightCodeModeSource("const value = String.raw`unterminated;", RESTRICTED),
  );
  assert.match(message, /\[invalid_javascript\]/);
  assert.match(message, /nested backticks\/template interpolation/);
  assert.match(message, /String\.raw/);
});

test("expected failing shell commands remain legitimate source", () => {
  assert.doesNotThrow(() =>
    preflightCodeModeSource(
      'const result = await tools.exec_command({cmd: "exit 17"}); text(result.exit_code);',
      RESTRICTED,
    ),
  );
});

test("code-mode apply_patch rejects object arguments with the exact call shape", () => {
  const message = messageFromThrown(() =>
    prepareCodeModeApplyPatchInput({ input: "*** Begin Patch\n*** End Patch" }),
  );
  assert.match(message, /\[invalid_arguments\]/);
  assert.match(message, /accepts one patch string, not an object/);
  assert.match(message, /await tools\.apply_patch\(patch\)/);
  assert.deepEqual(prepareCodeModeApplyPatchInput("patch"), { input: "patch" });
});

test("bridged read errors include current EOF and an exact tail re-read", () => {
  const enhanced = enhanceCodeModeNestedToolError(
    "read",
    { path: "src/example.ts", offset: 260, limit: 40 },
    new Error("Offset 260 is beyond end of file (175 lines total)"),
    "/tmp",
  );
  assert.match(enhanced.message, /\[read_offset_beyond_eof\]/);
  assert.match(enhanced.message, /Current line count: 175/);
  assert.match(enhanced.message, /"offset":136,"limit":40/);
});

test("the registered-tool bridge applies focused read-offset errors", async () => {
  const definition: ToolDefinition = {
    name: "read",
    label: "read",
    description: "read",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }),
    async execute() {
      throw new Error("Offset 260 is beyond end of file (175 lines total)");
    },
  };
  const [readTool] = collectBridgedTools({
    getAllRegisteredTools: () => [
      { definition, sourceInfo: createSyntheticSourceInfo("test", { source: "test" }) },
    ],
  });
  assert.ok(readTool);
  // SAFETY: The fake tool ignores ExtensionContext; the bridge only requires a present context.
  const extensionContext = {} as ExtensionContext;
  await assert.rejects(
    readTool.invoke(
      { path: "src/example.ts", offset: 260 },
      { cwd: "/tmp", extensionContext },
      new AbortController().signal,
    ),
    (error: Error) => {
      assert.match(error.message, /\[read_offset_beyond_eof\]/);
      assert.match(error.message, /Current line count: 175/);
      return true;
    },
  );
});

test("bridged stale edits include candidate ranges and focused reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-preflight-edit-"));
  try {
    writeFileSync(join(directory, "sample.txt"), "header\nanchor\ncurrent\nanchor\nfooter\n");
    const enhanced = enhanceCodeModeNestedToolError(
      "edit",
      {
        path: "sample.txt",
        edits: [{ oldText: "anchor\nstale", newText: "replacement" }],
      },
      new Error("RETRYABLE — File modified since read"),
      directory,
    );
    assert.match(enhanced.message, /\[stale_edit\]/);
    assert.match(enhanced.message, /Current line count: 5/);
    assert.match(enhanced.message, /Candidate ranges: 2-3, 4-5/);
    assert.match(enhanced.message, /await tools\.read\(/);
    assert.match(enhanced.message, /Re-read current contents and rebuild oldText/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridged ambiguous edits require multiple exact oldText matches", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ambiguous-edit-"));
  try {
    writeFileSync(
      join(directory, "sample.txt"),
      "header\nanchor\ncurrent\nanchor\ncurrent\nfooter\n",
    );
    const enhanced = enhanceCodeModeNestedToolError(
      "edit",
      {
        path: "sample.txt",
        edits: [{ oldText: "anchor\ncurrent", newText: "replacement" }],
      },
      new Error("oldText must be unique"),
      directory,
    );
    assert.match(enhanced.message, /\[ambiguous_edit\]/);
    assert.match(enhanced.message, /Candidate ranges: 2-3, 4-5/);
    assert.match(enhanced.message, /select exactly one oldText range/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing UI observation state becomes a focused prerequisite error", () => {
  const enhanced = enhanceCodeModeNestedToolError(
    "inspect_ui",
    {},
    new Error("No observation state is available; call observe_ui first"),
    "/tmp",
  );
  assert.match(enhanced.message, /\[observation_required\]/);
  assert.match(enhanced.message, /await tools\.observe_ui\(\{\}\)/);
  assert.match(enhanced.message, /retry the original tool call/);
});

test("repeated and anchored apply_patch context remains authoritative to the applier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-authoritative-patch-"));
  const path = join(directory, "sample.txt");
  const original = "alpha\nsame\nomega\ngap\nalpha\nsame\nomega\n";
  try {
    writeFileSync(path, original);
    const repeated = [
      "*** Begin Patch",
      "*** Update File: sample.txt",
      "@@",
      " alpha",
      " same",
      "-omega",
      "+changed",
      "*** End Patch",
    ].join("\n");
    await executeApplyPatch("repeated-context", repeated, directory, undefined, undefined);
    assert.equal(readFileSync(path, "utf8"), "alpha\nsame\nchanged\ngap\nalpha\nsame\nomega\n");

    writeFileSync(path, original);
    const anchored = repeated.replace("@@", "@@ gap");
    await executeApplyPatch("anchored-context", anchored, directory, undefined, undefined);
    assert.equal(readFileSync(path, "utf8"), "alpha\nsame\nomega\ngap\nalpha\nsame\nchanged\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("multiple exact failed-context matches are labeled ambiguous", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ambiguous-patch-"));
  try {
    writeFileSync(join(directory, "sample.txt"), "alpha\nsame\nomega\ngap\nalpha\nsame\nomega\n");
    const action = {
      type: "update" as const,
      path: "sample.txt",
      lines: ["@@", " alpha", " same", "-omega", "+changed"],
    };
    const error = new ExecutePatchError(
      "Failed to find expected lines",
      { changedFiles: [], createdFiles: [], deletedFiles: [], movedFiles: [], fuzz: 0 },
      [{ action, message: "Failed to find expected lines" }],
    );
    const message = enrichApplyPatchContextFailure(error, directory);
    assert.match(message ?? "", /apply_patch context \[ambiguous_context\]/);
    assert.match(message ?? "", /Candidate ranges: 1-3, 5-7/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applier failures add anchored stale-context ranges and exact re-read windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-stale-patch-"));
  try {
    writeFileSync(join(directory, "sample.txt"), "target\ncurrent\nanchor\ntarget\ncurrent\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: sample.txt",
      "@@ anchor",
      " target",
      "-stale",
      "+replacement",
      "*** End Patch",
    ].join("\n");
    await assert.rejects(
      executeApplyPatch("stale-context", patch, directory, undefined, undefined),
      (error: Error) => {
        assert.match(error.message, /apply_patch context \[stale_context\]/);
        assert.match(error.message, /Current line count: 5/);
        assert.match(error.message, /Candidate ranges: 4-5/);
        assert.match(error.message, /path: "sample\.txt"; offset: 1; limit: 5/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
