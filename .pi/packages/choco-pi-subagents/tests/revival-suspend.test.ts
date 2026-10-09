import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  SUSPEND_SETTLE_TIMEOUT_MS,
  type AgentManager,
  type SubagentJournalSink,
} from "../src/agent-manager.ts";
import type { SubagentJournalData } from "../src/revival-journal.ts";
import { sessionFileOwner } from "../src/session-file-ownership.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  flush,
  harness,
  installPolicy,
  policyState,
  type HarnessOptions,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const execFileAsync = promisify(execFile);
const background = { description: "suspend probe", isBackground: true, isolated: true };
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";

async function setup(t: TestContext): Promise<UsageLimitEnv> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  return env;
}

function journal(manager: AgentManager, root: string): SubagentJournalData[] {
  const entries: SubagentJournalData[] = [];
  const sink: SubagentJournalSink = { rootSessionId: root, append: (data) => entries.push(data) };
  manager.setJournalSink(sink);
  return entries;
}

function entriesOf(entries: SubagentJournalData[], id: string): SubagentJournalData[] {
  return entries.filter((entry) => entry.agent.id === id);
}

function managed(t: TestContext, options: HarnessOptions = {}) {
  const h = harness(options);
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  return h;
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-suspend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A child session whose manager reports `file` as its session file. */
async function sessionWithFile(env: UsageLimitEnv, file: string): Promise<AgentSession> {
  const session = await env.childSession();
  session.sessionManager.getSessionFile = () => file;
  return session;
}

/**
 * Install an auto-resume quota policy whose corroboration stays pending until
 * `release()`, so a suspend can land while the usage-limit evaluation awaits it.
 */
function heldCorroboration(t: TestContext, env: UsageLimitEnv) {
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "structured", resetAt: Date.now() + 3_600_000 },
  });
  const installed = installPolicy(state, env.owner);
  t.after(() => installed.remove());
  const gate = deferred<undefined>();
  installed.policy.corroborate = async (classification) => {
    state.corroborations++;
    await gate.promise;
    return { ready: false, classification };
  };
  return { state, release: () => gate.resolve(undefined) };
}

/** The record's journal entries after its suspend entry. */
function afterSuspend(entries: SubagentJournalData[], id: string): SubagentJournalData[] {
  const own = entriesOf(entries, id);
  const index = own.findIndex((entry) => entry.suspended);
  assert.notEqual(index, -1, `${id}: a suspend entry was written`);
  return own.slice(index + 1);
}

test("suspend journals interrupted entries before aborting, and nothing follows them", async (t) => {
  const env = await setup(t);
  const dir = await tempDir(t);
  const session = await sessionWithFile(env, join(dir, "a.jsonl"));
  const { manager, runs, runOptions, completions } = managed(t, {
    maxConcurrent: 1,
    onRunAgent: (options) => options.onSessionCreated?.(session),
  });
  const entries = journal(manager, env.owner);

  const running = manager.spawn(env.pi, env.context(), "implementer", "task one", background);
  const queued = manager.spawn(env.pi, env.context(), "implementer", "task two", background);
  assert.equal(manager.steer(queued, "also check docs"), true);
  await flush();

  let suspendedAtAbort: SubagentJournalData | undefined;
  runOptions[0].signal?.addEventListener("abort", () => {
    suspendedAtAbort = entriesOf(entries, running).at(-1);
  });

  const pending = manager.suspendAll();
  assert.equal(suspendedAtAbort?.suspended, true, "the suspend entry precedes the abort");
  assert.equal(suspendedAtAbort?.agent.status, "interrupted");
  assert.equal(manager.getRecord(queued), undefined, "a queued record is retired at once");

  runs[0].resolve({ responseText: "partial", session, aborted: true, steered: false });
  const summary = await pending;
  await flush();

  assert.deepEqual(summary.suspended.sort(), [running, queued].sort());
  assert.deepEqual(summary.unsettled, []);
  assert.equal(summary.aborted, 0);
  for (const id of [running, queued]) {
    const own = entriesOf(entries, id);
    const last = own.at(-1);
    assert.equal(last?.suspended, true, `${id}: the suspended entry stays the latest`);
    assert.equal(last?.agent.status, "interrupted");
    assert.equal(
      own.some((entry) => entry.agent.status === "stopped"),
      false,
    );
    assert.equal(manager.getRecord(id), undefined);
  }
  const queuedEntry = entriesOf(entries, queued).at(-1)?.agent;
  assert.equal(queuedEntry?.prompt, "task two", "a never-started run keeps its prompt");
  assert.deepEqual(queuedEntry?.steers, ["also check docs"]);
  assert.equal(runs.length, 1, "the queued spawn never started");
  assert.deepEqual(completions, [], "no completion callback for suspended records");
  assert.equal(manager.getDormant(running), undefined, "suspended records are not dormant");
});

