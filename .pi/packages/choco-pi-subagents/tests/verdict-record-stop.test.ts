/**
 * Verdict records for runs that end stopped. The durable agent record
 * (<scratch>/verdicts/<work_task>/<agentId>.json) describes the latest
 * settled run of that agent under that work task, and the parent-visible
 * "Verdict record:" line agrees with it:
 *
 * - a stop that lands while a recording is in flight wins: the line is not
 *   "parsed" and the record is not parsed-clean;
 * - every terminal path of a verdict-role run records an outcome, including
 *   runs that never reach a runner (stopped while queued, parked then stopped).
 *
 * Ordering is forced with the runner's deferred promises. A stop "during the
 * recording" is issued in the microtask turn after recording began
 * (verdictRecordedGeneration is set before its first await) and before any
 * filesystem callback can run. No assertion compares a record object.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  readAgentParseRecord,
  verdictRecordsDirectory,
} from "../../../extensions/lib/verdict-blocks.ts";
import { ReviewRoundStore, type ReviewTicket } from "../src/review-rounds.ts";
import { recordVerdict, type VerdictRecordInput } from "../src/verdict-record.ts";
import type { AgentRecord } from "../src/types.ts";
import { fence, WORK_TASK } from "./fixtures/verdict-blocks.ts";
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

const ROOT = "verdict-stop-root";
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const background = { description: "review", isBackground: true, isolated: true };
const CLEAN_REVIEW = fence(
  "choco-pi-review",
  JSON.stringify({ schema: 1, verdict: "NO_FINDINGS", bundleDigest: "sha256:abc", findings: [] }),
);
const MISSING_REVIEW = "I looked around and everything seems fine.";
const STOPPED_LINE = /^Verdict record: MISSING - the run ended stopped/;

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  scratch: string;
  store: ReviewRoundStore;
}

async function setup(t: TestContext, maxConcurrent = 4): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scratch = join(dir, "scratch");
  const h = harness({ maxConcurrent });
  h.manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  h.manager.setVerdictScratchResolver(() => scratch);
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  return { env, h, scratch, store: new ReviewRoundStore(join(dir, "rounds")) };
}

async function ticket(
  store: ReviewRoundStore,
  agentType: string,
  workTask = WORK_TASK,
): Promise<ReviewTicket> {
  const result = await store.admit({ rootSessionId: ROOT, workTask, agentType, entry: "agent" });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.ticket;
}

/** The record's status on disk ("parsed NO_FINDINGS", "missing", "record missing"). */
async function onDisk(scratch: string, id: string, workTask = WORK_TASK): Promise<string> {
  const read = await readAgentParseRecord(verdictRecordsDirectory(scratch, workTask), id);
  if (read.status !== "valid") return "record " + read.status;
  const review = read.value.review?.verdict;
  return review === undefined ? read.value.status : read.value.status + " " + review;
}

function verdictLines(record: AgentRecord | undefined): string[] {
  return (record?.result ?? "")
    .split("\n")
    .filter((line) => line.startsWith("Verdict record:"))
    .map((line) => line.replace(/ -> .*$/, ""));
}

/** Microtask turns until the record's current generation started recording. */
async function untilRecordingStarted(record: AgentRecord): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (record.verdictRecordedGeneration === record.resultGeneration) return;
    await Promise.resolve();
  }
  throw new Error("verdict recording never started");
}

async function published(record: AgentRecord, label: string): Promise<void> {
  await waitFor(() => record.terminalResultGeneration === record.resultGeneration, label);
  await flush();
}

test("a stop during a clean review's recording publishes stopped, not parsed", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const done = record.promise;
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: false, steered: false });
  await untilRecordingStarted(record);
  assert.equal(s.h.manager.abort(id), true, "the stop lands during the recording");
  await done;
  await flush();
  assert.equal(record.status, "stopped");
  assert.deepEqual(s.h.completions, ["stopped"]);
  const lines = verdictLines(record);
  assert.equal(lines.length, 1, lines.join(" | "));
  assert.match(lines[0], STOPPED_LINE);
  assert.equal(await onDisk(s.scratch, id), "missing", "the file agrees with the line");
});

