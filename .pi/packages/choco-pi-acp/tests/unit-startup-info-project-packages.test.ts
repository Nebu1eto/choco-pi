import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiCommands,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";
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

/** A Pi process fake reporting one model and no commands. */
class SingleModelProcess implements PiRpcProcessLike {
  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<void> {}

  async getAvailableModels(): Promise<PiAvailableModels> {
    return { models: [{ provider: "test", id: "model", name: "model" }] };
  }

  async getState(): Promise<PiState> {
    return { thinkingLevel: "medium", model: { provider: "test", id: "model" } };
  }

  async getCommands(): Promise<PiCommands> {
    return { commands: [] };
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

test("PiAcpAgent: startup info includes project-level packages from .pi/settings.json", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  // Create a fake global agent dir (empty settings)
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-global-"));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:global-ext"] }),
    "utf-8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // Create a fake project dir with .pi/settings.json containing packages
  const projectDir = mkdtempSync(join(tmpdir(), "pi-acp-project-"));
  const piDir = join(projectDir, ".pi");
  mkdirSync(piDir);
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ packages: ["/path/to/local-extension"] }),
    "utf-8",
  );

  const conn = new FakeAgentSideConnection();
  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: projectDir,
    mcpServers: [],
    proc: new SingleModelProcess(),
    conn: asAgentConn(conn),
  });

  const agent = new PiAcpAgent(asAgentConn(conn), {});
  const sessions: SessionManagerLike = new SingleSessionManager(session);
  // `sessions` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { sessions });

  const timers = new TimerRecorder();
  timers.install();

  try {
    const res = await agent.newSession({ cwd: projectDir, mcpServers: [] });
    const startupInfo = res._meta.piAcp.startupInfo ?? "";

    assert.ok(startupInfo.includes("npm:global-ext"), "should include global package");
    assert.ok(startupInfo.includes("/path/to/local-extension"), "should include project package");
  } finally {
    timers.restore();
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
