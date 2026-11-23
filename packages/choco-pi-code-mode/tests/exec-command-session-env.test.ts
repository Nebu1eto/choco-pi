import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";

import { createExecCommandTracker } from "../src/tools/exec/command-state.ts";
import { createExecCommandTool } from "../src/tools/exec/command-tool.ts";
import { createLazyExecSessionManager } from "../src/tools/exec/lazy-session-manager.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

// Pi's bash tool exports the executing session's id to every child; exec_command
// must match it per call, never through process.env, which subagent sessions share.
test("exec_command exports the executing session's PI_SESSION_ID per call", async () => {
  const inheritedBefore = process.env["PI_SESSION_ID"];
  const sessions = createLazyExecSessionManager({
    env: { ...process.env, PI_SESSION_ID: "stale-construction" },
  });
  const tool = createExecCommandTool(createExecCommandTracker(), sessions);
  const run = async (sessionManager: SessionManager): Promise<string> => {
    const ctx = createToolContextFixture({ cwd: tmpdir(), sessionManager });
    const result = await tool.execute(
      "call",
      { cmd: 'printf %s "$PI_SESSION_ID"', yield_time_ms: 10_000 },
      undefined,
      undefined,
      ctx,
    );
    const content = result.content[0];
    assert.ok(content?.type === "text");
    return content.text;
  };
  try {
    const root = SessionManager.inMemory(tmpdir());
    const child = SessionManager.inMemory(tmpdir());
    assert.notEqual(root.getSessionId(), child.getSessionId());

    assert.ok((await run(root)).includes(root.getSessionId()));
    // A refreshed base env (session_start / config reload) cannot clobber it.
    sessions.setBaseEnv({ ...process.env, PI_SESSION_ID: "stale-refresh" });
    const childOutput = await run(child);
    assert.ok(childOutput.includes(child.getSessionId()));
    assert.doesNotMatch(childOutput, /stale-/);
    assert.equal(process.env["PI_SESSION_ID"], inheritedBefore);
  } finally {
    await sessions.shutdown();
  }
});

test("exec_command accepts descriptions over 60 characters and still rejects empty descriptions", () => {
  const tool = createExecCommandTool(createExecCommandTracker(), createLazyExecSessionManager());
  const longDescription =
    "Inspect workspace policy checks and verify every changed package compiles cleanly";
  assert.ok(longDescription.length > 60);
  const validated = validateToolArguments(
    { name: tool.name, description: tool.description, parameters: tool.parameters },
    {
      type: "toolCall",
      id: "call-long-desc",
      name: tool.name,
      arguments: { description: longDescription, cmd: "true" },
    },
  );
  assert.deepEqual(validated, { description: longDescription, cmd: "true" });
  assert.throws(
    () =>
      validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        {
          type: "toolCall",
          id: "call-empty-desc",
          name: tool.name,
          arguments: { description: "", cmd: "true" },
        },
      ),
    /minLength|at least 1|Validation failed/i,
  );
});
