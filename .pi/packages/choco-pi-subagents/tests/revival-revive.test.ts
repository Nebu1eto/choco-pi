import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  REARM_POLICY_RETRY_MS,
  REARM_RESET_GRACE_MS,
  ResumeModelError,
  USAGE_LIMIT_RESUME_PROMPT,
  type AgentManager,
  type RevivalContext,
  type RevivalReport,
  type RevivalSnapshot,
  type SubagentJournalSink,
} from "../src/agent-manager.ts";
import {
  CAPPED_REVIVAL_ERROR,
  type JournalAgentSnapshot,
  reduceJournal,
  SUBAGENT_JOURNAL_ENTRY,
  startupDisposition,
  type SubagentJournalData,
} from "../src/revival-journal.ts";
import { setScopeModelsEnabled } from "../src/model-scope.ts";
import {
  claimSessionFile,
  releaseSessionFile,
  sessionFileOwner,
} from "../src/session-file-ownership.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicy,
  policyState,
  type Harness,
  type HarnessOptions,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const execFileAsync = promisify(execFile);

interface Setup {
  env: UsageLimitEnv;
  h: Harness;
  manager: AgentManager;
  entries: SubagentJournalData[];
  reports: RevivalReport[];
  context: RevivalContext;
  dir: string;
}

async function setup(t: TestContext, options: HarnessOptions = {}): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-revive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(options);
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  const entries: SubagentJournalData[] = [];
  const sink: SubagentJournalSink = {
    rootSessionId: env.owner,
    append: (data) => entries.push(data),
  };
  h.manager.setJournalSink(sink);
  const reports: RevivalReport[] = [];
  const context: RevivalContext = {
    pi: env.pi,
    ctx: env.context(),
    onRevivalReport: (report) => reports.push(report),
  };
  return { env, h, manager: h.manager, entries, reports, context, dir };
}

async function sessionFile(dir: string, name: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, '{"type":"session"}\n');
  return file;
}

function snap(id: string, overrides: Partial<JournalAgentSnapshot> = {}): JournalAgentSnapshot {
  return {
    id,
    handle: `implementer-${id}`,
    type: "implementer",
    description: `revive ${id}`,
    depth: 1,
    status: "interrupted",
    options: { isBackground: true, isolated: true },
    model: { provider: "anthropic", id: "claude-opus-4-5" },
    revivals: 0,
    resultConsumed: false,
    ...overrides,
  };
}

function input(agent: JournalAgentSnapshot, suspended = true): RevivalSnapshot {
  return { suspended, agent };
}

