import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { NUDGE_HOLD_MS } from "../src/notification-gate.ts";
import {
  ADMISSION_CLOSED_MESSAGE,
  isStopReport,
  STOP_CONTROL_REGISTRY_KEY,
  STOP_CONTROL_REPORT_CHANNEL,
  STOP_CONTROL_REVOKE_CHANNEL,
  type StopReport,
} from "../src/stop-control-contract.ts";
import type { StopWorkflowPort } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  type Harness,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const run = promisify(execFile);
const background = { description: "stop", isBackground: true, isolated: true };

// ---------------------------------------------------------------------------
// Fake coordinator registry (the real one lives in the root extension)
// ---------------------------------------------------------------------------

type Latch = { epoch: number; closed: boolean };

function installRegistry(t: TestContext, latches: Map<string, Latch>): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, STOP_CONTROL_REGISTRY_KEY);
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    value: {
      protocol: "choco-pi:stop-control/v1",
      state: (root: string) => latches.get(root) ?? { epoch: 0, closed: false },
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, previous);
    else Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
  });
}

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  manager: AgentManager;
  latches: Map<string, Latch>;
  root: string;
}

async function setup(t: TestContext, maxConcurrent = 4): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const h = harness({ maxConcurrent });
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  const latches = new Map<string, Latch>();
  installRegistry(t, latches);
  return { env, h, manager: h.manager, latches, root: env.owner };
}

function spawn(s: Setup, prompt: string, extra: Record<string, string | boolean> = {}): string {
  return s.manager.spawn(s.env.pi, s.env.context(), "implementer", prompt, {
    ...background,
    ...extra,
  });
}

const noWorkflows: StopWorkflowPort = { runningFor: () => [], cancel: () => false };

// ---------------------------------------------------------------------------
// Manager: revocation
// ---------------------------------------------------------------------------

test("root stop cancels queued and running records with cause user_stop and settles once", async (t) => {
  const s = await setup(t, 1);
  const runningId = spawn(s, "running");
  const queuedId = spawn(s, "queued");
  assert.equal(s.manager.getRecord(runningId)?.status, "running");
  assert.equal(s.manager.getRecord(queuedId)?.status, "queued");
  assert.equal(s.manager.getRecord(queuedId)?.admissionRoot, s.root);
  assert.equal(s.manager.getRecord(queuedId)?.admissionEpoch, 0);

  const stop = s.manager.stopAllForRoot(s.root, noWorkflows);
  assert.equal(stop.agents, 2);
  assert.equal(stop.workflows, 0);
  for (const id of [runningId, queuedId]) {
    const record = s.manager.getRecord(id);
    assert.equal(record?.status, "stopped");
    assert.equal(record?.cancellation?.cause, "user_stop");
    assert.equal(record?.stoppedByUser, true);
  }
  // The queued record never started: exactly one run exists, and it is aborted.
  assert.equal(s.h.runs.length, 1);
  assert.equal(s.h.runOptions[0]?.signal?.aborted, true);

  let settled = false;
  void stop.settled.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false, "settled waits for the running record to publish");
  const session = await s.env.childSession();
  s.h.runs[0]?.resolve({ responseText: "", session, aborted: true, steered: false });
  assert.deepEqual(await stop.settled, []);
  assert.equal(s.manager.getRecord(runningId)?.terminalResultGeneration, 1);

  // Repeating the request stops nothing new and still resolves.
  const again = s.manager.stopAllForRoot(s.root, noWorkflows);
  assert.equal(again.agents, 0);
  assert.deepEqual(await again.settled, []);
  assert.equal(s.h.runs.length, 1);
});

test("root stop cancels workflows before stopping their agents and ignores other roots", async (t) => {
  const s = await setup(t);
  const stepId = spawn(s, "step", { workflowId: "wf-1" });
  const otherCtx = s.env.context({ sessionManager: s.env.freshSessionManager() });
  const otherId = s.manager.spawn(s.env.pi, otherCtx, "implementer", "other root", background);
  const order: string[] = [];
  const port: StopWorkflowPort = {
    runningFor: (root) => (root === s.root ? ["wf-extra"] : []),
    cancel: (id) => {
      order.push(`${id}:${s.manager.getRecord(stepId)?.status}`);
      return true;
    },
  };
  const stop = s.manager.stopAllForRoot(s.root, port);
  assert.deepEqual(order.sort(), ["wf-1:running", "wf-extra:running"]);
  assert.equal(stop.workflows, 2);
  assert.equal(s.manager.getRecord(stepId)?.status, "stopped");
  assert.equal(s.manager.getRecord(otherId)?.status, "running", "another root keeps running");
});

