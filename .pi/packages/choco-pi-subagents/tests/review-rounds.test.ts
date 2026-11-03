import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  consumeReviewTicket,
  isReviewRole,
  isValidWorkTask,
  issueExemptTicket,
  REVIEW_ROLES,
  ReviewRoundStore,
  roundLimitMessage,
  sessionLimitMessage,
  stateUnavailableMessage,
  workTaskRequiredMessage,
} from "../src/review-rounds.ts";
import type { AdmitResult, ReviewTicket } from "../src/review-rounds.ts";

const execFileAsync = promisify(execFile);
const MODULE_URL = pathToFileURL(
  fileURLToPath(new URL("../src/review-rounds.ts", import.meta.url)),
).href;
const SESSION = "session-1";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-rounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function admit(store: ReviewRoundStore, workTask: string, rootSessionId = SESSION) {
  return store.admit({ rootSessionId, workTask, agentType: "reviewer", entry: "agent" });
}

function okTicket(result: AdmitResult): ReviewTicket {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.ticket;
}

test("admits three rounds per task then refuses the fourth with the exact text", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const notices: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const result = await admit(store, "alpha");
    assert.equal(result.ok, true);
    if (result.ok) notices.push(result.notice);
  }
  assert.deepEqual(notices, [
    'Review round 1/3 admitted for work task "alpha" (new review budget; session total 1/9).',
    'Review round 2/3 admitted for work task "alpha" (session total 2/9).',
    'Review round 3/3 admitted for work task "alpha" (session total 3/9).',
  ]);
  const fourth = await admit(store, "alpha");
  assert.deepEqual(fourth, {
    ok: false,
    code: "REVIEW_ROUND_LIMIT",
    message:
      'Review round refused [REVIEW_ROUND_LIMIT]: work task "alpha" has used 3/3 review rounds. No reviewer was started. Do not retry: triage the latest findings, finish in-scope fixes and validation, and report the remaining risk. Only the user can authorize more rounds with /review-continue alpha [rounds].',
  });
  assert.equal(fourth.ok === false && fourth.message, roundLimitMessage("alpha", 3, 3));
});

test("10 concurrent admits on a fresh ledger admit exactly 3", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const results = await Promise.all(Array.from({ length: 10 }, () => admit(store, "race")));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(results.filter((r) => !r.ok && r.code === "REVIEW_ROUND_LIMIT").length, 7);
});

test("two store instances on one dir cannot exceed the cap", async (t) => {
  const dir = await tempDir(t);
  const a = new ReviewRoundStore(dir);
  const b = new ReviewRoundStore(dir);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => admit(i % 2 === 0 ? a : b, "race")),
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
});

test("separate processes racing on one ledger cannot exceed the cap", async (t) => {
  const dir = await tempDir(t);
  const script = join(dir, "worker.mjs");
  await writeFile(
    script,
    `import { ReviewRoundStore } from ${JSON.stringify(MODULE_URL)};
const store = new ReviewRoundStore(process.argv[2]);
const out = await Promise.all(Array.from({ length: 4 }, () =>
  store.admit({ rootSessionId: "proc-session", workTask: "race", agentType: "reviewer", entry: "agent" })));
console.log(out.filter((r) => r.ok).length);
`,
  );
  const ledgerDir = join(dir, "ledgers");
  const runs = await Promise.all(
    [0, 1, 2].map(() => execFileAsync(process.execPath, [script, ledgerDir])),
  );
  const admitted = runs.reduce((sum, run) => sum + Number(run.stdout.trim()), 0);
  assert.equal(admitted, 3);
  const raw = await readFile(join(ledgerDir, "proc-session.json"), "utf-8");
  assert.equal(raw.match(/"status": "admitted"/g)?.length, 3);
});

test("session ceiling across four tasks: 9 admitted, 10th refused", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const tasks = ["t1", "t2", "t3", "t4"];
  let admitted = 0;
  for (const task of tasks.slice(0, 3)) {
    for (let i = 0; i < 3; i++) {
      assert.equal((await admit(store, task)).ok, true);
      admitted++;
    }
  }
  assert.equal(admitted, 9);
  const tenth = await admit(store, "t4");
  assert.deepEqual(tenth, {
    ok: false,
    code: "REVIEW_SESSION_LIMIT",
    message:
      "Review round refused [REVIEW_SESSION_LIMIT]: this session has used 9/9 review rounds across 3 work tasks. No reviewer was started. Do not retry or open a new work task to continue reviewing; report the remaining risk. Only the user can authorize more rounds with /review-continue <id> [rounds].",
  });
  assert.equal(tenth.ok === false && tenth.message, sessionLimitMessage(9, 9, 3));
});

