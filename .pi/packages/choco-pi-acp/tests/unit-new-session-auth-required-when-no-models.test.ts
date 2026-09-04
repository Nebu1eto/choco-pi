import test from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@agentclientprotocol/sdk";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
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

/** A Pi process fake that reports no configured models. */
class NoModelsProcess implements PiRpcProcessLike {
  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<void> {}

  async getAvailableModels(): Promise<PiAvailableModels> {
    return { models: [] };
  }

  async getState(): Promise<PiState> {
    return { thinkingLevel: "medium" };
  }
}

test("PiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models", async () => {
  const conn = new FakeAgentSideConnection();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: new NoModelsProcess(),
    conn: asAgentConn(conn),
  });

  const sessions = new SingleSessionManager(session);
  const agent = new PiAcpAgent(asAgentConn(conn), {});
  // `sessions` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { sessions });

  let threw = false;
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    threw = true;
    assert.equal(error.code, -32000);
    assert.match(error.message, /Configure an API key or log in with an OAuth provider/i);
  }

  assert.equal(threw, true);
  assert.deepEqual(sessions.closeCalls, ["s1"]);
});
