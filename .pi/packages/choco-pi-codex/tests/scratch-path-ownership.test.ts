import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  registerScratchRoot,
  scratchDirFor,
  unregisterScratchRoot,
} from "../../../extensions/lib/scratch-path.ts";
import { createExecCommandTracker } from "../src/tools/exec/command-state.ts";
import { createExecCommandTool } from "../src/tools/exec/command-tool.ts";
import { createLazyExecSessionManager } from "../src/tools/exec/lazy-session-manager.ts";
import { registerCodeModePreflightBroker } from "../src/tools/code-mode/nested-tool-preflight.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

async function runPrintf(
  sessions: ReturnType<typeof createLazyExecSessionManager>,
  sessionManager: SessionManager,
): Promise<string> {
  const tool = createExecCommandTool(createExecCommandTracker(), sessions);
  const ctx = createToolContextFixture({ cwd: tmpdir(), sessionManager });
  const result = await tool.execute(
    "call",
    {
      description: "Print scratch environment",
      cmd: 'printf "%s|%s|%s" "$PI_ROOT_SESSION_ID" "$PI_SCRATCH_DIR" "$PI_SESSION_ID"',
      yield_time_ms: 10_000,
    },
    undefined,
    undefined,
    ctx,
  );
  const content = result.content[0];
  assert.ok(content?.type === "text");
  return content.text;
}

test("exec_command exports the lineage root and scratch directory, a child keeping its parent's", async () => {
  const inheritedRoot = process.env["PI_ROOT_SESSION_ID"];
  const inheritedDir = process.env["PI_SCRATCH_DIR"];
  delete process.env["PI_ROOT_SESSION_ID"];
  delete process.env["PI_SCRATCH_DIR"];
  const sessions = createLazyExecSessionManager({ env: { ...process.env } });
  const root = SessionManager.inMemory(tmpdir());
  const child = SessionManager.inMemory(tmpdir());
  registerScratchRoot(child.getSessionId(), root.getSessionId());
  try {
    const rootOutput = await runPrintf(sessions, root);
    assert.ok(
      rootOutput.includes(
        `${root.getSessionId()}|${scratchDirFor(root.getSessionId())}|${root.getSessionId()}`,
      ),
      rootOutput,
    );
    const childOutput = await runPrintf(sessions, child);
    assert.ok(
      childOutput.includes(
        `${root.getSessionId()}|${scratchDirFor(root.getSessionId())}|${child.getSessionId()}`,
      ),
      childOutput,
    );
  } finally {
    unregisterScratchRoot(child.getSessionId());
    await sessions.shutdown();
    if (inheritedRoot !== undefined) process.env["PI_ROOT_SESSION_ID"] = inheritedRoot;
    if (inheritedDir !== undefined) process.env["PI_SCRATCH_DIR"] = inheritedDir;
  }
});

test("exec_command keeps an inherited PI_ROOT_SESSION_ID", async () => {
  const previousRoot = process.env["PI_ROOT_SESSION_ID"];
  delete process.env["PI_SCRATCH_DIR"];
  process.env["PI_ROOT_SESSION_ID"] = "inherited-root";
  const sessions = createLazyExecSessionManager({ env: { ...process.env } });
  try {
    const output = await runPrintf(sessions, SessionManager.inMemory(tmpdir()));
    assert.ok(output.includes("inherited-root|/tmp/choco-pi/inherited-root/|"), output);
  } finally {
    if (previousRoot === undefined) delete process.env["PI_ROOT_SESSION_ID"];
    else process.env["PI_ROOT_SESSION_ID"] = previousRoot;
    await sessions.shutdown();
  }
});

test("code-mode nested preflight warns about /tmp paths outside scratch without blocking", async () => {
  let run: ReturnType<typeof registerCodeModePreflightBroker>["run"] | undefined;
  const { session, ctx } = await createSdkFixture(undefined, [
    (pi) => {
      run = registerCodeModePreflightBroker(pi).run;
    },
  ]);
  try {
    assert.ok(run);
    const scratchDir = scratchDirFor(ctx.sessionManager.getSessionId());
    const call = (toolName: string, input: Record<string, string>) =>
      run?.({
        toolName,
        input,
        toolCallId: "tc",
        cwd: process.cwd(),
        extensionContext: ctx,
        signal: new AbortController().signal,
      });
    assert.deepEqual(await call("write", { path: `${scratchDir}ok.txt` }), []);
    assert.deepEqual(await call("write", { path: "relative/ok.txt" }), []);
    assert.deepEqual(await call("write", { path: "/tmp/scratch-stray/a.txt" }), [
      `Scratch path warning: /tmp/scratch-stray/a.txt is outside this session's scratch directory ${scratchDir}. Use ${scratchDir} for temporary files unless the user granted this path.`,
    ]);
    assert.deepEqual(await call("write", { path: "/tmp/scratch-stray/b.txt" }), []);
    assert.equal((await call("edit", { path: "/private/tmp/scratch-stray/b.txt" }))?.length, 1);
  } finally {
    session.dispose();
  }
});
