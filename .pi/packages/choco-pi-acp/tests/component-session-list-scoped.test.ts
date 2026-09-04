import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpAgent } from "../src/acp/agent.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

interface AgentCwdState {
  lastSessionCwd: string;
}

function encodedProjectDirectory(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

test("PiAcpAgent: listSessions defaults to lastSessionCwd when cwd param is omitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-test-"));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);

  const dirA = join(root, "sessions", encodedProjectDirectory(projectA));
  const dirB = join(root, "sessions", encodedProjectDirectory(projectB));
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  writeFileSync(
    join(dirA, "1.jsonl"),
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-a",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: projectA,
    }) +
      "\n" +
      JSON.stringify({
        type: "session_info",
        id: "a1b2c3d4",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        name: "A",
      }) +
      "\n",
    { encoding: "utf8" },
  );

  writeFileSync(
    join(dirB, "2.jsonl"),
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-b",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: projectB,
    }) +
      "\n" +
      JSON.stringify({
        type: "session_info",
        id: "b1b2c3d4",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        name: "B",
      }) +
      "\n",
    { encoding: "utf8" },
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    // This test sets the agent's private cwd cache to a real project directory before listing.
    Object.assign(agent, { lastSessionCwd: projectA } satisfies AgentCwdState);

    const listed = await agent.listSessions({});
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.sessionId, "sess-a");
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
