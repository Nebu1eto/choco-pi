import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAcpAgent, type SessionStoreLike } from "../src/acp/agent.ts";
import { PiAcpSession, SessionManager } from "../src/acp/session.ts";
import type { SessionStoreEntry } from "../src/acp/session-store.ts";
import type {
  PiAvailableModels,
  PiPromptImage,
  PiRpcEvent,
  PiState,
} from "../src/pi-rpc/protocol.ts";
import { PiRpcProcess, type PiRpcExit, type PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

type SpawnParameters = Parameters<typeof PiRpcProcess.spawn>[0];
type SessionPromptResult = Awaited<ReturnType<PiAcpSession["prompt"]>>;

interface ProcessSpawner {
  spawn(params: SpawnParameters): Promise<PiRpcProcessLike>;
}

interface RestoredSession {
  sessionId: string;
  cwd: string;
  proc: PiRpcProcessLike;
  prompt?(message: string, images: PiPromptImage[]): Promise<SessionPromptResult>;
  activate?(): void;
  markIdle?(): void;
  wasCancelRequested?(): boolean;
  cancel?(): Promise<void>;
  setStartupInfo?(text: string): void;
  sendStartupInfoIfPending?(): Promise<void>;
}

interface SessionBuildParameters {
  cwd: string;
  proc: PiRpcProcessLike;
}

interface AgentState<Sessions> {
  sessions: Sessions;
  store: SessionStoreLike;
}

class FakeSessions {
  restoredSession: RestoredSession | undefined;
  private readonly buildSession: (
    sessionId: string,
    params: SessionBuildParameters,
  ) => RestoredSession;

  constructor(
    buildSession: (sessionId: string, params: SessionBuildParameters) => RestoredSession,
  ) {
    this.buildSession = buildSession;
  }

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId ? this.restoredSession : undefined;
  }

  getOrCreate(sessionId: string, params: SessionBuildParameters): RestoredSession {
    if (!this.restoredSession) {
      this.restoredSession = this.buildSession(sessionId, params);
    }
    return this.restoredSession;
  }

  async create(): Promise<RestoredSession> {
    throw new Error("FakeSessions.create is not used by these restore tests");
  }

  get(sessionId: string): RestoredSession {
    const session = this.maybeGet(sessionId);
    if (!session) throw new Error(`Unknown restored session: ${sessionId}`);
    return session;
  }

  close(_sessionId: string): void {}
  disposeAll(): void {}
  async shutdownAll(): Promise<void> {}
  retainRecent(_sessionId: string, _maxLive: number): void {}
}

class RestorableFakeProcess implements PiRpcProcessLike {
  readonly promptCalls: string[] = [];
  readonly shutdownCalls: Array<number | undefined> = [];
  private eventHandler: ((event: PiRpcEvent) => void) | undefined;

  onEvent(handler: (event: PiRpcEvent) => void): () => void {
    this.eventHandler = handler;
    return () => {
      this.eventHandler = undefined;
    };
  }

  onExit(): () => void {
    return () => {};
  }

  async prompt(message: string, _images: PiPromptImage[] = []): Promise<void> {
    this.promptCalls.push(message);
    queueMicrotask(() => this.eventHandler?.({ type: "agent_settled" }));
  }

  async shutdown(graceMs?: number): Promise<PiRpcExit> {
    this.shutdownCalls.push(graceMs);
    return { code: null, signal: "SIGTERM" };
  }
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("PiAcpAgent: prompt auto-restores a missing session from SessionStore", async () => {
  const conn = new FakeAgentSideConnection();
  const promptCalls: Array<{ message: string; images: PiPromptImage[] }> = [];
  const spawnCalls: SpawnParameters[] = [];
  const storeUpserts: SessionStoreEntry[] = [];

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async prompt(message: string, images: PiPromptImage[]): Promise<SessionPromptResult> {
      promptCalls.push({ message, images });
      return "end_turn";
    },
    async cancel() {},
    wasCancelRequested() {
      return false;
    },
  }));

  const spawner: ProcessSpawner = PiRpcProcess;
  const originalSpawn = spawner.spawn;
  spawner.spawn = async (params) => {
    spawnCalls.push(params);
    return {
      onEvent: () => () => {},
      prompt: async () => {},
    };
  };

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {});
    const store: SessionStoreLike = {
      get(sessionId: string) {
        if (sessionId !== "stored-session") return null;
        return {
          sessionId,
          cwd: "/tmp/store-project",
          sessionFile: "/tmp/store-project/session.jsonl",
          updatedAt: new Date().toISOString(),
        };
      },
      upsert(entry) {
        storeUpserts.push(entry);
      },
      delete() {},
    };
    // The injected fakes implement the session-manager and store operations used by restore.
    Object.assign(agent, { sessions, store } satisfies AgentState<FakeSessions>);

    const result = await agent.prompt({
      sessionId: "stored-session",
      prompt: [{ type: "text", text: "hello again" }],
    });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/store-project",
        sessionPath: "/tmp/store-project/session.jsonl",
        piCommand: process.env.PI_ACP_PI_COMMAND,
      },
    ]);
    assert.deepEqual(promptCalls, [{ message: "hello again", images: [] }]);
    assert.deepEqual(storeUpserts, [
      {
        sessionId: "stored-session",
        cwd: "/tmp/store-project",
        sessionFile: "/tmp/store-project/session.jsonl",
      },
    ]);
  } finally {
    spawner.spawn = originalSpawn;
  }
});

