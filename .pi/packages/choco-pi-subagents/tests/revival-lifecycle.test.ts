import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { getAvailableTypes } from "../src/agent-types.ts";
import { runInChildSessionContext } from "../src/child-context.ts";
import subagentsExtension from "../src/index.ts";
import { NUDGE_HOLD_MS } from "../src/notification-gate.ts";
import {
  buildJournalData,
  CAPPED_REVIVAL_ERROR,
  type JournalAgentSnapshot,
  reduceJournal,
  SUBAGENT_JOURNAL_ENTRY,
  type SubagentJournalData,
} from "../src/revival-journal.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  installPolicy,
  policyState,
  type RunAgentOptions,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

/** Longer than index.ts's revival start delay (250 ms). */
const REVIVAL_WAIT_MS = 600;
const MARKER = "Your last tool call may have run partly or fully.";

type RuntimeValue = {} | null | undefined;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;

function reinterpret<Target>(value: RuntimeValue): Target {
  // SAFETY: Test host fixtures implement exactly the members the extension exercises.
  return value as Target;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SentMessage {
  customType: string;
  content: string;
}

/** Parameters of the root tools these tests call. */
interface ToolParams {
  agent_id?: string;
  prompt?: string;
  description?: string;
  subagent_type?: string;
  run_in_background?: boolean;
  resume?: string;
  model?: string;
}

interface RunCall {
  prompt: string;
  options: RunAgentOptions;
}

/** One extension activation over a shared session manager (a Pi runtime). */
interface Activation {
  handlers: Map<string, LifecycleHandler>;
  tools: Map<string, ToolDefinition>;
  sent: SentMessage[];
  notices: string[];
  ctx: ExtensionContext;
  start(reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  tool(name: string, params: ToolParams): Promise<string>;
  mention(text: string): Promise<RuntimeValue>;
}

interface Env {
  env: UsageLimitEnv;
  dir: string;
  runs: RunCall[];
  aborted: string[];
  /** Journal entry seen by the runner's abort listener, per agent id. */
  atAbort: Map<string, SubagentJournalData | undefined>;
  sm: SessionManager;
  activate(options?: { mode?: ExtensionContext["mode"]; sm?: SessionManager }): Activation;
  journal(id: string, sm?: SessionManager): SubagentJournalData[];
  seed(agent: JournalAgentSnapshot, suspended: boolean): void;
  childFile(name: string): Promise<string>;
  /** Settle every pending fake run as completed. */
  finishAll(): void;
}

function snap(id: string, overrides: Partial<JournalAgentSnapshot> = {}): JournalAgentSnapshot {
  return {
    id,
    handle: `worker-${id}`,
    type: "general-purpose",
    description: `task ${id}`,
    depth: 1,
    status: "interrupted",
    options: { isBackground: true },
    revivals: 0,
    resultConsumed: false,
    ...overrides,
  };
}

async function setup(t: TestContext): Promise<Env> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  t.after(() => cleanupProviders());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  const runs: RunCall[] = [];
  const aborted: string[] = [];
  const atAbort = new Map<string, SubagentJournalData | undefined>();
  const pending: Array<() => void> = [];
  const managers: AgentManager[] = [];
  const childSessions = new Map<string, AgentSession>();

  const journalOf = (id: string, manager = sm) =>
    manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === SUBAGENT_JOURNAL_ENTRY
          ? [reinterpret<SubagentJournalData>(reinterpret<RuntimeValue>(entry.data))]
          : [],
      )
      .filter((data) => data.agent.id === id);

  async function childFile(name: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, '{"type":"session"}\n');
    return file;
  }

  const runner: AgentManagerRunner = {
    async runAgent(_ctx, _type, prompt, options) {
      runs.push({ prompt, options });
      const id = options.agentId ?? "unknown";
      const file = options.resumeSessionFile ?? (await childFile(`child-${id}.jsonl`));
      let session = childSessions.get(file);
      if (session === undefined) {
        session = await env.childSession();
        session.sessionManager.getSessionFile = () => file;
        childSessions.set(file, session);
      }
      const live = session;
      options.onSessionCreated?.(live);
      options.onTurnEnd?.(1);
      return new Promise((resolve) => {
        const signal = options.signal;
        const settle = (aborted: boolean) =>
          resolve({ responseText: aborted ? "" : "done", session: live, aborted, steered: false });
        signal?.addEventListener(
          "abort",
          () => {
            aborted.push(id);
            atAbort.set(id, journalOf(id).at(-1));
            settle(true);
          },
          { once: true },
        );
        pending.push(() => settle(false));
      });
    },
    async resumeAgent() {
      throw new Error("unexpected in-memory resume");
    },
  };

  // Swap the runner of each activation's internally constructed manager at the
  // first session_start boundary (setJournalSink runs there for every session).
  const setSink = AgentManager.prototype.setJournalSink;
  t.mock.method(
    AgentManager.prototype,
    "setJournalSink",
    function (this: AgentManager, ...args: Parameters<AgentManager["setJournalSink"]>) {
      if (!managers.includes(this)) {
        managers.push(this);
        assert.equal(Reflect.set(this, "runner", runner), true);
      }
      return setSink.apply(this, args);
    },
  );
  t.after(() => {
    for (const manager of managers) manager.dispose();
  });

  function activate(
    options: { mode?: ExtensionContext["mode"]; sm?: SessionManager } = {},
  ): Activation {
    const handlers = new Map<string, LifecycleHandler>();
    let open = false;
    // A failing assertion must not leave the global manager slot claimed.
    t.after(async () => {
      if (!open) return;
      for (const settle of pending.splice(0)) settle();
      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    });
    const tools = new Map<string, ToolDefinition>();
    const sent: SentMessage[] = [];
    const notices: string[] = [];
    const session = options.sm ?? sm;
    const pi = reinterpret<ExtensionAPI>({
      events: { emit: () => undefined, on: () => () => undefined },
      on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      registerTool: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
      },
      appendEntry: (customType: string, data: RuntimeValue) => {
        session.appendCustomEntry(customType, data);
      },
      sendMessage: (message: SentMessage) => {
        sent.push({ customType: message.customType, content: message.content });
      },
      getSettings: () => ({}),
    });
    subagentsExtension(pi);
    const base = env.context({ sessionManager: session });
    const mode = options.mode ?? "rpc";
    // The SDK's headless UI; notify is captured for the latest activation.
    const ui = env.base.ui;
    t.mock.method(ui, "notify", (message: string) => {
      notices.push(message);
    });
    const ctx: ExtensionContext = {
      ...base,
      mode,
      hasUI: false,
      ui,
      sessionManager: session,
      modelRegistry: base.modelRegistry,
    };
    const tuiCtx: ExtensionContext = { ...ctx, mode: "tui" };
    return {
      handlers,
      tools,
      sent,
      notices,
      ctx,
      async start(reason = "startup") {
        const handler = handlers.get("session_start");
        assert.ok(handler);
        open = true;
        await handler({ type: "session_start", reason }, ctx);
      },
      async shutdown(reason = "quit") {
        const handler = handlers.get("session_shutdown");
        assert.ok(handler);
        open = false;
        await handler({ type: "session_shutdown", reason });
      },
      async tool(name, params) {
        const tool = tools.get(name);
        assert.ok(tool, `tool ${name}`);
        const result = await tool.execute(
          "fixture-call",
          params,
          undefined,
          undefined,
          toolContext(ctx),
        );
        const first = result.content[0];
        return first?.type === "text" ? first.text : "";
      },
      async mention(text) {
        const handler = handlers.get("input");
        assert.ok(handler);
        return handler({ type: "input", text, source: "interactive" }, tuiCtx);
      },
    };
  }

  return {
    env,
    dir,
    runs,
    aborted,
    atAbort,
    sm,
    activate,
    journal: journalOf,
    seed(agent, suspended) {
      sm.appendCustomEntry(
        SUBAGENT_JOURNAL_ENTRY,
        buildJournalData({ rootSessionId: sm.getSessionId(), suspended, agent }),
      );
    },
    childFile,
    finishAll() {
      for (const settle of pending.splice(0)) settle();
    },
  };
}

