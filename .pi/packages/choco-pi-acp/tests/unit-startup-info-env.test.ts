import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type { PiAvailableModels, PiPromptImage, PiState } from "../src/pi-rpc/protocol.ts";
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

/** A Pi process fake reporting one configured model. */
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
}

/** A session that counts how often the adapter handed it startup info. */
class StartupInfoSession extends PiAcpSession {
  startupInfoCalls = 0;

  override setStartupInfo(text: string): void {
    this.startupInfoCalls += 1;
    super.setStartupInfo(text);
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

test("PiAcpAgent: quietStartup=true disables startup info generation/emission", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-quietstartup-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ quietStartup: true }, null, 2),
    "utf-8",
  );
  process.env.PI_CODING_AGENT_DIR = dir;

  const conn = new FakeAgentSideConnection();
  const session = new StartupInfoSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: new SingleModelProcess(),
    conn: asAgentConn(conn),
  });

  const agent = new PiAcpAgent(asAgentConn(conn), {});
  const sessions: SessionManagerLike = new SingleSessionManager(session);
  // `sessions` is a private implementation detail of `PiAcpAgent`; `Object.assign`
  // installs the fake through the same property without weakening any declared type.
  Object.assign(agent, { sessions });

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const timers = new TimerRecorder();
  timers.install();

  try {
    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    const startupInfo = res._meta.piAcp.startupInfo;

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/);
      assert.equal(session.startupInfoCalls > 0, true);
      assert.equal(timers.callbacks.length, 2);
    } else {
      assert.equal(session.startupInfoCalls, 0);
      assert.equal(timers.callbacks.length, 1);
    }
  } finally {
    timers.restore();
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
