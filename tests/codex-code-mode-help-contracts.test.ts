import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildCodeModeToolsPrompt,
  EXEC_DESCRIPTION,
  injectCodeModeToolsPrompt,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/custom-tool-prompt.ts";
import { codeModeHostBinaryPath } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/binary.ts";
import { CodeModeHostClient } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/host-client.ts";
import { unavailableToolsGuardPreamble } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/tools-namespace.ts";

const CONTRACT_SENTENCES = [
  "notify(value) rejects empty or whitespace-only text; guard before calling.",
  "Only exposed tools are callable via tools.<name>; direct-only Pi tools must be called outside exec.",
];

test("compact prompt and exec description share the enforced contracts exactly once", () => {
  const prompt = injectCodeModeToolsPrompt("System prompt", []);
  assert.match(prompt, /<code_mode_tools>/);
  for (const help of [EXEC_DESCRIPTION, buildCodeModeToolsPrompt([]), prompt]) {
    for (const sentence of CONTRACT_SENTENCES) {
      assert.equal(help.split(sentence).length - 1, 1);
    }
  }
  assert.match(
    EXEC_DESCRIPTION,
    /text\(value\) and notify\(value\) EMIT output and return nothing/,
  );
});

test("direct-only Pi tools are rejected while exposed tools remain callable", () => {
  const guard = unavailableToolsGuardPreamble(["module_report"], ["Agent"]);
  const context = {
    tools: { module_report: () => "exposed" },
  };
  assert.equal(runInNewContext(`${guard} tools.module_report()`, context), "exposed");
  assert.throws(
    () => runInNewContext("tools.Agent({})", context),
    /Outside code mode: yes — Agent is registered as a direct Pi tool/,
  );
});

test("host notification validation and emitter return values agree with the help", async () => {
  const client = new CodeModeHostClient({ binary: codeModeHostBinaryPath(), tools: [] });
  const context = { cwd: process.cwd(), toolCallId: "help-contract-test" };
  try {
    for (const source of ['notify("")', 'notify(" \\t\\n")']) {
      const result = await client.execute(source, context);
      assert.ok(result.kind === "result");
      assert.equal(result.errorText, "notify expects non-empty text");
    }
    const result = await client.execute(
      'const textReturn = text("text emitted"); const notifyReturn = notify("notification emitted"); text(JSON.stringify({textReturnsNothing: textReturn === undefined, notifyReturnsNothing: notifyReturn === undefined}))',
      context,
    );
    assert.ok(result.kind === "result");
    assert.equal(result.errorText, undefined);
    assert.deepEqual(
      result.contentItems
        .filter((item) => item.type === "input_text")
        .map((item) => item.text)
        .sort(),
      [
        "notification emitted",
        "text emitted",
        '{"textReturnsNothing":true,"notifyReturnsNothing":true}',
      ].sort(),
    );
  } finally {
    await client.shutdown();
  }
});
