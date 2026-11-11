/**
 * After the manager is disposed (session shutdown, switch or replacement all
 * end in dispose()), a settle that finishes a verdict-recording await
 * publishes for internal waiters but calls no completion callback.
 * No assertion compares a record object.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ReviewRoundStore, type ReviewTicket } from "../src/review-rounds.ts";
import type { AgentRecord } from "../src/types.ts";
import { fence, WORK_TASK } from "./fixtures/verdict-blocks.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  type Harness,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";
import { waitFor } from "./wait-for.ts";

const background = { description: "review", isBackground: true, isolated: true };
const CLEAN_REVIEW = fence(
  "choco-pi-review",
  JSON.stringify({ schema: 1, verdict: "NO_FINDINGS", bundleDigest: "sha256:abc", findings: [] }),
);

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  store: ReviewRoundStore;
}

async function setup(t: TestContext, maxConcurrent: number): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-dispose-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness({ maxConcurrent });
  h.manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  h.manager.setVerdictScratchResolver(() => join(dir, "scratch"));
  t.after(() => cleanupProviders());
  return { env, h, store: new ReviewRoundStore(join(dir, "rounds")) };
}

async function ticket(store: ReviewRoundStore): Promise<ReviewTicket> {
  const result = await store.admit({
    rootSessionId: "verdict-dispose",
    workTask: WORK_TASK,
    agentType: "reviewer",
    entry: "agent",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.ticket;
}

async function untilRecorded(record: AgentRecord): Promise<void> {
  await waitFor(() => record.verdictRecord !== undefined, "the verdict recording");
  await flush();
}

test("a queued reviewer stopped then disposed publishes without a completion callback", async (t) => {
  const s = await setup(t, 1);
  s.h.manager.spawn(s.env.pi, s.env.context(), "implementer", "busy", {
    ...background,
    description: "busy",
  });
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  assert.equal(record.status, "queued");
  assert.equal(s.h.manager.abort(id), true);
  s.h.manager.dispose();
  const after = s.h.completions.length;
  await untilRecorded(record);
  assert.equal(record.terminalResultGeneration, record.resultGeneration, "waiters settle");
  assert.equal(s.h.completions.length - after, 0, "no completion callback after dispose");
});

test("a running reviewer stopped then disposed during recording calls no completion callback", async (t) => {
  const s = await setup(t, 4);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const done = record.promise;
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: false, steered: false });
  await waitFor(
    () => record.verdictRecordedGeneration === record.resultGeneration,
    "recording started",
  );
  assert.equal(s.h.manager.abort(id), true);
  s.h.manager.dispose();
  const after = s.h.completions.length;
  await done;
  await flush();
  // The runner path already settled internally on dispose (pre-existing guard):
  // the run's promise resolved and the record left the manager unpublished.
  assert.equal(s.h.manager.getRecord(id) === undefined, true, "settled internally");
  assert.equal(s.h.completions.length - after, 0, "no completion callback after dispose");
});
