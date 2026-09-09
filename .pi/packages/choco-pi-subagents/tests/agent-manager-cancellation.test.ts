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

for (const cancellation of ["user", "budget", "shutdown"] as const) {
  for (const settlement of ["resolve", "reject"] as const) {
    test(
      `${cancellation}-cancelled startup retains child ownership on ${settlement}`,
      { timeout: 2_000 },
      async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const run = Promise.withResolvers<Awaited<ReturnType<AgentManagerRunner["runAgent"]>>>();
        let createSession: ((session: AgentSession) => void) | undefined;
        let callbacks = 0;
        let completions = 0;
        let disposals = 0;
        let outputFlushes = 0;
        const steers: string[] = [];
        const sessionFile = "/tmp/child-session.jsonl";
        const session = partialHostFixture<AgentSession>({
          sessionManager: partialHostFixture<AgentSession["sessionManager"]>({
            getSessionFile: () => sessionFile,
            getSessionId: () => "cancelled-child",
          }),
          getSessionStats: () =>
            partialHostFixture<ReturnType<AgentSession["getSessionStats"]>>({
              sessionId: "cancelled-child",
              cost: 2,
            }),
          steer: async (message) => void steers.push(message),
          dispose: () => disposals++,
        });
        const runner: AgentManagerRunner = {
          runAgent(_ctx, _type, _prompt, options) {
            createSession = options.onSessionCreated;
            return run.promise;
          },
          async resumeAgent() {
            return { text: "unused" };
          },
        };
        const manager = new AgentManager(() => completions++, 1, undefined, undefined, runner);
        const id = manager.spawn(
          partialHostFixture<ExtensionAPI>({}),
          partialHostFixture<ExtensionContext>({ cwd: process.cwd() }),
          "implementer",
          "run",
          {
            description: "late child ownership",
            isBackground: true,
            budgets: cancellation === "budget" ? { timeoutMs: 5 } : undefined,
            mainSessionFork: {
              sessionManager: session.sessionManager,
              systemPrompt: "fork",
              model: undefined,
              thinkingLevel: undefined,
            },
            onSessionCreated(created) {
              assert.equal(created, session);
              callbacks++;
              const current = manager.getRecord(id);
              assert.ok(current);
              current.outputCleanup = () => outputFlushes++;
            },
          },
        );
        const record = manager.getRecord(id);
        assert.ok(record?.promise);
        try {
          assert.equal(manager.steer(id, "queued before creation"), true);
          if (cancellation === "shutdown") manager.dispose();
          else if (cancellation === "budget") t.mock.timers.tick(5);
          else assert.equal(manager.abort(id), true);
          assert.equal(record.abortController?.signal.aborted, true);
          assert.equal(record.cancellation?.generation, record.resultGeneration);
          assert.notEqual(record.terminalResultGeneration, record.resultGeneration);
          assert.equal(record.pendingSteers, undefined);
          assert.equal(manager.steer(id, "after cancellation"), false);
          assert.ok(createSession);
          createSession(session);
          assert.equal(record.session, session, "capture the owned session before settlement");
          assert.equal(record.sessionFile, sessionFile);
          assert.deepEqual(record.sessionCostBaseline, { sessionId: "cancelled-child", cost: 2 });
          assert.equal(callbacks, cancellation === "shutdown" ? 0 : 1);
          assert.deepEqual(steers, []);
          assert.equal(disposals, 0, "runner still owns session until unwind");
          if (settlement === "reject") run.reject(new Error("startup failed after creation"));
          else run.resolve({ responseText: "partial", session, aborted: true, steered: false });
          await record.promise;
          assert.equal(callbacks, cancellation === "shutdown" ? 0 : 1);
          assert.equal(outputFlushes, callbacks, "observational transcript wiring flushes once");
          assert.equal(completions, cancellation === "shutdown" ? 0 : 1);
          if (cancellation === "shutdown") {
            assert.notEqual(record.terminalResultGeneration, record.resultGeneration);
            assert.equal(manager.getRecord(id), undefined);
          } else {
            assert.equal(record.terminalResultGeneration, record.resultGeneration);
            assert.equal(disposals, 0);
            if (settlement === "resolve") assert.equal(record.result, "partial");
          }
          manager.dispose();
          assert.equal(disposals, 1);
          assert.equal(manager.getRecord(id), undefined);
          assert.equal(
            manager.listTombstones().find((entry) => entry.id === id)?.sessionFile,
            sessionFile,
          );
          manager.dispose();
          assert.equal(disposals, 1, "cleanup is exact-once");
        } finally {
          run.resolve({ responseText: "cleanup", session, aborted: true, steered: false });
          await record.promise;
          manager.dispose();
        }
      },
    );
  }
}

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
