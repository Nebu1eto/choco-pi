import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { resetProviderHealth } from "../src/provider-health.ts";
import type { UsageLimitPolicy } from "../src/usage-limit-seam.ts";

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

test("a stopped run rejects resume until settlement, then starts a fresh generation", async () => {
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
    1,
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
    const prematureResume = await manager.resume(agentId, "resumed", undefined, {
      isBackground: true,
      name: "must-not-mutate",
    });
    assert.equal(prematureResume, undefined);
    assert.equal(
      manager.hasRunning(),
      true,
      "pending cancellation remains active until settlement",
    );
    assert.equal(manager.getActiveCount(), 2, "the stopped parent and live child still own runs");
    assert.equal(stoppedRecord.resultGeneration, 1);
    assert.notEqual(stoppedRecord.alias, "must-not-mutate");
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

    assert.equal(stoppedRecord.terminalResultGeneration, 1);
    assert.equal(stoppedRecord.result, "stale result");
    assert.equal(stoppedRecord.cancellation?.cause, "user_stop");
    assert.deepEqual(completions, [`${agentId}:1`]);
    assert.equal(manager.getRecord(childId)?.status, "stopped");
    assert.equal(manager.getRecord(childId)?.abortController?.signal.aborted, true);
    assert.equal(manager.getRecord(queuedId)?.status, "running");
    assert.match(starts.join(","), /queued/);

    const resumedRecord = await manager.resume(agentId, "resumed", undefined, {
      isBackground: true,
    });
    assert.equal(resumedRecord?.resultGeneration, 2);
    assert.equal(resumedRecord?.cancellation, undefined);

    resumed.resolve({ text: "current result" });
    queued.resolve({ responseText: "queued result", session, aborted: false, steered: false });
    nested.resolve({ responseText: "partial child", session, aborted: true, steered: false });
    await Promise.all([
      manager.getRecord(agentId)?.promise,
      manager.getRecord(queuedId)?.promise,
      manager.getRecord(childId)?.promise,
    ]);

    manager.setMaxConcurrent(2);
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

test("a usage-limit-parked record refuses resume until stopped, then resumes as a fresh generation", async () => {
  const session = reinterpretHostValue<AgentSession>({
    sessionManager: { getSessionFile: () => undefined },
    model: { provider: "anthropic-generation-usage-limit", id: "m" },
    dispose: () => undefined,
  });
  const initial = deferred<{
    responseText: string;
    session: AgentSession;
    aborted: boolean;
    steered: boolean;
    failure?: string;
  }>();
  const runner: AgentManagerRunner = {
    runAgent: () => initial.promise,
    resumeAgent: async () => ({ text: "resumed" }),
  };
  const owner = "generation-usage-limit-owner";
  const slotKey = Symbol.for("choco-pi.usage-limit-policy");
  interface Slot {
    [slotKey]?: Map<string, UsageLimitPolicy>;
  }
  // SAFETY: The test owns this process-global slot for its duration.
  const slots = globalThis as typeof globalThis & Slot;
  const policies = slots[slotKey] ?? new Map<string, UsageLimitPolicy>();
  slots[slotKey] = policies;
  policies.set(owner, {
    owner,
    generation: 1,
    preference: async () => "auto-resume",
    classify: () => ({
      kind: "quota",
      provider: "anthropic-generation-usage-limit",
      modelId: "m",
      resetAt: Date.now() + 3_600_000,
      confidence: "structured",
    }),
    corroborate: async (classification) => ({ ready: false, classification }),
    pickFallback: () => undefined,
    closeProvider: () => undefined,
    isClosed: () => false,
  });
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const ctx = reinterpretHostValue<ExtensionContext>({
    cwd: process.cwd(),
    model: { provider: "anthropic-generation-usage-limit", id: "m" },
    sessionManager: { getSessionId: () => owner },
  });
  try {
    const id = manager.spawn(reinterpretHostValue<ExtensionAPI>({}), ctx, "implementer", "task", {
      description: "parked generation",
      isBackground: true,
      isolated: true,
    });
    const promise = manager.getRecord(id)?.promise;
    initial.resolve({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "limit",
    });
    await promise;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "waiting_for_reset");
    assert.equal(record?.resultGeneration, 1);
    assert.equal(await manager.resume(id, "again", undefined, { isBackground: true }), undefined);
    assert.equal(record?.resultGeneration, 1, "refused resume does not advance the generation");

    assert.equal(manager.abort(id), true);
    assert.equal(record?.terminalResultGeneration, 1);
    // The limit's closure still holds: resume is refused like spawn.
    await assert.rejects(
      manager.resume(id, "again", undefined, { isBackground: true }),
      /Provider anthropic-generation-usage-limit unavailable/,
    );
    assert.equal(record?.resultGeneration, 1, "a refused resume changes nothing");
    resetProviderHealth("anthropic-generation-usage-limit");
    const resumed = await manager.resume(id, "again", undefined, { isBackground: true });
    assert.equal(resumed?.resultGeneration, 2);
    assert.equal(resumed?.usageLimit, undefined, "a caller resume starts a new outcome");
    await resumed?.promise;
    assert.equal(record?.status, "completed");
  } finally {
    manager.dispose();
    policies.delete(owner);
    resetProviderHealth("anthropic-generation-usage-limit");
  }
});
