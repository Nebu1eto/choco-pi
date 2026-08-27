import assert from "node:assert/strict";
import test from "node:test";
import { HOOK_EVENTS, matcherValue, matches, matchesIf } from "../src/index.ts";
import type { HookInput } from "../src/types.ts";

const base = (event: HookInput["hook_event_name"], extra = {}): HookInput => ({
  session_id: "s",
  transcript_path: "/t",
  cwd: "/p",
  hook_event_name: event,
  ...extra,
});

test("exports every documented Claude Code hook event", () => {
  assert.equal(HOOK_EVENTS.length, 31);
  assert.deepEqual(HOOK_EVENTS.slice(0, 5), [
    "SessionStart",
    "Setup",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "PreToolUse",
  ]);
  assert.equal(HOOK_EVENTS.at(-1), "SessionEnd");
});

test("exact, comma, pipe, regex, wildcard, and unsupported matcher behavior", () => {
  assert.equal(matches("PreToolUse", "Bash", { tool_name: "Bash" }), true);
  assert.equal(matches("PreToolUse", "Edit, Write", { tool_name: "Write" }), true);
  assert.equal(matches("PreToolUse", "Edit|Write", { tool_name: "Read" }), false);
  assert.equal(matches("PreToolUse", "mcp__.*", { tool_name: "mcp__memory__read" }), true);
  assert.equal(matches("PreToolUse", "*", { tool_name: "Anything" }), true);
  assert.equal(matches("Stop", "never", {}), true);
});

test("FileChanged uses literal basename matching and narrow separators", () => {
  assert.equal(matcherValue("FileChanged", { file_path: "C:\\repo\\.env" }), ".env");
  assert.equal(matches("FileChanged", ".envrc|.env", { file_path: "/repo/.env" }), true);
  assert.equal(matches("FileChanged", "^\\.env", { file_path: "/repo/.env" }), true);
});

test("if filters tool events by tool and argument", () => {
  assert.equal(
    matchesIf(
      "Bash(git *)",
      "PreToolUse",
      base("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test && git push" } }),
    ),
    true,
  );
  assert.equal(
    matchesIf(
      "Edit(*.ts)",
      "PreToolUse",
      base("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "main.ts" } }),
    ),
    true,
  );
  assert.equal(matchesIf("Bash(git *)", "Stop", base("Stop")), false);
});