function lastOf(entries: SubagentJournalData[], id: string): SubagentJournalData | undefined {
  return entries.filter((entry) => entry.agent.id === id).at(-1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A temp git repo with one commit and a detached worktree at `dir/name`. */
async function repoWithWorktree(
  t: TestContext,
  dir: string,
  name: string,
): Promise<{
  repo: string;
  path: string;
  baseSha: string;
  git: (...args: string[]) => Promise<{ stdout: string }>;
}> {
  const repo = await mkdtemp(join(tmpdir(), "choco-pi-revive-repo-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(repo, "file.txt"), "content\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();
  const path = join(dir, name);
  await git("worktree", "add", "--detach", path, "HEAD");
  t.after(async () => {
    await git("worktree", "remove", "--force", path).catch(() => undefined);
  });
  return { repo, path, baseSha, git };
}

test("a clean revival reuses id, handle and options and reopens the file with the interruption prompt", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "a.jsonl");
  const agent = snap("rev-a", {
    alias: "auth-audit",
    sessionFile: file,
    steers: ["also check the tests"],
    options: {
      isBackground: false,
      readOnly: true,
      isolated: true,
      inheritContext: true,
      maxTurns: 9,
      scopedModels: ["openai/gpt-5.6-sol"],
    },
  });
  const reports = await s.manager.reviveFromJournal([input(agent)], s.context);

  assert.deepEqual(
    reports.map((report) => report.kind),
    ["revived"],
  );
  assert.equal(s.h.runs.length, 1);
  const options = s.h.runOptions[0];
  assert.equal(options.agentId, "rev-a");
  assert.equal(options.resumeSessionFile, file, "reopened through the runner's resume path");
  assert.equal(options.readOnly, true, "readOnly is never widened");
  assert.equal(options.maxTurns, 9);
  assert.equal(options.inheritContext, false, "a reopened file already holds the context");
  const prompt = s.h.runPrompts[0];
  assert.match(prompt, /restarted, reloaded, or switched sessions/);
  assert.match(prompt, /also check the tests/);
  const record = s.manager.getRecord("rev-a");
  assert.equal(record?.handle, "implementer-rev-a");
  assert.equal(record?.alias, "auth-audit");
  assert.equal(record?.isBackground, true, "a foreground agent comes back in the background");
  assert.deepEqual(record?.runOptions?.scopedModels, ["openai/gpt-5.6-sol"]);
  assert.ok(sessionFileOwner(file)?.includes("rev-a"), "the file is claimed for the record");
  await flush();
  assert.equal(lastOf(s.entries, "rev-a")?.agent.revivals, 0);
  assert.equal(lastOf(s.entries, "rev-a")?.suspended, false);
});

test("an unclean revival journals revivals+1 before the runner starts", async (t) => {
  let entriesAtRun = -1;
  let entries: SubagentJournalData[] = [];
  const s = await setup(t, {
    onRunAgent: () => {
      entriesAtRun = entries.filter(
        (entry) => entry.agent.id === "rev-u" && entry.agent.revivals === 2,
      ).length;
    },
  });
  entries = s.entries;
  const file = await sessionFile(s.dir, "u.jsonl");
  const agent = snap("rev-u", { status: "running", sessionFile: file, revivals: 1 });
  const reports = await s.manager.reviveFromJournal([input(agent, false)], s.context);
  assert.equal(reports[0]?.kind, "revived");
  assert.ok(entriesAtRun >= 1, "revivals were journaled before runAgent was called");
  assert.equal(s.manager.getRecord("rev-u")?.revivals, 2);
  assert.match(s.h.runPrompts[0], /ended unexpectedly/);
});

test("a queued run without a session file restarts from its original prompt under the same id", async (t) => {
  const s = await setup(t);
  const agent = snap("rev-q", {
    status: "interrupted",
    prompt: "original task",
    steers: ["early"],
  });
  const reports = await s.manager.reviveFromJournal([input(agent)], s.context);
  assert.equal(reports[0]?.kind, "revived");
  assert.match(reports[0]?.message ?? "", /original prompt/);
  assert.equal(s.h.runPrompts[0], "original task");
  assert.equal(s.h.runOptions[0].resumeSessionFile, undefined);
  assert.equal(s.h.runOptions[0].agentId, "rev-q");
  assert.deepEqual(s.manager.getRecord("rev-q")?.pendingSteers, ["early"]);
});

test("capped and stopped snapshots are not revived", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "c.jsonl");
  const capped = snap("rev-cap", { status: "running", sessionFile: file, revivals: 2 });
  const stopped = snap("rev-stop", { status: "stopped", stoppedByUser: true, sessionFile: file });
  const reports = await s.manager.reviveFromJournal(
    [input(capped, false), input(stopped, false)],
    s.context,
  );
  assert.deepEqual(
    reports.map((report) => [report.kind, report.agentId]),
    [["capped", "rev-cap"]],
  );
  assert.equal(s.h.runs.length, 0);
  // Capped once: journaled as a terminal error, so the next startup neither
  // revives nor re-reports it.
  assert.equal(s.manager.getDormant("rev-cap")?.status, "error");
  assert.equal(s.manager.getDormant("rev-cap")?.error, CAPPED_REVIVAL_ERROR);
  const cappedEntry = lastOf(s.entries, "rev-cap");
  assert.ok(cappedEntry);
  assert.equal(cappedEntry.agent.status, "error");
  assert.equal(cappedEntry.suspended, false);
  const again = await s.manager.reviveFromJournal([input(cappedEntry.agent, false)], s.context);
  assert.deepEqual(again, [], "a capped agent is reported once");
  assert.equal(s.h.runs.length, 0);
  assert.equal(s.manager.getDormant("rev-stop")?.status, "stopped");
  assert.equal(sessionFileOwner(file), undefined, "nothing claimed the file");
});