test("records outside the journal keep today's abort semantics", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  const { manager, runs, completions } = managed(t);
  const entries = journal(manager, env.owner);
  const step = manager.spawn(env.pi, env.context(), "implementer", "step", {
    ...background,
    workflowId: "wf",
    workflowStepId: "s1",
  });
  await flush();
  const pending = manager.suspendAll();
  assert.equal(manager.getRecord(step)?.status, "stopped");
  runs[0].resolve({ responseText: "", session, aborted: true, steered: false });
  const summary = await pending;
  assert.deepEqual(summary.suspended, []);
  assert.equal(summary.aborted, 1);
  await flush();
  assert.deepEqual(entriesOf(entries, step), []);
  assert.deepEqual(completions, ["stopped"]);
});

test("suspend of a parked record journals waiting_for_reset with its steers", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const resetAt = Date.now() + 3_600_000;
  const installed = installPolicy(
    policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "structured", resetAt },
      corroborate: () => ({ ready: false, resetAt, evidence: "confirmed" }),
    }),
    env.owner,
  );
  t.after(() => installed.remove());
  const { manager, runs, completions, usageEvents } = managed(t);
  const entries = journal(manager, env.owner);

  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
  await flush();
  const parkedPromise = manager.getRecord(id)?.promise;
  assert.equal(manager.getRecord(id)?.status, "waiting_for_reset");
  manager.steer(id, "steer while parked");
  const events = usageEvents.length;

  const summary = await manager.suspendAll();
  await flush();
  assert.deepEqual(summary.suspended, [id]);
  const last = entriesOf(entries, id).at(-1);
  assert.equal(last?.suspended, true);
  assert.equal(last?.agent.status, "waiting_for_reset");
  assert.equal(last?.agent.usageWait?.resetAt, resetAt);
  assert.deepEqual(last?.agent.usageWait?.steers, ["steer while parked"]);
  assert.equal(manager.getRecord(id), undefined);
  assert.deepEqual(completions, []);
  assert.equal(usageEvents.length, events, "no exhausted/stopped usage event");
  assert.equal(await parkedPromise, "", "anyone awaiting the parked promise is released");
  t.mock.timers.tick(4 * 3_600_000);
  await flush();
  assert.equal(runs.length, 1, "the cleared wake timer never resumes it");
});

