import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { Value } from "typebox/value";

import {
  boundSummary,
  FRAME_INTERVAL_MS,
  HOST_BRIDGE_COMMAND,
  type HostBridgeApi,
  type HostBridgeContext,
  mapRecordStatus,
  registerHostBridge,
} from "../.pi/extensions/lib/host-bridge/bridge.ts";
import {
  GOAL_ENTRY_TYPE,
  GoalEntrySchema,
  GoalMirrorSchema,
  HOST_BRIDGE_STATUS_KEY,
  ProgressFrameSchema,
  ProgressShellSchema,
  ProgressSubagentSchema,
  SHELL_ENTRY_TYPE,
  ShellEntrySchema,
  ShellRecordSchema,
  SUBAGENT_ENTRY_TYPE,
  SubagentAgentSchema,
  SubagentEntrySchema,
  WORKFLOW_ENTRY_TYPE,
  WorkflowEntrySchema,
} from "../.pi/extensions/lib/host-bridge/schema.ts";
import {
  createProcessSources,
  GOAL_RUNTIME_SYMBOL,
  SHELL_MANAGER_SYMBOL,
  SUBAGENT_REGISTRY_SYMBOL,
} from "../.pi/extensions/lib/host-bridge/sources.ts";
import { isJsonRecord, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

// ---------------------------------------------------------------- fixtures

interface FakeRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  result?: string;
  toolCallId?: string;
  outputFile?: string;
  parentAgentId?: string;
  isBackground?: boolean;
  rootSessionId?: string;
  spawnCwd?: string;
  spawnModel?: { provider: string; id: string };
  runOptions?: { cwd?: string; maxTurns?: number };
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
}

function agentRecord(id: string, overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id,
    type: "general",
    description: `task ${id}`,
    status: "running",
    toolUses: 0,
    startedAt: 1_000,
    isBackground: true,
    spawnCwd: "/work",
    spawnModel: { provider: "anthropic", id: "claude" },
    toolCallId: `call-${id}`,
    outputFile: `/out/${id}.md`,
    lifetimeUsage: { input: 1, output: 2, cacheWrite: 3 },
    ...overrides,
  };
}

interface FakeShell {
  shellId: string;
  ownerId: string;
  name?: string;
  command: string;
  cwd: string;
  state: string;
  pid?: number;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

class FakeRegistry {
  records: FakeRecord[] = [];
  stopped: string[] = [];
  childContext = false;
  childIds = new Set<string>();
  install(): void {
    Object.defineProperty(globalThis, SUBAGENT_REGISTRY_SYMBOL, {
      configurable: true,
      writable: true,
      value: {
        getAllRecords: () => this.records,
        stop: (id: string) => {
          this.stopped.push(id);
          return this.records.some((record) => record.id === id);
        },
        isChildSessionContext: () => this.childContext,
        isChildSessionId: (id: string) => this.childIds.has(id),
      },
    });
  }
}

class FakeShellManager {
  shells: FakeShell[] = [];
  stopped: string[] = [];
  install(): void {
    Object.defineProperty(globalThis, SHELL_MANAGER_SYMBOL, {
      configurable: true,
      writable: true,
      value: {
        list: () => ({ shells: this.shells }),
        read: () => ({ stdout: { endOffset: 10 }, stderr: { endOffset: 5 } }),
        stop: async (input: { shellId: string }) => {
          this.stopped.push(input.shellId);
          return { shell: input.shellId };
        },
        toolCallIdOf: (shellId: string) => `tool-${shellId}`,
      },
    });
  }
}

function threadGoal(status = "active") {
  return {
    goalId: "g1",
    objective: "ship",
    status,
    tokenBudget: 1000,
    usage: { tokensUsed: 10, activeSeconds: 4 },
    createdAt: 1,
    updatedAt: 2,
  };
}

function installGoalRuntime(key: string, owner: string, completions: string[]): void {
  const map = new Map([
    [
      key,
      {
        owner,
        getGoal: () => threadGoal(),
        completeGoal: () => {
          completions.push(owner);
          return { ok: true, message: "done", goal: threadGoal("complete") };
        },
      },
    ],
  ]);
  Object.defineProperty(globalThis, GOAL_RUNTIME_SYMBOL, {
    configurable: true,
    writable: true,
    value: map,
  });
}

afterEach(() => {
  for (const key of [SUBAGENT_REGISTRY_SYMBOL, SHELL_MANAGER_SYMBOL, GOAL_RUNTIME_SYMBOL]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

interface Appended {
  customType: string;
  data: RuntimeValue;
}

type StartHandler = (
  event: { reason: "startup" | "reload" | "new" | "resume" | "fork" },
  ctx: HostBridgeContext,
) => void;
type CommandHandler = (args: string, ctx: HostBridgeContext) => Promise<void>;

class FakePi implements HostBridgeApi {
  readonly entries: Appended[] = [];
  readonly commands = new Map<string, CommandHandler>();
  readonly busHandlers = new Map<string, Array<(data: RuntimeValue) => void>>();
  startHandlers: StartHandler[] = [];
  shutdownHandlers: Array<() => void> = [];
  appendFailure: Error | undefined;
  readonly events = {
    on: (channel: string, handler: (data: RuntimeValue) => void) => {
      const list = this.busHandlers.get(channel) ?? [];
      list.push(handler);
      this.busHandlers.set(channel, list);
    },
  };
  on(event: "session_start", handler: StartHandler): void;
  on(event: "session_shutdown", handler: () => void): void;
  on(event: string, handler: StartHandler | (() => void)): void {
    if (event === "session_start") this.startHandlers.push(handler);
    else this.shutdownHandlers.push(() => handler({ reason: "startup" }, fakeContext("unused")));
  }
  appendEntry(customType: string, data: RuntimeValue): void {
    if (this.appendFailure !== undefined) throw this.appendFailure;
    this.entries.push({ customType, data });
  }
  registerCommand(name: string, options: { description: string; handler: CommandHandler }): void {
    this.commands.set(name, options.handler);
  }
  emit(channel: string, data: RuntimeValue): void {
    for (const handler of this.busHandlers.get(channel) ?? []) handler(data);
  }
  start(ctx: HostBridgeContext, reason: Parameters<StartHandler>[0]["reason"] = "startup"): void {
    for (const handler of this.startHandlers) handler({ reason }, ctx);
  }
  shutdown(): void {
    for (const handler of this.shutdownHandlers) handler();
  }
  ofType(customType: string): RuntimeValue[] {
    return this.entries
      .filter((entry) => entry.customType === customType)
      .map((entry) => entry.data);
  }
}

interface FakeContext extends HostBridgeContext {
  readonly statuses: Array<string | undefined>;
  branch: SessionEntry[];
  statusFailure: Error | undefined;
}

function fakeContext(sessionId: string, mode: HostBridgeContext["mode"] = "rpc"): FakeContext {
  const statuses: Array<string | undefined> = [];
  const ctx: FakeContext = {
    mode,
    statuses,
    branch: [],
    statusFailure: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => ctx.branch,
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (ctx.statusFailure !== undefined) throw ctx.statusFailure;
        assert.equal(key, HOST_BRIDGE_STATUS_KEY);
        statuses.push(text);
      },
    },
  };
  return ctx;
}

class FakeClock {
  nowMs = 10_000;
  timers = new Map<number, { at: number; callback: () => void }>();
  nextId = 1;
  readonly api = {
    now: () => this.nowMs,
    setTimeout: (callback: () => void, ms: number) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.nowMs + ms, callback });
      return () => {
        this.timers.delete(id);
      };
    },
  };
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target);
      if (due.length === 0) break;
      due.sort((left, right) => left[1].at - right[1].at);
      const [id, timer] = due[0]!;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = target;
  }
}

