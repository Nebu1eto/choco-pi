import assert from "node:assert/strict";
import test from "node:test";
import { HookEngine } from "../src/index.ts";
import type { HookInput, HookSource, RawExecution } from "../src/index.ts";

const input = (toolUseId: string): HookInput => ({
  session_id: "s",
  transcript_path: "/tmp/t",
  cwd: process.cwd(),
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_use_id: toolUseId,
});

const skillSource: HookSource = {
  id: "skill",
  kind: "skill",
  hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "x", once: true }] }] },
};

test("overlapping runs execute a once skill hook at most once", async () => {
  let calls = 0;
  const engine = new HookEngine([skillSource], {
    command: async (): Promise<RawExecution> => {
      calls++;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await Promise.all([engine.run(input("a")), engine.run(input("b"))]);
  await engine.run(input("c"));
  assert.equal(calls, 1);
});

test("a once skill hook whose overlapped run failed runs again later", async () => {
  let calls = 0;
  const engine = new HookEngine([skillSource], {
    command: async (): Promise<RawExecution> => {
      calls++;
      return calls === 1
        ? { exitCode: 1, stdout: "", stderr: "failed" }
        : { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await Promise.all([engine.run(input("a")), engine.run(input("b"))]);
  assert.equal(calls, 1);
  await engine.run(input("c"));
  await engine.run(input("d"));
  assert.equal(calls, 2);
});
