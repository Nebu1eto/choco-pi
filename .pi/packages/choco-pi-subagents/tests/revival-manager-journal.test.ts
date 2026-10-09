import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentManager, SubagentJournalSink } from "../src/agent-manager.ts";
import type { JournalAgentSnapshot, SubagentJournalData } from "../src/revival-journal.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicy,
  policyState,
  type HarnessOptions,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const background = { description: "journal probe", isBackground: true, isolated: true };
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const CHILD_FILE = "/tmp/choco-pi-journal-test/child.jsonl";

async function setup(t: TestContext): Promise<{ env: UsageLimitEnv; session: AgentSession }> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const session = await env.childSession();
  return { env, session };
}

interface Journaled {
  entries: SubagentJournalData[];
  sink: SubagentJournalSink;
}

function journal(manager: AgentManager, rootSessionId: string): Journaled {
  const entries: SubagentJournalData[] = [];
  const sink: SubagentJournalSink = { rootSessionId, append: (data) => entries.push(data) };
  manager.setJournalSink(sink);
  return { entries, sink };
}

function statusesOf(entries: SubagentJournalData[], id: string): string[] {
  return entries.filter((entry) => entry.agent.id === id).map((entry) => entry.agent.status);
}

function lastOf(entries: SubagentJournalData[], id: string): SubagentJournalData | undefined {
  return entries.filter((entry) => entry.agent.id === id).at(-1);
}

function done(session: AgentSession, responseText = "done") {
  return { responseText, session, aborted: false, steered: false };
}

function managed(t: TestContext, options: HarnessOptions = {}) {
  const h = harness(options);
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  return h;
}

function snapshot(id: string, overrides: Partial<JournalAgentSnapshot> = {}): JournalAgentSnapshot {
  return {
    id,
    handle: `h-${id}`,
    type: "implementer",
    description: "dormant",
    depth: 1,
    status: "completed",
    options: {},
    revivals: 0,
    resultConsumed: false,
    result: `result ${id}`,
    ...overrides,
  };
}

test("every transition of a background run is journaled with its fields", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t, { maxConcurrent: 1 });
  const { entries } = journal(manager, env.owner);

  const first = manager.spawn(env.pi, env.context(), "implementer", "task one", background);
  const second = manager.spawn(env.pi, env.context(), "implementer", "task two", {
    ...background,
    readOnly: true,
    maxTurns: 7,
    budgets: { timeoutMs: 60_000 },
  });
  await flush();
  assert.deepEqual(statusesOf(entries, second), ["queued"]);

  runs[0].resolve(done(session, "first done"));
  await flush();
  assert.equal(runs.length, 2, "the queued spawn started when the slot freed");
  runs[1].resolve(done(session, "second done"));
  await flush();

  // Spawn and start share one tick for an immediate start, so `queued` coalesces.
  assert.deepEqual(statusesOf(entries, first), ["running", "completed"]);
  assert.deepEqual(statusesOf(entries, second), ["queued", "running", "completed"]);
  for (const entry of entries) {
    assert.equal(entry.v, 1);
    assert.equal(entry.rootSessionId, env.owner);
    assert.equal(entry.suspended, false);
  }
  const queued = entries.find((entry) => entry.agent.id === second);
  assert.equal(queued?.agent.prompt, "task two");
  assert.equal(queued?.agent.result, undefined, "no result before a terminal status");
  const final = lastOf(entries, second)?.agent;
  assert.equal(final?.type, "implementer");
  assert.equal(final?.description, "journal probe");
  assert.equal(final?.depth, 1);
  assert.equal(final?.handle, manager.getRecord(second)?.handle);
  assert.deepEqual(final?.model, { provider: "anthropic", id: "claude-opus-4-5" });
  assert.equal(final?.options.readOnly, true, "readOnly survives into the journal");
  assert.equal(final?.options.isBackground, true);
  assert.equal(final?.options.maxTurns, 7);
  assert.deepEqual(final?.options.budgets, { timeoutMs: 60_000 });
  assert.equal(final?.options.isolated, true);
  assert.equal(final?.revivals, 0);
  assert.equal(final?.resultConsumed, false);
  assert.equal(final?.stoppedByUser, undefined);
  assert.equal(final?.result, "second done");
});

test("a failing sink never breaks the run and is reported once per record", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs, completions } = managed(t);
  const reported: string[] = [];
  manager.setJournalSink({
    rootSessionId: env.owner,
    append: () => {
      throw new Error("disk full");
    },
    reportError: (agentId) => reported.push(agentId),
  });
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  await flush();
  runs[0].resolve(done(session));
  await manager.getRecord(id)?.promise;
  await flush();

  assert.equal(manager.getRecord(id)?.status, "completed");
  assert.deepEqual(completions, ["completed"]);
  assert.ok(manager.getJournalHealth().failures >= 2, "every failed write is counted");
  assert.equal(manager.getJournalHealth().lastError, "disk full");
  assert.deepEqual(reported, [id], "the diagnostic fires once for the record");
});