async function spawnBackground(a: Activation): Promise<string> {
  const text = await a.tool("Agent", {
    prompt: "long task",
    description: "long task",
    subagent_type: "general-purpose",
    run_in_background: true,
  });
  const id = /Agent ID: (\S+)/.exec(text)?.[1];
  assert.ok(id, text);
  return id;
}

for (const reason of ["reload", "quit", "resume", "fork"]) {
  test(`shutdown (${reason}) journals the running agent as suspended before aborting it`, async (t) => {
    const s = await setup(t);
    const a = s.activate();
    await a.start();
    const id = await spawnBackground(a);
    await flush();
    assert.equal(s.journal(id).at(-1)?.agent.status, "running");

    await a.shutdown(reason);
    assert.deepEqual(s.aborted, [id]);
    const atAbort = s.atAbort.get(id);
    assert.equal(atAbort?.suspended, true, "suspend entry precedes the abort");
    assert.equal(atAbort?.agent.status, "interrupted");
    const own = s.journal(id);
    assert.equal(own.at(-1)?.suspended, true, "nothing is journaled after the suspend entry");
    assert.equal(
      own.some((entry) => entry.agent.status === "stopped"),
      false,
    );
    assert.ok(own.at(-1)?.agent.sessionFile, "the child file is journaled");
  });
}