interface Harness {
  pi: FakePi;
  clock: FakeClock;
  warnings: string[];
}

function createBridge(host: string | undefined = "waku", schema?: string): Harness {
  const pi = new FakePi();
  const clock = new FakeClock();
  const warnings: string[] = [];
  registerHostBridge(pi, {
    sources: createProcessSources(),
    environment: { host, requestedSchema: schema },
    clock: clock.api,
    warn: (message) => warnings.push(message),
  });
  return { pi, clock, warnings };
}

function lifecyclePayload(record: FakeRecord, extra: Record<string, string | number | null> = {}) {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    toolCallId: record.toolCallId ?? null,
    outputFile: record.outputFile ?? null,
    parentAgentId: null,
    model: "anthropic/claude",
    cwd: "/work",
    isBackground: true,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? null,
    ...extra,
  };
}

function shellPayload(id: string, overrides: Record<string, string | number | null> = {}) {
  return {
    id,
    name: null,
    command: "sleep 10",
    cwd: "/work",
    pid: 42,
    exitCode: null,
    startedAt: 5,
    finishedAt: null,
    toolCallId: `tool-${id}`,
    tailPath: null,
    ...overrides,
  };
}

function customEntry(customType: string, data: RuntimeValue, index: number): SessionEntry {
  return {
    type: "custom",
    id: `e${index}`,
    parentId: index === 0 ? null : `e${index - 1}`,
    timestamp: "2026-10-11T00:00:00.000Z",
    customType,
    data,
  };
}

function subagentEntryData(event: string, overrides: Record<string, RuntimeValue>, live: string[]) {
  return {
    schema: 1,
    at: 1,
    event,
    agent: {
      id: "a1",
      parentId: null,
      role: "general",
      model: null,
      description: "d",
      background: true,
      cwd: null,
      toolCallId: null,
      outputFile: null,
      status: "running",
      startedAt: 1,
      finishedAt: null,
      summary: null,
      ...overrides,
    },
    live,
  };
}

// ---------------------------------------------------------------- schema

const validEntries = {
  subagent: subagentEntryData("started", {}, ["a1"]),
  shell: { schema: 1, at: 1, event: "started", shell: shellPayload("s1"), live: ["s1"] },
  goal: {
    schema: 1,
    at: 1,
    goal: { objective: "o", status: "active", tokenBudget: null, tokensUsed: 0, activeSeconds: 0 },
  },
  workflow: {
    schema: 1,
    at: 1,
    event: "created",
    workflow: { id: "w1", title: "t", agentIds: ["a1"] },
  },
  frame: {
    schema: 1,
    at: 1,
    subagents: [
      {
        id: "a1",
        status: "running",
        toolUses: 1,
        tokens: 2,
        turnCount: null,
        maxTurns: 5,
        durationMs: 3,
        activity: null,
      },
    ],
    shells: [{ id: "s1", status: "running", bytes: 4 }],
  },
};

const schemas = {
  subagent: SubagentEntrySchema,
  shell: ShellEntrySchema,
  goal: GoalEntrySchema,
  workflow: WorkflowEntrySchema,
  frame: ProgressFrameSchema,
};

