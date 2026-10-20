import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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
import { toolContext } from "./fixtures/tool-context.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the exact structural slice exercised by its subject.
  return fixture as T;
}

function record(id: string, options: Partial<AgentRecord> = {}): AgentRecord {
  return partialFixture<AgentRecord>({
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
    ...options,
  });
}

function nestedFixture(): AgentRecord[] {
  return [
    record("top", {
      alias: "lead",
      startedAt: 1_000,
      toolUses: 4,
      lifetimeUsage: { input: 100, output: 20, cacheWrite: 5 },
      session: partialFixture<AgentSession>({
        model: partialFixture<NonNullable<AgentSession["model"]>>({
          provider: "anthropic",
          id: "claude-x",
        }),
      }),
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

test("subagent_tree view nests descendants with status fields and bounded reasons", () => {
  const view = buildSubagentTree(nestedFixture(), { now: 10_000 });
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

interface GlobalManagerEntry {
  waitForAll(): Promise<void>;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: { description: string; isBackground: boolean; isolated: boolean },
  ): string;
}

type RuntimeValue = {} | null | undefined;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The fixture implements every ExtensionAPI member exercised by this test.
  return value as ExtensionAPI;
}

function asExtensionContext(value: RuntimeValue): ExtensionContext {
  // SAFETY: Session binding reads only these members; child setup is deliberately
  // incomplete so the spawned run settles as an error.
  return value as ExtensionContext;
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("registered tree and status tools read records without consuming results", async () => {
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: This test reads only the package's documented process-global manager slot.
  const registry = globalThis as typeof globalThis & {
    [registryKey: symbol]: GlobalManagerEntry | undefined;
  };
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const noop = () => undefined;
  const pi = asExtensionAPI({
    events: { emit: noop, on: () => noop },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: noop,
    sendMessage: noop,
  });
  subagentsExtension(pi);
  const manager = registry[key];
  assert.ok(manager);
  const treeTool = tools.get("subagent_tree");
  const statusTool = tools.get("get_subagent_status");
  const resultTool = tools.get("get_subagent_result");
  assert.ok(treeTool && statusTool && resultTool);
  try {
    const context = asExtensionContext({
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "subagent-tree-probe", getEntries: () => [] },
    });
    const start = handlers.get("session_start");
    assert.ok(start);
    await start({}, context);
    const id = manager.spawn(pi, context, "implementer", "tree probe", {
      description: "tree probe",
      isBackground: true,
      isolated: true,
    });
    await manager.waitForAll();

    const tree = await treeTool.execute("tree", {}, undefined, undefined, toolContext(context));
    assert.match(
      resultText(tree),
      new RegExp(`- (\\S+ \\()?${id}\\)? \\[implementer\\] \\| status=error`),
    );
    const status = await statusTool.execute(
      "status",
      { ids: [id, "missing-agent"] },
      undefined,
      undefined,
      toolContext(context),
    );
    assert.match(resultText(status), /status=error/);
    assert.match(resultText(status), /missing-agent \| status=unknown/);
    const missingRoot = await treeTool.execute(
      "tree-missing",
      { root: "missing-agent" },
      undefined,
      undefined,
      toolContext(context),
    );
    assert.equal("isError" in missingRoot && missingRoot.isError, true);

    const terminal = await resultTool.execute(
      "terminal-first",
      { agent_id: id },
      undefined,
      undefined,
      toolContext(context),
    );
    assert.match(resultText(terminal), /Status: error/, "result is still unconsumed");
  } finally {
    const shutdown = handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
});
