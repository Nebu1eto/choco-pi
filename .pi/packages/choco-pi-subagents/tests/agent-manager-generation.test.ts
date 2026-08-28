import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

type RuntimeValue = {} | null | undefined;

function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: Callers provide the exact minimal host shape consumed by the injected test runner.
  return value as Target;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("a stopped run settling after resume releases its own slot and drains the queue", async () => {
  const session = reinterpretHostValue<AgentSession>({
    sessionManager: { getSessionFile: () => undefined },
    dispose: () => undefined,
  });
  const initial = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const nested = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const queued = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const laterOne = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const laterTwo = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const resumed = deferred<{ text: string; failure?: string }>();
  const runs = new Map([
    ["initial", initial],
    ["nested", nested],
    ["queued", queued],
    ["later-one", laterOne],
    ["later-two", laterTwo],
  ]);
  const starts: string[] = [];
  const completions: string[] = [];
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, prompt, options) {
      const run = runs.get(prompt);
      assert.ok(run, `unexpected prompt: ${prompt}`);
      starts.push(prompt);
      options.onSessionCreated?.(session);
      return run.promise;
    },
    resumeAgent(_session, prompt) {
      assert.equal(prompt, "resumed");
      starts.push(`resume:${prompt}`);
      return resumed.promise;
    },
  };
  const manager = new AgentManager(
    (record) => completions.push(`${record.id}:${record.resultGeneration}`),
    2,
    undefined,
    undefined,
    runner,
  );
  // SAFETY: The injected runner does not inspect ExtensionAPI or ExtensionContext beyond ctx.cwd.
  const pi = {} as ExtensionAPI;
  // SAFETY: The injected runner reads only the supplied cwd from this ExtensionContext fixture.
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  const background = { description: "generation race", isBackground: true, isolated: true };

  try {
    const agentId = manager.spawn(pi, ctx, "implementer", "initial", background);
    const stalePromise = manager.getRecord(agentId)?.promise;
    assert.ok(stalePromise);
    const childId = manager.spawn(pi, ctx, "implementer", "nested", {
      ...background,
      parentAgentId: agentId,
      depth: 2,
    });

    const stoppedRecord = manager.getRecord(agentId);
    assert.ok(stoppedRecord);
    stoppedRecord.resultConsumed = true; // stop_subagent suppresses its redundant completion nudge.
    assert.equal(manager.abort(agentId), true, "stop_subagent reaches this manager abort boundary");
    const resumedRecord = await manager.resume(agentId, "resumed", undefined, {
      isBackground: true,
    });
    assert.equal(resumedRecord?.resultGeneration, 2);
    const queuedId = manager.spawn(pi, ctx, "implementer", "queued", background);
    assert.equal(manager.getRecord(queuedId)?.status, "queued");
    assert.doesNotMatch(starts.join(","), /queued/);

    initial.resolve({
      responseText: "stale result",
      session,
      aborted: true,
      steered: false,
    });
    await stalePromise;

    assert.deepEqual(completions, [], "stale settlement skips onComplete");
    assert.equal(manager.getRecord(childId)?.status, "stopped");
    assert.equal(manager.getRecord(childId)?.abortController?.signal.aborted, true);
    assert.equal(manager.getRecord(queuedId)?.status, "running");
    assert.match(starts.join(","), /queued/);

    resumed.resolve({ text: "current result" });
    queued.resolve({ responseText: "queued result", session, aborted: false, steered: false });
    nested.resolve({ responseText: "partial child", session, aborted: true, steered: false });
    await Promise.all([
      manager.getRecord(agentId)?.promise,
      manager.getRecord(queuedId)?.promise,
      manager.getRecord(childId)?.promise,
    ]);

    const laterOneId = manager.spawn(pi, ctx, "implementer", "later-one", background);
    const laterTwoId = manager.spawn(pi, ctx, "implementer", "later-two", background);
    assert.equal(manager.getRecord(laterOneId)?.status, "running");
    assert.equal(manager.getRecord(laterTwoId)?.status, "running");

    laterOne.resolve({ responseText: "one", session, aborted: false, steered: false });
    laterTwo.resolve({ responseText: "two", session, aborted: false, steered: false });
    await Promise.all([
      manager.getRecord(laterOneId)?.promise,
      manager.getRecord(laterTwoId)?.promise,
    ]);
  } finally {
    manager.dispose();
  }
});