test("without a sink nothing is journaled and nothing goes dormant", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t);
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  runs[0].resolve(done(session));
  await flush();
  manager.clearCompleted();
  assert.equal(manager.getDormant(id), undefined);
  assert.equal(manager.getJournalHealth().failures, 0);
});

test("workflow steps and their children are never journaled", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t);
  const { entries } = journal(manager, env.owner);
  const step = manager.spawn(env.pi, env.context(), "implementer", "step", {
    ...background,
    workflowId: "wf-1",
    workflowStepId: "s-1",
  });
  const child = manager.spawn(env.pi, env.context(), "implementer", "child", {
    ...background,
    parentAgentId: step,
    depth: 2,
  });
  const side = manager.spawn(env.pi, env.context(), "implementer", "btw", {
    ...background,
    sideConversation: true,
  });
  for (const run of runs) run.resolve(done(session));
  await flush();
  manager.clearCompleted();
  assert.deepEqual(
    entries.filter((entry) => [step, child, side].includes(entry.agent.id)),
    [],
  );
  assert.equal(manager.getDormant(step), undefined);
});

test("an explicit stop journals stopped with stoppedByUser; shutdown stops are not journaled", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t);
  const { entries } = journal(manager, env.owner);
  const stopped = manager.spawn(env.pi, env.context(), "implementer", "stop me", background);
  const shutdown = manager.spawn(env.pi, env.context(), "implementer", "keep me", background);
  await flush();

  assert.equal(manager.abort(stopped), true);
  await flush();
  const stopping = lastOf(entries, stopped)?.agent;
  assert.equal(stopping?.status, "stopped");
  assert.equal(stopping?.stoppedByUser, true);
  // The run settles later; its terminal text is journaled without a status change.
  runs[0].resolve({ responseText: "partial", session, aborted: true, steered: false });
  await flush();
  const settled = lastOf(entries, stopped)?.agent;
  assert.equal(settled?.status, "stopped");
  assert.equal(settled?.stoppedByUser, true);
  assert.equal(settled?.error, "Stopped by user request.");
  assert.equal(settled?.result, "partial");

  manager.abortAll();
  await flush();
  assert.deepEqual(
    statusesOf(entries, shutdown),
    ["running"],
    "a host shutdown keeps the last real state for revival",
  );
});

test("a usage-limit park journals waiting_for_reset with usageWait, then queued steers", async (t) => {
  const { env, session } = await setup(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const resetAt = Date.now() + 3_600_000;
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "structured", resetAt },
    corroborate: () => ({ ready: false, resetAt, evidence: "confirmed" }),
  });
  const installed = installPolicy(state, env.owner);
  t.after(() => installed.remove());
  const { manager, runs } = managed(t);
  const { entries } = journal(manager, env.owner);

  const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
  runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
  await flush();
  assert.equal(manager.getRecord(id)?.status, "waiting_for_reset");
  const parked = lastOf(entries, id)?.agent;
  assert.equal(parked?.status, "waiting_for_reset");
  assert.equal(parked?.usageWait?.providerKey, "anthropic");
  assert.equal(parked?.usageWait?.resetAt, resetAt);
  assert.equal(parked?.usageWait?.classification.kind, "quota");
  assert.equal(parked?.usageWait?.classification.provider, "anthropic");
  assert.deepEqual(parked?.usageWait?.steers, []);
  assert.equal(parked?.error, undefined, "a parked record carries no terminal text");

  assert.equal(manager.steer(id, "also check the tests"), true);
  await flush();
  assert.deepEqual(lastOf(entries, id)?.agent.usageWait?.steers, ["also check the tests"]);
});

test("resultConsumed is journaled for inline results and after external flips", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t);
  const { entries } = journal(manager, env.owner);

  const waiting = manager.spawnAndWait(env.pi, env.context(), "implementer", "inline", {
    description: "foreground",
    isolated: true,
  });
  await flush();
  runs[0].resolve(done(session));
  const { id: inlineId } = await waiting;
  await flush();
  const inline = lastOf(entries, inlineId)?.agent;
  assert.equal(inline?.status, "completed");
  assert.equal(inline?.resultConsumed, true);

  const id = manager.spawn(env.pi, env.context(), "implementer", "background", background);
  runs[1].resolve(done(session));
  await flush();
  assert.equal(lastOf(entries, id)?.agent.resultConsumed, false);
  const record = manager.getRecord(id);
  assert.ok(record);
  record.resultConsumed = true;
  assert.equal(manager.journalRecord(id), true);
  await flush();
  assert.equal(lastOf(entries, id)?.agent.resultConsumed, true);
  const count = entries.length;
  assert.equal(manager.journalRecord(id), true);
  await flush();
  assert.equal(entries.length, count, "an unchanged snapshot is not appended again");
  assert.equal(manager.journalRecord("missing"), false);
});

