import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { SessionStore } from "../src/acp/session-store.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type { PiAvailableModels, PiPromptImage, PiState } from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** A session manager that hands out one prepared session and records closures. */
class SingleSessionManager implements SessionManagerLike {
  readonly closeCalls: string[] = [];

  private readonly session: PiAcpSession;

  constructor(session: PiAcpSession) {
    this.session = session;
  }

  async create(): Promise<PiAcpSession> {
    return this.session;
  }

  maybeGet(): PiAcpSession {
    return this.session;
  }

  get(): PiAcpSession {
    return this.session;
  }

  getOrCreate(): PiAcpSession {
    return this.session;
  }

  close(sessionId: string): void {
    this.closeCalls.push(sessionId);
  }

  disposeAll(): void {}

  async shutdownAll(): Promise<void> {}
}

/** A Pi process fake whose model probe fails after a successful spawn. */
class FailingModelProbeProcess implements PiRpcProcessLike {
  private readonly failure: string;
  private readonly state: PiState;

  constructor(failure: string, state: PiState) {
    this.failure = failure;
    this.state = state;
  }

  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<void> {}

  async getAvailableModels(): Promise<PiAvailableModels> {
    throw new Error(this.failure);
  }

  async getState(): Promise<PiState> {
    return this.state;
  }
}

/** Run `call` and return the `RequestError` it must reject with. */
async function rejectionOf(call: () => Promise<void>): Promise<RequestError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with a RequestError");
}

test("PiAcpAgent: newSession returns AUTH_REQUIRED when pi reports an auth error after spawn", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(join(tmpdir(), "pi-acp-runtime-auth-"));
  const sessionFile = join(root, "sessions", "failed.jsonl");
  const sessionMapPath = join(root, "session-map.json");

  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "s-auth",
      timestamp: "2026-05-07T00:00:00.000Z",
      cwd: process.cwd(),
    }) + "\n",
    "utf-8",
  );

  const session = new PiAcpSession({
    sessionId: "s-auth",
    cwd: process.cwd(),
    mcpServers: [],
    proc: new FailingModelProbeProcess("Authentication required: missing key", {
      thinkingLevel: "medium",
      sessionFile,
    }),
    conn: asAgentConn(conn),
  });

  const sessions = new SingleSessionManager(session);
  const store = new SessionStore(sessionMapPath);
  store.upsert({ sessionId: "s-auth", cwd: process.cwd(), sessionFile });
  const agent = new PiAcpAgent(asAgentConn(conn), {});
  // `sessions` and `store` are private implementation details of `PiAcpAgent`;
  // `Object.assign` installs the fakes without weakening any declared type.
  Object.assign(agent, { sessions, store });

  const error = await rejectionOf(async () => {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  });
  assert.equal(error.code, -32000);

  assert.deepEqual(sessions.closeCalls, ["s-auth"]);
  assert.equal(existsSync(sessionFile), false);
  assert.equal(store.get("s-auth"), null);
});

test("PiAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn", async () => {
  const conn = new FakeAgentSideConnection();

  const session = new PiAcpSession({
    sessionId: "s-internal",
    cwd: process.cwd(),
    mcpServers: [],
    proc: new FailingModelProbeProcess("socket hang up", { thinkingLevel: "medium" }),
    conn: asAgentConn(conn),
  });

  const sessions = new SingleSessionManager(session);
  const agent = new PiAcpAgent(asAgentConn(conn), {});
  // `sessions` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { sessions });

  const error = await rejectionOf(async () => {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  });
  assert.equal(error.code, -32603);
  assert.ok(error.message.includes("socket hang up"));

  assert.deepEqual(sessions.closeCalls, ["s-internal"]);
});