test("agent-scope stop targets the subtree only and allows nested refs", async (t) => {
  const s = await setup(t);
  const parentId = spawn(s, "parent");
  const siblingId = spawn(s, "sibling");
  const childId = s.manager.spawn(s.env.pi, s.env.context(), "implementer", "child", {
    ...background,
    parentAgentId: parentId,
    depth: 2,
  });
  const childRecord = s.manager.getRecord(childId);
  assert.ok(childRecord?.handle);
  assert.equal(s.manager.findRecordForStop(childRecord.handle)?.id, childId);
  assert.equal(s.manager.findRecordForStop(childId)?.id, childId);
  const parent = s.manager.getRecord(parentId);
  assert.ok(parent);

  const stop = s.manager.stopTreeForUser(parent, noWorkflows);
  assert.equal(stop.agents, 2);
  assert.equal(s.manager.getRecord(parentId)?.status, "stopped");
  assert.equal(s.manager.getRecord(childId)?.status, "stopped");
  assert.equal(s.manager.getRecord(siblingId)?.status, "running");
  // A nested record is also reachable on its own.
  const nested = s.manager.getRecord(siblingId);
  assert.ok(nested);
  const lone = s.manager.stopTreeForUser(nested, noWorkflows);
  assert.equal(lone.agents, 1);
});

test("a parked record stops as user_stop and ownerSessionIds are snapshotted", async (t) => {
  const s = await setup(t);
  const id = spawn(s, "with session");
  const session = await s.env.childSession();
  const record = s.manager.getRecord(id);
  assert.ok(record);
  record.session = session;
  const stop = s.manager.stopAllForRoot(s.root, noWorkflows);
  assert.deepEqual(stop.ownerSessionIds, [session.sessionManager.getSessionId()]);
  s.h.runs[0]?.resolve({ responseText: "", session, aborted: true, steered: false });
  await stop.settled;
});

// ---------------------------------------------------------------------------
// Manager: admission
// ---------------------------------------------------------------------------

test("spawn is refused with the verbatim message while the latch is closed", async (t) => {
  const s = await setup(t);
  s.latches.set(s.root, { epoch: 3, closed: true });
  assert.throws(
    () => spawn(s, "refused"),
    (error) => error instanceof Error && error.message === ADMISSION_CLOSED_MESSAGE,
  );
  assert.equal(s.manager.listAgents().length, 0);
  assert.equal(s.h.runs.length, 0);
  // Reopening admits again, under the new epoch.
  s.latches.set(s.root, { epoch: 4, closed: false });
  const id = spawn(s, "admitted");
  assert.equal(s.manager.getRecord(id)?.admissionEpoch, 4);
});

