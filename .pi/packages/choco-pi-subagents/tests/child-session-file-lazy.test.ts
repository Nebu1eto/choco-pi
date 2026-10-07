import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { registerAgents } from "../src/agent-types.ts";
import { runAgent } from "../src/agent-runner.ts";
import { unregisterChildSessionId } from "../src/child-context.ts";
import type { AgentConfig } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const SessionHeaderSchema = Type.Object({
  type: Type.Literal("session"),
  parentSession: Type.Optional(Type.String()),
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function persistedConfig(sessionDir: string): AgentConfig {
  return {
    name: "lazy-session-probe",
    description: "lazy session file probe",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "lazy session probe",
    promptMode: "replace",
    persistSession: true,
    sessionDir,
  };
}

// Pi 1.0.4 writes a session file only once it holds a user or assistant
// message. runAgent's persisted child (agent-runner.ts, SessionManager.create
// with the parent's possibly unwritten session file as `parentSession`) must
// construct, name, and bind such a session without the file existing, and the
// first user message must materialize it with the parent link intact.
test("runAgent tolerates a persisted child session whose file is created lazily", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "choco-pi-lazy-session-"));
  const fixture = await createSdkFixture();
  const config = persistedConfig(sessionDir);
  registerAgents(new Map([[config.name, config]]));
  const controller = new AbortController();
  // Aborted before the prompt: runAgent builds and binds the session, then skips
  // session.prompt, so only setup entries (session name and model/thinking
  // state) reach the session manager.
  controller.abort();
  const childSessionIds: string[] = [];
  try {
    const result = await runAgent(fixture.ctx, config.name, "probe", {
      pi: fixture.pi,
      agentId: "lazyagent01",
      signal: controller.signal,
    });
    const child = result.session;
    childSessionIds.push(child.sessionManager.getSessionId());
    try {
      assert.equal(child.sessionManager.isPersisted(), true);
      const sessionFile = child.sessionManager.getSessionFile();
      assert.ok(sessionFile, "a persisted child reports its eventual session file path");
      assert.equal(sessionFile.startsWith(sessionDir), true);
      assert.equal(child.sessionManager.getSessionName(), "lazy-session-probe#lazyagen");
      assert.equal(
        await exists(sessionFile),
        false,
        "setup-only entries must not create the session file",
      );

      child.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first message" }],
        timestamp: Date.now(),
      });
      assert.equal(await exists(sessionFile), true, "the first user message creates the file");
      const [headerLine] = (await readFile(sessionFile, "utf8")).split("\n");
      assert.ok(headerLine);
      const header: unknown = JSON.parse(headerLine);
      assert.ok(Value.Check(SessionHeaderSchema, header), "the file starts with a session header");
      assert.equal(header.parentSession, fixture.ctx.sessionManager.getSessionFile());
    } finally {
      child.dispose();
    }

    // A child that never received a message leaves a path with no file behind.
    // Reopening that path (the resume route) must start cleanly instead of failing.
    const neverWritten = join(sessionDir, "never-written.jsonl");
    const resumed = await runAgent(fixture.ctx, config.name, "probe", {
      pi: fixture.pi,
      signal: controller.signal,
      resumeSessionFile: neverWritten,
    });
    childSessionIds.push(resumed.session.sessionManager.getSessionId());
    try {
      assert.equal(resumed.session.sessionManager.getSessionFile(), neverWritten);
      assert.equal(await exists(neverWritten), false);
    } finally {
      resumed.session.dispose();
    }
  } finally {
    for (const id of childSessionIds) unregisterChildSessionId(id);
    registerAgents(new Map());
    fixture.session.dispose();
    await rm(sessionDir, { recursive: true, force: true });
  }
});
