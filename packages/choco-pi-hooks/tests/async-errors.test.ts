import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { HookEngine } from "../src/engine.ts";
import { executeHandler } from "../src/executor.ts";
import type { HookInput } from "../src/types.ts";

const input: HookInput = {
  session_id: "async-errors",
  transcript_path: "/t",
  cwd: process.cwd(),
  hook_event_name: "PostToolUse",
};

test("rejecting async result delivery is reported without an unhandled rejection", async (t) => {
  const reporter = t.mock.method(console, "error", () => undefined);
  const engine = new HookEngine(
    [
      {
        id: "test",
        kind: "project",
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "unused", async: true }] }] },
      },
    ],
    {
      command: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      onAsyncResult: async () => {
        throw new Error("delivery rejected");
      },
    },
  );
  const result = await engine.run(input);
  assert.equal(result.invocations[0]?.status, "background");
  await engine.waitForBackground();
  await setImmediate();
  assert.equal(reporter.mock.callCount(), 1);
  assert.deepEqual(reporter.mock.calls[0]?.arguments, ["Async hook failed:", "delivery rejected"]);
  await engine.waitForBackground();
});

test("rejected execution backends become hook failures", async () => {
  for (const type of ["command", "http"] as const) {
    const result = await executeHandler(
      type === "command" ? { type, command: "unused" } : { type, url: "http://unused.invalid" },
      input,
      {
        command: async () => {
          throw new Error("command rejected");
        },
        http: async () => {
          throw new Error("http rejected");
        },
      },
    );
    assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: `${type} rejected` });
  }
});