test("the prompt is journaled until the session file is confirmed, then dropped", async (t) => {
  const { env, session } = await setup(t);
  session.sessionManager.getSessionFile = () => CHILD_FILE;
  const { manager, runs, runOptions } = managed(t, {
    onRunAgent: (options) => options.onSessionCreated?.(session),
  });
  const { entries } = journal(manager, env.owner);

  const id = manager.spawn(env.pi, env.context(), "implementer", "original task", background);
  await flush();
  assert.equal(manager.getRecord(id)?.sessionFile, CHILD_FILE, "the path is captured");
  const early = lastOf(entries, id)?.agent;
  assert.equal(early?.prompt, "original task");
  assert.equal(early?.sessionFile, undefined, "the file may not exist before the first message");

  runOptions[0].onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0 });
  await flush();
  const confirmed = lastOf(entries, id)?.agent;
  assert.equal(confirmed?.sessionFile, CHILD_FILE);
  assert.equal(confirmed?.prompt, undefined);
  assert.equal(manager.getRecord(id)?.spawnPrompt, undefined);
  const count = entries.length;
  runOptions[0].onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0 });
  runOptions[0].onToolActivity?.({ type: "end", toolName: "read" });
  await flush();
  assert.equal(entries.length, count, "no journal write per token or tool use");

  runs[0].resolve(done(session));
  await flush();
  assert.equal(lastOf(entries, id)?.agent.sessionFile, CHILD_FILE);
});

test("eviction keeps a dormant snapshot reachable by id and handle", async (t) => {
  const { env, session } = await setup(t);
  const { manager, runs } = managed(t);
  const { entries } = journal(manager, env.owner);
  const id = manager.spawn(env.pi, env.context(), "implementer", "task", {
    ...background,
    name: "auth-audit",
  });
  const handle = manager.getRecord(id)?.handle;
  runs[0].resolve(done(session, "audit result"));
  await flush();
  assert.equal(manager.getDormant(id), undefined, "a live record is not dormant");

  manager.clearCompleted();
  assert.equal(manager.getRecord(id), undefined, "getRecord stays live-only");
  assert.equal(
    manager.listAgents().some((record) => record.id === id),
    false,
  );
  assert.equal(manager.getActiveCount(), 0);
  const dormant = manager.getDormant(id);
  assert.equal(dormant?.status, "completed");
  assert.equal(dormant?.result, "audit result");
  assert.ok(handle);
  assert.equal(manager.findDormantByHandle(handle.toUpperCase())?.id, id);
  assert.equal(manager.findDormantByHandle("auth-audit")?.id, id);
  assert.equal(manager.findDormantByHandle(id)?.id, id);
  assert.equal(manager.findDormantByHandle("nobody"), undefined);

  const count = entries.length;
  assert.equal(manager.markDormantResultConsumed(id), true);
  assert.equal(entries.length, count + 1);
  assert.equal(entries.at(-1)?.agent.resultConsumed, true);
  assert.equal(entries.at(-1)?.agent.result, "audit result");
  assert.equal(manager.getDormant(id)?.resultConsumed, true);
  assert.equal(manager.markDormantResultConsumed(id), true);
  assert.equal(entries.length, count + 1, "already consumed: nothing appended");
  assert.equal(manager.markDormantResultConsumed("missing"), false);

  manager.setJournalSink(undefined);
  assert.equal(manager.getDormant(id), undefined, "no sink: dormant entries are hidden");
});

test("setJournalLookup is the fallback when the dormant map misses", async (t) => {
  const { env } = await setup(t);
  const { manager } = managed(t);
  journal(manager, env.owner);
  assert.equal(manager.getDormant("old"), undefined);
  manager.setJournalLookup((id) => (id === "old" ? snapshot("old") : snapshot("wrong-id")));
  assert.equal(manager.getDormant("old")?.result, "result old");
  assert.equal(manager.getDormant("other"), undefined, "a mismatched id is rejected");
  manager.setJournalLookup(() => {
    throw new Error("broken lookup");
  });
  assert.equal(manager.getDormant("old"), undefined, "a throwing lookup is contained");

  manager.setJournalLookup(() => snapshot("old"));
  manager.setJournalSink({ rootSessionId: "another-root", append: () => undefined });
  assert.equal(manager.getDormant("old"), undefined, "a new root drops the old lookup");
});

test("the dormant map is bounded at 500, oldest first, and skips invalid snapshots", async (t) => {
  const { env } = await setup(t);
  const { manager } = managed(t);
  journal(manager, env.owner);
  const snapshots = Array.from({ length: 501 }, (_, index) => snapshot(`a${index}`));
  const invalid = { ...snapshot("bad"), revivals: -1 };
  assert.equal(manager.hydrateDormant([...snapshots, invalid]), 501);
  assert.equal(manager.getDormant("a0"), undefined, "the oldest entry was dropped");
  assert.equal(manager.getDormant("a1")?.id, "a1");
  assert.equal(manager.getDormant("a500")?.id, "a500");
  assert.equal(manager.getDormant("bad"), undefined);
  assert.equal(manager.listAgents().length, 0, "dormant entries are not live records");
  assert.equal(manager.getScheduledActiveCount(), 0);
});
