/**
 * Replays the counterexample TLC found for QueueProgress in
 * formal/tla/subagent-run (mutation catch-callback-uncontained), the scan's
 * suspected defect S2: when startAgent's .catch settle path called onComplete
 * without the try/catch its .then path uses, a throwing completion callback
 * skipped drainQueue and stranded a queued agent while a pool slot was free.
 * The current code contains the callback on every path; this test keeps it so.
 *
 * Trace: B runs (slot 1 of 1), A queues behind it, B's runner rejects, the
 * .catch path publishes B, releases its slot, onComplete throws, and A must
 * still start. Ordering is forced by the runner's deferred promises.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  type Deferred,
  flush,
  type ResumeResult,
  type RunResult,
} from "./usage-limit-fixture.ts";

const background = { description: "model replay", isBackground: true, isolated: true };

test("a throwing completion callback on a rejected run does not strand the queue", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const runs: Deferred<RunResult>[] = [];
  const runner: AgentManagerRunner = {
    runAgent() {
      const run = deferred<RunResult>();
      runs.push(run);
      return run.promise;
    },
    resumeAgent() {
      return deferred<ResumeResult>().promise;
    },
    async setSessionModel() {},
  };
  const completed: string[] = [];
  const manager = new AgentManager(
    (record) => {
      completed.push(record.description);
      // e.g. pi.appendEntry against a retired context
      throw new Error("completion side effect failed");
    },
    1,
    undefined,
    undefined,
    runner,
  );
  try {
    const first = manager.spawn(env.pi, env.context(), "implementer", "B", {
      ...background,
      description: "B",
    });
    const queued = manager.spawn(env.pi, env.context(), "implementer", "A", {
      ...background,
      description: "A",
    });
    assert.equal(manager.getRecord(queued)?.status, "queued", "A waits for B's slot");
    // A contained callback error never reaches B's promise.
    const settled = manager.getRecord(first)?.promise?.then(
      () => "resolved",
      () => "rejected",
    );

    runs[0].reject(new Error("provider stream failed"));
    await flush();
    assert.deepEqual(completed, ["B"], "B's completion callback ran (and threw)");
    assert.equal(manager.getRecord(first)?.status, "error");
    assert.equal(await settled, "resolved");
    assert.equal(manager.getRecord(queued)?.status, "running", "A starts in the freed slot");
    assert.equal(runs.length, 2);
  } finally {
    manager.dispose();
    cleanupProviders();
  }
});