/** Every object path in a sample, so each field is proven required and closed. */
function objectPaths(value: RuntimeValue, path: string[] = []): string[][] {
  if (value === null || value === undefined || Array.isArray(value) || !(value instanceof Object)) {
    if (Array.isArray(value) && value.length > 0) return objectPaths(value[0], [...path, "0"]);
    return [];
  }
  const paths: string[][] = [path];
  for (const [key, child] of Object.entries(value))
    paths.push(...objectPaths(child, [...path, key]));
  return paths;
}

function cloneWith(
  value: RuntimeValue,
  path: string[],
  edit: (target: Record<string, RuntimeValue>) => void,
): RuntimeValue {
  const copy: RuntimeValue = structuredClone(value);
  let target: RuntimeValue = copy;
  for (const key of path) {
    assert.ok(target instanceof Object);
    target = Object.getOwnPropertyDescriptor(target, key)?.value;
  }
  assert.ok(isJsonRecord(target));
  edit(target);
  return copy;
}

describe("host-bridge schema (§6.4, frozen)", () => {
  for (const name of ["subagent", "shell", "goal", "workflow", "frame"] as const) {
    const sample = validEntries[name];
    const schema = schemas[name];
    it(`${name}: accepts the canonical sample`, () => {
      assert.deepEqual([...Value.Errors(schema, sample)], []);
    });
    it(`${name}: every field is required and no field may be added`, () => {
      for (const path of objectPaths(sample)) {
        const extended = cloneWith(sample, path, (target) => {
          target.extraField = 1;
        });
        assert.equal(Value.Check(schema, extended), false, `extra field at ${path.join(".")}`);
        const node = path.reduce<RuntimeValue>(
          (current, key) =>
            current instanceof Object
              ? Object.getOwnPropertyDescriptor(current, key)?.value
              : undefined,
          sample,
        );
        assert.ok(node instanceof Object);
        for (const key of Object.keys(node)) {
          const removed = cloneWith(sample, path, (target) => {
            Reflect.deleteProperty(target, key);
          });
          assert.equal(Value.Check(schema, removed), false, `missing ${[...path, key].join(".")}`);
        }
      }
    });
  }

  it("pins the exact §6.4 field set of every closed object", () => {
    const frozen: Array<[string, TObject, string[]]> = [
      ["subagent entry", SubagentEntrySchema, ["schema", "at", "event", "agent", "live"]],
      [
        "subagent agent",
        SubagentAgentSchema,
        [
          "id",
          "parentId",
          "role",
          "model",
          "description",
          "background",
          "cwd",
          "toolCallId",
          "outputFile",
          "status",
          "startedAt",
          "finishedAt",
          "summary",
        ],
      ],
      ["shell entry", ShellEntrySchema, ["schema", "at", "event", "shell", "live"]],
      [
        "shell record",
        ShellRecordSchema,
        [
          "id",
          "name",
          "command",
          "cwd",
          "pid",
          "exitCode",
          "startedAt",
          "finishedAt",
          "toolCallId",
          "tailPath",
        ],
      ],
      ["goal entry", GoalEntrySchema, ["schema", "at", "goal"]],
      [
        "goal mirror",
        GoalMirrorSchema,
        ["objective", "status", "tokenBudget", "tokensUsed", "activeSeconds"],
      ],
      ["workflow entry", WorkflowEntrySchema, ["schema", "at", "event", "workflow"]],
      ["progress frame", ProgressFrameSchema, ["schema", "at", "subagents", "shells"]],
      [
        "progress subagent",
        ProgressSubagentSchema,
        ["id", "status", "toolUses", "tokens", "turnCount", "maxTurns", "durationMs", "activity"],
      ],
      ["progress shell", ProgressShellSchema, ["id", "status", "bytes"]],
    ];
    for (const [name, schema, keys] of frozen) {
      assert.deepEqual(Object.keys(schema.properties), keys, name);
      assert.deepEqual(schema.required, keys, `${name} required`);
      assert.equal(
        Object.getOwnPropertyDescriptor(schema, "additionalProperties")?.value,
        false,
        `${name} closed`,
      );
    }
  });

  it("subagent event/status unions include lost and reject unknown values", () => {
    assert.ok(
      Value.Check(
        SubagentEntrySchema,
        subagentEntryData("lost", { status: "lost", finishedAt: 2 }, []),
      ),
    );
    assert.ok(Value.Check(SubagentEntrySchema, subagentEntryData("resumed", {}, ["a1"])));
    assert.equal(
      Value.Check(SubagentEntrySchema, subagentEntryData("steered", { status: "steered" }, [])),
      false,
    );
    assert.equal(Value.Check(SubagentEntrySchema, subagentEntryData("revived", {}, [])), false);
    assert.equal(
      Value.Check(SubagentEntrySchema, { ...subagentEntryData("started", {}, []), schema: 2 }),
      false,
    );
  });

  it("summary is bounded to 200 code points", () => {
    const ascii201 = "x".repeat(201);
    const astral200 = "\u{1F600}".repeat(200);
    assert.equal(
      Value.Check(
        SubagentEntrySchema,
        subagentEntryData(
          "completed",
          { status: "completed", finishedAt: 2, summary: ascii201 },
          [],
        ),
      ),
      false,
    );
    assert.ok(
      Value.Check(
        SubagentEntrySchema,
        subagentEntryData(
          "completed",
          { status: "completed", finishedAt: 2, summary: astral200 },
          [],
        ),
      ),
    );
    assert.equal(boundSummary(`${"\u{1F600}".repeat(250)}`)?.length, 400);
    assert.equal(Array.from(boundSummary("y".repeat(300)) ?? "").length, 200);
    assert.equal(boundSummary(""), null);
  });
});