test("startup revives an interrupted agent under its id, after session_start returns", async (t) => {
  const s = await setup(t);
  const first = s.activate();
  await first.start();
  const id = await spawnBackground(first);
  await flush();
  await first.shutdown("reload");
  const file = s.journal(id).at(-1)?.agent.sessionFile;
  assert.ok(file);
  const before = s.runs.length;

  const second = s.activate();
  await second.start("reload");
  await flush();
  assert.equal(s.runs.length, before, "revival is deferred past the session_start handler");
  await sleep(REVIVAL_WAIT_MS);
  assert.equal(s.runs.length, before + 1);
  const revived = s.runs.at(-1);
  assert.equal(revived?.options.agentId, id);
  assert.equal(revived?.options.resumeSessionFile, file);
  assert.ok(revived?.prompt.includes(MARKER), revived?.prompt);
  const latest = s.journal(id).at(-1);
  assert.equal(latest?.agent.status, "running");
  assert.equal(latest?.agent.revivals, 0);
  assert.equal(latest?.agent.handle, s.journal(id)[0]?.agent.handle);

  s.finishAll();
  await sleep(50);
  assert.equal(s.journal(id).at(-1)?.agent.status, "completed");
  await second.shutdown("quit");
});

test("a revival scheduled for a session that already shut down does nothing", async (t) => {
  const s = await setup(t);
  const file = await s.childFile("stale.jsonl");
  s.seed(snap("stale", { sessionFile: file }), true);
  const a = s.activate();
  await a.start();
  await a.shutdown("reload");
  await sleep(REVIVAL_WAIT_MS);
  assert.equal(s.runs.length, 0);
});

test("print mode and in-memory roots do not journal and abort as before", async (t) => {
  const s = await setup(t);
  const print = s.activate({ mode: "print" });
  await print.start();
  const id = await spawnBackground(print);
  await flush();
  await print.shutdown("quit");
  assert.deepEqual(s.journal(id), []);
  assert.deepEqual(s.aborted, [id]);

  const memory = SessionManager.inMemory(s.dir);
  const inMemory = s.activate({ sm: memory });
  await inMemory.start();
  const other = await spawnBackground(inMemory);
  await flush();
  await inMemory.shutdown("quit");
  assert.deepEqual(s.journal(other, memory), []);
  assert.deepEqual(s.aborted, [id, other]);
});

