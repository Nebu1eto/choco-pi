/**
 * Verdict recording through the manager's settle paths: spawn success and
 * rejection (background and foreground), foreground and background resume,
 * stops and failures. The runner is the deferred fake from the usage-limit
 * fixture, so every run settles exactly when the test says.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  readAgentParseRecord,
  verdictRecordsDirectory,
} from "../../../extensions/lib/verdict-blocks.ts";
import { AgentManager } from "../src/agent-manager.ts";
import { issueExemptTicket, ReviewRoundStore, type ReviewTicket } from "../src/review-rounds.ts";
import type { AgentRecord } from "../src/types.ts";
import { claimsVerdictText, REVIEW_TEXT, WORK_TASK } from "./fixtures/verdict-blocks.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  harness,
  type Deferred,
  type Harness,
  type RunResult,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const ROOT = "verdict-root-session";
const background = { description: "review", isBackground: true, isolated: true };

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  manager: AgentManager;
  scratch: string;
  store: ReviewRoundStore;
}

async function setup(t: TestContext, scratchOverride?: (dir: string) => Promise<string>) {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-manager-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scratch = scratchOverride === undefined ? join(dir, "scratch") : await scratchOverride(dir);
  const h = harness();
  h.manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  const roots: string[] = [];
  h.manager.setVerdictScratchResolver((root) => {
    roots.push(root);
    return scratch;
  });
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  const setupResult: Setup = {
    env,
    h,
    manager: h.manager,
    scratch,
    store: new ReviewRoundStore(join(dir, "rounds")),
  };
  return { ...setupResult, roots };
}

async function admitted(store: ReviewRoundStore, agentType: string): Promise<ReviewTicket> {
  const result = await store.admit({
    rootSessionId: ROOT,
    workTask: WORK_TASK,
    agentType,
    entry: "agent",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.ticket;
}

function countLines(record: AgentRecord | undefined): number {
  return (record?.result ?? "").split("\n").filter((line) => line.startsWith("Verdict record:"))
    .length;
}

async function parseStatus(scratch: string, id: string): Promise<string> {
  const read = await readAgentParseRecord(verdictRecordsDirectory(scratch, WORK_TASK), id);
  return read.status === "valid" ? read.value.status : `record ${read.status}`;
}

test("background reviewer: parsed record and the line appended to the result", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: REVIEW_TEXT, session, aborted: false, steered: false });
  await done;
  const record = s.manager.getRecord(id);
  assert.equal(record?.status, "completed");
  assert.deepEqual(s.h.completions, ["completed"], "delivered exactly once");
  const path = join(s.scratch, "verdicts", WORK_TASK, `${id}.json`);
  assert.equal(
    record?.result,
    `${REVIEW_TEXT}\n\nVerdict record: parsed (FINDINGS, 2 findings, 1 candidate) -> ${path}`,
  );
  assert.equal(record?.verdictRecord?.startsWith("Verdict record: parsed"), true);
  assert.equal(await parseStatus(s.scratch, id), "parsed");
  assert.deepEqual(s.roots, [ROOT], "the ticket's root session picks the scratch root, once");
});

test("the completion callback already sees the line and the written record", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-callback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runs: Deferred<RunResult>[] = [];
  const seen: { result: string | undefined; onDisk: Promise<string> }[] = [];
  const manager = new AgentManager(
    (record) =>
      seen.push({ result: record.result, onDisk: parseStatus(join(dir, "s"), record.id) }),
    4,
    undefined,
    undefined,
    {
      runAgent() {
        const run = deferred<RunResult>();
        runs.push(run);
        return run.promise;
      },
      resumeAgent() {
        throw new Error("not used");
      },
    },
  );
  manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  manager.setVerdictScratchResolver(() => join(dir, "s"));
  t.after(() => {
    manager.dispose();
    cleanupProviders();
  });
  const id = manager.spawn(env.pi, env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(new ReviewRoundStore(join(dir, "rounds")), "reviewer"),
  });
  const done = manager.getRecord(id)?.promise;
  runs[0].resolve({
    responseText: REVIEW_TEXT,
    session: await env.childSession(),
    aborted: false,
    steered: false,
  });
  await done;
  assert.equal(seen.length, 1);
  assert.match(seen[0]?.result ?? "", /\n\nVerdict record: parsed \(FINDINGS/);
  assert.equal(await seen[0]?.onDisk, "parsed");
});

test("a failed final turn and a rejected run are missing; the line is appended once", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const failed = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const failedDone = s.manager.getRecord(failed)?.promise;
  s.h.runs[0].resolve({
    responseText: REVIEW_TEXT,
    session,
    aborted: false,
    steered: false,
    failure: "provider exploded",
  });
  await failedDone;
  assert.equal(s.manager.getRecord(failed)?.status, "error");
  assert.match(
    s.manager.getRecord(failed)?.result ?? "",
    /Verdict record: MISSING - the run ended error: provider exploded/,
  );
  assert.equal(await parseStatus(s.scratch, failed), "missing");

  const rejected = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const rejectedDone = s.manager.getRecord(rejected)?.promise;
  s.h.runs[1].reject(new Error("runner crashed"));
  await rejectedDone;
  const record = s.manager.getRecord(rejected);
  assert.equal(record?.status, "error");
  assert.equal(record?.error, "runner crashed");
  assert.match(
    record?.result ?? "",
    /^Verdict record: MISSING - the run ended error: runner crashed/,
  );
  assert.equal(countLines(record), 1);
  assert.equal(await parseStatus(s.scratch, rejected), "missing");
  assert.deepEqual(s.h.completions, ["error", "error"]);
});

test("a verifier is recorded once per settle path (spawn bg/fg, resume fg/bg)", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const verdict = claimsVerdictText();
  // Background spawn.
  const id = s.manager.spawn(s.env.pi, s.env.context(), "verifier", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "verifier"),
  });
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: verdict, session, aborted: false, steered: false });
  await done;
  assert.equal(countLines(s.manager.getRecord(id)), 1);

  // Foreground spawn.
  const waiting = s.manager.spawnAndWait(s.env.pi, s.env.context(), "verifier", "p", {
    description: "verify",
    isolated: true,
    reviewTicket: await admitted(s.store, "verifier"),
  });
  s.h.runs[1].resolve({ responseText: verdict, session, aborted: false, steered: false });
  const { record: foreground } = await waiting;
  assert.equal(countLines(foreground), 1);
  assert.match(foreground.result ?? "", /Verdict record: parsed \(claims, 2 claims/);

  // Foreground resume of the first verifier.
  const resumed = s.manager.resume(id, "again", undefined, {
    reviewTicket: await admitted(s.store, "verifier"),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  s.h.resumes[0].resolve({ text: verdict, aborted: false, steered: false });
  const afterForeground = await resumed;
  assert.equal(countLines(afterForeground), 1);

  // Background resume.
  await s.manager.resume(id, "and again", undefined, {
    isBackground: true,
    reviewTicket: await admitted(s.store, "verifier"),
  });
  const backgroundDone = s.manager.getRecord(id)?.promise;
  s.h.resumes[1].resolve({ text: verdict, aborted: false, steered: false });
  await backgroundDone;
  assert.equal(countLines(s.manager.getRecord(id)), 1);
  const agents = await readdir(verdictRecordsDirectory(s.scratch, WORK_TASK));
  assert.deepEqual(agents.sort(), [`${foreground.id}.json`, `${id}.json`].sort());
});

test("resume failures settle as missing through the resume paths", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: REVIEW_TEXT, session, aborted: false, steered: false });
  await done;
  assert.equal(await parseStatus(s.scratch, id), "parsed");

  const foreground = s.manager.resume(id, "again", undefined, {
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  s.h.resumes[0].reject(new Error("resume crashed"));
  const record = await foreground;
  assert.equal(record?.status, "error");
  assert.equal(
    record?.result,
    "Verdict record: MISSING - the run ended error: resume crashed; this review is unrecorded and must not be reported as clean -> " +
      join(verdictRecordsDirectory(s.scratch, WORK_TASK), `${id}.json`),
  );
  assert.equal(await parseStatus(s.scratch, id), "missing", "the parsed record is replaced");

  await s.manager.resume(id, "once more", undefined, {
    isBackground: true,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const backgroundDone = s.manager.getRecord(id)?.promise;
  s.h.resumes[1].reject(new Error("background crashed"));
  await backgroundDone;
  assert.equal(countLines(s.manager.getRecord(id)), 1);
  assert.match(s.manager.getRecord(id)?.result ?? "", /the run ended error: background crashed/);
});

test("an unwritable scratch root leaves the delivered result intact apart from the FAILED line", async (t) => {
  const s = await setup(t, async (dir) => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    return blocker;
  });
  const session = await s.env.childSession();
  const id = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: REVIEW_TEXT, session, aborted: false, steered: false });
  await done;
  const record = s.manager.getRecord(id);
  assert.equal(record?.status, "completed");
  assert.equal(record?.error, undefined);
  assert.deepEqual(s.h.completions, ["completed"]);
  const result = record?.result ?? "";
  assert.ok(
    result.startsWith(`${REVIEW_TEXT}\n\nVerdict record: FAILED - could not write the record (`),
  );
  assert.match(result, /this review is unrecorded and must not be reported as clean$/);

  // A throwing resolver is contained the same way.
  s.manager.setVerdictScratchResolver(() => {
    throw new Error("resolver broke");
  });
  const second = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: await admitted(s.store, "reviewer"),
  });
  const secondDone = s.manager.getRecord(second)?.promise;
  s.h.runs[1].resolve({ responseText: "text", session, aborted: false, steered: false });
  await secondDone;
  assert.equal(s.manager.getRecord(second)?.status, "completed");
  assert.match(
    s.manager.getRecord(second)?.result ?? "",
    /^text\n\nVerdict record: FAILED - resolver broke;/,
  );
});

test("exempt launches and ungated roles are not recorded", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const exempt = s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
    ...background,
    reviewTicket: issueExemptTicket("user-mention"),
  });
  const plain = s.manager.spawn(s.env.pi, s.env.context(), "implementer", "p", background);
  const promises = [s.manager.getRecord(exempt)?.promise, s.manager.getRecord(plain)?.promise];
  s.h.runs[0].resolve({ responseText: REVIEW_TEXT, session, aborted: false, steered: false });
  s.h.runs[1].resolve({ responseText: REVIEW_TEXT, session, aborted: false, steered: false });
  await Promise.all(promises);
  assert.equal(s.manager.getRecord(exempt)?.result, REVIEW_TEXT);
  assert.equal(s.manager.getRecord(plain)?.result, REVIEW_TEXT);
  assert.deepEqual(s.roots, []);
});

test("a ticket admitted for the other round class cannot start the role", async (t) => {
  const s = await setup(t);
  const reviewTicket = await admitted(s.store, "reviewer");
  assert.throws(
    () =>
      s.manager.spawn(s.env.pi, s.env.context(), "verifier", "p", { ...background, reviewTicket }),
    /Verification admission required \[VERIFY_ADMISSION_REQUIRED\]/,
  );
  assert.throws(
    () => s.manager.spawn(s.env.pi, s.env.context(), "verifier", "p", background),
    /VERIFY_ADMISSION_REQUIRED/,
  );
  assert.equal(s.manager.listAgents().length, 0);
});
