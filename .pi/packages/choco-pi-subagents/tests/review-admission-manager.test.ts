import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentManager, RevivalContext } from "../src/agent-manager.ts";
import { registerRpcHandlers, type EventBus } from "../src/cross-extension-rpc.ts";
import {
  admissionRequiredMessage,
  consumeReviewTicket,
  issueExemptTicket,
  type ReviewTicket,
} from "../src/review-rounds.ts";
import type { JournalAgentSnapshot } from "../src/revival-journal.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  type Harness,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const REQUIRED = /Review admission required \[REVIEW_ADMISSION_REQUIRED\]/;
const background = { description: "review", isBackground: true, isolated: true };

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  manager: AgentManager;
  dir: string;
}

async function setup(t: TestContext): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-review-admission-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness();
  h.manager.setJournalSink({ rootSessionId: env.owner, append: () => undefined });
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  return { env, h, manager: h.manager, dir };
}

function ticket(): ReviewTicket {
  return issueExemptTicket("user-mention");
}

function snapshot(id: string, type: string, sessionFile: string): JournalAgentSnapshot {
  return {
    id,
    handle: `${type}-${id}`,
    type,
    description: `revive ${id}`,
    depth: 1,
    status: "interrupted",
    options: { isBackground: true, isolated: true },
    model: { provider: "anthropic", id: "claude-opus-4-5" },
    revivals: 0,
    resultConsumed: false,
    sessionFile,
  };
}

test("reviewer spawn without a ticket throws and creates no record, run or queue entry", async (t) => {
  const s = await setup(t);
  const ctx = s.env.context();
  assert.throws(() => s.manager.spawn(s.env.pi, ctx, "reviewer", "p", background), REQUIRED);
  assert.throws(
    () => s.manager.spawn(s.env.pi, ctx, "Reviewer", "p", { ...background, isBackground: false }),
    REQUIRED,
    "matching is case-insensitive",
  );
  assert.equal(s.manager.listAgents().length, 0);
  assert.equal(s.h.runs.length, 0);
  assert.ok(admissionRequiredMessage("reviewer").startsWith("Review admission required"));
});

test("a forged ticket-shaped object cannot start a reviewer", async (t) => {
  const s = await setup(t);
  const forged: ReviewTicket = { roundId: "r", workTask: "w", rootSessionId: "s" };
  assert.throws(
    () =>
      s.manager.spawn(s.env.pi, s.env.context(), "reviewer", "p", {
        ...background,
        reviewTicket: forged,
      }),
    REQUIRED,
  );
  assert.equal(s.manager.listAgents().length, 0);
});

test("a ticket starts a reviewer once and is then spent", async (t) => {
  const s = await setup(t);
  const ctx = s.env.context();
  const reviewTicket = ticket();
  const id = s.manager.spawn(s.env.pi, ctx, "reviewer", "p", { ...background, reviewTicket });
  assert.equal(s.h.runs.length, 1);
  assert.equal(s.manager.getRecord(id)?.type, "reviewer");
  assert.equal(consumeReviewTicket(reviewTicket), false, "consumed by the manager");
  assert.throws(
    () => s.manager.spawn(s.env.pi, ctx, "reviewer", "again", { ...background, reviewTicket }),
    REQUIRED,
  );
  assert.equal(s.manager.listAgents().length, 1);
});

test("a queued reviewer is admitted once at spawn, not again at drain", async (t) => {
  const s = await setup(t);
  const small = harness({ maxConcurrent: 1 });
  t.after(() => small.manager.dispose());
  const ctx = s.env.context();
  small.manager.spawn(s.env.pi, ctx, "implementer", "first", background);
  const id = small.manager.spawn(s.env.pi, ctx, "reviewer", "second", {
    ...background,
    reviewTicket: ticket(),
  });
  assert.equal(small.manager.getRecord(id)?.status, "queued");
  assert.equal(small.runs.length, 1);
});

test("non-review types are unaffected and ignore a missing ticket", async (t) => {
  const s = await setup(t);
  const ctx = s.env.context();
  const id = s.manager.spawn(s.env.pi, ctx, "implementer", "p", background);
  assert.equal(s.manager.getRecord(id)?.type, "implementer");
  const withTicket = ticket();
  s.manager.spawn(s.env.pi, ctx, "explore", "p", { ...background, reviewTicket: withTicket });
  assert.equal(consumeReviewTicket(withTicket), true, "a non-review launch does not spend it");
});

