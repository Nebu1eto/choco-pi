import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { ResumeModelError, USAGE_LIMIT_RESUME_PROMPT } from "../src/agent-manager.ts";
import { setScopeModelsEnabled } from "../src/model-scope.ts";
import { resolveStopOutcome } from "../src/stop-subagent.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicy,
  policyState,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const SOL = "openai/gpt-5.6-sol";
const OPUS = "anthropic/claude-opus-4-5";

const background = { description: "usage limit", isBackground: true, isolated: true };
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";

/** Real env plus one real child session; built before mock timers are enabled. */
async function setup(t: TestContext): Promise<{ env: UsageLimitEnv; session: AgentSession }> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session = await env.childSession();
  return { env, session };
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
}

test("none: limit settles as error with a usageLimit block and closes the provider", async (t) => {
  const { env, session } = await setup(t);
  const { pi } = env;
  enableTimers(t);
  const resetAt = Date.now() + HOUR;
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt },
    pick: { provider: "openai", id: "gpt-5.6-sol" },
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, completions, usageEvents } = harness();
  try {
    const id = manager.spawn(pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;

    const record = manager.getRecord(id);
    assert.equal(record?.status, "error");
    assert.deepEqual(record?.usageLimit, {
      provider: "anthropic",
      accountId: "default",
      kind: "quota",
      resetAt,
      suggestedModel: SOL,
      status: "reported",
    });
    assert.match(
      record?.error ?? "",
      /Codex usage limit reached[\s\S]*Usage limit: .*suggested model: openai\/gpt-5\.6-sol/,
    );
    assert.deepEqual(completions, ["error"], "exactly one completion");
    assert.deepEqual(usageEvents, ["error:reported"]);
    assert.deepEqual(state.closed, [["anthropic", "default", resetAt]]);
    assert.deepEqual(state.fallbackContexts[0]?.scoped, [SOL, OPUS]);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
    assert.equal(
      manager.isProviderAvailable("anthropic"),
      true,
      "no usage-limit closure in the provider-only registry",
    );
    assert.throws(
      () => manager.spawn(pi, env.context(), "implementer", "again", background),
      /Provider anthropic unavailable .*Usage limit until .*; suggested: openai\/gpt-5\.6-sol\./,
    );
    assert.equal(runs.length, 1, "no substitution: nothing else was started");
    // A closure recorded under owner X never blocks another root owner Y.
    const otherOwner = env.context({ sessionManager: env.freshSessionManager() });
    assert.equal(
      manager.isProviderAvailable("anthropic", otherOwner.sessionManager.getSessionId()),
      true,
    );
    manager.spawn(pi, otherOwner, "implementer", "other owner", background);
    assert.equal(runs.length, 2, "owner Y spawns on the same provider");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("suggestion outside the parent's scoped models is dropped", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "fallback",
    classification: { kind: "billing", confidence: "structured" },
    pick: { provider: "moonshotai", id: "kimi-k3" },
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "error");
    assert.equal(record?.usageLimit?.suggestedModel, undefined);
    assert.equal(record?.usageLimit?.kind, "billing");
    assert.equal(record?.usageLimit?.resetAt, undefined);
    assert.match(record?.error ?? "", /suggested model: none available/);
    assert.equal(state.closed[0]?.[2], Date.now() + 30 * 60_000, "unknown reset closes 30 min");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("an inferred limit that corroboration shows ready is treated as transient", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "inferred" },
    corroborate: () => ({ ready: true }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, usageEvents } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "429 {}",
    });
    await promise;
    assert.equal(manager.getRecord(id)?.status, "error");
    assert.equal(manager.getRecord(id)?.usageLimit, undefined);
    assert.deepEqual(usageEvents, []);
    assert.deepEqual(state.closed, []);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("auto-resume parks, releases its slot, resumes once on the same model, and notifies once", async (t) => {
  const { env, session } = await setup(t);
  const { pi } = env;
  enableTimers(t);
  const resetAt = Date.now() + 60_000;
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt },
    corroborate: (count) => ({ ready: count > 1 }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, resumePrompts, completions, usageEvents, modelSwitches } =
    harness({ maxConcurrent: 1 });
  try {
    const parkedId = manager.spawn(pi, env.context(), "implementer", "task", background);
    // Another provider: the limited provider is closed to new work until the reset.
    const peerId = manager.spawn(pi, env.context(), "implementer", "peer", {
      ...background,
      model: env.models.sol,
    });
    assert.equal(manager.getRecord(peerId)?.status, "queued");
    const promise = manager.getRecord(parkedId)?.promise;
    runs[0].resolve({
      responseText: "partial",
      session,
      aborted: false,
      steered: false,
      failure: LIMIT,
    });
    await promise;

    const record = manager.getRecord(parkedId);
    assert.equal(record?.status, "waiting_for_reset");
    assert.equal(record?.usageLimit?.status, "waiting_for_reset");
    assert.notEqual(record?.terminalResultGeneration, record?.resultGeneration, "unpublished");
    assert.equal(manager.getRecord(peerId)?.status, "running", "pool slot released");
    assert.equal(manager.getScheduledActiveCount(), 1);
    assert.deepEqual(completions, [], "parking is not an outcome");
    assert.deepEqual(usageEvents, ["waiting_for_reset:waiting_for_reset"]);
    assert.equal(resolveStopOutcome(record).kind, "stop");
    assert.equal(manager.steer(parkedId, "note from parent"), true);

    runs[1].resolve({ responseText: "peer done", session, aborted: false, steered: false });
    await flush();
    assert.deepEqual(completions, ["completed"]);

    t.mock.timers.tick(89_999);
    await flush();
    assert.equal(resumePrompts.length, 0, "wake fires at resetAt + 30 s, not before");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.corroborations, 2, "settle-time plus one wake-up check");
    assert.equal(resumePrompts.length, 1);
    assert.match(resumePrompts[0], new RegExp(USAGE_LIMIT_RESUME_PROMPT));
    assert.match(resumePrompts[0], /note from parent/, "held messages join the continuation");
    assert.equal(record?.status, "running");
    assert.equal(record?.resultGeneration, 2);
    assert.equal(modelSwitches.length, 0, "no model substitution");

    resumes[0].resolve({ text: "finished" });
    await flush();
    assert.equal(record?.status, "completed");
    assert.equal(record?.result, "finished");
    assert.equal(record?.usageLimit?.status, "resumed");
    assert.deepEqual(completions, ["completed", "completed"], "exactly one final notification");
    assert.deepEqual(usageEvents, ["waiting_for_reset:waiting_for_reset", "running:resumed"]);

    t.mock.timers.tick(24 * HOUR);
    await flush();
    assert.equal(resumePrompts.length, 1, "resumed exactly once");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("a second limit after the post-reset resume settles as exhausted", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    // Only the wake-up check (the second) reports capacity; the second limit is confirmed.
    corroborate: (count) => ({ ready: count === 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, resumePrompts, completions, usageEvents } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    t.mock.timers.tick(90_001);
    await flush();
    assert.equal(resumePrompts.length, 1);

    resumes[0].resolve({ text: "", failure: LIMIT });
    await flush();
    const record = manager.getRecord(id);
    assert.equal(record?.status, "error");
    assert.equal(record?.usageLimit?.status, "exhausted");
    assert.deepEqual(completions, ["error"]);
    assert.equal(usageEvents.at(-1), "error:exhausted");
    t.mock.timers.tick(24 * HOUR);
    await flush();
    assert.equal(resumePrompts.length, 1, "no second park");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("a foreground child converts to background on park and stop cancels the wait", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
    corroborate: () => ({ ready: false, evidence: "confirmed" }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumePrompts, completions, usageEvents } = harness();
  try {
    const waiting = manager.spawnAndWait(env.pi, env.context(), "implementer", "task", {
      description: "foreground",
      isolated: true,
    });
    await flush();
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    const { id, record } = await waiting;
    assert.equal(record.status, "waiting_for_reset", "caller answered without waiting for reset");
    assert.equal(record.isBackground, true);
    assert.notEqual(record.resultConsumed, true, "final notification still owed");
    assert.deepEqual(completions, []);

    assert.equal(manager.abort(id), true);
    assert.equal(record.status, "stopped");
    assert.equal(record.cancellation?.cause, "user_stop");
    assert.equal(record.error, "Stopped by user request.");
    assert.equal(record.usageLimit?.status, "exhausted", "stopped waits end in a terminal status");
    assert.equal(record.terminalResultGeneration, record.resultGeneration);
    assert.deepEqual(completions, ["stopped"], "exactly one final notification");
    assert.deepEqual(
      usageEvents,
      ["waiting_for_reset:waiting_for_reset", "stopped:exhausted"],
      "exactly one final usage-limit event",
    );
    assert.equal(await record.promise, "", "parked promise released");

    t.mock.timers.tick(2 * HOUR);
    await flush();
    assert.equal(resumePrompts.length, 0, "cancelled wait never resumes");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("session switch and manager dispose cancel waits without notifications", async (t) => {
  const { env, session } = await setup(t);
  const secondSession = await env.childSession();
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
    corroborate: () => ({ ready: false }),
  });
  const installed = installPolicy(state, env.owner);
  const first = harness();
  const second = harness();
  try {
    const switchedId = first.manager.spawn(
      env.pi,
      env.context(),
      "implementer",
      "task",
      background,
    );
    let promise = first.manager.getRecord(switchedId)?.promise;
    first.runs[0].resolve({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: LIMIT,
    });
    await promise;
    assert.equal(first.manager.cancelUsageLimitWaits("Session switched."), 1);
    assert.equal(first.manager.getRecord(switchedId)?.status, "stopped");
    assert.equal(first.manager.getRecord(switchedId)?.cancellation?.cause, "shutdown");
    assert.deepEqual(first.completions, []);
    cleanupProviders();

    const disposedId = second.manager.spawn(
      env.pi,
      env.context(),
      "implementer",
      "task",
      background,
    );
    promise = second.manager.getRecord(disposedId)?.promise;
    second.runs[0].resolve({
      responseText: "",
      session: secondSession,
      aborted: false,
      steered: false,
      failure: LIMIT,
    });
    await promise;
    second.manager.dispose();
    assert.equal(second.manager.getRecord(disposedId), undefined, "settled and removed");
    assert.deepEqual(second.completions, []);

    t.mock.timers.tick(2 * HOUR);
    await flush();
    assert.equal(first.resumePrompts.length + second.resumePrompts.length, 0);
  } finally {
    first.manager.dispose();
    second.manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("unknown reset polls every 5 minutes for at most 6 hours, then settles exhausted", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed" },
    corroborate: () => ({ ready: false }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumePrompts, completions } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    assert.equal(manager.getRecord(id)?.status, "waiting_for_reset");
    const record = manager.getRecord(id);

    t.mock.timers.tick(5 * 60_000);
    await flush();
    assert.equal(state.corroborations, 2);
    for (let step = 0; step < 72; step++) {
      t.mock.timers.tick(5 * 60_000);
      await flush();
    }
    assert.equal(record?.status, "error");
    assert.equal(record?.usageLimit?.status, "exhausted");
    assert.match(record?.error ?? "", /Auto-resume gave up/);
    assert.equal(state.corroborations, 73, "one settle-time check plus 72 polls");
    assert.deepEqual(completions, ["error"]);
    assert.equal(resumePrompts.length, 0);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("a nested record uses its root session's policy", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    classification: { kind: "quota", confidence: "structured", resetAt: Date.now() + HOUR },
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs } = harness();
  try {
    const parentId = manager.spawn(env.pi, env.context(), "implementer", "parent", {
      ...background,
      rootSessionId: env.owner,
    });
    const childContext = env.context({ sessionManager: env.freshSessionManager() });
    assert.notEqual(childContext.sessionManager.getSessionId(), env.owner);
    const childId = manager.spawn(env.pi, childContext, "implementer", "child", {
      description: "nested",
      isolated: true,
      parentAgentId: parentId,
      depth: 2,
    });
    const promise = manager.getRecord(childId)?.promise;
    runs[1].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    assert.equal(manager.getRecord(childId)?.usageLimit?.status, "reported");
    assert.equal(manager.getRecord(parentId)?.status, "running");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("resume with model validates scope and availability, and reports setModel failure", async (t) => {
  const { env, session } = await setup(t);
  const cwd = await mkdtemp(join(tmpdir(), "usage-limit-scope-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ enabledModels: [OPUS, SOL] }),
  );
  let failSetModel = false;
  const { manager, runs, resumes, resumePrompts, modelSwitches } = harness({
    setSessionModel: async () => {
      if (failSetModel) throw new Error("No API key for openai");
    },
  });
  setScopeModelsEnabled(true);
  try {
    const id = manager.spawn(env.pi, env.context({ cwd }), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    await promise;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "completed");

    await assert.rejects(
      manager.resume(id, "continue", undefined, {
        model: "moonshotai/kimi-k3",
        isBackground: true,
      }),
      (error: Error) => error instanceof ResumeModelError && /not in scope/.test(error.message),
    );
    await assert.rejects(
      manager.resume(id, "continue", undefined, { model: "nobody/nothing", isBackground: true }),
      (error: Error) => error instanceof ResumeModelError && /not available/.test(error.message),
    );
    failSetModel = true;
    await assert.rejects(
      manager.resume(id, "continue", undefined, { model: SOL, isBackground: true }),
      (error: Error) =>
        error instanceof ResumeModelError && /Failed to switch .*No API key/.test(error.message),
    );
    assert.equal(record?.status, "completed", "refused switches leave the record untouched");
    assert.equal(record?.resultGeneration, 1);
    assert.equal(resumePrompts.length, 0);

    failSetModel = false;
    const resumed = await manager.resume(id, "continue", undefined, {
      model: SOL,
      isBackground: true,
    });
    assert.equal(resumed?.status, "running");
    assert.deepEqual(
      modelSwitches.map((entry) => `${entry.provider}/${entry.id}`),
      [SOL, SOL],
    );
    resumes[0].resolve({ text: "ok" });
    await flush();
    assert.equal(record?.status, "completed");
  } finally {
    setScopeModelsEnabled(false);
    manager.dispose();
    cleanupProviders();
  }
});

test("a hung corroboration cannot stall settlement past the policy timeout", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
  });
  const installed = installPolicy(state, env.owner);
  installed.policy.corroborate = () => new Promise(() => undefined);
  const { manager, runs, completions } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await flush();
    assert.equal(manager.getRecord(id)?.status, "running", "still evaluating");
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(manager.getRecord(id)?.status, "error");
    assert.equal(manager.getRecord(id)?.usageLimit?.status, "reported");
    assert.deepEqual(completions, ["error"]);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});