test("stopping a queued resume replaces the previous clean record", async (t) => {
  const s = await setup(t, 1);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const first = record.promise;
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: false, steered: false });
  await first;
  assert.equal(await onDisk(s.scratch, id), "parsed NO_FINDINGS");

  // Fill the only slot, then resume the reviewer: it queues.
  s.h.manager.spawn(s.env.pi, s.env.context(), "implementer", "busy", {
    ...background,
    description: "busy",
  });
  const resumed = await s.h.manager.resume(id, "again", undefined, {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  assert.equal(resumed === undefined, false);
  assert.equal(record.status, "queued");

  assert.equal(s.h.manager.abort(id), true);
  await published(record, "the stopped resume's publication");
  assert.equal(record.status, "stopped");
  const lines = verdictLines(record);
  assert.equal(lines.length, 1, lines.join(" | "));
  assert.match(lines[0], STOPPED_LINE);
  assert.equal(await onDisk(s.scratch, id), "missing", "the previous clean record is replaced");
});

test("a fresh queued launch stopped before starting is recorded", async (t) => {
  const s = await setup(t, 1);
  s.h.manager.spawn(s.env.pi, s.env.context(), "implementer", "busy", {
    ...background,
    description: "busy",
  });
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  assert.equal(record.status, "queued");
  assert.equal(s.h.manager.abort(id), true);
  await published(record, "the stopped launch's publication");
  assert.match(verdictLines(record)[0] ?? "", STOPPED_LINE);
  assert.equal(await onDisk(s.scratch, id), "missing");
});

test("a parked reviewer that is stopped is recorded", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    corroborate: () => ({ ready: false }),
  });
  const installed = installPolicy(state, s.env.owner);
  t.after(() => installed.remove());
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const first = record.promise;
  s.h.runs[0].resolve({
    responseText: "",
    session,
    aborted: false,
    steered: false,
    failure: LIMIT,
  });
  await first;
  assert.equal(record.status, "waiting_for_reset", "parked");
  assert.equal(s.h.manager.abort(id), true);
  await published(record, "the parked record's publication");
  assert.equal(record.status, "stopped");
  assert.deepEqual(s.h.completions, ["stopped"]);
  assert.match(verdictLines(record)[0] ?? "", STOPPED_LINE);
  assert.equal(await onDisk(s.scratch, id), "missing");
});

test("a resume without a block after a clean run replaces the record", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const first = record.promise;
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: false, steered: false });
  await first;
  await s.h.manager.resume(id, "again", undefined, {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const second = record.promise;
  s.h.resumes[0].resolve({ text: MISSING_REVIEW, aborted: false, steered: false });
  await second;
  assert.match(verdictLines(record)[0] ?? "", /^Verdict record: MISSING - the final message/);
  assert.equal(await onDisk(s.scratch, id), "missing");
});

test("a resume under another work task records there and keeps the first task's record", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.h.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer"),
  });
  const record = s.h.manager.getRecord(id);
  assert.ok(record !== undefined);
  const first = record.promise;
  s.h.runs[0].resolve({ responseText: CLEAN_REVIEW, session, aborted: false, steered: false });
  await first;
  await s.h.manager.resume(id, "again", undefined, {
    ...background,
    reviewTicket: await ticket(s.store, "reviewer", "other-task"),
  });
  const second = record.promise;
  s.h.resumes[0].resolve({ text: MISSING_REVIEW, aborted: false, steered: false });
  await second;
  assert.equal(await onDisk(s.scratch, id, "other-task"), "missing");
  assert.equal(await onDisk(s.scratch, id), "parsed NO_FINDINGS", "records are per work task");
});

/** An outcome that reads "completed" until its nth read, then "stopped". */
function stopsOnRead(n: number): NonNullable<VerdictRecordInput["outcome"]> {
  let reads = 0;
  return () => {
    reads += 1;
    return reads >= n
      ? { status: "stopped", error: "Stopped by user request." }
      : { status: "completed" };
  };
}

async function scratchDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "scratch");
}

// Reads of outcome: the initial parse, one before the record write, and one after it.
test("a clean review stopped during its record write is rewritten as missing", async (t) => {
  const scratch = await scratchDir(t);
  const outcome = await recordVerdict({
    agentId: "r1",
    agentType: "reviewer",
    workTask: WORK_TASK,
    scratchDir: scratch,
    text: CLEAN_REVIEW,
    status: "completed",
    outcome: stopsOnRead(3),
  });
  assert.equal(outcome.status, "missing");
  assert.equal(await onDisk(scratch, "r1"), "missing");
});
