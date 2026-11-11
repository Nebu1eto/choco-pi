/**
 * A throwing completion callback is a side-effect failure of one run. It must
 * not stop queued runs from starting, leak a concurrency slot, surface as an
 * unhandled rejection, or settle any run more than once. Two settle paths are
 * covered: the spawn `.catch` handler and `drainQueue`'s provider-block refusal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import type { AgentRecord } from "../src/types.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  flush,
  type Deferred,
  type RunResult,
} from "./usage-limit-fixture.ts";

const background = { description: "oncomplete throw", isBackground: true, isolated: true };

interface Completion {
  id: string;
  status: AgentRecord["status"];
}

function throwingHarness(throwFor: Set<string>) {
  const runs: Deferred<RunResult>[] = [];
  const completions: Completion[] = [];
  const runner: AgentManagerRunner = {
    runAgent() {
      const run = deferred<RunResult>();
      runs.push(run);
      return run.promise;
    },
    async resumeAgent() {
      throw new Error("unexpected resume");
    },
  };
  const manager = new AgentManager(
    (record) => {
      completions.push({ id: record.id, status: record.status });
      if (throwFor.has(record.id)) throw new Error(`completion side effect failed: ${record.id}`);
    },
    1,
    undefined,
    undefined,
    runner,
  );
  return { manager, runs, completions };
}

interface UnhandledCapture {
  reasons: string[];
  remove(): void;
}

function captureUnhandled(): UnhandledCapture {
  const reasons: string[] = [];
  const listener = (reason: Error | string) => {
    reasons.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", listener);
  return { reasons, remove: () => process.off("unhandledRejection", listener) };
}

function countFor(completions: Completion[], id: string): number {
  return completions.filter((completion) => completion.id === id).length;
}

test("a throwing onComplete on the spawn .catch path still drains the queue", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session: AgentSession = await env.childSession();
  const throwFor = new Set<string>();
  const { manager, runs, completions } = throwingHarness(throwFor);
  const unhandled = captureUnhandled();
  try {
    const first = manager.spawn(env.pi, env.context(), "implementer", "first", background);
    const second = manager.spawn(env.pi, env.context(), "implementer", "second", background);
    throwFor.add(first);
    await flush();
    assert.equal(runs.length, 1, "concurrency limit of one holds the second run");
    assert.equal(manager.getRecord(second)?.status, "queued");

    // Runner rejection takes the spawn `.catch` settle path.
    runs[0].reject(new Error("runner crashed"));
    await flush();

    assert.equal(manager.getRecord(first)?.status, "error", "failed run still settles");
    assert.equal(countFor(completions, first), 1, "failed run completes exactly once");
    assert.equal(runs.length, 2, "queued run starts after the throwing completion");
    assert.equal(manager.getRecord(second)?.status, "running");
    assert.deepEqual(unhandled.reasons, [], "no unhandled rejection");

    runs[1].resolve({ responseText: "done", session, aborted: false, steered: false });
    await flush();
    assert.equal(manager.getRecord(second)?.status, "completed");
    assert.equal(countFor(completions, second), 1);
    assert.deepEqual(unhandled.reasons, [], "no unhandled rejection after drain");
  } finally {
    unhandled.remove();
    manager.dispose();
    cleanupProviders();
  }
});

test("a throwing onComplete in drainQueue's provider refusal keeps draining", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session: AgentSession = await env.childSession();
  const throwFor = new Set<string>();
  const { manager, runs, completions } = throwingHarness(throwFor);
  const unhandled = captureUnhandled();
  try {
    // first and refused run on anthropic (the context default); other on openai.
    const first = manager.spawn(env.pi, env.context(), "implementer", "first", background);
    const refused = manager.spawn(env.pi, env.context(), "implementer", "refused", background);
    const other = manager.spawn(env.pi, env.context(), "implementer", "other", {
      ...background,
      model: env.models.sol,
    });
    throwFor.add(refused);
    await flush();
    assert.equal(runs.length, 1);

    // A terminal rate-limit failure closes anthropic, so the drain after the
    // first run refuses the queued anthropic run and calls onComplete for it.
    runs[0].resolve({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "rate_limit_error: 429",
    });
    await flush();

    assert.equal(manager.getRecord(first)?.status, "error");
    assert.equal(countFor(completions, first), 1, "first run completes exactly once");
    assert.equal(manager.getRecord(refused)?.status, "error", "refused run settles");
    assert.equal(countFor(completions, refused), 1, "refused run completes exactly once");
    assert.equal(runs.length, 2, "the next queued run starts");
    assert.equal(manager.getRecord(other)?.status, "running");
    assert.deepEqual(unhandled.reasons, [], "no unhandled rejection");

    runs[1].resolve({ responseText: "done", session, aborted: false, steered: false });
    await flush();
    assert.equal(manager.getRecord(other)?.status, "completed");
    assert.equal(countFor(completions, other), 1);
    assert.deepEqual(unhandled.reasons, [], "no unhandled rejection after drain");
  } finally {
    unhandled.remove();
    manager.dispose();
    cleanupProviders();
  }
});