test("a child-session activation registers no lifecycle handlers and never revives", async (t) => {
  const s = await setup(t);
  const handlers = new Map<string, LifecycleHandler>();
  const pi = reinterpret<ExtensionAPI>({
    events: { emit: () => undefined, on: () => () => undefined },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerTool: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  });
  await runInChildSessionContext(async () => subagentsExtension(pi));
  assert.equal(handlers.has("session_start"), false);
  assert.equal(handlers.has("session_shutdown"), false);
  assert.equal(s.runs.length, 0);
});

test("a capped agent is journaled as an error and reported once", async (t) => {
  const s = await setup(t);
  const file = await s.childFile("capped.jsonl");
  s.seed(snap("cap", { status: "running", sessionFile: file, revivals: 2 }), false);
  const first = s.activate();
  await first.start();
  await sleep(REVIVAL_WAIT_MS);
  assert.equal(s.runs.length, 0);
  const reports = first.sent.filter((message) => message.customType === "subagent-revival");
  assert.equal(reports.length, 1);
  assert.match(reports[0]?.content ?? "", /cap.*capped/s);
  assert.match(reports[0]?.content ?? "", /resume: "cap"/);
  const latest = s.journal("cap").at(-1)?.agent;
  assert.equal(latest?.status, "error");
  assert.equal(latest?.error, CAPPED_REVIVAL_ERROR);
  await first.shutdown("quit");

  const second = s.activate();
  await second.start();
  await sleep(REVIVAL_WAIT_MS);
  assert.equal(second.sent.filter((m) => m.customType === "subagent-revival").length, 0);
  assert.equal(s.runs.length, 0);
  await second.shutdown("quit");
});

test("dormant agents: result read, stop before revival, Agent resume and @handle", async (t) => {
  const s = await setup(t);
  const doneFile = await s.childFile("done.jsonl");
  const waitFile = await s.childFile("wait.jsonl");
  const mentionFile = await s.childFile("mention.jsonl");
  // Activation loads the agent registry; a resume refuses fallback types, so
  // seed with one that resolves exactly in this checkout.
  const a = s.activate();
  const type = getAvailableTypes()[0];
  assert.ok(type);
  s.seed(
    snap("done", { type, status: "completed", result: "final answer", sessionFile: doneFile }),
    false,
  );
  s.seed(snap("held", { type, status: "interrupted", sessionFile: waitFile }), true);
  s.seed(
    snap("talk", { type, status: "completed", result: "earlier", sessionFile: mentionFile }),
    false,
  );
  await a.start();

  // Before the deferred revival fires: stopping the interrupted agent wins.
  const notRunning = await a.tool("get_subagent_result", { agent_id: "held" });
  assert.match(notRunning, /is not running \(saved status: interrupted\)/);
  const stopped = await a.tool("stop_subagent", { agent_id: "worker-held" });
  assert.match(stopped, /marked stopped and will not be revived/);
  await sleep(REVIVAL_WAIT_MS);
  assert.equal(s.runs.length, 0, "an explicitly stopped dormant agent is not revived");
  const heldLatest = s.journal("held").at(-1)?.agent;
  assert.equal(heldLatest?.status, "stopped");
  assert.equal(heldLatest?.stoppedByUser, true);

  const read = await a.tool("get_subagent_result", { agent_id: "done" });
  assert.match(read, /final answer/);
  assert.equal(s.journal("done").at(-1)?.agent.resultConsumed, true);
  const again = await a.tool("get_subagent_result", { agent_id: "done" });
  assert.match(again, /terminal_generation_already_consumed/);
  const nothing = await a.tool("stop_subagent", { agent_id: "done" });
  assert.match(nothing, /not running \(status: completed\); nothing to stop/);

  const resumed = await a.tool("Agent", {
    prompt: "follow up",
    description: "follow up",
    subagent_type: "general-purpose",
    resume: "done",
  });
  assert.match(resumed, /resumed in background from its saved session/);
  assert.equal(s.runs.at(-1)?.options.agentId, "done");
  assert.equal(s.runs.at(-1)?.options.resumeSessionFile, doneFile);
  assert.equal(s.runs.at(-1)?.prompt, "follow up");

  assert.deepEqual(await a.mention("@worker-talk please continue"), { action: "handled" });
  await sleep(50);
  assert.equal(s.runs.at(-1)?.options.agentId, "talk");
  assert.equal(s.runs.at(-1)?.options.resumeSessionFile, mentionFile);
  assert.equal(s.runs.at(-1)?.prompt, "please continue");

  const unknown = await a.tool("Agent", {
    prompt: "x",
    description: "x",
    subagent_type: "general-purpose",
    resume: "missing",
  });
  assert.match(unknown, /Agent not found: "missing"/);

  s.finishAll();
  await sleep(50);
  await a.shutdown("quit");
});