test("validation failures become journaled errors and are reported", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "v.jsonl");
  const badModel = snap("rev-model", {
    sessionFile: file,
    model: { provider: "anthropic", id: "no-such-model" },
  });
  const badType = snap("rev-type", { sessionFile: file, type: "Gone" });
  const memory = snap("rev-mem", { status: "running", inMemorySession: true, prompt: "p" });
  const reports = await s.manager.reviveFromJournal(
    [input(badModel), input(badType), input(memory)],
    {
      ...s.context,
      resolveType: (type) =>
        type === "Gone" ? { ok: false, message: 'Unknown agent type "Gone".' } : { ok: true, type },
    },
  );
  assert.deepEqual(
    reports.map((report) => report.kind),
    ["failed", "failed", "failed"],
  );
  assert.equal(s.h.runs.length, 0);
  assert.match(lastOf(s.entries, "rev-model")?.agent.error ?? "", /no-such-model/);
  assert.equal(lastOf(s.entries, "rev-model")?.agent.status, "error");
  assert.match(lastOf(s.entries, "rev-type")?.agent.error ?? "", /Unknown agent type/);
  assert.match(lastOf(s.entries, "rev-mem")?.agent.error ?? "", /persist_session: false/);
  assert.equal(s.manager.getDormant("rev-model")?.status, "error", "reachable, never retried");
  assert.equal(sessionFileOwner(file), undefined);
});

test("a revival waits for the previous owner to release the session file", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "w.jsonl");
  assert.equal(claimSessionFile(file, "outgoing-instance"), true);
  const pending = s.manager.reviveFromJournal(
    [input(snap("rev-w", { sessionFile: file }))],
    s.context,
  );
  await flush();
  assert.equal(s.h.runs.length, 0, "not opened while another owner holds it");
  releaseSessionFile(file, "outgoing-instance");
  const reports = await pending;
  assert.equal(reports[0]?.kind, "revived");
  assert.equal(s.h.runOptions[0].resumeSessionFile, file);
});

test("a session file never released is not opened and the agent stays dormant", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "x.jsonl");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  assert.equal(claimSessionFile(file, "stuck-owner"), true);
  t.after(() => releaseSessionFile(file, "stuck-owner"));
  const pending = s.manager.reviveFromJournal(
    [input(snap("rev-x", { sessionFile: file }))],
    s.context,
  );
  await flush();
  t.mock.timers.tick(15_000);
  const reports = await pending;
  assert.equal(reports[0]?.kind, "failed");
  assert.match(reports[0]?.message ?? "", /still in use/);
  assert.equal(s.h.runs.length, 0);
  assert.equal(s.manager.getDormant("rev-x")?.status, "interrupted");
  assert.equal(lastOf(s.entries, "rev-x"), undefined, "a transient failure is not journaled");
});

test("a present worktree is adopted and cleaned up on the final settle; a missing one is reported", async (t) => {
  const s = await setup(t);
  const { repo, path, baseSha, git } = await repoWithWorktree(t, s.dir, "wt");
  const before = (await git("worktree", "list", "--porcelain")).stdout;
  const file = await sessionFile(s.dir, "wt.jsonl");
  const present = snap("rev-wt", {
    sessionFile: file,
    options: { isBackground: true, isolation: "worktree" },
    worktree: { path, branch: "pi-agent-rev-wt", baseSha, repo },
  });
  const missing = snap("rev-gone", {
    sessionFile: file,
    options: { isBackground: true, isolation: "worktree" },
    worktree: { path: join(s.dir, "gone"), branch: "pi-agent-gone", baseSha, repo },
  });
  const reports = await s.manager.reviveFromJournal([input(present), input(missing)], s.context);
  const byId = new Map(reports.map((report) => [report.agentId, report]));
  assert.equal(byId.get("rev-wt")?.kind, "revived");
  assert.equal(byId.get("rev-gone")?.kind, "failed");
  assert.match(byId.get("rev-gone")?.message ?? "", /pi-agent-gone/);
  assert.match(lastOf(s.entries, "rev-gone")?.agent.error ?? "", /pi-agent-gone/);

  assert.equal(s.h.runs.length, 1);
  assert.equal(s.h.runOptions[0].cwd, path, "runs in the original worktree");
  assert.equal(s.manager.getRecord("rev-wt")?.worktree?.path, path);
  assert.equal((await git("worktree", "list", "--porcelain")).stdout, before, "none created");

  const session = await s.env.childSession();
  s.h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await s.manager.getRecord("rev-wt")?.promise;
  await flush();
  assert.equal(s.manager.getRecord("rev-wt")?.status, "completed");
  assert.equal(await exists(path), false, "the final settle cleaned the adopted worktree");
});