test("resume is refused while closed, before and after a barrier-released model switch", async (t) => {
  const s = await setup(t);
  const id = spawn(s, "to resume");
  const session = await s.env.childSession();
  s.h.runs[0]?.resolve({ responseText: "done", session, aborted: false, steered: false });
  await s.manager.getRecord(id)?.promise;
  assert.equal(s.manager.getRecord(id)?.status, "completed");

  s.latches.set(s.root, { epoch: 1, closed: true });
  await assert.rejects(
    () => s.manager.resume(id, "again", undefined, { isBackground: true }),
    (error) => error instanceof Error && error.message === ADMISSION_CLOSED_MESSAGE,
  );
  assert.equal(s.h.resumes.length, 0);
  assert.equal(s.manager.getRecord(id)?.status, "completed", "nothing changed");

  // Open at entry, closed while the model switch awaits: still refused, run never starts.
  s.latches.set(s.root, { epoch: 2, closed: false });
  const sol = s.env.models.sol;
  const gate = Promise.withResolvers<void>();
  const switching = new AgentManager(undefined, 4, undefined, undefined, {
    runAgent: () => new Promise(() => undefined),
    resumeAgent: () => new Promise(() => undefined),
    setSessionModel: () => gate.promise,
  });
  t.after(() => switching.dispose());
  const sid = switching.spawn(s.env.pi, s.env.context(), "implementer", "p", background);
  const ssession = await s.env.childSession();
  const srecord = switching.getRecord(sid);
  assert.ok(srecord);
  srecord.session = ssession;
  srecord.status = "completed";
  srecord.terminalResultGeneration = srecord.resultGeneration ?? 1;
  const attempt = switching.resume(sid, "go", undefined, {
    isBackground: true,
    model: `${sol.provider}/${sol.id}`,
  });
  const outcome = attempt.then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  );
  s.latches.set(s.root, { epoch: 3, closed: true });
  gate.resolve();
  const message = await outcome;
  assert.notEqual(message, "resolved");
  assert.ok(
    message === ADMISSION_CLOSED_MESSAGE || /model|resume/i.test(message),
    `unexpected outcome: ${message}`,
  );
  assert.equal(switching.getRecord(sid)?.status, "completed", "the resumed run never started");
});

test("a queued spawn that reaches its start while closed settles stopped/user_stop, never runs", async (t) => {
  const s = await setup(t, 1);
  const firstId = spawn(s, "first");
  const queuedId = spawn(s, "queued behind");
  assert.equal(s.manager.getRecord(queuedId)?.status, "queued");
  // The latch closes without the coordinator stopping the queue (barrier-released start).
  s.latches.set(s.root, { epoch: 1, closed: true });
  const session = await s.env.childSession();
  s.h.runs[0]?.resolve({ responseText: "", session, aborted: false, steered: false });
  await s.manager.getRecord(firstId)?.promise;
  await flush();
  const queued = s.manager.getRecord(queuedId);
  assert.equal(queued?.status, "stopped");
  assert.equal(queued?.cancellation?.cause, "user_stop");
  assert.equal(queued?.error, ADMISSION_CLOSED_MESSAGE);
  assert.equal(queued?.terminalResultGeneration, queued?.resultGeneration);
  assert.equal(s.h.runs.length, 1, "the refused item never started a run");
});

test("a spawn whose cwd check is awaited while the latch closes never starts a session", async (t) => {
  const s = await setup(t);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "stop-admission-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const id = s.manager.spawn(s.env.pi, s.env.context(), "implementer", "cwd", {
    ...background,
    cwd,
  });
  // prepareRun is awaiting the directory check; close the latch without stopping the record.
  s.latches.set(s.root, { epoch: 1, closed: true });
  await s.manager.getRecord(id)?.promise;
  assert.equal(s.h.runs.length, 0, "no session was created");
  assert.equal(s.manager.getRecord(id)?.status, "error");
  assert.equal(s.manager.getRecord(id)?.error, ADMISSION_CLOSED_MESSAGE);
});

test("resumeDormant is refused while closed and nothing is reserved", async (t) => {
  const s = await setup(t);
  s.manager.setJournalSink({ rootSessionId: s.root, append: () => undefined });
  s.manager.hydrateDormant([
    {
      id: "dorm-1",
      handle: "implementer-dorm",
      type: "implementer",
      description: "dormant",
      depth: 1,
      status: "interrupted",
      options: { isBackground: true, isolated: true },
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      revivals: 0,
      resultConsumed: false,
      sessionFile: join(tmpdir(), "does-not-matter.jsonl"),
    },
  ]);
  s.latches.set(s.root, { epoch: 1, closed: true });
  await assert.rejects(
    () => s.manager.resumeDormant("dorm-1", "go", { pi: s.env.pi, ctx: s.env.context() }),
    (error) => error instanceof Error && error.message === ADMISSION_CLOSED_MESSAGE,
  );
  assert.equal(s.h.runs.length, 0);
  assert.equal(s.manager.canResumeDormant("dorm-1"), true, "still resumable after /resume-work");
});

// ---------------------------------------------------------------------------
// Isolated worktree: stopped through the coordinator path keeps the work, no commit
// ---------------------------------------------------------------------------

