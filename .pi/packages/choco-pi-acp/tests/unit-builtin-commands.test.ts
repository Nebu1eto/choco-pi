import test from "node:test";
import assert from "node:assert/strict";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type { PiPromptImage, PiState } from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** A session manager that always resolves to one prepared session. */
class SingleSessionManager implements SessionManagerLike {
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

  close(): void {}

  disposeAll(): void {}

  async shutdownAll(): Promise<void> {}
}

/** A Pi process fake recording prompts and adapter-driven session naming. */
class BuiltinCommandProcess implements PiRpcProcessLike {
  readonly prompts: string[] = [];
  sessionName: string | null = null;

  private readonly state: PiState;

  constructor(state: PiState) {
    this.state = state;
  }

  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(message: string, _images: PiPromptImage[] = []): Promise<void> {
    this.prompts.push(message);
  }

  async getState(): Promise<PiState> {
    return this.state;
  }

  async setSessionName(name: string): Promise<void> {
    this.sessionName = name;
  }
}

/** Build an agent whose only session is backed by `proc`. */
function agentWithSession(conn: FakeAgentSideConnection, proc: PiRpcProcessLike): PiAcpAgent {
  const agent = new PiAcpAgent(asAgentConn(conn));
  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });
  const sessions: SessionManagerLike = new SingleSessionManager(session);
  // `sessions` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { sessions });
  return agent;
}

/** Read the text of a trailing `agent_message_chunk` notification. */
function agentMessageText(notification: SessionNotification | undefined): string {
  const update = notification?.update;
  if (update?.sessionUpdate !== "agent_message_chunk") {
    throw new Error(`expected agent_message_chunk, got ${String(update?.sessionUpdate)}`);
  }
  const content = update.content;
  if (content.type !== "text") {
    throw new Error(`expected text content, got ${content.type}`);
  }
  return content.text;
}

/** Read the title of the first `session_info_update` notification, if any. */
function sessionInfoTitle(updates: readonly SessionNotification[]): string | null {
  for (const notification of updates) {
    const update = notification.update;
    if (update.sessionUpdate === "session_info_update") return update.title ?? null;
  }
  return null;
}

test("PiAcpAgent: /steering is handled adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new BuiltinCommandProcess({ steeringMode: "one-at-a-time" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/steering" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  assert.match(agentMessageText(conn.updates.at(-1)), /Steering mode: one-at-a-time/);
});

test("PiAcpAgent: /name sets session display name adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new BuiltinCommandProcess({});
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/name My Session" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  assert.equal(proc.sessionName, "My Session");
  assert.equal(sessionInfoTitle(conn.updates), "My Session");
  assert.match(agentMessageText(conn.updates.at(-1)), /Session name set: My Session/);
});