test("a dormant agent resumes from its file under the same id", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "d.jsonl");
  const interruptedFile = await sessionFile(s.dir, "di.jsonl");
  s.manager.hydrateDormant([
    snap("dorm", { status: "completed", sessionFile: file, result: "old" }),
    snap("dorm-int", { status: "interrupted", sessionFile: interruptedFile }),
  ]);
  assert.equal(s.manager.assertResumable("dorm"), false, "the live-only check is unchanged");
  assert.equal(s.manager.assertResumable("dorm", undefined, { dormant: true }), true);

  const record = await s.manager.resumeDormant("dorm", "next step", s.context);
  assert.equal(record.id, "dorm");
  assert.equal(record.handle, "implementer-dorm");
  assert.equal(s.h.runOptions[0].resumeSessionFile, file);
  assert.equal(s.h.runPrompts[0], "next step");
  assert.equal(s.manager.getDormant("dorm"), undefined, "live again");
  await assert.rejects(s.manager.resumeDormant("dorm", "again", s.context), /live/);

  await s.manager.resumeDormant("dorm-int", "go on", s.context);
  assert.match(s.h.runPrompts[1], /^Your previous run was interrupted before it finished\./);
  assert.match(s.h.runPrompts[1], /go on$/);
  await assert.rejects(s.manager.resumeDormant("unknown", "x", s.context), /No saved agent/);
});

interface RearmSetup extends Setup {
  file: string;
}

async function rearmSetup(t: TestContext): Promise<RearmSetup> {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "r.jsonl");
  return { ...s, file };
}

function waiting(file: string, resetAt: number | undefined): JournalAgentSnapshot {
  return snap("rev-r", {
    status: "waiting_for_reset",
    sessionFile: file,
    usageWait: {
      providerKey: "anthropic",
      resetAt,
      classification: {
        kind: "quota",
        provider: "anthropic",
        modelId: "claude-opus-4-5",
        confidence: "structured",
        resetAt,
      },
      steers: ["queued steer"],
    },
  });
}

test("a re-armed wait with a future reset wakes on schedule and reopens the file", async (t) => {
  const s = await rearmSetup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const installed = installPolicy(
    policyState({ preference: "auto-resume", corroborate: () => ({ ready: true }) }),
    s.env.owner,
  );
  t.after(() => installed.remove());
  const resetAt = Date.now() + 60_000;
  const reports = await s.manager.reviveFromJournal([input(waiting(s.file, resetAt))], s.context);
  assert.equal(reports[0]?.kind, "rearmed");
  assert.equal(s.manager.getRecord("rev-r")?.status, "waiting_for_reset");
  assert.ok(sessionFileOwner(s.file)?.includes("rev-r"), "claimed while waiting");
  await flush();
  assert.equal(lastOf(s.entries, "rev-r")?.agent.status, "waiting_for_reset");
  assert.deepEqual(lastOf(s.entries, "rev-r")?.agent.usageWait?.steers, ["queued steer"]);

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(s.h.runs.length, 0, "not before reset + margin");
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(s.h.runs.length, 1);
  assert.equal(s.h.runOptions[0].agentId, "rev-r");
  assert.equal(s.h.runOptions[0].resumeSessionFile, s.file);
  assert.equal(s.h.runPrompts[0], `${USAGE_LIMIT_RESUME_PROMPT}\n\nqueued steer`);
  assert.equal(s.manager.getRecord("rev-r")?.status, "running");
});