test("resume of a reviewer requires a fresh ticket and does not touch the record without one", async (t) => {
  const s = await setup(t);
  const ctx = s.env.context();
  const session = await s.env.childSession();
  const id = s.manager.spawn(s.env.pi, ctx, "reviewer", "p", {
    ...background,
    reviewTicket: ticket(),
  });
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await done;
  const record = s.manager.getRecord(id);
  assert.equal(record?.status, "completed");
  const generation = record?.resultGeneration;

  await assert.rejects(s.manager.resume(id, "next", undefined, { isBackground: true }), REQUIRED);
  assert.equal(record?.status, "completed");
  assert.equal(record?.resultGeneration, generation);
  assert.equal(s.h.resumes.length, 0);

  const reviewTicket = ticket();
  const resumed = await s.manager.resume(id, "next", undefined, {
    isBackground: true,
    reviewTicket,
  });
  assert.equal(resumed?.id, id);
  assert.equal(s.h.resumes.length, 1);
  await assert.rejects(
    s.manager.resume(id, "reuse", undefined, { isBackground: true, reviewTicket }),
    REQUIRED,
  );
});

test("resume of a non-review agent needs no ticket", async (t) => {
  const s = await setup(t);
  const session = await s.env.childSession();
  const id = s.manager.spawn(s.env.pi, s.env.context(), "implementer", "p", background);
  const done = s.manager.getRecord(id)?.promise;
  s.h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await done;
  const resumed = await s.manager.resume(id, "next", undefined, { isBackground: true });
  assert.equal(resumed?.id, id);
});

test("resumeDormant of a reviewer requires a ticket; a non-review agent does not", async (t) => {
  const s = await setup(t);
  const reviewerFile = join(s.dir, "r.jsonl");
  const implementerFile = join(s.dir, "i.jsonl");
  await writeFile(reviewerFile, '{"type":"session"}\n');
  await writeFile(implementerFile, '{"type":"session"}\n');
  s.manager.hydrateDormant([
    { ...snapshot("dorm-r", "reviewer", reviewerFile), status: "completed", result: "old" },
    { ...snapshot("dorm-i", "implementer", implementerFile), status: "completed", result: "old" },
  ]);
  const context: RevivalContext = { pi: s.env.pi, ctx: s.env.context() };

  await assert.rejects(s.manager.resumeDormant("dorm-r", "go", context), REQUIRED);
  assert.ok(s.manager.getDormant("dorm-r"), "still dormant after the refusal");
  assert.equal(s.h.runs.length, 0);

  const record = await s.manager.resumeDormant("dorm-r", "go", context, {
    reviewTicket: ticket(),
  });
  assert.equal(record.id, "dorm-r");
  assert.equal(s.h.runs.length, 1);

  const other = await s.manager.resumeDormant("dorm-i", "go", context);
  assert.equal(other.id, "dorm-i");
});

test("journal revival of a reviewer record stays exempt", async (t) => {
  const s = await setup(t);
  const file = join(s.dir, "rev.jsonl");
  await writeFile(file, '{"type":"session"}\n');
  const reports = await s.manager.reviveFromJournal(
    [{ suspended: true, agent: snapshot("rev-r", "reviewer", file) }],
    { pi: s.env.pi, ctx: s.env.context() },
  );
  assert.deepEqual(
    reports.map((report) => report.kind),
    ["revived"],
  );
  assert.equal(s.manager.getRecord("rev-r")?.type, "reviewer");
  assert.equal(s.h.runs.length, 1);
  await flush();
});

test("the RPC spawn path returns an error envelope for a reviewer and still serves others", async (t) => {
  const s = await setup(t);
  const handlers = new Map<string, (data: Parameters<EventBus["emit"]>[1]) => void>();
  const replies: string[] = [];
  const events: EventBus = {
    on(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    emit(channel, data) {
      if (channel.startsWith("subagents:rpc:spawn:reply:")) {
        replies.push(JSON.stringify(data));
      }
    },
  };
  const handle = registerRpcHandlers({
    events,
    pi: s.env.pi,
    getCtx: () => s.env.context(),
    manager: s.manager,
  });
  t.after(() => handle.unsubSpawn());
  const spawn = handlers.get("subagents:rpc:spawn");
  assert.ok(spawn);

  spawn({ requestId: "a", type: "reviewer", prompt: "p", options: { isolated: true } });
  await flush();
  assert.match(replies.at(-1) ?? "", /"success":false/);
  assert.match(replies.at(-1) ?? "", REQUIRED);
  assert.equal(s.manager.listAgents().length, 0);

  spawn({
    requestId: "b",
    type: "reviewer",
    prompt: "p",
    options: { isolated: true, reviewTicket: { roundId: "x", workTask: "w", rootSessionId: "s" } },
  });
  await flush();
  assert.match(replies.at(-1) ?? "", /"success":false/, "a wire object is not a ticket");
  assert.equal(s.manager.listAgents().length, 0);

  spawn({ requestId: "c", type: "implementer", prompt: "p", options: { isolated: true } });
  await flush();
  assert.match(replies.at(-1) ?? "", /"success":true/);
  assert.equal(s.manager.listAgents().length, 1);
});