test("a worktree run stopped by the user reports its retained path and makes no commit", async (t) => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "stop-worktree-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = async (cwd: string, ...args: string[]) =>
    (
      await run(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd },
      )
    ).stdout.trim();
  await git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");

  const s = await setup(t);
  let workPath: string | undefined;
  const hostCtx = s.env.context({ cwd: repo });
  const id = s.manager.spawn(s.env.pi, hostCtx, "implementer", "edit", {
    description: "wt",
    isBackground: true,
    isolated: true,
    isolation: "worktree",
  });
  for (let i = 0; i < 400 && s.h.runs.length === 0; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(s.h.runs.length, 1, "run started inside a created worktree");
  const worktree = s.manager.getRecord(id)?.worktree;
  assert.ok(worktree);
  workPath = worktree.path;
  t.after(() => rm(workPath ?? repo, { recursive: true, force: true }));
  await writeFile(join(workPath, "partial.txt"), "partial\n");
  const headBefore = await git(workPath, "rev-parse", "HEAD");
  const branchesBefore = await git(repo, "branch", "--list");

  const stop = s.manager.stopAllForRoot(s.root, noWorkflows);
  const session = await s.env.childSession();
  s.h.runs[0]?.resolve({ responseText: "", session, aborted: true, steered: false });
  assert.deepEqual(await stop.settled, [workPath]);
  assert.equal(await git(workPath, "rev-parse", "HEAD"), headBefore);
  assert.equal(await git(repo, "branch", "--list"), branchesBefore);
  assert.match(await git(workPath, "status", "--porcelain"), /\?\? partial\.txt/);
});

// ---------------------------------------------------------------------------
// Extension: revoke handler and notification gating
// ---------------------------------------------------------------------------

type RuntimeValue = {} | null | undefined;
type BusHandler = (data: RuntimeValue) => void;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;

interface Bus {
  on: (channel: string, handler: BusHandler) => () => void;
  emit: (channel: string, data: RuntimeValue) => void;
}

function createBus(): Bus {
  const handlers = new Map<string, Set<BusHandler>>();
  return {
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set<BusHandler>();
      set.add(handler);
      handlers.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

function partial<T extends object>(value: Partial<T>): T {
  // SAFETY: Fixtures supply only the host members the registered extension exercises.
  return value as T;
}

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The host fixture implements the registration and delivery members exercised here.
  return value as ExtensionAPI;
}

interface Delivery {
  triggerTurn?: boolean;
  deliverAs?: string;
}

async function extensionFixture(t: TestContext, latches: Map<string, Latch>) {
  installRegistry(t, latches);
  const lifecycle = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const bus = createBus();
  const deliveries: Array<Delivery | undefined> = [];
  const notices: RuntimeValue[] = [];
  const reports: StopReport[] = [];
  const lifecycleEvents: string[] = [];
  bus.on(STOP_CONTROL_REPORT_CHANNEL, (data) => {
    assert.ok(isStopReport(data), "reports match the contract");
    reports.push(data);
  });
  const pi = asExtensionAPI({
    events: {
      emit: (channel: string, data: RuntimeValue) => {
        if (channel.startsWith("subagents:")) lifecycleEvents.push(channel);
        bus.emit(channel, data);
      },
      on: (channel: string, handler: BusHandler) => bus.on(channel, handler),
    },
    on: (name: string, handler: LifecycleHandler) => {
      lifecycle.set(name, handler);
    },
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    appendEntry: () => undefined,
    sendMessage: (message: RuntimeValue, options: Delivery | undefined) => {
      notices.push(message);
      deliveries.push(options);
    },
  });
  await subagentsExtension(pi);

  const runner: Pick<AgentManagerRunner, "runAgent" | "resumeAgent"> = {
    runAgent(_ctx, _type, _prompt, options) {
      return new Promise((resolve) => {
        const finish = () =>
          resolve({
            responseText: "preserved partial output",
            session: partial<AgentSession>({ dispose: () => undefined }),
            aborted: options.signal?.aborted === true,
            steered: false,
          });
        pending.push(finish);
      });
    },
    async resumeAgent() {
      throw new Error("unexpected resume");
    },
  };
  const pending: Array<() => void> = [];
  const spawn = AgentManager.prototype.spawn;
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      Object.defineProperty(this, "runner", { value: runner, configurable: true, writable: true });
      return spawn.apply(this, args);
    },
  );
  const root = "p4b2-root";
  const ctx = partial<ExtensionContext>({
    cwd: process.cwd(),
    sessionManager: partial<ExtensionContext["sessionManager"]>({
      getSessionId: () => root,
      getEntries: () => [],
    }),
  });
  const start = lifecycle.get("session_start");
  assert.ok(start);
  await start({}, ctx);
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: Root activation owns this documented manager slot in this isolated test process.
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: Pick<AgentManager, "spawn" | "getRecord" | "waitForAll"> | undefined;
  };
  const manager = registry[key];
  assert.ok(manager);
  return {
    root,
    bus,
    manager,
    reports,
    deliveries,
    notices,
    pending,
    pi,
    ctx,
    tools,
    toolCtx: toolContext(ctx),
    lifecycleEvents,
    spawnAgent: () =>
      manager.spawn(pi, ctx, "implementer", "p", {
        description: "stop",
        isBackground: true,
        isolated: true,
      }),
    async close() {
      for (const finish of pending) finish();
      await manager.waitForAll();
      const shutdown = lifecycle.get("session_shutdown");
      assert.ok(shutdown);
      await shutdown();
    },
  };
}

