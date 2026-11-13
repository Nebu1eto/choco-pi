import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { computeChildToolGate } from "../src/agent-runner.ts";
import subagentsExtension from "../src/index.ts";
import {
  buildSubagentStatusBatch,
  buildSubagentTree,
  countFailedDescendants,
  DescendantFailureReporter,
  TERMINAL_REASON_LIMIT,
} from "../src/subagent-tree.ts";
import type { AgentRecord } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

function record(id: string, options: Partial<AgentRecord> = {}): AgentRecord {
  const base: AgentRecord = {
    id,
    type: "implementer",
    handle: id,
    description: id,
    status: "running",
    toolUses: 0,
    startedAt: 1_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    depth: 1,
    resultGeneration: 1,
  };
  return { ...base, ...options };
}

/** A model the live-session fixture runs on; nothing calls its provider. */
const liveModel: Model<Api> = {
  id: "claude-x",
  name: "Claude X",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

/** `session` is the live session of the top record, when a test reads its model. */
function nestedFixture(session?: AgentSession): AgentRecord[] {
  return [
    record("top", {
      alias: "lead",
      startedAt: 1_000,
      toolUses: 4,
      lifetimeUsage: { input: 100, output: 20, cacheWrite: 5 },
      session,
    }),
    record("child", {
      alias: "worker",
      type: "explore",
      depth: 2,
      parentAgentId: "top",
      startedAt: 2_000,
      completedAt: 5_000,
      status: "error",
      error: `boom ${"x".repeat(400)}`,
      spawnModel: { provider: "openai", id: "gpt-y" },
      terminalResultGeneration: 1,
    }),
    record("sibling", { startedAt: 3_000, status: "completed", completedAt: 4_000 }),
  ];
}

test("subagent_tree view nests descendants with status fields and bounded reasons", async (t) => {
  const live = await createSdkFixture(liveModel);
  t.after(() => live.session.dispose());
  const view = buildSubagentTree(nestedFixture(live.session), { now: 10_000 });
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  const lines = view.text.split("\n");
  assert.match(lines[0] ?? "", /3 matching records \(filter: all\)/);
  assert.match(lines[1] ?? "", /^- lead \(top\) \[implementer\] \| status=running \| depth=1/);
  assert.match(lines[1] ?? "", /model=anthropic\/claude-x \| tokens=125 \| tools=4 \| duration=9s/);
  assert.match(
    lines[2] ?? "",
    /^ {2}- worker \(child\) \[explore\] \| status=error \| depth=2 \| parent=top/,
  );
  assert.match(lines[2] ?? "", /model=openai\/gpt-y/);
  assert.match(lines[3] ?? "", /^- sibling \[implementer\] \| status=completed/);

  const child = view.entries.find((entry) => entry.id === "child");
  assert.ok(child);
  assert.equal(child.parentId, "top");
  assert.equal(child.durationMs, 3_000);
  assert.equal(child.terminalReason?.length, TERMINAL_REASON_LIMIT);
  assert.ok(child.terminalReason?.startsWith("boom x"));
  assert.equal(view.entries.find((entry) => entry.id === "top")?.terminalReason, undefined);
});

test("subagent_tree filters keep matching descendants under their ancestor and scope to a subtree", () => {
  const terminal = buildSubagentTree(nestedFixture(), { status: "terminal" });
  assert.equal(terminal.kind, "ok");
  if (terminal.kind !== "ok") return;
  assert.deepEqual(
    terminal.entries.map((entry) => entry.id),
    ["child", "sibling"],
  );
  assert.match(terminal.text, /\n· lead \(top\)/, "non-matching ancestor is shown as context");

  const active = buildSubagentTree(nestedFixture(), { status: "active" });
  assert.equal(active.kind, "ok");
  if (active.kind !== "ok") return;
  assert.deepEqual(
    active.entries.map((entry) => entry.id),
    ["top"],
  );

  const scoped = buildSubagentTree(nestedFixture(), { root: "worker" });
  assert.equal(scoped.kind, "ok");
  if (scoped.kind !== "ok") return;
  assert.deepEqual(
    scoped.entries.map((entry) => entry.id),
    ["child"],
  );

  assert.deepEqual(buildSubagentTree(nestedFixture(), { root: "missing" }), {
    kind: "unknown-root",
    ref: "missing",
  });
});

test("status batch resolves nested ids and aliases and lists unknown refs", () => {
  const records = nestedFixture();
  const before = records.map((entry) => ({ ...entry }));
  const batch = buildSubagentStatusBatch(records, ["worker", "nope", "top"], 10_000);
  assert.deepEqual(
    batch.entries.map((entry) => entry.id),
    ["child", "top"],
  );
  assert.deepEqual(batch.unknown, ["nope"]);
  const lines = batch.text.split("\n");
  assert.match(lines[0] ?? "", /^worker \(child\) .*status=error/);
  assert.equal(lines[1], "nope | status=unknown");
  assert.match(lines[2] ?? "", /^lead \(top\) .*status=running/);
  assert.deepEqual(records, before, "status reads never mutate records");
});

test("descendant failure line is reported once per failed nested generation", () => {
  const [top, child] = nestedFixture();
  assert.ok(top && child);
  const reporter = new DescendantFailureReporter();
  const line = reporter.report(child, top);
  assert.ok(line);
  assert.match(line, /^Descendant worker \(owner lead, depth 2\) failed: boom x/);
  assert.equal(reporter.report(child, top), undefined, "same generation is not repeated");

  child.terminalResultGeneration = 2;
  assert.ok(reporter.report(child, top), "a later failed generation reports again");
  assert.equal(reporter.report(top, undefined), undefined, "top-level records are not descendants");
  assert.equal(
    reporter.report(record("ok", { parentAgentId: "top", status: "completed" }), top),
    undefined,
  );
  assert.match(
    reporter.report(
      record("budget", { parentAgentId: "gone", status: "budget_exceeded", depth: 3 }),
      undefined,
    ) ?? "",
    /^Descendant budget \(owner gone, depth 3\) failed: budget_exceeded$/,
  );
});

test("failed descendant count covers nested failure statuses only", () => {
  const records = [
    ...nestedFixture(),
    record("watchdog", { parentAgentId: "top", status: "watchdog_stopped" }),
    record("stopped", { parentAgentId: "top", status: "stopped" }),
    record("top-error", { status: "error" }),
  ];
  assert.equal(countFailedDescendants(records), 2);
});

test("children never inherit the root-only tree tools", () => {
  const gate = computeChildToolGate({
    noExtensions: true,
    toolNames: ["read", "subagent_tree", "get_subagent_status"],
    disallowedSet: undefined,
    nestedToolNames: new Set(),
    alwaysToolNames: new Set(),
  });
  assert.deepEqual(gate.sessionTools, ["read"]);
});

// ---- registered production tools ----

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("registered tree and status tools read records without consuming results", async (t) => {
  const fixture = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => fixture.session.dispose());
  // refreshOnCreate is off in the SDK fixture; populate availability offline.
  await fixture.ctx.modelRegistry.refresh({ allowNetwork: false });
  // The child run fails deterministically at the runner seam, before any provider call.
  const runner: AgentManagerRunner = {
    runAgent: async () => {
      throw new Error("tree probe failure");
    },
    resumeAgent: async () => {
      throw new Error("tree probe never resumes");
    },
  };
  const spawn = AgentManager.prototype.spawn;
  const spawningManagers = new Set<AgentManager>();
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      spawningManagers.add(this);
      assert.equal(Reflect.set(this, "runner", runner), true);
      return spawn.apply(this, args);
    },
  );
  const host = fixture.session.extensionRunner;
  const tool = (name: string): ToolDefinition => {
    const found = host.getToolDefinition(name);
    assert.ok(found, name);
    return found;
  };
  const execute = (
    name: string,
    toolCallId: string,
    params: Record<string, string | boolean | string[]>,
  ) => {
    const signal = new AbortController().signal;
    return tool(name).execute(
      toolCallId,
      params,
      signal,
      () => undefined,
      host.createToolContext(toolCallId, signal),
    );
  };

  const started = await execute("Agent", "spawn", {
    prompt: "tree probe",
    description: "tree probe",
    subagent_type: "implementer",
    model: "anthropic/claude-opus-4-5",
    thinking: "low",
    run_in_background: true,
    isolated: true,
  });
  const [manager] = spawningManagers;
  assert.equal(spawningManagers.size, 1, resultText(started));
  assert.ok(manager);
  try {
    const [spawned] = manager.listAgents();
    assert.ok(spawned);
    const id = spawned.id;
    await manager.waitForAll();

    const tree = await execute("subagent_tree", "tree", {});
    assert.match(
      resultText(tree),
      new RegExp(`- (\\S+ \\()?${id}\\)? \\[implementer\\] \\| status=error`),
    );
    const status = await execute("get_subagent_status", "status", {
      ids: [id, "missing-agent"],
    });
    assert.match(resultText(status), /status=error/);
    assert.match(resultText(status), /missing-agent \| status=unknown/);
    const missingRoot = await execute("subagent_tree", "tree-missing", { root: "missing-agent" });
    assert.equal("isError" in missingRoot && missingRoot.isError, true);

    const terminal = await execute("get_subagent_result", "terminal-first", { agent_id: id });
    assert.match(resultText(terminal), /Status: error/, "result is still unconsumed");
  } finally {
    manager.dispose();
  }
});
