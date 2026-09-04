import test from "node:test";
import assert from "node:assert/strict";
import { isBoundaryRecord, type BoundaryValue } from "../src/boundary.ts";
import { PiAcpAgent, type SessionStoreLike } from "../src/acp/agent.ts";
import type { StoredSession } from "../src/acp/session-store.ts";
import { PiRpcProcess, type PiRpcEvent, type PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiMessages,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** A session index that always resolves the single stored session under test. */
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

/** A Pi process fake for a restored session with an empty transcript. */
class RestoredProcess implements PiRpcProcessLike {
  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<void> {}

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

/** Replace `setTimeout` with a recorder so scheduled work never runs during a test. */
class TimerRecorder {
  readonly callbacks: Array<() => void> = [];

  private readonly realSetTimeout = globalThis.setTimeout;

  install(): void {
    const realSetTimeout = this.realSetTimeout;
    const callbacks = this.callbacks;
    const record = (callback: () => void): NodeJS.Timeout => {
      callbacks.push(callback);
      // Hand back a genuine (already cleared) handle so callers can still unref it.
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

/** Decode `_meta.piAcp.startupInfo` from an ACP response's undecoded metadata. */
function startupInfoFromMeta(meta: BoundaryValue): BoundaryValue {
  if (!isBoundaryRecord(meta)) return undefined;
  const piAcp = meta.piAcp;
  if (!isBoundaryRecord(piAcp)) return undefined;
  return piAcp.startupInfo;
}

test("PiAcpAgent: does not emit startup info on loadSession", async () => {
  // spy on timers (commands update is scheduled)
  const timers = new TimerRecorder();
  timers.install();

  const originalSpawn = PiRpcProcess.spawn;
  const spawnRestoredProcess = async (): Promise<PiRpcProcessLike> => new RestoredProcess();
  // `PiRpcProcess.spawn` is the only seam that starts a real pi child; `Object.assign`
  // swaps it for the duration of this test and the `finally` block restores it.
  Object.assign(PiRpcProcess, { spawn: spawnRestoredProcess });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    // Inject store so loadSession resolves without depending on actual filesystem.
    const store: SessionStoreLike = new FixedSessionStore();
    // `store` is a private implementation detail of `PiAcpAgent`; `Object.assign`
    // installs the fake through the same property without weakening any declared type.
    Object.assign(agent, { store });

    const res = await agent.loadSession({
      sessionId: "s1",
      cwd: "/tmp/project",
      mcpServers: [],
    });

    assert.equal(startupInfoFromMeta(res._meta ?? undefined), null);

    // Session load schedules available_commands_update plus the managed idle-reap timer.
    assert.equal(timers.callbacks.length, 2);
  } finally {
    timers.restore();
    Object.assign(PiRpcProcess, { spawn: originalSpawn });
  }
});
