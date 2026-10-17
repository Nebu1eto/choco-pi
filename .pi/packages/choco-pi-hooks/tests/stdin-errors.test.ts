import assert from "node:assert/strict";
import childProcess, { type spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { executeHandler } from "../src/executor.ts";
import type { HookInput } from "../src/types.ts";

const input: HookInput = {
  session_id: "stdin-errors",
  transcript_path: "/t",
  cwd: process.cwd(),
  hook_event_name: "PostToolUse",
  tool_response: "画像".repeat(600_000),
};

test("large hook payloads tolerate a child exiting without reading stdin", async () => {
  const result = await executeHandler(
    { type: "command", command: "sh", args: ["-c", "exit 0"] },
    input,
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
});

test("a reading child receives the entire large UTF-8 hook payload", async () => {
  const result = await executeHandler(
    { type: "command", command: "sh", args: ["-c", "wc -c"] },
    input,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(Number(result.stdout.trim()), Buffer.byteLength(JSON.stringify(input)));
});

test("unexpected stdin errors are reported once without replacing the child exit code", async (t) => {
  const originalSpawn = childProcess.spawn;
  const error = Object.assign(new Error("injected stdin failure"), { code: "EIO" });
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    child.stdin?.destroy(error);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await executeHandler(
    { type: "command", command: "sh", args: ["-c", "exit 0"] },
    input,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Hook stdin: injected stdin failure\n");
});
test("a child that closed its stdin socket (ENOTCONN) is not reported as a stdin failure", async (t) => {
  const originalSpawn = childProcess.spawn;
  const error = Object.assign(new Error("write ENOTCONN"), { code: "ENOTCONN" });
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    child.stdin?.destroy(error);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await executeHandler(
    { type: "command", command: "sh", args: ["-c", "exit 0"] },
    input,
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
});
