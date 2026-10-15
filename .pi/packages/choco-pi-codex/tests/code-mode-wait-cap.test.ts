import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS,
  MAX_CODE_MODE_WAIT_MS,
  MAX_EXEC_YIELD_TIME_MS,
  clampExecYieldTime,
  clampWriteYieldTime,
} from "../src/tools/exec/shell.ts";
import { buildCodeModeToolsPrompt } from "../src/tools/code-mode/custom-tool-prompt.ts";

test("every code-mode wait clamps to five minutes", () => {
  assert.equal(MAX_CODE_MODE_WAIT_MS, 300_000);
  assert.equal(MAX_EXEC_YIELD_TIME_MS, MAX_CODE_MODE_WAIT_MS);
  assert.equal(DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS, MAX_CODE_MODE_WAIT_MS);
  assert.equal(clampExecYieldTime(1_800_000, 10_000, false, 5_000), MAX_CODE_MODE_WAIT_MS);
  assert.equal(clampExecYieldTime(1_800_000, 10_000, true, 5_000), MAX_CODE_MODE_WAIT_MS);
  assert.equal(
    clampWriteYieldTime(1_800_000, 250, true, 30_000, DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS),
    MAX_CODE_MODE_WAIT_MS,
  );
});

test("code-mode guidance routes longer work to managed shells", () => {
  const prompt = buildCodeModeToolsPrompt([]);
  assert.match(prompt, /No code-mode wait exceeds 5 minutes/u);
  assert.match(prompt, /shell_start/u);
});
