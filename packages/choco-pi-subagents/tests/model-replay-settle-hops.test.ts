/**
 * A run that is not subject to verdict recording settles in exactly as many
 * microtask turns as before verdict recording existed (commit d1063614's
 * parent). The model in formal/tla/subagent-run gives the verdict await to
 * verdict-role runs only; this pins the code to that.
 *
 * Each count is the number of `await Promise.resolve()` turns between the
 * runner's promise settling and `onComplete` firing. The settle paths here do
 * no I/O, so the count is deterministic. If a change adds or removes an await
 * on a settle path on purpose, re-measure and update the constant; an
 * unintended change shows up here first.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  cleanupProviders,
  createUsageLimitEnv,
  harness,
  type Harness,
} from "./usage-limit-fixture.ts";

const background = { description: "settle hops", isBackground: true, isolated: true };
/** Far above any settle path; only bounds a failing run. */
const MAX_TURNS = 200;

/** Microtask turns until `h.completions` has `count` entries. */
async function turnsUntilCompletion(h: Harness, count: number): Promise<number> {
  for (let turn = 0; turn <= MAX_TURNS; turn++) {
    if (h.completions.length >= count) return turn;
    await Promise.resolve();
  }
  return -1;
}

// Measured with this test on d1063614^ (2, 2, 3). Unguarded verdict awaits
// (d1063614 to d12bd0a5) made every one of them one turn longer (3, 3, 4).
const SPAWN_SETTLE_TURNS = 2;
const SPAWN_REJECT_TURNS = 2;
const RESUME_SETTLE_TURNS = 3;

test("a non-verdict run's settle takes no extra microtask turns", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session: AgentSession = await env.childSession();
  const h = harness({ maxConcurrent: 4 });
  try {
    // Spawn, success: the .then settle path.
    const ok = h.manager.spawn(env.pi, env.context(), "implementer", "ok", background);
    await Promise.resolve();
    h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    const spawnTurns = await turnsUntilCompletion(h, 1);

    // Spawn, rejection: the .catch settle path.
    h.manager.spawn(env.pi, env.context(), "implementer", "fails", background);
    await Promise.resolve();
    h.runs[1].reject(new Error("provider stream failed"));
    const rejectTurns = await turnsUntilCompletion(h, 2);

    // Background resume of the first agent: the startResume settle path.
    const resumed = await h.manager.resume(ok, "again", undefined, background);
    assert.equal(resumed === undefined, false, "the settled agent resumes");
    await Promise.resolve();
    h.resumes[0].resolve({ text: "again done", aborted: false, steered: false });
    const resumeTurns = await turnsUntilCompletion(h, 3);

    t.diagnostic(`turns spawn=${spawnTurns} reject=${rejectTurns} resume=${resumeTurns}`);
    assert.deepEqual(h.completions, ["completed", "error", "completed"]);
    assert.equal(spawnTurns, SPAWN_SETTLE_TURNS, "spawn .then settle");
    assert.equal(rejectTurns, SPAWN_REJECT_TURNS, "spawn .catch settle");
    assert.equal(resumeTurns, RESUME_SETTLE_TURNS, "background resume settle");
  } finally {
    h.manager.dispose();
    cleanupProviders();
  }
});