test("revoke(all) acknowledges synchronously, settles once, ignores foreign or invalid requests", async (t) => {
  const host = await extensionFixture(t, new Map());
  try {
    const id = host.spawnAgent();
    assert.equal(host.manager.getRecord(id)?.status, "running");

    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, {
      requestId: "r0",
      rootSessionId: "someone-else",
      epoch: 1,
      scope: "all",
    });
    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, { requestId: "bad", scope: "all" });
    assert.equal(host.reports.length, 0);
    assert.equal(host.manager.getRecord(id)?.status, "running");

    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, {
      requestId: "r1",
      rootSessionId: host.root,
      epoch: 1,
      scope: "all",
    });
    // Acknowledged synchronously, before any await.
    assert.equal(host.reports.length, 1);
    assert.equal(host.reports[0]?.phase, "acknowledged");
    assert.equal(host.reports[0]?.participant, "subagents");
    assert.deepEqual(host.reports[0]?.counts, { agents: 1, workflows: 0 });
    assert.equal(host.manager.getRecord(id)?.status, "stopped");
    assert.ok(host.lifecycleEvents.includes("subagents:stopped"));

    // A repeated request is idempotent: nothing new is stopped.
    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, {
      requestId: "r2",
      rootSessionId: host.root,
      epoch: 1,
      scope: "all",
    });
    assert.deepEqual(host.reports[1]?.counts, { agents: 0, workflows: 0 });

    for (const finish of host.pending) finish();
    await flush();
    await flush();
    const settled = host.reports.filter((report) => report.phase === "settled");
    assert.deepEqual(settled.map((report) => report.requestId).sort(), ["r1", "r2"]);
    assert.equal(host.reports.filter((report) => report.requestId === "r1").length, 2);
  } finally {
    await host.close();
  }
});

test("revoke(agent) with an unknown ref fails synchronously with the verbatim detail", async (t) => {
  const host = await extensionFixture(t, new Map());
  try {
    const id = host.spawnAgent();
    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, {
      requestId: "a1",
      rootSessionId: host.root,
      epoch: 0,
      scope: "agent",
      agentRef: "ghost",
    });
    assert.equal(host.reports.length, 1);
    assert.equal(host.reports[0]?.phase, "failed");
    assert.equal(
      host.reports[0]?.detail,
      'No agent matches "ghost" in this session; nothing was stopped.',
    );
    assert.equal(host.manager.getRecord(id)?.status, "running");

    const handle = host.manager.getRecord(id)?.handle;
    assert.ok(handle);
    host.bus.emit(STOP_CONTROL_REVOKE_CHANNEL, {
      requestId: "a2",
      rootSessionId: host.root,
      epoch: 0,
      scope: "agent",
      agentRef: handle,
    });
    assert.equal(host.reports[1]?.phase, "acknowledged");
    assert.deepEqual(host.reports[1]?.counts, { agents: 1, workflows: 0 });
    assert.equal(host.manager.getRecord(id)?.status, "stopped");
  } finally {
    await host.close();
  }
});