test("session ceiling is reached by 4 tasks with partial use", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  for (const [task, count] of [
    ["a", 3],
    ["b", 3],
    ["c", 2],
    ["d", 1],
  ] as const) {
    for (let i = 0; i < count; i++) assert.equal((await admit(store, task)).ok, true);
  }
  const refused = await admit(store, "d");
  assert.equal(!refused.ok && refused.code, "REVIEW_SESSION_LIMIT");
});

test("grant raises both limits and persists across a new store instance", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  for (let i = 0; i < 3; i++) await admit(store, "alpha");
  assert.equal((await admit(store, "alpha")).ok, false);
  const granted = await store.grant(SESSION, "alpha", 2);
  assert.deepEqual(granted, {
    ok: true,
    message: 'Granted 2 more review round(s) for work task "alpha" (now 3/5; session 3/11).',
  });
  const reloaded = new ReviewRoundStore(dir);
  const fourth = await admit(reloaded, "alpha");
  assert.equal(fourth.ok, true);
  assert.equal(fourth.ok && fourth.notice.startsWith("Review round 4/5 admitted"), true);
  assert.equal(await reloaded.summary(SESSION), '"alpha": 4/5 review rounds\nSession total: 4/11');
});

test("grant rejects bad input and unknown tasks; summary of empty ledger", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  assert.equal(await store.summary(SESSION), "No review rounds recorded in this session.");
  const usage = "Usage: /review-continue [<work_task> [rounds 1-3]]";
  assert.deepEqual(await store.grant(SESSION, "alpha", 0), { ok: false, message: usage });
  assert.deepEqual(await store.grant(SESSION, "alpha", 4), { ok: false, message: usage });
  assert.deepEqual(await store.grant(SESSION, "alpha", 1.5), { ok: false, message: usage });
  assert.deepEqual(await store.grant(SESSION, "Bad Id", 1), { ok: false, message: usage });
  assert.deepEqual(await store.grant(SESSION, "alpha", 1), {
    ok: false,
    message: 'No review rounds recorded for work task "alpha" in this session.',
  });
});

test("release refunds once; released and consumed tickets are single-use", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const ticket = okTicket(await admit(store, "alpha"));
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(await store.release(ticket), true);
  assert.equal(await store.release(ticket), false);
  assert.equal(consumeReviewTicket(ticket), false);
  const next = await admit(store, "alpha");
  assert.equal(next.ok && next.notice.startsWith("Review round 1/3 admitted"), true);

  // A ticket consumed by the manager can still be refunded if the launch then throws.
  const second = okTicket(await admit(store, "alpha"));
  assert.equal(consumeReviewTicket(second), true);
  assert.equal(consumeReviewTicket(second), false);
  assert.equal(await store.release(second), true);
  assert.equal(await store.summary(SESSION), '"alpha": 1/3 review rounds\nSession total: 1/9');
});

test("tickets are single-use and unforgeable", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const ticket = okTicket(await admit(store, "alpha"));
  assert.equal(consumeReviewTicket(undefined), false);
  const forged: ReviewTicket = { ...ticket };
  assert.equal(consumeReviewTicket(forged), false);
  assert.equal(await store.release(forged), false);
  assert.equal(consumeReviewTicket(ticket), true);
  assert.equal(consumeReviewTicket(ticket), false);
});

test("exempt tickets write nothing and are single-use", async (t) => {
  const dir = await tempDir(t);
  const ticket = issueExemptTicket("user-mention");
  assert.equal(ticket.exemptReason, "user-mention");
  assert.equal(consumeReviewTicket(ticket), true);
  assert.equal(consumeReviewTicket(ticket), false);
  const hook = issueExemptTicket("hook-continuation");
  assert.equal(await new ReviewRoundStore(dir).release(hook), false);
  assert.deepEqual(await readdir(dir), []);
});

