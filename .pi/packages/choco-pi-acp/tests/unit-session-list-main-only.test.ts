import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { PiAcpAgent } from "../src/acp/agent.ts";
import { listPiSessions } from "../src/acp/pi-sessions.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

function encodedProjectDirectory(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]+/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

function writeSession(
  file: string,
  session: {
    id: string;
    cwd: string;
    timestamp: string;
    name?: string;
    parentSession?: string;
  },
): void {
  mkdirSync(dirname(file), { recursive: true });
  const header: SessionHeader = {
    type: "session",
    version: 3,
    id: session.id,
    timestamp: session.timestamp,
    cwd: session.cwd,
  };
  if (session.parentSession) header.parentSession = session.parentSession;
  const lines: unknown[] = [header];
  if (session.name) {
    lines.push({
      type: "session_info",
      id: `${session.id}-info`,
      parentId: null,
      timestamp: session.timestamp,
      name: session.name,
    });
  }
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

test("listPiSessions returns project main sessions only, newest first", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-list-main-"));
  const project = join(agentDir, "project");
  const otherProject = join(agentDir, "other");
  mkdirSync(project);
  mkdirSync(otherProject);
  const projectSessions = join(agentDir, "sessions", encodedProjectDirectory(project));
  const otherSessions = join(agentDir, "sessions", encodedProjectDirectory(otherProject));

  writeSession(join(projectSessions, "main.jsonl"), {
    id: "main",
    cwd: project,
    timestamp: "2026-01-01T00:00:01.000Z",
    name: "Main title",
  });
  writeSession(join(projectSessions, "continuation.jsonl"), {
    id: "continuation",
    cwd: project,
    timestamp: "2026-01-01T00:00:02.000Z",
    name: "Continuation title",
    parentSession: join(projectSessions, "main.jsonl"),
  });
  writeSession(join(projectSessions, "sidechain.jsonl"), {
    id: "sidechain",
    cwd: project,
    timestamp: "2026-01-01T00:00:03.000Z",
    name: "implementer#abc12",
    parentSession: join(projectSessions, "main.jsonl"),
  });
  writeSession(join(projectSessions, "nested", "nested.jsonl"), {
    id: "nested",
    cwd: project,
    timestamp: "2026-01-01T00:00:04.000Z",
    name: "Nested",
  });
  writeSession(join(otherSessions, "other.jsonl"), {
    id: "other",
    cwd: otherProject,
    timestamp: "2026-01-01T00:00:05.000Z",
    name: "Other project",
  });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.deepEqual(
      listPiSessions(project).map(({ sessionId, title, cwd }) => ({ sessionId, title, cwd })),
      [
        { sessionId: "continuation", title: "Continuation title", cwd: project },
        { sessionId: "main", title: "Main title", cwd: project },
      ],
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("listPiSessions matches real and symlinked project roots in both forms", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-list-link-"));
  const realProject = join(agentDir, "real-project");
  const linkedProject = join(agentDir, "linked-project");
  mkdirSync(realProject);
  symlinkSync(realProject, linkedProject, "dir");
  const projectSessions = join(agentDir, "sessions", encodedProjectDirectory(realProject));
  writeSession(join(projectSessions, "real-header.jsonl"), {
    id: "real-header",
    cwd: realProject,
    timestamp: "2026-01-01T00:00:02.000Z",
    name: "Real header",
  });
  writeSession(join(projectSessions, "link-header.jsonl"), {
    id: "link-header",
    cwd: linkedProject,
    timestamp: "2026-01-01T00:00:01.000Z",
    name: "Link header",
  });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.deepEqual(
      listPiSessions(linkedProject).map((session) => session.sessionId),
      ["real-header", "link-header"],
    );
    assert.deepEqual(
      listPiSessions(realProject).map((session) => session.sessionId),
      ["real-header", "link-header"],
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("listPiSessions rejects the same lexical project path when it is missing", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-list-missing-"));
  const missingProject = join(agentDir, "missing-project");
  const projectSessions = join(agentDir, "sessions", encodedProjectDirectory(missingProject));
  writeSession(join(projectSessions, "missing.jsonl"), {
    id: "missing",
    cwd: missingProject,
    timestamp: "2026-01-01T00:00:01.000Z",
    name: "Missing project",
  });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.deepEqual(listPiSessions(missingProject), []);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("PiAcpAgent paginates the filtered project session list", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-list-page-"));
  const project = join(agentDir, "project");
  mkdirSync(project);
  const projectSessions = join(agentDir, "sessions", encodedProjectDirectory(project));
  for (let index = 0; index < 51; index += 1) {
    writeSession(join(projectSessions, `${index}.jsonl`), {
      id: `session-${index}`,
      cwd: project,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      name: `Session ${index}`,
    });
  }

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
    const first = await agent.listSessions({ cwd: project, cursor: null });
    assert.equal(first.sessions.length, 50);
    assert.equal(first.nextCursor, "50");
    const second = await agent.listSessions({ cwd: project, cursor: first.nextCursor });
    assert.equal(second.sessions.length, 1);
    assert.equal(second.sessions[0]?.sessionId, "session-0");
    assert.equal(second.nextCursor, null);
    agent.dispose();
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
