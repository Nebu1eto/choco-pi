import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compile, lit, nullable, obj, opt, str } from "@earendil-works/pi-schema";

import { registerAgents } from "../src/agent-types.ts";
import { SUBAGENT_SESSION_MARKER, runAgent } from "../src/agent-runner.ts";
import { unregisterChildSessionId } from "../src/child-context.ts";
import type { AgentConfig } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const SessionHeaderSchema = obj(
  {
    type: lit("session"),
    parentSession: opt(str()),
  },
  { open: true },
);

const isSessionHeader = compile(SessionHeaderSchema).check;

const SubagentMarkerSchema = obj(
  {
    type: lit("custom"),
    customType: lit(SUBAGENT_SESSION_MARKER),
    data: obj(
      {
        schemaVersion: lit(1),
        agentId: nullable(str()),
        agentType: str(),
        parentSessionId: nullable(str()),
      },
      { open: true },
    ),
  },
  { open: true },
);

const isSubagentMarker = compile(SubagentMarkerSchema).check;

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

test("runAgent tolerates a persisted child session whose file is created lazily", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "choco-pi-lazy-session-"));
  const fixture = await createSdkFixture();
  const config = persistedConfig(sessionDir);
  registerAgents(new Map([[config.name, config]]));
  const controller = new AbortController();
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
      const lines = (await readFile(sessionFile, "utf8")).split("\n");
      const [headerLine] = lines;
      assert.ok(headerLine);
      const header: unknown = JSON.parse(headerLine);
      assert.ok(isSessionHeader(header), "the file starts with a session header");
      assert.equal(header.parentSession, fixture.ctx.sessionManager.getSessionFile());
      const markers = [];
      for (const line of lines) {
        if (!line.includes(SUBAGENT_SESSION_MARKER)) continue;
        const entry: unknown = JSON.parse(line);
        if (isSubagentMarker(entry)) markers.push(entry);
      }
      assert.equal(markers.length, 1, "exactly one subagent marker is written at spawn");
      assert.deepEqual(markers[0]?.data, {
        schemaVersion: 1,
        agentId: "lazyagent01",
        agentType: config.name,
        parentSessionId: fixture.ctx.sessionManager.getSessionId(),
      });
    } finally {
      child.dispose();
    }

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
