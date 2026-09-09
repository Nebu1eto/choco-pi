import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";

function partialHostFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each caller supplies the exact host-owned slice exercised by its injected runner path.
  return fixture as T;
}

test("pre-aborted foreground resume records cancellation instead of false completion", async () => {
  const session = partialHostFixture<AgentSession>({ dispose: () => undefined });
  const runner: AgentManagerRunner = {
    async runAgent() {
      return { responseText: "ready", session, aborted: false, steered: false };
    },
    async resumeAgent(_session, _prompt, options) {
      assert.ok(options);
      assert.equal(options.signal?.aborted, true);
      return { text: "" };
    },
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const id = manager.spawn(
    partialHostFixture<ExtensionAPI>({}),
    partialHostFixture<ExtensionContext>({ cwd: process.cwd() }),
    "implementer",
    "initial",
    { description: "pre-aborted resume", isBackground: false },
  );
  await manager.getRecord(id)?.promise;
  const signal = new AbortController();
  signal.abort(new Error("parent gone"));

  const resumed = await manager.resume(id, "resume", signal.signal);
  assert.equal(resumed?.status, "stopped");
  assert.equal(resumed?.cancellation?.cause, "parent_signal");
  assert.equal(resumed?.error, resumed?.cancellation?.reason);
  assert.equal(resumed?.terminalResultGeneration, resumed?.resultGeneration);
  manager.dispose();
});

test("foreground resume owns the current promise until cancelled runner settlement", async () => {
  let resolveResume: ((value: { text: string }) => void) | undefined;
  const session = partialHostFixture<AgentSession>({ dispose: () => undefined });
  const runner: AgentManagerRunner = {
    async runAgent() {
      return { responseText: "ready", session, aborted: false, steered: false };
    },
    resumeAgent() {
      return new Promise((resolve) => {
        resolveResume = resolve;
      });
    },
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const id = manager.spawn(
    partialHostFixture<ExtensionAPI>({}),
    partialHostFixture<ExtensionContext>({ cwd: process.cwd() }),
    "implementer",
    "initial",
    { description: "foreground ownership", isBackground: false },
  );
  const record = manager.getRecord(id);
  assert.ok(record?.promise);
  await record.promise;
  const previousPromise = record.promise;
  const resumeResult = manager.resume(id, "delayed");
  assert.notEqual(
    record.promise,
    previousPromise,
    "new generation replaces the settled owner promise",
  );
  assert.equal(manager.abort(id), true);

  let waitSettled = false;
  const waiting = manager.waitForAll().then(() => {
    waitSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    waitSettled,
    false,
    "waitForAll remains pending while the cancelled runner owns cleanup",
  );

  resolveResume?.({ text: "partial resume" });
  await resumeResult;
  await waiting;
  assert.equal(waitSettled, true);
  assert.equal(record.status, "stopped");
  assert.equal(record.result, "partial resume");
  assert.equal(record.terminalResultGeneration, record.resultGeneration);
  manager.dispose();
});

test("budget-cancelled startup discards queued steering and refuses new messages", async () => {
  let createSession: ((session: AgentSession) => void) | undefined;
  let resolveRun:
    | ((value: {
        responseText: string;
        session: AgentSession;
        aborted: boolean;
        steered: boolean;
      }) => void)
    | undefined;
  const steers: string[] = [];
  const session = partialHostFixture<AgentSession>({
    sessionManager: partialHostFixture<AgentSession["sessionManager"]>({
      getSessionFile: () => undefined,
    }),
    steer: async (message: string) => void steers.push(message),
    dispose: () => undefined,
  });
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      createSession = options.onSessionCreated;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    },
    async resumeAgent() {
      return { text: "unused" };
    },
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const id = manager.spawn(
    partialHostFixture<ExtensionAPI>({}),
    partialHostFixture<ExtensionContext>({ cwd: process.cwd() }),
    "implementer",
    "run",
    {
      description: "cancel startup",
      isBackground: true,
      budgets: { timeoutMs: 5 },
    },
  );
  assert.equal(manager.steer(id, "before session"), true);
  assert.deepEqual(manager.getRecord(id)?.pendingSteers, ["before session"]);
  while (!manager.getRecord(id)?.abortController?.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(manager.getRecord(id)?.status, "running");
  assert.equal(manager.getRecord(id)?.cancellation?.cause, "budget");
  assert.equal(
    manager.getRecord(id)?.pendingSteers,
    undefined,
    "cancellation discards queued steering",
  );
  assert.equal(manager.steer(id, "after budget"), false);
  createSession?.(session);
  assert.deepEqual(steers, []);
  resolveRun?.({ responseText: "partial", session, aborted: true, steered: false });
  await manager.getRecord(id)?.promise;
  assert.equal(manager.getRecord(id)?.result, "partial");
  manager.dispose();
});

test("shutdown disposes settled sessions now and pending sessions only after unwind", async () => {
  let resolvePending:
    | ((value: {
        responseText: string;
        session: AgentSession;
        aborted: boolean;
        steered: boolean;
      }) => void)
    | undefined;
  let settledDisposals = 0;
  let pendingDisposals = 0;
  const settledSession = partialHostFixture<AgentSession>({
    sessionManager: partialHostFixture<AgentSession["sessionManager"]>({
      getSessionFile: () => undefined,
    }),
    dispose: () => settledDisposals++,
  });
  const pendingSession = partialHostFixture<AgentSession>({
    sessionManager: partialHostFixture<AgentSession["sessionManager"]>({
      getSessionFile: () => undefined,
    }),
    dispose: () => pendingDisposals++,
  });
  const completions: string[] = [];
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, prompt, options) {
      const session = prompt === "settled" ? settledSession : pendingSession;
      options.onSessionCreated?.(session);
      if (prompt === "settled") {
        return Promise.resolve({ responseText: "done", session, aborted: false, steered: false });
      }
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    },
    async resumeAgent() {
      return { text: "unused" };
    },
  };
  const manager = new AgentManager(
    (record) => completions.push(record.id),
    2,
    undefined,
    undefined,
    runner,
  );
  const pi = partialHostFixture<ExtensionAPI>({});
  const ctx = partialHostFixture<ExtensionContext>({ cwd: process.cwd() });
  const options = { description: "shutdown boundary", isBackground: true };
  const settledId = manager.spawn(pi, ctx, "implementer", "settled", options);
  await manager.getRecord(settledId)?.promise;
  assert.equal(completions.length, 1);
  const pendingId = manager.spawn(pi, ctx, "implementer", "pending", options);
  const pendingRecord = manager.getRecord(pendingId);
  assert.ok(pendingRecord);

  manager.dispose();
  assert.equal(settledDisposals, 1);
  assert.equal(pendingDisposals, 0);
  assert.equal(pendingRecord.cancellation?.cause, "shutdown");

  resolvePending?.({
    responseText: "late",
    session: pendingSession,
    aborted: true,
    steered: false,
  });
  await pendingRecord.promise;
  assert.equal(pendingDisposals, 1);
  assert.equal(completions.length, 1, "shutdown suppresses late completion callbacks");
  assert.equal(manager.getRecord(pendingId), undefined);
});
