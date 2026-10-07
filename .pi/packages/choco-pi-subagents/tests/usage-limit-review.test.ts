/**
 * Review corrections for the "On Usage Limit" manager paths: queued wake
 * ownership, exclusive resume, owner-scoped closures, corroboration verdicts,
 * cancelled evaluation, foreground-resume and worktree parking, and nested
 * resume with a model.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { ResumeModelError } from "../src/agent-manager.ts";
import { createNestedSubagentTools } from "../src/nested-tools.ts";
import { ProviderUnavailableError } from "../src/provider-health.ts";
import { setWorktreeIsolationEnabled } from "../src/worktree.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  flush,
  harness,
  installPolicy,
  policyState,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const SOL = "openai/gpt-5.6-sol";
const OPUS = "anthropic/claude-opus-4-5";
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const background = { description: "usage limit", isBackground: true, isolated: true };
const run = promisify(execFile);

async function setup(t: TestContext): Promise<{ env: UsageLimitEnv; session: AgentSession }> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  return { env, session: await env.childSession() };
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("a queued post-reset continuation keeps promise ownership when stopped", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    corroborate: (count) => ({ ready: count === 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumePrompts, completions, usageEvents } = harness({
    maxConcurrent: 1,
  });
  try {
    const parkedId = manager.spawn(env.pi, env.context(), "implementer", "A", background);
    const parkedPromise = manager.getRecord(parkedId)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await parkedPromise;
    const record = manager.getRecord(parkedId);
    assert.equal(record?.status, "waiting_for_reset");

    // B takes the only pool slot on another provider.
    manager.spawn(env.pi, env.context(), "implementer", "B", {
      ...background,
      model: env.models.sol,
    });
    assert.equal(runs.length, 2);

    t.mock.timers.tick(90_000);
    await flush();
    assert.equal(record?.status, "queued", "reset confirmed; continuation waits for a slot");
    assert.equal(resumePrompts.length, 0);
    const owned = record?.promise;
    assert.ok(owned);

    assert.equal(manager.abort(parkedId), true);
    assert.equal(record?.status, "stopped");
    assert.equal(record?.error, "Stopped by user request.");
    assert.equal(record?.usageLimit?.status, "exhausted");
    assert.equal(await owned, "", "the parked promise settles on the queued stop");
    assert.deepEqual(completions, ["stopped"], "exactly one final notification");
    assert.deepEqual(usageEvents, [
      "waiting_for_reset:waiting_for_reset",
      "queued:resumed",
      "stopped:exhausted",
    ]);

    runs[1].resolve({ responseText: "B done", session, aborted: false, steered: false });
    await manager.waitForAll();
    assert.equal(resumePrompts.length, 0, "the stopped continuation never starts");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("session switch and dispose release a queued continuation's promise without notifying", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    // Two settle-time checks (one per manager), then both wake-ups report capacity.
    corroborate: (count) => ({ ready: count > 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const switched = harness({ maxConcurrent: 1 });
  const disposed = harness({ maxConcurrent: 1 });
  try {
    for (const target of [switched, disposed]) {
      const id = target.manager.spawn(env.pi, env.context(), "implementer", "A", background);
      const first = target.manager.getRecord(id)?.promise;
      target.runs[0].resolve({
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: LIMIT,
      });
      await first;
      target.manager.spawn(env.pi, env.context(), "implementer", "B", {
        ...background,
        model: env.models.sol,
      });
      // Both managers share the owner's closure; reopen it for the second one.
      cleanupProviders();
    }
    t.mock.timers.tick(90_000);
    await flush();
    const switchedRecord = switched.manager.listAgents().find((r) => r.status === "queued");
    const disposedRecord = disposed.manager.listAgents().find((r) => r.status === "queued");
    assert.ok(switchedRecord?.promise && disposedRecord?.promise);
    const switchedPromise = switchedRecord.promise;
    const disposedPromise = disposedRecord.promise;

    assert.equal(switched.manager.cancelUsageLimitWaits("Session switched."), 1);
    assert.equal(switchedRecord.status, "stopped");
    assert.equal(await switchedPromise, "");
    assert.deepEqual(switched.completions, []);

    disposed.manager.dispose();
    assert.equal(await disposedPromise, "");
    assert.deepEqual(disposed.completions, []);
  } finally {
    switched.manager.dispose();
    disposed.manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("concurrent resume with model: the second call is refused before any side effect", async (t) => {
  const { env, session } = await setup(t);
  const auth = deferred<undefined>();
  const { manager, runs, resumePrompts, modelSwitches } = harness({
    setSessionModel: async () => {
      await auth.promise;
    },
  });
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const first = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    await first;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "completed");

    const winner = manager.resume(id, "one", undefined, { model: SOL, isBackground: true });
    await flush();
    assert.equal(modelSwitches.length, 1, "first switch is awaiting authentication");
    assert.equal(
      await manager.resume(id, "two", undefined, { model: OPUS, isBackground: true }),
      undefined,
    );
    assert.equal(await manager.resume(id, "three", undefined, { isBackground: true }), undefined);
    assert.equal(modelSwitches.length, 1, "the refused call never touched the session");
    assert.equal(record?.status, "completed");
    assert.equal(record?.resultGeneration, 1);
    assert.equal(resumePrompts.length, 0);

    auth.resolve(undefined);
    const resumed = await winner;
    assert.equal(resumed?.status, "running");
    assert.deepEqual(resumePrompts, ["one"]);
    assert.deepEqual(
      modelSwitches.map((model) => `${model.provider}/${model.id}`),
      [SOL],
    );
  } finally {
    manager.dispose();
    cleanupProviders();
  }
});

test("the owning root's policy closure blocks spawn and drain; other owners are unaffected", async (t) => {
  const { env, session } = await setup(t);
  let closed = true;
  const state = policyState({
    isClosed: (providerKey, accountId) =>
      closed && providerKey === "anthropic" && accountId === "default",
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, completions } = harness({ maxConcurrent: 1 });
  try {
    assert.throws(
      () => manager.spawn(env.pi, env.context(), "implementer", "blocked", background),
      (error: Error) =>
        error instanceof ProviderUnavailableError &&
        /Provider anthropic unavailable/.test(error.message),
    );
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
    assert.equal(manager.isProviderAvailable("anthropic"), true, "no transient closure");

    const other = env.context({ sessionManager: env.freshSessionManager() });
    manager.spawn(env.pi, other, "implementer", "other owner", background);
    assert.equal(runs.length, 1, "another owner spawns on the same provider");

    // Queued under the closing owner: the drain consults the same closure.
    closed = false;
    const queuedId = manager.spawn(env.pi, env.context(), "implementer", "queued", background);
    assert.equal(manager.getRecord(queuedId)?.status, "queued");
    closed = true;
    runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    await flush();
    const queued = manager.getRecord(queuedId);
    assert.equal(queued?.status, "error");
    assert.match(queued?.error ?? "", /Provider anthropic unavailable/);
    assert.equal(runs.length, 1, "the closed provider never started");
    assert.deepEqual(completions, ["completed", "error"]);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

for (const scenario of [
  {
    name: "an inferred limit without evidence is transient",
    confidence: "inferred",
    answer: { ready: false },
    parked: false,
    limited: false,
  },
  {
    name: "an inferred limit whose evidence is unavailable is transient",
    confidence: "inferred",
    answer: { ready: false, evidence: "unavailable" },
    parked: false,
    limited: false,
  },
  {
    name: "a parsed limit whose evidence reports capacity is transient",
    confidence: "parsed",
    answer: { ready: false, evidence: "capacity" },
    parked: false,
    limited: false,
  },
  {
    name: "a parsed limit whose evidence is unavailable is reported, not parked",
    confidence: "parsed",
    answer: { ready: false, evidence: "unavailable" },
    parked: false,
    limited: true,
  },
  {
    name: "an inferred limit with confirmed evidence parks",
    confidence: "inferred",
    answer: { ready: false, evidence: "confirmed" },
    parked: true,
    limited: true,
  },
] as const) {
  test(`corroboration verdict: ${scenario.name}`, async (t) => {
    const { env, session } = await setup(t);
    enableTimers(t);
    const state = policyState({
      preference: "auto-resume",
      classification: {
        kind: "quota",
        confidence: scenario.confidence,
        resetAt: Date.now() + HOUR,
      },
      corroborate: () => scenario.answer,
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
      const record = manager.getRecord(id);
      if (scenario.parked) {
        assert.equal(record?.status, "waiting_for_reset");
      } else {
        assert.equal(record?.status, "error");
      }
      if (scenario.limited) {
        assert.equal(
          record?.usageLimit?.status,
          scenario.parked ? "waiting_for_reset" : "reported",
        );
        assert.equal(state.closed.length, 1);
        assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
      } else {
        assert.equal(record?.usageLimit, undefined, "no usage-limit block");
        assert.deepEqual(state.closed, [], "no closure");
        assert.deepEqual(usageEvents, []);
        assert.equal(manager.isProviderAvailable("anthropic", env.owner), false, "transient gate");
        assert.equal(manager.isProviderAvailable("anthropic", "another-owner"), false);
      }
    } finally {
      manager.dispose();
      installed.remove();
      cleanupProviders();
    }
  });
}

test("an evaluation cancelled during corroboration writes no closure", async (t) => {
  const { env, session } = await setup(t);
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
  });
  const installed = installPolicy(state, env.owner);
  const answer = deferred<{
    ready: boolean;
    classification: {
      kind: "quota";
      provider: string;
      modelId: string;
      confidence: "parsed";
    };
  }>();
  installed.policy.corroborate = () => answer.promise;
  const { manager, runs, completions, usageEvents } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await flush();
    assert.equal(manager.getRecord(id)?.status, "running", "still evaluating");
    assert.equal(manager.abort(id), true);
    answer.resolve({
      ready: false,
      classification: {
        kind: "quota",
        provider: "anthropic",
        modelId: "claude-opus-4-5",
        confidence: "parsed",
      },
    });
    await flush();
    const record = manager.getRecord(id);
    assert.equal(record?.status, "stopped");
    assert.equal(record?.usageLimit, undefined);
    assert.deepEqual(state.closed, [], "no policy closure");
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true, "no local closure");
    assert.deepEqual(usageEvents, []);
    assert.deepEqual(completions, ["stopped"]);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("a foreground resume that hits a limit under auto-resume parks and converts to background", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    corroborate: (count) => ({ ready: count === 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, resumePrompts, completions, usageEvents } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const first = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    await first;
    assert.deepEqual(completions, ["completed"]);

    const foreground = manager.resume(id, "more");
    await flush();
    resumes[0].resolve({ text: "", failure: LIMIT });
    const record = await foreground;
    assert.equal(record?.status, "waiting_for_reset", "the caller is answered now");
    assert.equal(record?.isBackground, true);
    assert.notEqual(record?.resultConsumed, true, "final notification still owed");
    assert.deepEqual(completions, ["completed"]);
    assert.deepEqual(usageEvents, ["waiting_for_reset:waiting_for_reset"]);

    t.mock.timers.tick(90_000);
    await flush();
    assert.equal(resumePrompts.length, 2, "continued on the same session after the reset");
    resumes[1].resolve({ text: "finished" });
    await flush();
    assert.equal(record?.status, "completed");
    assert.equal(record?.result, "finished");
    assert.deepEqual(completions, ["completed", "completed"], "one notification per outcome");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

async function createRepo(t: TestContext): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "usage-limit-worktree-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await run("git", ["add", "."], { cwd: repo });
  await run(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  return repo;
}

for (const ending of ["continuation", "stop"] as const) {
  test(`a worktree record parks and keeps its worktree until the final settle (${ending})`, async (t) => {
    const { env, session } = await setup(t);
    const repo = await createRepo(t);
    setWorktreeIsolationEnabled(true);
    enableTimers(t);
    const state = policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
      corroborate: (count) => ({ ready: count === 2 }),
    });
    const installed = installPolicy(state, env.owner);
    const { manager, runs, resumes, completions } = harness();
    try {
      const id = manager.spawn(env.pi, env.context({ cwd: repo }), "implementer", "task", {
        ...background,
        isolation: "worktree",
      });
      const record = manager.getRecord(id);
      const worktree = record?.worktree;
      assert.ok(worktree, "worktree created");
      const first = record?.promise;
      runs[0].resolve({
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: LIMIT,
      });
      await first;
      assert.equal(record?.status, "waiting_for_reset");
      assert.equal(await exists(worktree.path), true, "kept while parked");
      assert.equal(record?.worktreeResult, undefined);

      if (ending === "continuation") {
        t.mock.timers.tick(90_000);
        await flush();
        assert.equal(record?.status, "running");
        assert.equal(await exists(worktree.path), true, "kept for the continuation");
        resumes[0].resolve({ text: "finished" });
        await flush();
        assert.equal(record?.status, "completed");
      } else {
        assert.equal(manager.abort(id), true);
        assert.equal(record?.status, "stopped");
      }
      assert.deepEqual(record?.worktreeResult, { hasChanges: false });
      assert.equal(await exists(worktree.path), false, "cleaned on the final settle");
      assert.equal(completions.length, 1);
    } finally {
      manager.dispose();
      installed.remove();
      cleanupProviders();
    }
  });
}

test("nested resume forwards and validates model through the manager", async (t) => {
  const { env, session } = await setup(t);
  let closeOpenAi = false;
  const state = policyState({
    isClosed: (providerKey) => closeOpenAi && providerKey === "openai",
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, modelSwitches } = harness();
  try {
    const parentId = manager.spawn(env.pi, env.context(), "implementer", "parent", {
      ...background,
      rootSessionId: env.owner,
    });
    const childId = manager.spawn(env.pi, env.context(), "implementer", "child", {
      description: "nested",
      isolated: true,
      parentAgentId: parentId,
      depth: 2,
    });
    const childPromise = manager.getRecord(childId)?.promise;
    runs[1].resolve({ responseText: "child done", session, aborted: false, steered: false });
    await childPromise;
    assert.equal(manager.getRecord(childId)?.status, "completed");

    const [agentTool] = createNestedSubagentTools({
      manager,
      pi: env.pi,
      parentAgentId: parentId,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: env.base.cwd,
    });
    const resumeWith = (model: string) =>
      agentTool.execute(
        "call",
        {
          prompt: "continue",
          description: "resume child",
          subagent_type: "implementer",
          resume: childId,
          model,
        },
        undefined,
        undefined,
        toolContext(env.context()),
      );

    closeOpenAi = true;
    const refused = await resumeWith(SOL);
    assert.match(
      JSON.stringify(refused.content),
      /Failed to resume nested agent .*Provider openai unavailable/,
    );
    assert.equal(modelSwitches.length, 0, "a closed target is refused before the switch");

    closeOpenAi = false;
    const pending = resumeWith(SOL);
    await flush();
    assert.deepEqual(
      modelSwitches.map((model) => `${model.provider}/${model.id}`),
      [SOL],
    );
    resumes[0].resolve({ text: "resumed on sol" });
    const result = await pending;
    assert.match(JSON.stringify(result.content), /resumed on sol/);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("resume model errors stay ResumeModelError instances across modules", () => {
  assert.equal(new ResumeModelError("x").name, "ResumeModelError");
});
