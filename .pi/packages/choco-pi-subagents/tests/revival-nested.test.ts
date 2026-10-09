import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  AgentManager,
  RevivalContext,
  RevivalReport,
  RevivalSnapshot,
} from "../src/agent-manager.ts";
import type { JournalAgentSnapshot, SubagentJournalData } from "../src/revival-journal.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  harness,
  type Harness,
} from "./usage-limit-fixture.ts";

interface Setup {
  h: Harness;
  manager: AgentManager;
  entries: SubagentJournalData[];
  reports: RevivalReport[];
  context: RevivalContext;
  dir: string;
}

async function setup(t: TestContext): Promise<Setup> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-nested-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness();
  t.after(() => {
    h.manager.dispose();
    cleanupProviders();
  });
  const entries: SubagentJournalData[] = [];
  h.manager.setJournalSink({ rootSessionId: env.owner, append: (data) => entries.push(data) });
  const reports: RevivalReport[] = [];
  return {
    h,
    manager: h.manager,
    entries,
    reports,
    context: { pi: env.pi, ctx: env.context(), onRevivalReport: (report) => reports.push(report) },
    dir,
  };
}

async function file(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, '{"type":"session"}\n');
  return path;
}

function snap(id: string, overrides: Partial<JournalAgentSnapshot> = {}): JournalAgentSnapshot {
  return {
    id,
    handle: `h-${id}`,
    type: "implementer",
    description: `task ${id}`,
    depth: 1,
    status: "interrupted",
    options: { isBackground: true },
    revivals: 0,
    resultConsumed: false,
    ...overrides,
  };
}

function input(agent: JournalAgentSnapshot): RevivalSnapshot {
  return { suspended: true, agent };
}

test("a nested child revives with its parent, and the parent's prompt lists it", async (t) => {
  const s = await setup(t);
  const parent = snap("parent", { sessionFile: await file(s.dir, "p.jsonl") });
  const child = snap("child", {
    depth: 2,
    parentAgentId: "parent",
    sessionFile: await file(s.dir, "c.jsonl"),
  });
  // Child first in the input: revival must still start the parent first.
  const reports = await s.manager.reviveFromJournal([input(child), input(parent)], s.context);

  assert.deepEqual(
    reports.map((report) => [report.kind, report.agentId]),
    [
      ["revived", "parent"],
      ["revived", "child"],
    ],
  );
  assert.deepEqual(
    s.h.runOptions.map((options) => options.agentId),
    ["parent", "child"],
  );
  const parentPrompt = s.h.runPrompts[0];
  assert.match(parentPrompt, /get_subagent_result/);
  assert.match(parentPrompt, /- child \(@h-child\): task child/);
  assert.doesNotMatch(s.h.runPrompts[1], /get_subagent_result/, "a leaf lists no children");
  const record = s.manager.getRecord("child");
  assert.equal(record?.parentAgentId, "parent");
  assert.equal(record?.depth, 2);
  assert.equal(record?.handle, "h-child");
  assert.equal(s.h.runOptions[1].nested, true);
});

test("a child whose parent is not revived stays dormant and is reported", async (t) => {
  const s = await setup(t);
  const parent = snap("done-parent", { status: "completed", result: "finished" });
  const orphan = snap("orphan", {
    depth: 2,
    parentAgentId: "done-parent",
    sessionFile: await file(s.dir, "o.jsonl"),
  });
  const failingParent = snap("bad-parent", {
    sessionFile: await file(s.dir, "b.jsonl"),
    model: { provider: "anthropic", id: "no-such-model" },
  });
  const stranded = snap("stranded", {
    depth: 2,
    parentAgentId: "bad-parent",
    sessionFile: await file(s.dir, "s.jsonl"),
  });
  const reports = await s.manager.reviveFromJournal(
    [input(parent), input(orphan), input(failingParent), input(stranded)],
    s.context,
  );
  const byId = new Map(reports.map((report) => [report.agentId, report.kind]));
  assert.equal(byId.get("orphan"), "skipped");
  assert.equal(byId.get("bad-parent"), "failed");
  assert.equal(byId.get("stranded"), "skipped");
  assert.equal(s.h.runs.length, 0);
  assert.equal(s.manager.getRecord("orphan"), undefined);
  assert.equal(s.manager.getDormant("orphan")?.status, "interrupted");
  assert.equal(s.manager.getDormant("stranded")?.status, "interrupted");
  assert.equal(
    s.entries.some((entry) => entry.agent.id === "orphan"),
    false,
    "a skipped child keeps its journaled state",
  );
});
