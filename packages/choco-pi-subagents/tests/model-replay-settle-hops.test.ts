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
const MAX_TURNS = 200;

async function turnsUntilCompletion(h: Harness, count: number): Promise<number> {
  for (let turn = 0; turn <= MAX_TURNS; turn++) {
    if (h.completions.length >= count) return turn;
    await Promise.resolve();
  }
  return -1;
}

const SPAWN_SETTLE_TURNS = 2;
const SPAWN_REJECT_TURNS = 2;
const RESUME_SETTLE_TURNS = 3;

test("a non-verdict run's settle takes no extra microtask turns", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session: AgentSession = await env.childSession();
  const h = harness({ maxConcurrent: 4 });
  try {
    const ok = h.manager.spawn(env.pi, env.context(), "implementer", "ok", background);
    await Promise.resolve();
    h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    const spawnTurns = await turnsUntilCompletion(h, 1);

    h.manager.spawn(env.pi, env.context(), "implementer", "fails", background);
    await Promise.resolve();
    h.runs[1].reject(new Error("provider stream failed"));
    const rejectTurns = await turnsUntilCompletion(h, 2);

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