describe("record status normalization", () => {
  it("maps manager statuses onto the closed union", () => {
    assert.equal(mapRecordStatus("queued", undefined), "queued");
    assert.equal(mapRecordStatus("waiting_for_reset", undefined), "running");
    assert.equal(mapRecordStatus("interrupted", undefined), "running");
    assert.equal(mapRecordStatus("steered", undefined), "running");
    assert.equal(mapRecordStatus("steered", 5), "completed");
    assert.equal(mapRecordStatus("error", 5), "failed");
    assert.equal(mapRecordStatus("aborted", 5), "stopped");
    assert.equal(mapRecordStatus("budget_exceeded", 5), "stopped");
  });
});

// ---------------------------------------------------------------- lifecycle

describe("host-bridge durable entries", () => {
  it("records C4 lifecycle payloads as closed subagent entries with the live list", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1", { runOptions: { cwd: "/wt" } });
    registry.records.push(record);
    registry.install();
    const { pi } = createBridge();
    pi.start(fakeContext("root"));

    pi.emit("subagents:created", lifecyclePayload(record));
    pi.emit("subagents:started", lifecyclePayload(record));
    record.status = "completed";
    record.completedAt = 2_000;
    pi.emit("subagents:completed", lifecyclePayload(record, { summary: "z".repeat(260) }));

    const entries = pi.ofType(SUBAGENT_ENTRY_TYPE);
    assert.equal(entries.length, 3);
    for (const entry of entries) assert.ok(Value.Check(SubagentEntrySchema, entry));
    assert.deepEqual(
      entries.map(
        (entry) =>
          Value.Check(SubagentEntrySchema, entry) && [entry.event, entry.agent.status, entry.live],
      ),
      [
        ["created", "running", ["a1"]],
        ["started", "running", ["a1"]],
        ["completed", "completed", []],
      ],
    );
    const last = entries[2];
    assert.ok(Value.Check(SubagentEntrySchema, last));
    assert.equal(last.agent.cwd, "/wt");
    assert.equal(last.agent.model, "anthropic/claude");
    assert.equal(last.agent.toolCallId, "call-a1");
    assert.equal(last.agent.finishedAt, 2_000);
    assert.equal(last.agent.summary?.length, 200);
  });

  it("falls back to payload fields when the manager no longer holds the record", () => {
    new FakeRegistry().install();
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("subagents:failed", { id: "gone", type: "general", status: "error", summary: "boom" });
    const [entry] = pi.ofType(SUBAGENT_ENTRY_TYPE);
    assert.ok(Value.Check(SubagentEntrySchema, entry));
    assert.equal(entry.agent.status, "failed");
    assert.equal(entry.agent.summary, "boom");
    assert.equal(entry.agent.finishedAt, 10_000);
  });

  it("maps terminal steered records to completed and live ones to running", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1", { status: "steered" });
    registry.records.push(record);
    registry.install();
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("subagents:steered", { id: "a1", message: "x" });
    record.completedAt = 3_000;
    pi.emit("subagents:steered", { id: "a1", message: "y" });
    const statuses = pi
      .ofType(SUBAGENT_ENTRY_TYPE)
      .map((entry) => Value.Check(SubagentEntrySchema, entry) && [entry.event, entry.agent.status]);
    assert.deepEqual(statuses, [
      ["steered", "running"],
      ["steered", "completed"],
    ]);
  });

  it("records shell lifecycle with exactly the C3 shell fields", () => {
    const shells = new FakeShellManager();
    shells.install();
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("shells:started", { ...shellPayload("s1"), ownerId: "root" });
    pi.emit("shells:exited", shellPayload("s1", { exitCode: 0, finishedAt: 9 }));
    pi.emit("shells:exited", shellPayload("never-started"));
    const entries = pi.ofType(SHELL_ENTRY_TYPE);
    assert.equal(entries.length, 2);
    for (const entry of entries) assert.ok(Value.Check(ShellEntrySchema, entry));
    assert.deepEqual(
      entries.map((entry) => Value.Check(ShellEntrySchema, entry) && [entry.event, entry.live]),
      [
        ["started", ["s1"]],
        ["exited", []],
      ],
    );
  });

  it("mirrors goal:changed including null and ignores malformed goals", () => {
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("goal:changed", threadGoal());
    pi.emit("goal:changed", null);
    pi.emit("goal:changed", { objective: "bad" });
    const goals = pi.ofType(GOAL_ENTRY_TYPE);
    assert.equal(goals.length, 2);
    assert.ok(goals.every((entry) => Value.Check(GoalEntrySchema, entry)));
    assert.ok(Value.Check(GoalEntrySchema, goals[0]));
    assert.deepEqual(goals[0].goal, {
      objective: "ship",
      status: "active",
      tokenBudget: 1000,
      tokensUsed: 10,
      activeSeconds: 4,
    });
    assert.ok(Value.Check(GoalEntrySchema, goals[1]));
    assert.equal(goals[1].goal, null);
  });

  it("records workflow created, completed, and cancelled", () => {
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    const workflow = {
      workflowId: "w1",
      name: "Plan",
      status: "running",
      steps: [{ agentId: "a1" }, {}],
    };
    pi.emit("subagents:workflow_created", workflow);
    pi.emit("subagents:workflow_completed", { ...workflow, status: "completed" });
    pi.emit("subagents:workflow_completed", { ...workflow, status: "cancelled" });
    const entries = pi.ofType(WORKFLOW_ENTRY_TYPE);
    assert.ok(entries.every((entry) => Value.Check(WorkflowEntrySchema, entry)));
    assert.deepEqual(
      entries.map(
        (entry) => Value.Check(WorkflowEntrySchema, entry) && [entry.event, entry.workflow],
      ),
      [
        ["created", { id: "w1", title: "Plan", agentIds: ["a1"] }],
        ["completed", { id: "w1", title: "Plan", agentIds: ["a1"] }],
        ["cancelled", { id: "w1", title: "Plan", agentIds: ["a1"] }],
      ],
    );
  });

  it("records entries in every mode but never sends frames or registers commands outside rpc", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const { pi, clock } = createBridge("waku");
    const ctx = fakeContext("root", "tui");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    clock.advance(FRAME_INTERVAL_MS * 4);
    assert.equal(pi.ofType(SUBAGENT_ENTRY_TYPE).length, 1);
    assert.deepEqual(ctx.statuses, []);
    assert.equal(pi.commands.size, 0);
  });
});