test("a queued post-reset continuation is suspended as a usage wait", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const resetAt = Date.now() + 60_000;
  const installed = installPolicy(
    policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "structured", resetAt },
      corroborate: (count) =>
        count === 1 ? { ready: false, resetAt, evidence: "confirmed" } : { ready: true },
    }),
    env.owner,
  );
  t.after(() => installed.remove());
  const { manager, runs, resumes } = managed(t, { maxConcurrent: 1 });
  const entries = journal(manager, env.owner);

  const parked = manager.spawn(env.pi, env.context(), "implementer", "parked", background);
  runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
  await flush();
  manager.steer(parked, "carry me");
  // Another provider: the parked one is closed until its reset.
  const busy = manager.spawn(
    env.pi,
    env.context({ model: env.models.sol }),
    "implementer",
    "busy",
    background,
  );
  await flush();
  t.mock.timers.tick(60_000 + 30_000);
  await flush();
  assert.equal(manager.getRecord(parked)?.status, "queued", "continuation waits for a slot");
  assert.equal(resumes.length, 0);

  const pending = manager.suspendAll();
  const last = entriesOf(entries, parked).at(-1);
  assert.equal(last?.suspended, true);
  assert.equal(last?.agent.status, "waiting_for_reset");
  assert.deepEqual(last?.agent.usageWait?.steers, ["carry me"]);
  runs[1].resolve({ responseText: "", session, aborted: true, steered: false });
  const summary = await pending;
  assert.deepEqual(summary.suspended.sort(), [busy, parked].sort());
  assert.equal(resumes.length, 0, "the continuation never started");
});

test("suspend waits at most SUSPEND_SETTLE_TIMEOUT_MS for runs to settle", async (t) => {
  const env = await setup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { manager } = managed(t);
  journal(manager, env.owner);
  const id = manager.spawn(env.pi, env.context(), "implementer", "stuck", background);
  await flush();
  let done = false;
  const pending = manager.suspendAll().then((summary) => {
    done = true;
    return summary;
  });
  await flush();
  t.mock.timers.tick(SUSPEND_SETTLE_TIMEOUT_MS - 1);
  await flush();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  const summary = await pending;
  assert.deepEqual(summary.unsettled, [id]);
});

test("a run claims its session file and releases it after disposal", async (t) => {
  const env = await setup(t);
  const dir = await tempDir(t);
  const file = join(dir, "child.jsonl");
  const session = await sessionWithFile(env, file);
  const { manager, runs } = managed(t, {
    onRunAgent: (options) => options.onSessionCreated?.(session),
  });
  journal(manager, env.owner);
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  await flush();
  const owner = sessionFileOwner(file);
  assert.ok(owner?.includes(id), "claimed with a token naming the record");
  runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await flush();
  assert.equal(sessionFileOwner(file), owner, "kept while the live record holds the session");
  manager.clearCompleted();
  await flush();
  assert.equal(sessionFileOwner(file), undefined, "released once the session is disposed");
});

test("dispose({ suspend: true }) keeps a suspended run's worktree", async (t) => {
  const env = await setup(t);
  const repo = await tempDir(t);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(repo, "file.txt"), "content\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const session = await env.childSession();
  const { manager, runs, completions } = managed(t);
  const entries = journal(manager, env.owner);

  const id = manager.spawn(env.pi, env.context(), "implementer", "task", {
    ...background,
    isolation: "worktree",
    cwd: repo,
  });
  const worktree = manager.getRecord(id)?.worktree;
  assert.ok(worktree, "a worktree was created");
  t.after(async () => {
    await git("worktree", "remove", "--force", worktree.path).catch(() => undefined);
  });
  await flush();

  manager.dispose({ suspend: true });
  runs[0].resolve({ responseText: "partial", session, aborted: true, steered: false });
  await flush();

  assert.equal(await exists(worktree.path), true, "the worktree directory survives");
  const { stdout } = await git("worktree", "list", "--porcelain");
  assert.ok(stdout.includes(worktree.path.split("/").at(-1) ?? "?"), "still registered");
  const last = entriesOf(entries, id).at(-1);
  assert.equal(last?.suspended, true);
  assert.equal(last?.agent.worktree?.path, worktree.path);
  assert.equal(last?.agent.worktree?.repo, repo);
  assert.deepEqual(completions, []);
  assert.equal(manager.getRecord(id), undefined);
});