test("corrupt, wrong-version and mismatched ledgers fail closed and stay untouched", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  const file = join(dir, `${SESSION}.json`);
  const bodies = [
    "{not json",
    JSON.stringify({ schemaVersion: 2, rootSessionId: SESSION, sessionGranted: 0, workTasks: {} }),
    JSON.stringify({ schemaVersion: 1, rootSessionId: "other", sessionGranted: 0, workTasks: {} }),
    JSON.stringify({ schemaVersion: 1, rootSessionId: SESSION, sessionGranted: -1, workTasks: {} }),
    JSON.stringify({
      schemaVersion: 1,
      rootSessionId: SESSION,
      sessionGranted: 0,
      workTasks: { "Bad Key": { createdAt: "x", granted: 0, rounds: [] } },
    }),
  ];
  for (const body of bodies) {
    await writeFile(file, body);
    const result = await admit(store, "alpha");
    assert.equal(!result.ok && result.code, "REVIEW_STATE_UNAVAILABLE", body);
    assert.equal(await readFile(file, "utf-8"), body);
    assert.match(await store.summary(SESSION), /REVIEW_STATE_UNAVAILABLE/);
    assert.equal((await store.grant(SESSION, "alpha", 1)).ok, false);
  }
  assert.deepEqual((await readdir(dir)).sort(), [`${SESSION}.json`]);
});

test("invalid root session ids fail closed without touching the filesystem", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  for (const id of ["", "../evil", "a/b", "a.b", "x".repeat(129)]) {
    const result = await admit(store, "alpha", id);
    assert.equal(!result.ok && result.code, "REVIEW_STATE_UNAVAILABLE", id);
    assert.equal(!result.ok && result.message, stateUnavailableMessage("invalid root session id"));
  }
  assert.deepEqual(await readdir(dir), []);
});

test("an invalid work task is rejected before any ledger access", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  for (const task of ["", "Alpha", "-a", "a_b", "a b", "a".repeat(65), "__proto__"]) {
    const result = await admit(store, task);
    assert.deepEqual(result, {
      ok: false,
      code: "REVIEW_WORK_TASK_REQUIRED",
      message: workTaskRequiredMessage("reviewer"),
    });
  }
  assert.deepEqual(await readdir(dir), []);
  assert.equal(isValidWorkTask("a".repeat(64)), true);
  assert.equal(isValidWorkTask("0-a"), true);
});

test("prototype-named work tasks are ordinary tasks", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  for (let i = 0; i < 3; i++) assert.equal((await admit(store, "constructor")).ok, true);
  assert.equal((await admit(store, "constructor")).ok, false);
  assert.equal((await admit(store, "toString")).ok, false); // invalid (uppercase)
  assert.equal((await admit(store, "valueof")).ok, true);
});

test("a stale lock is recovered; a fresh lock times out as unavailable", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  await admit(store, "alpha"); // creates the directory
  const lock = join(dir, `${SESSION}.json.lock`);
  await writeFile(lock, "99999999");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await admit(store, "alpha")).ok, true);
  await assert.rejects(stat(lock), { code: "ENOENT" });

  await writeFile(lock, "99999999"); // fresh and held
  const blocked = await admit(store, "alpha");
  assert.equal(!blocked.ok && blocked.code, "REVIEW_STATE_UNAVAILABLE");
  assert.equal(
    await store.summary(SESSION).then((s) => s.includes("REVIEW_STATE_UNAVAILABLE")),
    true,
  );
  await rm(lock);
  assert.equal(await store.summary(SESSION), '"alpha": 2/3 review rounds\nSession total: 2/9');
});

test("ledger file is 0600, written atomically, with no temp or lock leftovers", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  await Promise.all([admit(store, "alpha"), admit(store, "beta")]);
  const file = join(dir, `${SESSION}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), [`${SESSION}.json`]);
  const data = JSON.parse(await readFile(file, "utf-8"));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.rootSessionId, SESSION);
  assert.deepEqual(Object.keys(data.workTasks).sort(), ["alpha", "beta"]);
});

test("an unreadable ledger path (directory) fails closed", async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, `${SESSION}.json`));
  const store = new ReviewRoundStore(dir);
  const result = await admit(store, "alpha");
  assert.equal(!result.ok && result.code, "REVIEW_STATE_UNAVAILABLE");
});

test("review role matching is case-insensitive and limited to reviewer", () => {
  assert.deepEqual([...REVIEW_ROLES], ["reviewer"]);
  assert.equal(isReviewRole("reviewer"), true);
  assert.equal(isReviewRole("Reviewer"), true);
  assert.equal(isReviewRole("general-purpose"), false);
  assert.equal(isReviewRole("reviewers"), false);
});
