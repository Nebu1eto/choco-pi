import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MODEL_GUIDANCE_FILES = [
  "../src/index.ts",
  "../src/nested-tools.ts",
  "../src/result-read.ts",
  "../examples/agent-tool-description.md",
] as const;

test("model-facing result guidance never recommends awaiting an active agent by result read", () => {
  for (const relativePath of MODEL_GUIDANCE_FILES) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /(?:use|call|invoke)\s+get_subagent_result[^.\n]{0,100}wait:\s*true/i,
      `${relativePath} recommends an active get_subagent_result wait`,
    );
    assert.doesNotMatch(
      source,
      /wait:\s*true[^.\n]{0,100}(?:to wait|recommended way|await an active agent)/i,
      `${relativePath} presents wait: true as the way to await an active agent`,
    );
  }
});