test("a re-armed wait whose reset passed re-checks after a short grace", async (t) => {
  const s = await rearmSetup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const installed = installPolicy(
    policyState({ preference: "auto-resume", corroborate: () => ({ ready: true }) }),
    s.env.owner,
  );
  t.after(() => installed.remove());
  await s.manager.reviveFromJournal([input(waiting(s.file, Date.now() - 1_000))], s.context);
  t.mock.timers.tick(REARM_RESET_GRACE_MS - 1);
  await flush();
  assert.equal(s.h.runs.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(s.h.runs.length, 1);
  assert.equal(s.h.runOptions[0].resumeSessionFile, s.file);
});

test("a re-armed wake retries while the policy registers late", async (t) => {
  const s = await rearmSetup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  await s.manager.reviveFromJournal([input(waiting(s.file, Date.now() - 1_000))], s.context);
  t.mock.timers.tick(REARM_RESET_GRACE_MS);
  await flush();
  assert.equal(s.manager.getRecord("rev-r")?.status, "waiting_for_reset", "no policy yet: retry");
  t.mock.timers.tick(4_000);
  await flush();
  const installed = installPolicy(
    policyState({ preference: "auto-resume", corroborate: () => ({ ready: true }) }),
    s.env.owner,
  );
  t.after(() => installed.remove());
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(s.h.runs.length, 1, "resumed once the policy appeared");
});

test("a re-armed wake gives up when the policy never registers", async (t) => {
  const s = await rearmSetup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  await s.manager.reviveFromJournal([input(waiting(s.file, Date.now() - 1_000))], s.context);
  t.mock.timers.tick(REARM_RESET_GRACE_MS);
  await flush();
  for (let elapsed = 0; elapsed <= REARM_POLICY_RETRY_MS; elapsed += 2_000) {
    t.mock.timers.tick(2_000);
    await flush();
  }
  const record = s.manager.getRecord("rev-r");
  assert.equal(record?.status, "error");
  assert.match(record?.error ?? "", /policy is no longer available/);
  assert.equal(s.h.runs.length, 0);
});

test("a re-armed wait journals its adopted worktree and cleans it if stopped before waking", async (t) => {
  const s = await rearmSetup(t);
  const { repo, path, baseSha } = await repoWithWorktree(t, s.dir, "rwt");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const agent: JournalAgentSnapshot = {
    ...waiting(s.file, Date.now() + 60_000),
    options: { isBackground: true, isolation: "worktree" },
    worktree: { path, branch: "pi-agent-rev-r", baseSha, repo },
  };
  const reports = await s.manager.reviveFromJournal([input(agent)], s.context);
  assert.equal(reports[0]?.kind, "rearmed");
  await flush();
  assert.equal(lastOf(s.entries, "rev-r")?.agent.worktree?.path, path, "journaled while waiting");
  assert.equal(s.manager.abort("rev-r"), true);
  await flush();
  assert.equal(s.manager.getRecord("rev-r")?.status, "stopped");
  assert.equal(await exists(path), false, "the stop's final settle removed the worktree");
  assert.notEqual(sessionFileOwner(s.file), undefined, "the live record still holds its file");
  s.manager.clearCompleted();
  await flush();
  assert.equal(sessionFileOwner(s.file), undefined, "released on eviction");
});

// ---- U5 follow-up: crash window and dormant resume with a model ----

const OPUS_REF = "anthropic/claude-opus-4-5";
const SOL_REF = "openai/gpt-5.6-sol";
const KIMI_REF = "moonshotai/kimi-k3";

/** Occupy the only pool slot so the next revival queues. */
function fillSlot(s: Setup): void {
  s.manager.spawn(s.env.pi, s.context.ctx, "implementer", "blocker", {
    description: "blocker",
    isBackground: true,
    isolated: true,
  });
  assert.equal(s.h.runs.length, 1);
}

test("a revival queued behind the cap journals its file, and a kill then reopens that file", async (t) => {
  const s = await setup(t, { maxConcurrent: 1 });
  const file = await sessionFile(s.dir, "q.jsonl");
  fillSlot(s);
  const reports = await s.manager.reviveFromJournal(
    [input(snap("rev-cq", { sessionFile: file }))],
    s.context,
  );
  assert.equal(reports[0]?.kind, "revived");
  assert.equal(s.manager.getRecord("rev-cq")?.status, "queued");
  assert.equal(s.h.runs.length, 1, "still queued behind the blocker");
  await flush();
  const queued = lastOf(s.entries, "rev-cq");
  assert.ok(queued);
  assert.equal(queued.agent.status, "queued");
  assert.equal(queued.agent.sessionFile, file, "the first entry already points at the file");
  assert.equal(queued.agent.prompt, undefined, "the interruption prompt is never the prompt");
  for (const entry of s.entries.filter((e) => e.agent.id === "rev-cq")) {
    assert.equal(entry.agent.prompt, undefined);
  }

  // Kill in that window: the process (and its file claims) disappears; the
  // next start reduces the journal and revives from it.
  s.manager.dispose();
  assert.equal(sessionFileOwner(file), undefined, "the dead process holds no claim");
  const disposition = startupDisposition(queued);
  assert.deepEqual(disposition, { kind: "revive", clean: false, revivals: 1 });
  const next = harness();
  t.after(() => next.manager.dispose());
  const nextEntries: SubagentJournalData[] = [];
  next.manager.setJournalSink({
    rootSessionId: s.env.owner,
    append: (data) => nextEntries.push(data),
  });
  const again = await next.manager.reviveFromJournal([queued], {
    pi: s.env.pi,
    ctx: s.env.context(),
  });
  assert.equal(again[0]?.kind, "revived");
  assert.equal(next.runOptions[0]?.resumeSessionFile, file, "reopened, not a fresh session");
  assert.equal(next.runOptions[0]?.agentId, "rev-cq");
  assert.match(next.runPrompts[0] ?? "", /ended unexpectedly/);
});

test("a worktree revival queued behind the cap journals its original worktree and a restart adopts it", async (t) => {
  const s = await setup(t, { maxConcurrent: 1 });
  const first = await repoWithWorktree(t, s.dir, "wt-first");
  const second = await repoWithWorktree(t, s.dir, "wt-second");
  const before = (await second.git("worktree", "list", "--porcelain")).stdout;
  const runningSnap = snap("rev-wt-run", {
    sessionFile: await sessionFile(s.dir, "wt-run.jsonl"),
    options: { isBackground: true, isolation: "worktree" },
    worktree: {
      path: first.path,
      branch: "pi-agent-rev-wt-run",
      baseSha: first.baseSha,
      repo: first.repo,
    },
  });
  const queuedWorktree = {
    path: second.path,
    branch: "pi-agent-rev-wt-q",
    baseSha: second.baseSha,
    repo: second.repo,
  };
  const queuedSnap = snap("rev-wt-q", {
    sessionFile: await sessionFile(s.dir, "wt-q.jsonl"),
    options: { isBackground: true, isolation: "worktree" },
    worktree: queuedWorktree,
  });
  const reports = await s.manager.reviveFromJournal(
    [input(runningSnap), input(queuedSnap)],
    s.context,
  );
  assert.deepEqual(
    reports.map((report) => report.kind),
    ["revived", "revived"],
  );
  assert.equal(s.h.runs.length, 1, "the cap holds the second revival");
  assert.equal(s.manager.getRecord("rev-wt-q")?.status, "queued");
  await flush();
  const queuedEntries = s.entries.filter((entry) => entry.agent.id === "rev-wt-q");
  assert.ok(queuedEntries.length > 0);
  for (const entry of queuedEntries) {
    assert.equal(entry.agent.worktree?.path, second.path, "every entry carries the worktree");
    assert.equal(entry.agent.worktree?.repo, second.repo);
    assert.equal(entry.agent.worktree?.branch, queuedWorktree.branch);
  }

  // Restart before the queued revival starts: reduce the journal as startup does.
  s.manager.dispose();
  assert.equal(await exists(second.path), true, "the original worktree is untouched");
  const reduced = reduceJournal(
    s.entries.map((data, index) => ({
      type: "custom",
      id: `e${index}`,
      customType: SUBAGENT_JOURNAL_ENTRY,
      data,
    })),
    s.env.owner,
  );
  const latest = reduced.get("rev-wt-q");
  assert.ok(latest);
  assert.equal(latest.agent.status, "queued");
  assert.equal(latest.agent.worktree?.path, second.path, "latest-wins keeps the worktree");
  assert.deepEqual(startupDisposition(latest), { kind: "revive", clean: false, revivals: 1 });
  const next = harness();
  t.after(() => next.manager.dispose());
  next.manager.setJournalSink({ rootSessionId: s.env.owner, append: () => undefined });
  const again = await next.manager.reviveFromJournal([latest], {
    pi: s.env.pi,
    ctx: s.env.context(),
  });
  assert.equal(again[0]?.kind, "revived");
  assert.equal(next.runOptions[0]?.agentId, "rev-wt-q");
  assert.equal(next.runOptions[0]?.cwd, second.path, "runs in the original worktree");
  assert.equal(next.manager.getRecord("rev-wt-q")?.worktree?.path, second.path);
  assert.equal(
    (await second.git("worktree", "list", "--porcelain")).stdout,
    before,
    "no new worktree was created",
  );
});

test("a queued revival without a file keeps the original prompt in the journal", async (t) => {
  const s = await setup(t, { maxConcurrent: 1 });
  fillSlot(s);
  await s.manager.reviveFromJournal(
    [input(snap("rev-qp", { status: "queued", prompt: "original task" }), false)],
    s.context,
  );
  assert.equal(s.manager.getRecord("rev-qp")?.status, "queued");
  await flush();
  const entry = lastOf(s.entries, "rev-qp");
  assert.equal(entry?.agent.status, "queued");
  assert.equal(entry?.agent.sessionFile, undefined);
  assert.equal(entry?.agent.prompt, "original task");
});

test("a dormant resume with a model revives on that model and journals it", async (t) => {
  const s = await setup(t);
  const file = await sessionFile(s.dir, "m.jsonl");
  s.manager.hydrateDormant([
    snap("dorm-m", {
      status: "completed",
      sessionFile: file,
      model: { provider: "anthropic", id: "claude-opus-4-5" },
    }),
  ]);
  assert.equal(
    s.manager.assertResumable("dorm-m", SOL_REF, { dormant: true, ctx: s.context.ctx }),
    true,
  );
  const record = await s.manager.resumeDormant("dorm-m", "on sol", s.context, { model: SOL_REF });
  assert.equal(record.id, "dorm-m");
  assert.equal(s.h.runOptions[0]?.resumeSessionFile, file);
  assert.equal(`${s.h.runOptions[0]?.model?.provider}/${s.h.runOptions[0]?.model?.id}`, SOL_REF);
  await flush();
  assert.deepEqual(lastOf(s.entries, "dorm-m")?.agent.model, {
    provider: "openai",
    id: "gpt-5.6-sol",
  });
});

test("a dormant resume with an out-of-scope model is refused like a live resume", async (t) => {
  const s = await setup(t);
  const cwd = await mkdtemp(join(tmpdir(), "revive-scope-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ enabledModels: [OPUS_REF, SOL_REF] }),
  );
  setScopeModelsEnabled(true);
  t.after(() => setScopeModelsEnabled(false));
  const file = await sessionFile(s.dir, "s.jsonl");
  s.manager.hydrateDormant([snap("dorm-s", { status: "completed", sessionFile: file })]);
  const context: RevivalContext = { ...s.context, ctx: s.env.context({ cwd }) };
  assert.throws(
    () => s.manager.assertResumable("dorm-s", KIMI_REF, { dormant: true, ctx: context.ctx }),
    (error: Error) => error instanceof ResumeModelError && /not in scope/.test(error.message),
  );
  await assert.rejects(
    s.manager.resumeDormant("dorm-s", "x", context, { model: KIMI_REF }),
    (error: Error) => error instanceof ResumeModelError && /not in scope/.test(error.message),
  );
  await assert.rejects(
    s.manager.resumeDormant("dorm-s", "x", context, { model: "nobody/nothing" }),
    (error: Error) => error instanceof ResumeModelError && /not available/.test(error.message),
  );
  assert.equal(s.h.runs.length, 0);
  assert.equal(s.manager.getDormant("dorm-s")?.status, "completed", "still dormant");
  assert.equal(sessionFileOwner(file), undefined, "nothing claimed the file");
  assert.equal(s.manager.canResumeDormant("dorm-s"), true, "no reservation left behind");
});

test("a dormant resume onto a closed provider is refused like a live resume", async (t) => {
  const s = await setup(t);
  const installed = installPolicy(
    policyState({ isClosed: (providerKey) => providerKey === "openai" }),
    s.env.owner,
  );
  t.after(() => installed.remove());
  const file = await sessionFile(s.dir, "c2.jsonl");
  s.manager.hydrateDormant([snap("dorm-c", { status: "completed", sessionFile: file })]);
  assert.throws(
    () => s.manager.assertResumable("dorm-c", SOL_REF, { dormant: true, ctx: s.context.ctx }),
    (error: Error) =>
      error instanceof ResumeModelError && /Provider openai unavailable/.test(error.message),
  );
  await assert.rejects(
    s.manager.resumeDormant("dorm-c", "x", s.context, { model: SOL_REF }),
    (error: Error) =>
      error instanceof ResumeModelError && /Provider openai unavailable/.test(error.message),
  );
  assert.equal(s.h.runs.length, 0);
  assert.equal(sessionFileOwner(file), undefined);
});

for (const outcome of ["settles", "throws"] as const) {
  test(`a suspend while a hook-managed worktree removal is pending publishes nothing (run ${outcome})`, async (t) => {
    await suspendDuringHookRemoval(t, outcome);
  });
}

/** What the test's `subagents:worktree-remove` listener observed. */
interface HookRemoval {
  done?: () => void;
  paths: string[];
}

async function suspendDuringHookRemoval(t: TestContext, outcome: "settles" | "throws") {
  const s = await setup(t);
  const hookPath = join(s.dir, "hook-wt");
  await mkdir(hookPath);
  const removal: HookRemoval = { paths: [] };
  const RemovePayload = Type.Object({
    path: Type.String(),
    claim: Type.Function([], Type.Void()),
    done: Type.Function([], Type.Void()),
  });
  const unsubscribe = s.env.pi.events.on("subagents:worktree-remove", (payload) => {
    if (!Value.Check(RemovePayload, payload)) return;
    removal.paths.push(payload.path);
    payload.claim();
    removal.done = payload.done;
  });
  t.after(() => unsubscribe());
  const completions = s.h.completions;
  const agent = snap("rev-hook", {
    sessionFile: await sessionFile(s.dir, "hook.jsonl"),
    options: { isBackground: true, isolation: "worktree" },
    worktree: {
      path: hookPath,
      branch: "pi-agent-rev-hook",
      baseSha: "0000000",
      repo: s.dir,
      hookManaged: true,
    },
  });
  const reports = await s.manager.reviveFromJournal([input(agent)], s.context);
  assert.equal(reports[0]?.kind, "revived");
  const session = await s.env.childSession();
  if (outcome === "settles") {
    s.h.runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  } else {
    s.h.runs[0].reject(new Error("runner crashed"));
  }
  await flush();
  assert.deepEqual(removal.paths, [hookPath], "the final settle awaits the hook removal");
  assert.equal(s.manager.getRecord("rev-hook")?.status, "running");

  const pending = s.manager.suspendAll();
  removal.done?.();
  const summary = await pending;
  await flush();

  assert.deepEqual(summary.suspended, ["rev-hook"]);
  assert.deepEqual(summary.unsettled, []);
  const last = lastOf(s.entries, "rev-hook");
  assert.equal(last?.suspended, true, "the suspend entry stays the latest");
  assert.equal(last?.agent.status, "interrupted");
  assert.deepEqual(completions, [], "no completion callback");
  assert.equal(s.manager.getRecord("rev-hook"), undefined);
}
