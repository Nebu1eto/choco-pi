import test from "node:test";
import assert from "node:assert/strict";
import { isBoundaryRecord, type BoundaryValue } from "../src/boundary.ts";
import { PiAcpAgent, type SessionStoreLike } from "../src/acp/agent.ts";
import type { StoredSession } from "../src/acp/session-store.ts";
import {
  PiRpcProcess,
  type PiPromptDisposition,
  type PiRpcEvent,
  type PiRpcProcessLike,
} from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiMessages,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

class FixedSessionStore implements SessionStoreLike {
  get(_sessionId: string): StoredSession {
    return {
      sessionId: "s1",
      cwd: "/tmp/project",
      sessionFile: "/tmp/s.jsonl",
      updatedAt: new Date().toISOString(),
    };
  }

  upsert(): void {}

  delete(): void {}
}

class RestoredProcess implements PiRpcProcessLike {
  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<PiPromptDisposition> {
    return "started";
  }

  async getMessages(): Promise<PiMessages> {
    return { messages: [] };
  }

  async getAvailableModels(): Promise<PiAvailableModels> {
    return { models: [] };
  }

  async getState(): Promise<PiState> {
    return { thinkingLevel: "medium" };
  }
}

class TimerRecorder {
  readonly callbacks: Array<() => void> = [];

  private readonly realSetTimeout = globalThis.setTimeout;

  install(): void {
    const realSetTimeout = this.realSetTimeout;
    const callbacks = this.callbacks;
    const record = (callback: () => void): NodeJS.Timeout => {
      callbacks.push(callback);
      const handle = realSetTimeout(() => {}, 0);
      clearTimeout(handle);
      return handle;
    };
    Object.assign(globalThis, { setTimeout: record });
  }

  restore(): void {
    Object.assign(globalThis, { setTimeout: this.realSetTimeout });
  }
}

function startupInfoFromMeta(meta: BoundaryValue): BoundaryValue {
  if (!isBoundaryRecord(meta)) return undefined;
  const piAcp = meta.piAcp;
  if (!isBoundaryRecord(piAcp)) return undefined;
  return piAcp.startupInfo;
}

test("PiAcpAgent: does not emit startup info on loadSession", async () => {
  const timers = new TimerRecorder();
  timers.install();

  const originalSpawn = PiRpcProcess.spawn;
  const spawnRestoredProcess = async (): Promise<PiRpcProcessLike> => new RestoredProcess();
  Object.assign(PiRpcProcess, { spawn: spawnRestoredProcess });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    const store: SessionStoreLike = new FixedSessionStore();
    Object.assign(agent, { store });

    const res = await agent.loadSession({
      sessionId: "s1",
      cwd: "/tmp/project",
      mcpServers: [],
    });

    assert.equal(startupInfoFromMeta(res._meta ?? undefined), null);

    assert.equal(timers.callbacks.length, 2);
  } finally {
    timers.restore();
    Object.assign(PiRpcProcess, { spawn: originalSpawn });
  }
});
