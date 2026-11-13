/**
 * A user stop that lands while a usage-limit evaluation is settling must win:
 * the run ends stopped, is never parked for a reset, never revives, and
 * reports exactly one completion. The stop is swept across every microtask
 * offset after the held corroboration resolves, so the interleaving between
 * the evaluation's last eligibility check and the caller's park is covered
 * without guessing its exact tick.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  flush,
  harness,
  installPolicy,
  policyState,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const background = { description: "usage limit stop race", isBackground: true, isolated: true };
/** Far past the park: the evaluation needs well under this many microtasks. */
const MAX_OFFSET = 24;

async function microtasks(count: number): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

test("a stop at any microtask during usage-limit evaluation is never parked or revived", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const sessions: AgentSession[] = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset++) sessions.push(await env.childSession());
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });

  const parkedOffsets: number[] = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset++) {
    const resetAt = Date.now() + 60_000;
    const state = policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "parsed", resetAt },
      // Settle-time check confirms exhaustion; any later wake reports capacity,
      // so a wrongly parked run would revive.
      corroborate: (count) =>
        count === 1 ? { ready: false, evidence: "confirmed" } : { ready: true },
    });
    const installed = installPolicy(state, env.owner);
    const held = deferred<undefined>();
    const corroborate = installed.policy.corroborate;
    let calls = 0;
    installed.policy.corroborate = async (classification) => {
      calls++;
      if (calls === 1) await held.promise;
      return corroborate(classification);
    };
    const { manager, runs, resumePrompts, completions } = harness();
    try {
      const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
      const record = manager.getRecord(id);
      assert.ok(record !== undefined);
      runs[0].resolve({
        responseText: "partial",
        session: sessions[offset],
        aborted: false,
        steered: false,
        failure: LIMIT,
      });
      await flush();
      assert.equal(calls, 1, `offset ${offset}: evaluation is holding corroboration`);
      assert.equal(record.status, "running", `offset ${offset}: still evaluating`);

      held.resolve(undefined);
      await microtasks(offset);
      if (manager.getRecord(id)?.status === "waiting_for_reset") parkedOffsets.push(offset);
      assert.equal(manager.abort(id), true, `offset ${offset}: stop accepted`);
      await flush();

      assert.equal(record.status, "stopped", `offset ${offset}: stop holds after evaluation`);
      assert.equal(record.stoppedByUser, true, `offset ${offset}: user stop recorded`);
      assert.deepEqual(completions, ["stopped"], `offset ${offset}: exactly one completion`);

      t.mock.timers.tick(2 * HOUR);
      await flush();
      assert.equal(record.status, "stopped", `offset ${offset}: still stopped after reset`);
      assert.equal(resumePrompts.length, 0, `offset ${offset}: never revived`);
      assert.equal(runs.length, 1, `offset ${offset}: never restarted`);
      assert.deepEqual(completions, ["stopped"], `offset ${offset}: no further completion`);
    } finally {
      manager.dispose();
      installed.remove();
      cleanupProviders();
    }
  }
  // The sweep reached past the park, so the post-park stop path was covered too.
  assert.ok(parkedOffsets.length > 0, "sweep reaches the parked state");
});
