import test from "node:test";
import assert from "node:assert/strict";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type { PiPromptImage, PiState, PiTurnMode } from "../src/pi-rpc/protocol.ts";
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

/** A Pi process fake that reports a fixed state and records turn-mode changes. */
class TurnModeProcess implements PiRpcProcessLike {
  readonly prompts: string[] = [];
  steeringMode: PiTurnMode | null = null;
  followUpMode: PiTurnMode | null = null;
  setSteeringModeCalls = 0;
  setFollowUpModeCalls = 0;

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

  async setSteeringMode(mode: PiTurnMode): Promise<void> {
    this.setSteeringModeCalls += 1;
    this.steeringMode = mode;
  }

  async setFollowUpMode(mode: PiTurnMode): Promise<void> {
    this.setFollowUpModeCalls += 1;
    this.followUpMode = mode;
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

test("PiAcpAgent: /steering reports current steeringMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ steeringMode: "all" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/steering" }],
  });

  assert.equal(res.stopReason, "end_turn");
  const last = conn.updates.at(-1);
  assert.equal(last?.update.sessionUpdate, "agent_message_chunk");
  assert.match(agentMessageText(last), /Steering mode: all/);
});

test("PiAcpAgent: /steering sets steering mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ steeringMode: "all" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/steering one-at-a-time" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.steeringMode, "one-at-a-time");
  assert.match(agentMessageText(conn.updates.at(-1)), /Steering mode set to: one-at-a-time/);
});

test("PiAcpAgent: /steering rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ steeringMode: "all" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/steering nope" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.setSteeringModeCalls, 0);
  assert.match(agentMessageText(conn.updates.at(-1)), /Usage: \/steering/);
});

test("PiAcpAgent: /follow-up reports current followUpMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ followUpMode: "one-at-a-time" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/follow-up" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.match(agentMessageText(conn.updates.at(-1)), /Follow-up mode: one-at-a-time/);
});

test("PiAcpAgent: /follow-up sets follow-up mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ followUpMode: "one-at-a-time" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/follow-up all" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.followUpMode, "all");
  assert.match(agentMessageText(conn.updates.at(-1)), /Follow-up mode set to: all/);
});

test("PiAcpAgent: /follow-up rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new TurnModeProcess({ followUpMode: "one-at-a-time" });
  const agent = agentWithSession(conn, proc);

  const res = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/follow-up ???" }],
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.setFollowUpModeCalls, 0);
  assert.match(agentMessageText(conn.updates.at(-1)), /Usage: \/follow-up/);
});