test("PiAcpAgent: prompt transparently respawns a session after idle reaping", async () => {
  const conn = new FakeAgentSideConnection();
  const manager = new SessionManager({ sessionIdleMs: 10 });
  const oldProc = new RestorableFakeProcess();
  const newProc = new RestorableFakeProcess();
  manager.getOrCreate("idle-session", {
    cwd: "/tmp/idle-project",
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: oldProc,
  });

  const spawner: ProcessSpawner = PiRpcProcess;
  const originalSpawn = spawner.spawn;
  const spawnCalls: SpawnParameters[] = [];
  spawner.spawn = async (params) => {
    spawnCalls.push(params);
    return newProc;
  };

  const agent = new PiAcpAgent(asAgentConn(conn), {});
  const store: SessionStoreLike = {
    get(sessionId: string) {
      return sessionId === "idle-session"
        ? {
            sessionId,
            cwd: "/tmp/idle-project",
            sessionFile: "/tmp/idle-project/session.jsonl",
            updatedAt: new Date().toISOString(),
          }
        : null;
    },
    upsert() {},
    delete() {},
  };
  // The real manager and complete fake store are injected to reproduce idle restoration.
  Object.assign(agent, { sessions: manager, store } satisfies AgentState<SessionManager>);

  try {
    await tick(30);
    assert.equal(manager.maybeGet("idle-session"), undefined);
    assert.deepEqual(oldProc.shutdownCalls, [undefined]);

    const result = await agent.prompt({
      sessionId: "idle-session",
      prompt: [{ type: "text", text: "after idle" }],
    });

    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/idle-project",
        sessionPath: "/tmp/idle-project/session.jsonl",
        piCommand: process.env.PI_ACP_PI_COMMAND,
      },
    ]);
    assert.deepEqual(newProc.promptCalls, ["after idle"]);
  } finally {
    spawner.spawn = originalSpawn;
    await agent.shutdown(1);
  }
});

test("PiAcpAgent: setSessionConfigOption auto-restores via pi session discovery when SessionStore misses", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(join(tmpdir(), "pi-acp-restore-fallback-"));
  const sessionsDir = join(root, "sessions", "--tmp--fallback-project--");
  const sessionFile = join(sessionsDir, "0000_restore_fallback.jsonl");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "fallback-session",
      timestamp: "2026-06-16T00:00:00.000Z",
      cwd: "/tmp/fallback-project",
    }) + "\n",
    "utf-8",
  );

  process.env.PI_CODING_AGENT_DIR = root;

  const storeUpserts: SessionStoreEntry[] = [];
  const setModelCalls: Array<{ provider: string; modelId: string }> = [];
  const spawnCalls: SpawnParameters[] = [];
  const state: PiState = {
    thinkingLevel: "medium",
    model: { provider: "test", id: "alpha" },
  };

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
  }));

  const spawner: ProcessSpawner = PiRpcProcess;
  const originalSpawn = spawner.spawn;
  spawner.spawn = async (params) => {
    spawnCalls.push(params);
    return {
      onEvent: () => () => {},
      prompt: async () => {},
      getAvailableModels: async (): Promise<PiAvailableModels> => ({
        models: [
          { provider: "test", id: "alpha", name: "Alpha" },
          { provider: "test", id: "beta", name: "Beta" },
        ],
      }),
      getState: async () => state,
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId });
        state.model = { provider, id: modelId };
      },
    };
  };

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {});
    const store: SessionStoreLike = {
      get() {
        return null;
      },
      upsert(entry) {
        storeUpserts.push(entry);
      },
      delete() {},
    };
    // The injected fakes implement the session-manager and store operations used by fallback restore.
    Object.assign(agent, { sessions, store } satisfies AgentState<FakeSessions>);

    const result = await agent.setSessionConfigOption({
      sessionId: "fallback-session",
      configId: "model",
      value: "test/beta",
    });

    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/fallback-project",
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
      },
    ]);
    assert.deepEqual(setModelCalls, [{ provider: "test", modelId: "beta" }]);
    assert.equal(
      result.configOptions.find((option) => option.id === "model")?.currentValue,
      "test/beta",
    );
    assert.deepEqual(storeUpserts, [
      {
        sessionId: "fallback-session",
        cwd: "/tmp/fallback-project",
        sessionFile,
      },
      {
        sessionId: "fallback-session",
        cwd: "/tmp/fallback-project",
        sessionFile,
      },
    ]);
    assert.deepEqual(conn.updates, [
      {
        sessionId: "fallback-session",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: result.configOptions,
        },
      },
    ]);
  } finally {
    spawner.spawn = originalSpawn;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

test("PiAcpAgent: cancel ignores stale session IDs without spawning a restore process", async () => {
  const conn = new FakeAgentSideConnection();
  const spawnCalls: SpawnParameters[] = [];

  const spawner: ProcessSpawner = PiRpcProcess;
  const originalSpawn = spawner.spawn;
  spawner.spawn = async (params) => {
    spawnCalls.push(params);
    return {
      onEvent: () => () => {},
      prompt: async () => {},
    };
  };

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {});
    const sessions = new FakeSessions(() => {
      throw new Error("cancel should not restore a missing session");
    });
    const store: SessionStoreLike = {
      get: () => null,
      upsert() {},
      delete() {},
    };
    // The injected fakes implement the session-manager and store operations used by stale cancel.
    Object.assign(agent, { sessions, store } satisfies AgentState<FakeSessions>);

    await agent.cancel({ sessionId: "stale-session" });

    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(conn.updates, []);
  } finally {
    spawner.spawn = originalSpawn;
  }
});
