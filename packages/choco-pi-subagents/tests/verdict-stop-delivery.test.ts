/**
 * What a stop of a review or verification run tells its caller, and whether it
 * happens. stop_subagent replies "terminal result is still pending ... until
 * the terminal completion notification arrives" exactly when
 * resolveStopOutcome(record) is "pending" right after manager.abort; it replies
 * "stopped and settled" (no notification) otherwise. Since verdict recording,
 * a queued verdict-role run publishes after its record is written, so its stop
 * is pending: the completion (onComplete) must then follow exactly once.
 * Non-verdict queued stops stay settled at once and never notify.
 *
 * Also: the stop reason reaches the verdict line on queued paths, as it does
 * for a running run. No assertion compares a record object.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ReviewRoundStore, type ReviewTicket } from "../src/review-rounds.ts";
import { resolveStopOutcome } from "../src/stop-subagent.ts";
import {
  ADMISSION_CLOSED_MESSAGE,
  STOP_CONTROL_REGISTRY_KEY,
} from "../src/stop-control-contract.ts";
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

const ROOT = "verdict-stop-delivery-root";
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
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness({ maxConcurrent });
  h.manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  h.manager.setVerdictScratchResolver(() => join(dir, "scratch"));
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  return { env, h, store: new ReviewRoundStore(join(dir, "rounds")) };
}

async function ticket(store: ReviewRoundStore, agentType: string): Promise<ReviewTicket> {
  const result = await store.admit({
    rootSessionId: ROOT,
    workTask: WORK_TASK,
    agentType,
    entry: "agent",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.ticket;
}

function verdictLine(record: AgentRecord): string {
  const line = (record.result ?? "").split("\n").find((l) => l.startsWith("Verdict record:"));
  return (line ?? "").replace(/ -> .*$/, "");
}

/** Fill the only slot, then queue a run of type with a ticket when it is a verdict role. */
async function queued(s: Setup, type: string): Promise<AgentRecord> {
  s.h.manager.spawn(s.env.pi, s.env.context(), "implementer", "busy", {
    ...background,
    description: "busy",
  });
  const verdict = type === "reviewer" || type === "verifier";
  const id = verdict
    ? s.h.manager.spawn(s.env.pi, s.env.context(), type, "p", {
        ...background,
        reviewTicket: await ticket(s.store, type),
      })
    : s.h.manager.spawn(s.env.pi, s.env.context(), type, "p", background);
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  assert.equal(record.status, "queued");
  return record;
}

async function settled(record: AgentRecord): Promise<void> {
  await waitFor(
    () => record.terminalResultGeneration === record.resultGeneration,
    "the stopped run's publication",
  );
  await flush();
}

for (const type of ["reviewer", "verifier"]) {
  test(
    type + " stopped while queued: a pending reply is followed by one notification",
    async (t) => {
      const s = await setup(t, 1);
      const record = await queued(s, type);
      assert.equal(s.h.manager.abort(record.id), true);
      assert.equal(resolveStopOutcome(record).kind, "pending", "the reply promises a notification");
      await settled(record);
      assert.deepEqual(s.h.completions, ["stopped"], "exactly one terminal delivery");
      assert.equal(
        verdictLine(record),
        "Verdict record: MISSING - the run ended stopped: Stopped by user request.; this " +
          (type === "reviewer"
            ? "review is unrecorded and must not be reported as clean"
            : "verification is unrecorded and must not be reported as passing"),
      );
    },
  );
}

test("a reviewer stopped while running notifies once, not twice", async (t) => {
  const s = await setup(t, 4);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const done = record.promise;
  assert.equal(s.h.manager.abort(id), true);
  assert.equal(resolveStopOutcome(record).kind, "pending");
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: true, steered: false });
  await done;
  await settled(record);
  assert.deepEqual(s.h.completions, ["stopped"]);
  assert.match(
    verdictLine(record),
    /^Verdict record: MISSING - the run ended stopped: Stopped by user request\./,
  );
});

test("a queued general stop is settled at once and never notifies", async (t) => {
  const s = await setup(t, 1);
  const record = await queued(s, "general");
  assert.equal(s.h.manager.abort(record.id), true);
  assert.equal(resolveStopOutcome(record).kind, "already_settled", "the reply says settled");
  await flush();
  assert.deepEqual(s.h.completions, []);
});

test("a second stop of a pending queued reviewer adds no second notification", async (t) => {
  const s = await setup(t, 1);
  const record = await queued(s, "reviewer");
  assert.equal(s.h.manager.abort(record.id), true);
  assert.equal(s.h.manager.abort(record.id), false, "already stopped");
  await settled(record);
  assert.deepEqual(s.h.completions, ["stopped"]);
});

test("/stop of a queued reviewer: the report waits for publication; one notification", async (t) => {
  const s = await setup(t, 1);
  const record = await queued(s, "reviewer");
  const result = s.h.manager.stopAllForRoot(s.env.owner);
  // The busy run is stopped too; its runner settles as aborted.
  s.h.runs[0].resolve({
    responseText: "",
    session: await s.env.childSession(),
    aborted: true,
    steered: false,
  });
  await result.settled;
  assert.equal(
    record.terminalResultGeneration,
    record.resultGeneration,
    "published before the report",
  );
  await flush();
  assert.deepEqual(s.h.completions, ["stopped", "stopped"], "the busy run and the reviewer");
  assert.match(verdictLine(record), /ended stopped: Stopped by user request\./);
});

test("a shutdown of a queued reviewer records the shutdown reason and does not notify", async (t) => {
  const s = await setup(t, 1);
  const record = await queued(s, "reviewer");
  s.h.manager.abortAll();
  await settled(record);
  assert.deepEqual(s.h.completions, []);
  assert.match(verdictLine(record), /ended stopped: Manager shutdown requested\./);
});

test("a queued reviewer refused at a closed latch notifies once, with the refusal reason", async (t) => {
  const s = await setup(t, 1);
  let closed = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, STOP_CONTROL_REGISTRY_KEY);
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    value: {
      protocol: "choco-pi:stop-control/v1",
      state: () => ({ epoch: closed ? 1 : 0, closed }),
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, previous);
    else Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
  });
  const session = await s.env.childSession();
  const record = await queued(s, "reviewer");
  // The latch closes without the coordinator stopping the queue; the busy run ends normally.
  closed = true;
  s.h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await settled(record);
  assert.equal(record.status, "stopped");
  assert.equal(record.error, ADMISSION_CLOSED_MESSAGE);
  assert.deepEqual(s.h.completions, ["completed", "stopped"], "one each: busy run, reviewer");
  assert.match(verdictLine(record), /ended stopped: /);
  assert.equal(verdictLine(record).includes(ADMISSION_CLOSED_MESSAGE.split("\n")[0]), true);
});
