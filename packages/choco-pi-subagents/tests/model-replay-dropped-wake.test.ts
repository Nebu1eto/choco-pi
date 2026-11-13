/**
 * Replays two counterexamples TLC found in formal/tla/subagent-run (now the
 * mutation dropped-wake-publishes-early) against the real manager.
 *
 * A worktree agent parks on a usage limit; at the reset its continuation is
 * queued behind another agent; the user stops it while queued. The finalizer
 * (settleDroppedWake) runs the deferred worktree cleanup, which appends the
 * retained-worktree note to record.result, and then calls onComplete. Before
 * the fix the stop published the stopped generation at once (stopQueuedRecord),
 * so in that window:
 *
 * - StaleInert: a resume was admitted (the generation was published), and the
 *   late onComplete reported the record while it belonged to the new run.
 * - ReadSeesFinal: a result read saw text that the cleanup changed later.
 *
 * The finalizer now publishes after the cleanup, as settleParked does; until
 * then the stopped record is terminal-unpublished, which resumeBlockedByRun
 * treats as busy.
 *
 * Ordering is forced with the runner's deferred promises and mock timers; the
 * only real I/O is the git worktree, which the test waits for by condition.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { claimSubagentResultRead } from "../src/result-read.ts";
import type { AgentRecord } from "../src/types.ts";
import { setWorktreeIsolationEnabled } from "../src/worktree.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  type Harness,
  installPolicy,
  policyState,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";
import { waitFor } from "./wait-for.ts";

const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const background = { description: "model replay", isBackground: true, isolated: true };
const run = promisify(execFile);

async function createRepo(t: TestContext): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "model-replay-worktree-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await run("git", ["add", "."], { cwd: repo });
  await run(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"].concat([
      "commit",
      "-qm",
      "init",
    ]),
    { cwd: repo },
  );
  return repo;
}

interface Scenario {
  env: UsageLimitEnv;
  h: Harness;
  id: string;
  record: AgentRecord;
  worktreePath: string;
  remove(): void;
}

/**
 * Trace steps 2-12: A (worktree) runs, B queues, A parks on a confirmed quota
 * limit (B starts), the reset is confirmed, A's continuation queues behind B.
 */
async function queuedContinuation(t: TestContext): Promise<Scenario> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session: AgentSession = await env.childSession();
  const repo = await createRepo(t);
  setWorktreeIsolationEnabled(true);
  t.after(() => setWorktreeIsolationEnabled(false));
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    corroborate: (count) => ({ ready: count === 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const h = harness({ maxConcurrent: 1 });
  const id = h.manager.spawn(env.pi, env.context({ cwd: repo }), "implementer", "A", {
    ...background,
    isolation: "worktree",
  });
  const record = h.manager.getRecord(id);
  assert.ok(record !== undefined);
  h.manager.spawn(env.pi, env.context(), "implementer", "B", {
    ...background,
    model: env.models.sol,
  });
  await waitFor(() => h.runs.length > 0, "A's worktree was created and its run started");
  const worktreePath = record.worktree?.path;
  assert.ok(worktreePath !== undefined, "A runs in a worktree");
  t.after(() => rm(worktreePath, { recursive: true, force: true }));
  const first = record.promise;
  h.runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
  await first;
  assert.equal(record.status, "waiting_for_reset", "A parked");
  assert.equal(h.runs.length, 2, "B took the freed slot");

  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(record.status, "queued", "A's post-reset continuation waits for B's slot");
  return {
    env,
    h,
    id,
    record,
    worktreePath,
    remove: () => {
      h.manager.dispose();
      installed.remove();
      cleanupProviders();
    },
  };
}

test("a stopped queued continuation's late completion never reports a newer generation", async (t) => {
  const s = await queuedContinuation(t);
  try {
    // Step 12: stop the queued continuation.
    assert.equal(s.h.manager.abort(s.id), true);
    assert.equal(s.record.status, "stopped");
    const stoppedGeneration = s.record.resultGeneration;
    assert.deepEqual(s.h.completions, [], "completion waits for the worktree cleanup");

    // Step 13: resume in the same tick, before the git cleanup settles.
    const resumed = await s.h.manager.resume(s.id, "again", undefined, background);
    // Compare a boolean, never the record: a failing assert on an AgentRecord
    // diffs its whole session graph and runs for minutes.
    assert.equal(
      resumed === undefined,
      true,
      "the unpublished stopped generation refuses a resume",
    );
    assert.equal(s.record.resultGeneration, stoppedGeneration);

    // Step 14: the deferred cleanup settles, then publication and onComplete.
    await waitFor(() => s.h.completions.length > 0, "the dropped wake's completion");
    await flush();
    assert.deepEqual(
      s.h.completions,
      ["stopped"],
      "the stopped generation's completion reports the stopped outcome",
    );
    assert.equal(s.record.terminalResultGeneration, stoppedGeneration, "published once settled");
  } finally {
    s.remove();
  }
});

test("a stopped queued continuation's result is final when it is published", async (t) => {
  const s = await queuedContinuation(t);
  try {
    assert.equal(s.h.manager.abort(s.id), true);
    // get_subagent_result's synchronous claim before the cleanup settles.
    const early = claimSubagentResultRead(s.record);
    assert.equal(early.kind, "terminal-pending", "not readable before the cleanup settles");

    await waitFor(
      () => s.record.terminalResultGeneration === s.record.resultGeneration,
      "the stopped generation's publication",
    );
    const claim = claimSubagentResultRead(s.record);
    assert.equal(claim.kind, "terminal");
    const readResult = s.record.result;
    assert.match(readResult ?? "", /Work retained in worktree/, "the note is part of the result");
    await waitFor(() => s.h.completions.length > 0, "the dropped wake's completion");
    await flush();
    assert.equal(s.record.result, readResult, "the read result was final");
  } finally {
    s.remove();
  }
});

test("a stopped queued continuation disposed before its cleanup publishes without a completion", async (t) => {
  const s = await queuedContinuation(t);
  try {
    assert.equal(s.h.manager.abort(s.id), true);
    s.h.manager.dispose();
    await waitFor(
      () => s.record.terminalResultGeneration === s.record.resultGeneration,
      "the stopped generation's publication",
    );
    await flush();
    assert.deepEqual(s.h.completions, [], "no completion callback after dispose");
  } finally {
    s.remove();
  }
});