// ---------------------------------------------------------------- frames

describe("host-bridge progress frames", () => {
  it("sends changed frames only, every 250ms, only for rpc + CHOCO_PI_HOST=waku", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1", { runOptions: { maxTurns: 7 } });
    registry.records.push(record);
    registry.install();
    const shells = new FakeShellManager();
    shells.shells.push({
      shellId: "s1",
      ownerId: "root",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.shells.push({
      shellId: "s2",
      ownerId: "other",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.install();
    const { pi, clock } = createBridge("waku");
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    clock.advance(FRAME_INTERVAL_MS - 1);
    assert.equal(ctx.statuses.length, 0);
    clock.advance(1);
    assert.equal(ctx.statuses.length, 1);
    const frame: RuntimeValue = JSON.parse(ctx.statuses[0] ?? "null");
    assert.ok(Value.Check(ProgressFrameSchema, frame));
    assert.deepEqual(frame.subagents, [
      {
        id: "a1",
        status: "running",
        toolUses: 0,
        tokens: 6,
        turnCount: null,
        maxTurns: 7,
        durationMs: 10_250 - 1_000,
        activity: null,
      },
    ]);
    assert.deepEqual(frame.shells, [{ id: "s1", status: "running", bytes: 15 }]);

    // Only elapsed time changed: no frame.
    clock.advance(FRAME_INTERVAL_MS * 3);
    assert.equal(ctx.statuses.length, 1);
    record.toolUses = 2;
    clock.advance(FRAME_INTERVAL_MS);
    assert.equal(ctx.statuses.length, 2);

    // Work ends: one empty frame, then the loop stops.
    record.status = "completed";
    record.completedAt = 20_000;
    pi.emit("subagents:completed", lifecyclePayload(record));
    shells.shells[0]!.state = "exited";
    clock.advance(FRAME_INTERVAL_MS);
    assert.equal(ctx.statuses.length, 3);
    const last: RuntimeValue = JSON.parse(ctx.statuses[2] ?? "null");
    assert.ok(Value.Check(ProgressFrameSchema, last));
    assert.deepEqual([last.subagents, last.shells], [[], []]);
    assert.equal(clock.timers.size, 0);
  });

  it("registers the command but sends no frames without CHOCO_PI_HOST=waku", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const { pi, clock } = createBridge("terminal");
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    clock.advance(FRAME_INTERVAL_MS * 2);
    assert.deepEqual(ctx.statuses, []);
    assert.ok(pi.commands.has(HOST_BRIDGE_COMMAND));
  });

  it("warns once for a newer requested schema and still sends schema 1", () => {
    const { warnings } = createBridge("waku", "3");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /schema 1/);
    assert.equal(createBridge("waku", "1").warnings.length, 0);
  });

  it("records nested descendant transitions that no root event announces", () => {
    const registry = new FakeRegistry();
    const parent = agentRecord("p");
    registry.records.push(parent);
    registry.install();
    const { pi, clock } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("subagents:started", lifecyclePayload(parent));
    const child = agentRecord("c", { parentAgentId: "p" });
    const grandchild = agentRecord("g", { parentAgentId: "c" });
    const foreign = agentRecord("f", { parentAgentId: "elsewhere" });
    registry.records.push(child, grandchild, foreign);
    clock.advance(FRAME_INTERVAL_MS);
    child.status = "completed";
    child.completedAt = 11_000;
    child.result = "first line\nsecond";
    clock.advance(FRAME_INTERVAL_MS);
    const view = pi
      .ofType(SUBAGENT_ENTRY_TYPE)
      .map(
        (entry) =>
          Value.Check(SubagentEntrySchema, entry) && [
            entry.event,
            entry.agent.id,
            entry.agent.parentId,
            entry.agent.summary,
          ],
      );
    assert.deepEqual(view, [
      ["started", "p", null, null],
      ["started", "c", "p", null],
      ["started", "g", "c", null],
      ["completed", "c", "p", "first line"],
    ]);
  });
});

// ---------------------------------------------------------------- snapshot

describe("/host-bridge snapshot", () => {
  it("excludes a nested child completed between ticks from the next transition live list", () => {
    const registry = new FakeRegistry();
    const parent = agentRecord("p");
    const child = agentRecord("c", { parentAgentId: "p" });
    registry.records.push(parent, child);
    registry.install();
    const { pi, clock } = createBridge();
    pi.start(fakeContext("root"));
    pi.emit("subagents:started", lifecyclePayload(parent));
    clock.advance(FRAME_INTERVAL_MS);

    child.status = "completed";
    child.completedAt = 10_250;
    const next = agentRecord("q");
    registry.records.push(next);
    pi.emit("subagents:started", lifecyclePayload(next));

    const entry = pi.ofType(SUBAGENT_ENTRY_TYPE).at(-1);
    assert.ok(Value.Check(SubagentEntrySchema, entry));
    assert.equal(entry.agent.id, "q");
    assert.deepEqual(entry.live, ["p", "q"]);
  });

  it("persists exactly one unannounced completion before snapshot live entries", async () => {
    const registry = new FakeRegistry();
    const parent = agentRecord("p");
    const child = agentRecord("c", { parentAgentId: "p" });
    registry.records.push(parent, child);
    registry.install();
    const { pi, clock } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(parent));
    clock.advance(FRAME_INTERVAL_MS);
    child.status = "completed";
    child.completedAt = 10_250;
    child.result = "nested child complete\nsecond line";
    const before = pi.entries.length;

    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("snapshot", ctx);
    const snapshotEntries = pi.entries.slice(before);
    assert.deepEqual(
      snapshotEntries.map((entry) => entry.customType),
      [GOAL_ENTRY_TYPE, SUBAGENT_ENTRY_TYPE, SUBAGENT_ENTRY_TYPE],
    );
    const terminal = snapshotEntries[1]?.data;
    assert.ok(Value.Check(SubagentEntrySchema, terminal));
    assert.equal(terminal.event, "completed");
    assert.equal(terminal.agent.id, "c");
    assert.equal(terminal.agent.status, "completed");
    assert.equal(terminal.agent.finishedAt, 10_250);
    assert.equal(terminal.agent.summary, "nested child complete");
    assert.deepEqual(terminal.live, ["p"]);
    const live = snapshotEntries[2]?.data;
    assert.ok(Value.Check(SubagentEntrySchema, live));
    assert.equal(live.event, "started");
    assert.equal(live.agent.id, "p");

    clock.advance(FRAME_INTERVAL_MS);
    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("snapshot", ctx);
    assert.equal(
      pi
        .ofType(SUBAGENT_ENTRY_TYPE)
        .filter(
          (entry) =>
            Value.Check(SubagentEntrySchema, entry) &&
            entry.agent.id === "c" &&
            entry.event === "completed",
        ).length,
      1,
    );
  });

  it("appends only a null goal entry when nothing is live", async () => {
    new FakeRegistry().install();
    new FakeShellManager().install();
    const { pi } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("snapshot", ctx);
    assert.deepEqual(
      pi.entries.map((entry) => entry.customType),
      [GOAL_ENTRY_TYPE],
    );
    assert.ok(Value.Check(GoalEntrySchema, pi.entries[0]?.data));
    assert.deepEqual(pi.entries[0]?.data, { schema: 1, at: 10_000, goal: null });
  });

  it("appends the current goal, then each live owned subagent and shell as started", async () => {
    const registry = new FakeRegistry();
    const a1 = agentRecord("a1");
    const a2 = agentRecord("a2", { status: "queued" });
    const done = agentRecord("a3", { status: "completed", completedAt: 5 });
    registry.records.push(a1, a2, done, agentRecord("foreign"));
    registry.install();
    const shells = new FakeShellManager();
    shells.shells.push({
      shellId: "s1",
      ownerId: "root",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
      pid: 3,
    });
    shells.shells.push({
      shellId: "s2",
      ownerId: "other",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.install();
    installGoalRuntime("root", "root", []);
    const { pi } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    for (const record of [a1, a2, done]) pi.emit("subagents:created", lifecyclePayload(record));
    pi.entries.length = 0;

    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("snapshot", ctx);
    assert.deepEqual(
      pi.entries.map((entry) => entry.customType),
      [GOAL_ENTRY_TYPE, SUBAGENT_ENTRY_TYPE, SUBAGENT_ENTRY_TYPE, SHELL_ENTRY_TYPE],
    );
    const goal = pi.entries[0]?.data;
    assert.ok(Value.Check(GoalEntrySchema, goal));
    assert.equal(goal.goal?.objective, "ship");
    const subs = pi.ofType(SUBAGENT_ENTRY_TYPE);
    assert.deepEqual(
      subs.map(
        (entry) =>
          Value.Check(SubagentEntrySchema, entry) && [
            entry.event,
            entry.agent.id,
            entry.agent.status,
            entry.live,
          ],
      ),
      [
        ["started", "a1", "running", ["a1", "a2"]],
        ["started", "a2", "queued", ["a1", "a2"]],
      ],
    );
    const [shell] = pi.ofType(SHELL_ENTRY_TYPE);
    assert.ok(Value.Check(ShellEntrySchema, shell));
    assert.deepEqual(shell.shell, {
      id: "s1",
      name: null,
      command: "x",
      cwd: "/",
      pid: 3,
      exitCode: null,
      startedAt: 1,
      finishedAt: null,
      toolCallId: "tool-s1",
      tailPath: null,
    });
    assert.deepEqual(shell.live, ["s1"]);
  });

  it("does not report ghost live agents the registry dropped before the next tick", async () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const { pi, clock } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    registry.records.length = 0;
    pi.entries.length = 0;
    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("snapshot", ctx);
    assert.deepEqual(
      pi.entries.map((entry) => entry.customType),
      [GOAL_ENTRY_TYPE, SUBAGENT_ENTRY_TYPE],
    );
    const lost = pi.ofType(SUBAGENT_ENTRY_TYPE)[0];
    assert.ok(Value.Check(SubagentEntrySchema, lost));
    assert.equal(lost.event, "lost");
    assert.equal(lost.agent.id, "a1");
    assert.deepEqual(lost.live, []);
    // A later lifecycle entry carries no ghost in its live list.
    const other = agentRecord("a2");
    registry.records.push(other);
    pi.emit("subagents:started", lifecyclePayload(other));
    const entry = pi.ofType(SUBAGENT_ENTRY_TYPE).at(-1);
    assert.ok(Value.Check(SubagentEntrySchema, entry));
    assert.deepEqual(entry.live, ["a2"]);
    clock.advance(FRAME_INTERVAL_MS);
    assert.equal(
      pi
        .ofType(SUBAGENT_ENTRY_TYPE)
        .filter(
          (item) =>
            Value.Check(SubagentEntrySchema, item) &&
            item.event === "lost" &&
            item.agent.id === "a1",
        ).length,
      1,
    );
  });
});

// ---------------------------------------------------------------- commands

describe("/host-bridge control", () => {
  it("stops only owned subagents and shells", async () => {
    const registry = new FakeRegistry();
    const mine = agentRecord("mine");
    const foreign = agentRecord("foreign");
    const otherRoot = agentRecord("other-root", { rootSessionId: "other" });
    registry.records.push(mine, foreign, otherRoot);
    registry.install();
    const shells = new FakeShellManager();
    shells.shells.push({
      shellId: "s1",
      ownerId: "root",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.shells.push({
      shellId: "s2",
      ownerId: "other",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.install();
    const { pi } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(mine));
    pi.emit("subagents:started", lifecyclePayload(otherRoot));
    const run = pi.commands.get(HOST_BRIDGE_COMMAND);
    assert.ok(run);

    await run("stop subagent mine", ctx);
    await assert.rejects(run("stop subagent foreign", ctx), /not found/);
    await assert.rejects(run("stop subagent other-root", ctx), /not found/);
    assert.deepEqual(registry.stopped, ["mine"]);

    await run("stop shell s1", ctx);
    await assert.rejects(run("stop shell s2", ctx), /Shell not found: s2/);
    assert.deepEqual(shells.stopped, ["s1"]);

    await assert.rejects(run("stop", ctx), /Usage/);
    await assert.rejects(run("snapshot extra", ctx), /Usage/);
    assert.ok(!pi.entries.some((entry) => entry.customType.includes("output")));
  });

  it("source boundary refuses to stop a record outside the owner predicate", () => {
    const registry = new FakeRegistry();
    registry.records.push(agentRecord("x"));
    registry.install();
    const source = createProcessSources().subagents("root", () => false);
    assert.equal(source.stop("x"), false);
    assert.deepEqual(registry.stopped, []);
  });

  it("completes the goal through the owning runtime only", async () => {
    const completions: string[] = [];
    installGoalRuntime("root", "root", completions);
    const { pi } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    await pi.commands.get(HOST_BRIDGE_COMMAND)?.("goal complete", ctx);
    assert.deepEqual(completions, ["root"]);

    // A map entry whose owner disagrees with its key is not trusted.
    installGoalRuntime("root", "someone-else", completions);
    await assert.rejects(
      Promise.resolve(pi.commands.get(HOST_BRIDGE_COMMAND)?.("goal complete", ctx)),
      /not available/,
    );
    assert.equal(createProcessSources().goals("root").goal(), null);
  });

  it("rejects commands from a non-rpc context after an earlier rpc registration", async () => {
    const { pi } = createBridge();
    pi.start(fakeContext("root"));
    const run = pi.commands.get(HOST_BRIDGE_COMMAND);
    assert.ok(run);
    const printCtx = fakeContext("second", "print");
    pi.start(printCtx, "new");
    await assert.rejects(run("snapshot", printCtx), /only in rpc mode/);
    await assert.rejects(run("snapshot", fakeContext("stale-id")), /not active/);
    assert.equal(pi.entries.length, 0);
  });
});

// ---------------------------------------------------------------- session lifecycle

describe("host-bridge session lifecycle", () => {
  function restoredBranch(): SessionEntry[] {
    return [
      customEntry(SUBAGENT_ENTRY_TYPE, subagentEntryData("started", {}, ["a1"]), 0),
      customEntry(
        SHELL_ENTRY_TYPE,
        { schema: 1, at: 1, event: "started", shell: shellPayload("s1"), live: ["s1"] },
        1,
      ),
    ];
  }

  it("marks restored live work lost on fork even when the runtime still exists", () => {
    const registry = new FakeRegistry();
    registry.records.push(agentRecord("a1"));
    registry.install();
    const shells = new FakeShellManager();
    shells.shells.push({
      shellId: "s1",
      ownerId: "forked",
      command: "x",
      cwd: "/",
      state: "running",
      startedAt: 1,
    });
    shells.install();
    const { pi } = createBridge();
    const ctx = fakeContext("forked");
    ctx.branch = restoredBranch();
    pi.start(ctx, "fork");
    const [agent] = pi.ofType(SUBAGENT_ENTRY_TYPE);
    assert.ok(Value.Check(SubagentEntrySchema, agent));
    assert.deepEqual(
      [agent.event, agent.agent.status, agent.agent.finishedAt, agent.live],
      ["lost", "lost", 10_000, []],
    );
    assert.match(agent.agent.summary ?? "", /^lost: /);
    const [shell] = pi.ofType(SHELL_ENTRY_TYPE);
    assert.ok(Value.Check(ShellEntrySchema, shell));
    assert.deepEqual([shell.event, shell.live], ["lost", []]);
  });

  it("adopts restored live work on resume when its runtime is present, else marks it lost", () => {
    const registry = new FakeRegistry();
    registry.records.push(agentRecord("a1"));
    registry.install();
    new FakeShellManager().install();
    const { pi, clock } = createBridge();
    const ctx = fakeContext("root");
    ctx.branch = restoredBranch();
    pi.start(ctx, "resume");
    assert.equal(pi.ofType(SUBAGENT_ENTRY_TYPE).length, 0);
    const [shell] = pi.ofType(SHELL_ENTRY_TYPE);
    assert.ok(Value.Check(ShellEntrySchema, shell));
    assert.equal(shell.event, "lost");
    // The adopted record later completes and is recorded.
    registry.records[0]!.status = "completed";
    registry.records[0]!.completedAt = 12_000;
    clock.advance(FRAME_INTERVAL_MS);
    const [done] = pi.ofType(SUBAGENT_ENTRY_TYPE);
    assert.ok(Value.Check(SubagentEntrySchema, done));
    assert.deepEqual([done.event, done.agent.status], ["completed", "completed"]);
  });

  it("records a lost agent that is later revived as resumed", () => {
    const registry = new FakeRegistry();
    registry.install();
    const { pi } = createBridge();
    const ctx = fakeContext("root");
    ctx.branch = restoredBranch().slice(0, 1);
    pi.start(ctx, "startup");
    const revived = agentRecord("a1");
    registry.records.push(revived);
    pi.emit("subagents:started", lifecyclePayload(revived));
    const events = pi
      .ofType(SUBAGENT_ENTRY_TYPE)
      .map(
        (entry) =>
          Value.Check(SubagentEntrySchema, entry) && [entry.event, entry.agent.status, entry.live],
      );
    assert.deepEqual(events, [
      ["lost", "lost", []],
      ["resumed", "running", ["a1"]],
    ]);
  });

  it("keeps a child-session bridge inert beside the root bridge", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const root = createBridge();
    // Child extension loading runs inside the subagent async child context.
    registry.childContext = true;
    const childByLoad = createBridge();
    registry.childContext = false;
    const childById = createBridge();
    registry.childIds.add("child-session");

    root.pi.start(fakeContext("root"));
    const childCtx = fakeContext("child-session");
    childCtx.branch = restoredBranch();
    childByLoad.pi.start(childCtx);
    childById.pi.start(childCtx);
    // Each Pi session owns its own event bus; the child buses see child traffic only.
    root.pi.emit("subagents:started", lifecyclePayload(record));
    childByLoad.pi.emit("goal:changed", null);
    childById.pi.emit("subagents:started", lifecyclePayload(record));
    root.clock.advance(FRAME_INTERVAL_MS);

    assert.equal(root.pi.ofType(SUBAGENT_ENTRY_TYPE).length, 1);
    assert.deepEqual(childByLoad.pi.entries, []);
    assert.deepEqual(childById.pi.entries, []);
    assert.equal(childByLoad.pi.commands.size + childById.pi.commands.size, 0);
  });

  it("stops recording after shutdown and contains only stale-context failures", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const { pi, clock } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    pi.shutdown();
    pi.emit("subagents:completed", lifecyclePayload(record));
    clock.advance(FRAME_INTERVAL_MS * 2);
    assert.equal(pi.ofType(SUBAGENT_ENTRY_TYPE).length, 1);
    assert.equal(clock.timers.size, 0);

    pi.start(ctx, "reload");
    pi.appendFailure = new Error(STALE);
    pi.emit("subagents:started", lifecyclePayload(record));
    pi.appendFailure = undefined;
    // The stale failure deactivated the bridge; nothing more is recorded.
    pi.emit("goal:changed", null);
    assert.equal(pi.ofType(GOAL_ENTRY_TYPE).length, 0);

    pi.start(ctx, "reload");
    pi.appendFailure = new Error("disk full");
    assert.throws(() => pi.emit("goal:changed", null), /disk full/);
  });

  it("contains a stale status failure in the frame loop", () => {
    const registry = new FakeRegistry();
    const record = agentRecord("a1");
    registry.records.push(record);
    registry.install();
    const { pi, clock } = createBridge();
    const ctx = fakeContext("root");
    pi.start(ctx);
    pi.emit("subagents:started", lifecyclePayload(record));
    ctx.statusFailure = new Error(`${STALE} (replaced)`);
    clock.advance(FRAME_INTERVAL_MS);
    assert.equal(clock.timers.size, 0);
    ctx.statusFailure = new Error("tty gone");
    pi.start(ctx, "reload");
    pi.emit("subagents:started", lifecyclePayload(record));
    assert.throws(() => clock.advance(FRAME_INTERVAL_MS), /tty gone/);
  });
});