test("a completion from a stopped epoch is delivered but never triggers a turn; the result stays readable once", async (t) => {
  const latches = new Map<string, Latch>();
  const host = await extensionFixture(t, latches);
  try {
    const id = host.spawnAgent();
    assert.equal(host.manager.getRecord(id)?.admissionEpoch, 0);
    // /stop landed (epoch 1, closed) while the child was mid-run; it still finishes by itself.
    latches.set(host.root, { epoch: 1, closed: true });
    for (const finish of host.pending) finish();
    await host.manager.waitForAll();
    await new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 50));
    assert.ok(host.notices.length >= 1, "the notification is still delivered");
    assert.deepEqual(host.deliveries.at(-1), { deliverAs: "steer", triggerTurn: false });

    const read = host.tools.get("get_subagent_result");
    assert.ok(read);
    const first = await read.execute("r", { agent_id: id }, undefined, undefined, host.toolCtx);
    const firstText = first.content[0];
    assert.match(firstText?.type === "text" ? firstText.text : "", /preserved partial output/);
    const second = await read.execute("r", { agent_id: id }, undefined, undefined, host.toolCtx);
    const secondText = second.content[0];
    assert.doesNotMatch(
      secondText?.type === "text" ? secondText.text : "",
      /preserved partial output/,
    );
  } finally {
    await host.close();
  }
});

test("a reopened epoch does not relabel old work: an old-epoch completion still cannot trigger", async (t) => {
  const latches = new Map<string, Latch>();
  const host = await extensionFixture(t, latches);
  try {
    host.spawnAgent();
    latches.set(host.root, { epoch: 2, closed: false });
    for (const finish of host.pending) finish();
    await host.manager.waitForAll();
    await new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 50));
    assert.deepEqual(host.deliveries.at(-1), { deliverAs: "steer", triggerTurn: false });

    // Work authorised under the open epoch keeps today's behaviour.
    host.pending.length = 0;
    host.spawnAgent();
    for (const finish of host.pending) finish();
    await host.manager.waitForAll();
    await new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 50));
    assert.deepEqual(host.deliveries.at(-1), { deliverAs: "steer", triggerTurn: true });
  } finally {
    await host.close();
  }
});

test("workflow_run is refused while closed and an old-epoch aggregate never triggers a turn", async (t) => {
  const latches = new Map<string, Latch>();
  const host = await extensionFixture(t, latches);
  try {
    const tool = host.tools.get("workflow_run");
    assert.ok(tool);
    latches.set(host.root, { epoch: 1, closed: true });
    const refused = await tool.execute(
      "w",
      { name: "wf", steps: [{ id: "a", subagent_type: "implementer", prompt: "do" }] },
      undefined,
      undefined,
      host.toolCtx,
    );
    const text = refused.content[0];
    assert.equal(text?.type === "text" ? text.text : "", ADMISSION_CLOSED_MESSAGE);
    latches.set(host.root, { epoch: 2, closed: false });

    const started = await tool.execute(
      "w2",
      { name: "wf", steps: [{ id: "a", subagent_type: "implementer", prompt: "do" }] },
      undefined,
      undefined,
      host.toolCtx,
    );
    const startedText = started.content[0];
    assert.match(startedText?.type === "text" ? startedText.text : "", /Workflow started/);
    // The workflow settles by itself (this host cannot run steps); /stop lands before its
    // aggregate notification leaves the hold, so the old-epoch notice must not start a turn.
    latches.set(host.root, { epoch: 3, closed: true });
    await new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 50));
    const aggregate = host.notices.findLast((notice) =>
      JSON.stringify(notice).includes("workflow-notification"),
    );
    assert.ok(aggregate, "the aggregate notice is still delivered");
    assert.deepEqual(host.deliveries.at(-1), { deliverAs: "steer", triggerTurn: false });
  } finally {
    await host.close();
  }
});
