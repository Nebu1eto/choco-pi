import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAcpAgent, type SessionStoreLike } from "../src/acp/agent.ts";
import type { StoredSession } from "../src/acp/session-store.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** A session index holding at most one entry and recording deletions. */
class RecordingSessionStore implements SessionStoreLike {
  readonly deletes: string[] = [];

  private readonly entry: StoredSession | null;

  constructor(entry: StoredSession | null) {
    this.entry = entry;
  }

  get(sessionId: string): StoredSession | null {
    const entry = this.entry;
    return entry && entry.sessionId === sessionId ? entry : null;
  }

  delete(sessionId: string): void {
    this.deletes.push(sessionId);
  }

  upsert(): void {}
}

/** Install a fake session index on an agent. */
function withStore(agent: PiAcpAgent, store: SessionStoreLike): void {
  // `store` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { store });
}

test("PiAcpAgent: deleteSession removes stored session and session file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-delete-test-"));
  const sessionsDir = join(root, "sessions", "--tmp--delete-project--");
  const sessionFile = join(sessionsDir, "0000_delete_me.jsonl");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    '{"type":"session","version":3,"id":"sess-del-store","timestamp":"2026-06-16T00:00:00.000Z","cwd":"/tmp/delete-project"}\n',
    "utf-8",
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  const storedSessionId = "stored-session";

  // Inject a SessionStore that tracks calls.
  const store = new RecordingSessionStore({
    sessionId: storedSessionId,
    cwd: "/tmp/delete-project",
    sessionFile,
    updatedAt: new Date().toISOString(),
  });
  withStore(agent, store);

  try {
    const response = await agent.deleteSession({ sessionId: storedSessionId });
    assert.deepEqual(response, {});
    assert.deepEqual(store.deletes, [storedSessionId]);
    assert.equal(existsSync(sessionFile), false);
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});

test("PiAcpAgent: deleteSession finds session via pi discovery when SessionStore misses", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-delete-discovery-"));
  const sessionsDir = join(root, "sessions", "--tmp--delete-discovery--");
  const sessionFile = join(sessionsDir, "0000_pi_discovery.jsonl");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-discovered-session",
      timestamp: "2026-06-16T00:00:00.000Z",
      cwd: "/tmp/delete-discovery",
    }) + "\n",
    "utf-8",
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  const store = new RecordingSessionStore(null);
  withStore(agent, store);

  try {
    const response = await agent.deleteSession({ sessionId: "pi-discovered-session" });
    assert.deepEqual(response, {});
    assert.deepEqual(store.deletes, ["pi-discovered-session"]);
    assert.equal(existsSync(sessionFile), false);
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});

test("PiAcpAgent: deleteSession succeeds idempotently for unknown sessionId", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-delete-unknown-"));
  const sessionsDir = join(root, "sessions", "--tmp--delete-unknown--");
  mkdirSync(sessionsDir, { recursive: true });

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  // Per ACP session/delete semantics, deleting a non-existent session
  // should succeed idempotently (return {} without error).
  const store = new RecordingSessionStore(null);
  withStore(agent, store);

  try {
    const response = await agent.deleteSession({ sessionId: "non-existent-session" });
    assert.deepEqual(response, {});
    assert.deepEqual(store.deletes, []);
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});

test("PiAcpAgent: deleteSession survives missing session file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-delete-missingfile-"));
  const sessionsDir = join(root, "sessions", "--tmp--delete-missingfile--");
  mkdirSync(sessionsDir, { recursive: true });
  const nonExistentFile = join(sessionsDir, "0000_non_existent.jsonl");

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  const store = new RecordingSessionStore({
    sessionId: "missing-file-session",
    cwd: "/tmp/delete-missingfile",
    sessionFile: nonExistentFile,
    updatedAt: new Date().toISOString(),
  });
  withStore(agent, store);

  try {
    const response = await agent.deleteSession({ sessionId: "missing-file-session" });
    assert.deepEqual(response, {});
    assert.deepEqual(store.deletes, ["missing-file-session"]);
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});
