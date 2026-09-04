import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiPromptImage,
  PiState,
  PiThinkingLevel,
} from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** A session manager that only knows the single session it was built with. */
class SingleSessionManager implements SessionManagerLike {
  private readonly session: PiAcpSession;

  constructor(session: PiAcpSession) {
    this.session = session;
  }

  async create(): Promise<PiAcpSession> {
    return this.session;
  }

  maybeGet(sessionId: string): PiAcpSession | undefined {
    if (sessionId !== this.session.sessionId) return undefined;
    return this.session;
  }

  get(sessionId: string): PiAcpSession {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    return this.session;
  }

  getOrCreate(): PiAcpSession {
    return this.session;
  }

  close(): void {}

  disposeAll(): void {}

  async shutdownAll(): Promise<void> {}
}

/** A Pi process fake exposing a mutable model and thinking selection. */
class ConfigurableProcess implements PiRpcProcessLike {
  readonly setModelCalls: Array<{ provider: string; modelId: string }> = [];
  readonly thinkingLevels: PiThinkingLevel[] = [];

  private readonly models: PiAvailableModels;
  private readonly state: PiState;

  constructor(models: PiAvailableModels, state: PiState) {
    this.models = models;
    this.state = state;
  }

  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<void> {}

  async getAvailableModels(): Promise<PiAvailableModels> {
    return this.models;
  }

  async getState(): Promise<PiState> {
    return this.state;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.setModelCalls.push({ provider, modelId });
    this.state.model = { provider, id: modelId };
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    this.thinkingLevels.push(level);
    this.state.thinkingLevel = level;
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

/** Build an agent whose only session is backed by `proc`. */
function agentWithSession(conn: FakeAgentSideConnection, proc: PiRpcProcessLike): PiAcpAgent {
  const agent = new PiAcpAgent(asAgentConn(conn), {});
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

test("PiAcpAgent: newSession returns configOptions for model and thinking selectors", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new ConfigurableProcess(
    {
      models: [
        { provider: "test", id: "alpha", name: "Alpha" },
        { provider: "test", id: "beta", name: "Beta" },
      ],
    },
    { thinkingLevel: "high", model: { provider: "test", id: "beta" } },
  );
  const agent = agentWithSession(conn, proc);

  const timers = new TimerRecorder();
  timers.install();

  try {
    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    assert.equal(result.models?.currentModelId, "test/beta");
    assert.equal(result.modes?.currentModeId, "high");
    assert.deepEqual(result.configOptions, [
      {
        type: "select",
        id: "model",
        category: "model",
        name: "Model",
        description: "Select the model for this session",
        currentValue: "test/beta",
        options: [
          { value: "test/alpha", name: "test/Alpha", description: null },
          { value: "test/beta", name: "test/Beta", description: null },
        ],
      },
      {
        type: "select",
        id: "thought_level",
        category: "thought_level",
        name: "Thinking",
        description: "Set the reasoning effort for this session",
        currentValue: "high",
        options: [
          { value: "off", name: "Thinking: off", description: null },
          { value: "minimal", name: "Thinking: minimal", description: null },
          { value: "low", name: "Thinking: low", description: null },
          { value: "medium", name: "Thinking: medium", description: null },
          { value: "high", name: "Thinking: high", description: null },
          { value: "xhigh", name: "Thinking: xhigh", description: null },
        ],
      },
    ]);
  } finally {
    timers.restore();
  }
});

test("PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new ConfigurableProcess(
    {
      models: [
        { provider: "test", id: "alpha", name: "Alpha" },
        { provider: "test", id: "beta", name: "Beta" },
      ],
    },
    { thinkingLevel: "medium", model: { provider: "test", id: "alpha" } },
  );
  const agent = agentWithSession(conn, proc);

  const result = await agent.setSessionConfigOption({
    sessionId: "s1",
    configId: "model",
    value: "test/beta",
  });

  assert.deepEqual(proc.setModelCalls, [{ provider: "test", modelId: "beta" }]);
  assert.equal(
    result.configOptions.find((option) => option.id === "model")?.currentValue,
    "test/beta",
  );
  assert.deepEqual(conn.updates, [
    {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: result.configOptions,
      },
    },
  ]);
});

test("PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new ConfigurableProcess(
    { models: [{ provider: "test", id: "alpha", name: "Alpha" }] },
    { thinkingLevel: "medium", model: { provider: "test", id: "alpha" } },
  );
  const agent = agentWithSession(conn, proc);

  const result = await agent.setSessionConfigOption({
    sessionId: "s1",
    configId: "thought_level",
    value: "xhigh",
  });

  assert.deepEqual(proc.thinkingLevels, ["xhigh"]);
  assert.equal(
    result.configOptions.find((option) => option.id === "thought_level")?.currentValue,
    "xhigh",
  );
  assert.deepEqual(conn.updates, [
    {
      sessionId: "s1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "xhigh",
      },
    },
    {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: result.configOptions,
      },
    },
  ]);
});