test("a suspend during the usage-limit evaluation keeps the worktree and publishes nothing", async (t) => {
  const env = await setup(t);
  const repo = await tempDir(t);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(repo, "file.txt"), "content\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const held = heldCorroboration(t, env);
  const session = await env.childSession();
  const { manager, runs, completions, usageEvents } = managed(t);
  const entries = journal(manager, env.owner);

  const id = manager.spawn(env.pi, env.context(), "implementer", "task", {
    ...background,
    isolation: "worktree",
    cwd: repo,
  });
  const worktree = manager.getRecord(id)?.worktree;
  assert.ok(worktree, "a worktree was created");
  t.after(async () => {
    await git("worktree", "remove", "--force", worktree.path).catch(() => undefined);
  });
  runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
  await flush();
  assert.equal(held.state.corroborations, 1, "the evaluation awaits corroboration");
  assert.equal(manager.getRecord(id)?.status, "running");

  const pending = manager.suspendAll();
  held.release();
  const summary = await pending;
  await flush();

  assert.deepEqual(summary.suspended, [id]);
  assert.deepEqual(summary.unsettled, [], "the run settled within the bound");
  assert.equal(await exists(worktree.path), true, "the worktree directory survives");
  const last = entriesOf(entries, id).at(-1);
  assert.equal(last?.suspended, true, "the suspend entry stays the latest");
  assert.equal(last?.agent.status, "interrupted");
  assert.equal(last?.agent.worktree?.path, worktree.path);
  assert.deepEqual(afterSuspend(entries, id), []);
  assert.deepEqual(completions, [], "no completion callback");
  assert.deepEqual(usageEvents, [], "no usage-limit publication");
  assert.equal(manager.getRecord(id), undefined);
});

test("a suspend during a background resume's usage-limit evaluation publishes nothing", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  const { manager, runs, resumes, completions, usageEvents } = managed(t);
  const entries = journal(manager, env.owner);
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await flush();
  assert.equal(manager.getRecord(id)?.status, "completed");
  const held = heldCorroboration(t, env);

  await manager.resume(id, "more", undefined, { isBackground: true });
  assert.equal(manager.getRecord(id)?.status, "running");
  resumes[0].resolve({ text: "", aborted: false, steered: false, failure: LIMIT });
  await flush();
  assert.equal(held.state.corroborations, 1, "the evaluation awaits corroboration");

  const pending = manager.suspendAll();
  held.release();
  const summary = await pending;
  await flush();

  assert.deepEqual(summary.suspended, [id]);
  assert.deepEqual(summary.unsettled, []);
  const last = entriesOf(entries, id).at(-1);
  assert.equal(last?.suspended, true);
  assert.equal(last?.agent.status, "interrupted");
  assert.deepEqual(afterSuspend(entries, id), []);
  assert.deepEqual(completions, ["completed"], "only the first run completed");
  assert.deepEqual(usageEvents, []);
  assert.equal(manager.getRecord(id), undefined);
});

test("a suspend during a foreground resume's usage-limit evaluation publishes nothing", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  const { manager, runs, resumes, completions, usageEvents } = managed(t);
  const entries = journal(manager, env.owner);
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
  await flush();
  const held = heldCorroboration(t, env);

  const resumed = manager.resume(id, "more");
  await flush();
  assert.equal(manager.getRecord(id)?.status, "running");
  resumes[0].resolve({ text: "", aborted: false, steered: false, failure: LIMIT });
  await flush();
  assert.equal(held.state.corroborations, 1, "the evaluation awaits corroboration");

  const pending = manager.suspendAll();
  held.release();
  const summary = await pending;
  const record = await resumed;
  await flush();

  assert.deepEqual(summary.suspended, [id]);
  assert.deepEqual(summary.unsettled, []);
  assert.equal(record?.status, "interrupted", "the caller sees the interrupted record");
  assert.equal(record?.terminalResultGeneration === record?.resultGeneration, false);
  const last = entriesOf(entries, id).at(-1);
  assert.equal(last?.suspended, true);
  assert.equal(last?.agent.status, "interrupted");
  assert.deepEqual(afterSuspend(entries, id), []);
  assert.deepEqual(completions, ["completed"]);
  assert.deepEqual(usageEvents, []);
  assert.equal(manager.getRecord(id), undefined);
});