test("a pending notification for a dormant unread result survives a restart", async (t) => {
  const s = await setup(t);
  s.seed(snap("note", { status: "completed", result: "the result" }), false);
  s.sm.appendCustomEntry("subagent-notification-pending", { keys: ["note"] });
  const a = s.activate();
  await a.start();
  await sleep(NUDGE_HOLD_MS * 3);
  const notification = a.sent.find((message) => message.customType === "subagent-notification");
  assert.ok(notification, JSON.stringify(a.sent));
  assert.match(notification.content, /<task-id>note<\/task-id>/);
  assert.match(notification.content, /the result/);
  assert.equal(
    reduceJournal(s.sm.getEntries(), s.sm.getSessionId()).get("note")?.agent.resultConsumed,
    false,
    "delivery does not consume the result",
  );
  await a.shutdown("quit");
});

test("Agent resume of a dormant agent with model: switches and journals, or refuses a closed provider", async (t) => {
  const s = await setup(t);
  const file = await s.childFile("model.jsonl");
  const closedFile = await s.childFile("closed.jsonl");
  const a = s.activate();
  const type = getAvailableTypes()[0];
  assert.ok(type);
  const anthropic = { provider: "anthropic", id: "claude-opus-4-5" };
  s.seed(
    snap("mod", { type, status: "completed", result: "r", sessionFile: file, model: anthropic }),
    false,
  );
  s.seed(
    snap("shut", {
      type,
      status: "completed",
      result: "r",
      sessionFile: closedFile,
      model: anthropic,
    }),
    false,
  );
  const installed = installPolicy(
    policyState({ isClosed: (providerKey) => providerKey === "moonshotai" }),
    s.sm.getSessionId(),
  );
  t.after(() => installed.remove());
  await a.start();

  const refused = await a.tool("Agent", {
    prompt: "go",
    description: "go",
    subagent_type: type,
    resume: "shut",
    model: "moonshotai/kimi-k3",
  });
  assert.match(refused, /Failed to resume agent "shut": .*Provider moonshotai unavailable/);
  assert.equal(s.runs.length, 0);

  const resumed = await a.tool("Agent", {
    prompt: "on sol",
    description: "on sol",
    subagent_type: type,
    resume: "mod",
    model: "openai/gpt-5.6-sol",
  });
  assert.match(resumed, /resumed in background from its saved session/);
  const run = s.runs.at(-1);
  assert.equal(run?.options.agentId, "mod");
  assert.equal(run?.options.resumeSessionFile, file);
  assert.equal(`${run?.options.model?.provider}/${run?.options.model?.id}`, "openai/gpt-5.6-sol");
  await flush();
  // Every entry of the resumed run names the chosen model (the first one is
  // written before the runner starts), so a later revival reopens on it.
  const entries = s.journal("mod").filter((entry) => entry.agent.status !== "completed");
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.deepEqual(entry.agent.model, { provider: "openai", id: "gpt-5.6-sol" });
  }
  s.finishAll();
  await sleep(50);
  await a.shutdown("quit");
});
