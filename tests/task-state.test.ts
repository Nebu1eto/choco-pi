import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_BOUNDARY_CUSTOM_TYPE,
  TASK_OUTCOME_CUSTOM_TYPE,
  TASK_PARTICIPANT_CUSTOM_TYPE,
  auditTaskLineage,
  TaskLineageOperationalError,
  type JsonObject,
  type JsonValue,
  type TaskLineageSummary,
  type TaskSessionSnapshot,
} from "../.pi/extensions/task-lineage/store.ts";
import {
  createTaskLineageExtension,
  type TaskLineageDependencies,
} from "../.pi/extensions/task-lineage.ts";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => Promise<void> | void;
type Appended = { customType: string; data: JsonValue };
type Deferred<Value> = { promise: Promise<Value>; resolve(value: Value): void };

const rootSessionId = "root-session";
const childSessionId = "child-session";
const rootFile = "/sessions/root.jsonl";
const snapshot: TaskSessionSnapshot = {
  capturedAt: "2026-09-01T00:00:00.000Z",
  sessions: [{ sessionId: rootSessionId, cursor: 10 }],
  truncated: false,
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function summary(taskId: string, coverageUnavailable = 0): TaskLineageSummary {
  const unavailable =
    coverageUnavailable === 0
      ? []
      : [
          {
            toolCallId: "agent-gap",
            role: "implementation" as const,
            status: "unavailable" as const,
            reason: "session-jsonl-unavailable" as const,
          },
        ];
  return {
    schemaVersion: 1,
    taskId,
    rootSessionId,
    parentSessionId: null,
    role: "root",
    purpose: "coordination",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:00:01.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    terminalOutcome: "completed",
    roles: ["root"],
    participants: [{ sessionId: rootSessionId, role: "root", purpose: "coordination" }],
    metrics: {
      participantDurationMs: 1000,
      usageCost: 2,
      toolResultFailures: 0,
      retries: 0,
      findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    coverage: {
      expected: unavailable.length,
      available: 0,
      unavailable: unavailable.length,
      entries: unavailable,
    },
  };
}

function event<Type extends ExtensionEvent["type"]>(
  value: Extract<ExtensionEvent, { type: Type }>,
): Extract<ExtensionEvent, { type: Type }> {
  return value;
}

function agentEnd(stopReason: "stop" | "error" | "aborted" | "length"): AgentEndEvent {
  // SAFETY: The lineage handler reads only the assistant role and structural stopReason fields.
  return {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason }],
  } as AgentEndEvent;
}

function createHarness(
  options: {
    sessionId?: string;
    sessionFile?: string;
    parentSession?: string;
    sessionName?: string;
    sessionDirectory?: string;
    branch?: SessionEntry[];
    overrides?: Partial<TaskLineageDependencies>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const entries: Appended[] = [];
  const branch = options.branch ?? [];
  const writes: Array<{ directory: string; summary: TaskLineageSummary }> = [];
  let taskCounter = 0;
  const dependencies: Partial<TaskLineageDependencies> = {
    now: () => `2026-09-01T00:00:0${Math.min(taskCounter, 9)}.000Z`,
    createTaskId: () => `task-${++taskCounter}`,
    snapshotProjectSessions: async () => snapshot,
    auditTaskLineage: async ({ taskId }) => summary(taskId),
    writeTaskSummary: async (directory, value) => {
      writes.push({ directory, summary: value });
      return `${directory}/${value.taskId}.summary.json`;
    },
    ...options.overrides,
  };
  const apiFixture = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: JsonValue) {
      entries.push({ customType, data });
      branch.push({
        type: "custom",
        id: `entry-${branch.length}`,
        parentId: null,
        timestamp: "2026-09-01T00:00:01.000Z",
        customType,
        data,
      });
    },
  };
  // SAFETY: The fixture implements the only ExtensionAPI methods used by task-lineage.
  const pi = apiFixture as ExtensionAPI;
  createTaskLineageExtension(dependencies)(pi);
  const sessionId = options.sessionId ?? rootSessionId;
  const header: SessionHeader = {
    type: "session" as const,
    id: sessionId,
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd: "/project",
  };
  if (options.parentSession) header.parentSession = options.parentSession;
  let contextAccesses = 0;
  const sessionManagerFixture = {
    getSessionId: () => sessionId,
    getSessionFile: () => options.sessionFile ?? rootFile,
    getSessionDir: () => options.sessionDirectory ?? "/sessions",
    getHeader: () => header,
    getBranch: () => branch,
    getSessionName: () => options.sessionName,
  };
  // SAFETY: The null-prototype fixture receives its typed sessionManager property immediately below.
  const contextFixture = Object.create(null) as { sessionManager: typeof sessionManagerFixture };
  Object.defineProperty(contextFixture, "sessionManager", {
    get: () => {
      contextAccesses += 1;
      return sessionManagerFixture;
    },
  });
  // SAFETY: The fixture defines every context property read by task-lineage handlers.
  const ctx = contextFixture as ExtensionContext;
  async function emit(name: string, value: ExtensionEvent): Promise<void> {
    const handler = handlers.get(name);
    assert.ok(handler, `registered ${name}`);
    await handler(value, ctx);
  }
  return {
    branch,
    entries,
    writes,
    emit,
    ctx,
    handlers,
    contextAccesses: () => contextAccesses,
  };
}

async function startRootTask(
  harness: ReturnType<typeof createHarness>,
  prompt: string,
): Promise<void> {
  await harness.emit("input", event({ type: "input", text: prompt, source: "interactive" }));
  await harness.emit(
    "message_start",
    event({
      type: "message_start",
      message: { role: "user", content: prompt, timestamp: 1 },
    }),
  );
}

function records(harness: ReturnType<typeof createHarness>, customType: string): JsonObject[] {
  return harness.entries
    .filter((entry) => entry.customType === customType)
    .map((entry) => {
      // SAFETY: Lineage constructors produce object records for these custom entry types.
      return entry.data as JsonObject;
    });
}

test("task boundaries isolate child resources, completion, index state, and the next task", async () => {
  const harness = createHarness();
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "first private prompt");
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "agent-review",
      toolName: "Agent",
      input: {
        subagent_type: "reviewer",
        reviewRevision: "abcdef1",
        prompt: "private agent prompt",
      },
    }),
  );
  await harness.emit(
    "tool_result",
    event({
      type: "tool_result",
      toolCallId: "agent-review",
      toolName: "Agent",
      input: {},
      content: [],
      details: { agentId: "agent-review-id" },
      isError: false,
    }),
  );
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "session-e2e",
      toolName: "session_create",
      input: { role: "e2e", purpose: "e2e", initial_prompt: "private e2e prompt" },
    }),
  );
  await harness.emit(
    "tool_result",
    event({
      type: "tool_result",
      toolCallId: "session-e2e",
      toolName: "session_create",
      input: {},
      content: [],
      details: { sessionId: "e2e-session" },
      isError: false,
    }),
  );
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "session-reused",
      toolName: "session_send",
      input: { session_id: "reused-session", message: "private mailbox message" },
    }),
  );
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "ledger-create",
      toolName: "TaskCreate",
      input: { title: "private title", body: "private body" },
    }),
  );
  await harness.emit("agent_end", agentEnd("stop"));
  await harness.emit("agent_settled", event({ type: "agent_settled" }));

  assert.deepEqual(
    records(harness, TASK_BOUNDARY_CUSTOM_TYPE).map((entry) => entry.event),
    ["start", "archive"],
  );
  assert.equal(records(harness, TASK_OUTCOME_CUSTOM_TYPE).length, 1);
  assert.equal(records(harness, TASK_OUTCOME_CUSTOM_TYPE)[0]?.outcome, "completed");
  const resources = records(harness, TASK_PARTICIPANT_CUSTOM_TYPE);
  assert.equal(resources[0]?.linkedSessionId, "agent-review-id");
  assert.deepEqual(
    resources.map((entry) => entry.toolCallId),
    ["agent-review", "session-e2e", "session-reused"],
  );
  assert.equal(resources[1]?.linkedSessionId, "e2e-session");
  assert.equal(resources[2]?.linkedSessionId, "reused-session");
  assert.deepEqual(records(harness, "choco-pi:task-lineage:resource"), [
    {
      schemaVersion: 1,
      taskId: "task-1",
      toolCallId: "ledger-create",
      kind: "create",
    },
  ]);
  assert.equal(harness.writes[0]?.directory, "/sessions/.task-lineage");

  await startRootTask(harness, "second private prompt");
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "ledger-update",
      toolName: "TaskUpdate",
      input: { task_id: "private" },
    }),
  );
  assert.deepEqual(
    records(harness, TASK_BOUNDARY_CUSTOM_TYPE)
      .filter((entry) => entry.event === "start")
      .map((entry) => entry.taskId),
    ["task-1", "task-2"],
  );
  assert.deepEqual(
    records(harness, "choco-pi:task-lineage:resource").map((entry) => entry.taskId),
    ["task-1", "task-2"],
  );
});

test("reload reconstructs an active task and terminalizes each boundary once", async () => {
  const harness = createHarness();
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "before reload");
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "agent-retry",
      toolName: "Agent",
      input: { resume: "agent-run" },
    }),
  );
  await harness.emit("session_shutdown", event({ type: "session_shutdown", reason: "reload" }));
  await harness.emit("session_start", event({ type: "session_start", reason: "reload" }));
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  await harness.emit("agent_settled", event({ type: "agent_settled" }));

  assert.equal(
    records(harness, TASK_BOUNDARY_CUSTOM_TYPE).filter((entry) => entry.event === "start").length,
    1,
  );
  assert.equal(
    records(harness, TASK_BOUNDARY_CUSTOM_TYPE).filter((entry) => entry.event === "archive").length,
    1,
  );
  assert.equal(records(harness, TASK_OUTCOME_CUSTOM_TYPE).length, 1);
  assert.equal(records(harness, TASK_OUTCOME_CUSTOM_TYPE)[0]?.retryCount, 1);
});

test("a child reads real parent JSONL, classifies itself, and writes only its outcome", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-child-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parentFile = path.join(directory, "parent.jsonl");
  const actualChildFile = path.join(directory, "child.jsonl");
  const parentStart = {
    schemaVersion: 1,
    event: "start",
    taskId: "task-parent",
    rootSessionId,
    parentSessionId: null,
    role: "root",
    purpose: "coordination",
    startedAt: "2026-09-01T00:00:00.000Z",
    snapshot,
  };
  await writeFile(
    parentFile,
    [
      {
        type: "session",
        id: rootSessionId,
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: "/project",
      },
      { type: "custom", customType: TASK_BOUNDARY_CUSTOM_TYPE, data: parentStart },
      {
        type: "custom",
        customType: TASK_PARTICIPANT_CUSTOM_TYPE,
        data: {
          schemaVersion: 1,
          event: "spawn",
          taskId: "task-parent",
          toolCallId: "spawn-review-child",
          role: "review",
          purpose: "review",
          reviewRevision: "refs/heads/review-child",
          linkedSessionId: "agent-review-id",
          auditWorker: false,
        },
      },
      {
        type: "custom",
        customType: TASK_PARTICIPANT_CUSTOM_TYPE,
        data: {
          schemaVersion: 1,
          event: "spawn",
          taskId: "task-parent",
          toolCallId: "spawn-audit-child",
          role: "review",
          purpose: "audit",
          linkedSessionId: "audit-child",
          auditWorker: true,
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  let audits = 0;
  const harness = createHarness({
    sessionId: childSessionId,
    sessionFile: actualChildFile,
    parentSession: parentFile,
    sessionName: "reviewer-task-parent#agent-review-id",
    sessionDirectory: directory,
    overrides: {
      auditTaskLineage: async ({ taskId }) => {
        audits += 1;
        return summary(taskId);
      },
    },
  });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  const secondChild = createHarness({
    sessionId: "parallel-child",
    sessionFile: path.join(directory, "parallel-child.jsonl"),
    parentSession: parentFile,
    sessionName: "implementer-task-parent",
    sessionDirectory: directory,
  });
  await secondChild.emit("session_start", event({ type: "session_start", reason: "startup" }));
  const auditChild = createHarness({
    sessionId: "audit-child",
    sessionFile: path.join(directory, "audit-child.jsonl"),
    parentSession: parentFile,
    sessionName: "implementer-audit",
    sessionDirectory: directory,
  });
  await auditChild.emit("session_start", event({ type: "session_start", reason: "startup" }));

  assert.equal(records(harness, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.event, "start");
  assert.equal(records(harness, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.toolCallId, "spawn-review-child");
  assert.equal(records(harness, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.role, "review");
  assert.equal(records(harness, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.auditWorker, false);
  assert.equal(records(harness, TASK_OUTCOME_CUSTOM_TYPE)[0]?.participantKey, childSessionId);
  assert.equal(records(harness, TASK_BOUNDARY_CUSTOM_TYPE).length, 0);
  assert.equal(records(secondChild, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.toolCallId, "parallel-child");
  assert.equal(records(secondChild, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.role, "implementation");
  assert.equal(
    records(auditChild, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.toolCallId,
    "spawn-audit-child",
  );
  assert.equal(records(auditChild, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.auditWorker, true);
  assert.equal(records(auditChild, TASK_PARTICIPANT_CUSTOM_TYPE)[0]?.purpose, "audit");
  assert.equal(audits, 0);
});

test("a fork with an archived parent starts a root task carrying validated ancestry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parentFile = path.join(directory, "parent.jsonl");
  const forkFile = path.join(directory, "fork.jsonl");
  await writeFile(
    parentFile,
    [
      {
        type: "session",
        id: rootSessionId,
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: "/project",
      },
      {
        type: "custom",
        customType: TASK_BOUNDARY_CUSTOM_TYPE,
        data: {
          schemaVersion: 1,
          event: "start",
          taskId: "archived-task",
          rootSessionId,
          parentSessionId: null,
          role: "root",
          purpose: "coordination",
          startedAt: "2026-09-01T00:00:00.000Z",
          snapshot,
        },
      },
      {
        type: "custom",
        customType: TASK_BOUNDARY_CUSTOM_TYPE,
        data: {
          schemaVersion: 1,
          event: "archive",
          taskId: "archived-task",
          archivedAt: "2026-09-01T00:00:01.000Z",
          outcome: "completed",
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const harness = createHarness({
    sessionId: "fork-session",
    sessionFile: forkFile,
    parentSession: parentFile,
    sessionDirectory: directory,
  });
  await harness.emit("session_start", event({ type: "session_start", reason: "fork" }));
  await startRootTask(harness, "new fork task");
  const start = records(harness, TASK_BOUNDARY_CUSTOM_TYPE)[0];
  assert.equal(start?.rootSessionId, "fork-session");
  assert.equal(start?.parentSessionId, rootSessionId);
});

test("an unavailable Agent child remains explicit in the written summary", async () => {
  const harness = createHarness({
    overrides: { auditTaskLineage: async ({ taskId }) => summary(taskId, 1) },
  });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "task");
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "agent-gap",
      toolName: "Agent",
      input: { subagent_type: "implementer", prompt: "never persisted" },
    }),
  );
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  assert.deepEqual(harness.writes[0]?.summary.coverage.entries, [
    {
      toolCallId: "agent-gap",
      role: "implementation",
      status: "unavailable",
      reason: "session-jsonl-unavailable",
    },
  ]);
});

test("finding counts accept only recognized records in the active task window", async () => {
  const branch: SessionEntry[] = [
    {
      type: "custom",
      id: "prior-finding",
      parentId: null,
      timestamp: "2026-09-01T00:00:00.000Z",
      customType: "choco-pi:review-finding",
      data: { schemaVersion: 1, taskId: "prior-task", severity: "critical" },
    },
  ];
  const harness = createHarness({ branch });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "findings");
  branch.push(
    {
      type: "custom",
      id: "arbitrary",
      parentId: null,
      timestamp: "2026-09-01T00:00:01.000Z",
      customType: "unrelated:custom",
      data: { taskId: "task-1", severity: "high" },
    },
    {
      type: "custom",
      id: "wrong-task",
      parentId: null,
      timestamp: "2026-09-01T00:00:01.000Z",
      customType: "choco-pi:review-finding",
      data: { schemaVersion: 1, taskId: "prior-task", severity: "low" },
    },
    {
      type: "custom",
      id: "current-finding",
      parentId: null,
      timestamp: "2026-09-01T00:00:01.000Z",
      customType: "choco-pi:review-finding",
      data: {
        schemaVersion: 1,
        taskId: "task-1",
        severity: "medium",
        finding: "must not be copied",
      },
    },
  );
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  assert.deepEqual(records(harness, TASK_OUTCOME_CUSTOM_TYPE)[0]?.findings, {
    critical: 0,
    high: 0,
    medium: 1,
    low: 0,
    info: 0,
  });
});

test("a delayed start snapshot cannot append after shutdown and replacement", async () => {
  const delayed = deferred<TaskSessionSnapshot>();
  const harness = createHarness({ overrides: { snapshotProjectSessions: () => delayed.promise } });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await harness.emit("input", event({ type: "input", text: "private", source: "interactive" }));
  const pending = harness.emit(
    "message_start",
    event({
      type: "message_start",
      message: { role: "user", content: "private", timestamp: 1 },
    }),
  );
  await Promise.resolve();
  await harness.emit("session_shutdown", event({ type: "session_shutdown", reason: "reload" }));
  await harness.emit("session_start", event({ type: "session_start", reason: "reload" }));
  const accessesBeforeResolution = harness.contextAccesses();
  delayed.resolve(snapshot);
  await pending;
  assert.equal(harness.entries.length, 0);
  assert.equal(harness.contextAccesses(), accessesBeforeResolution);
});

test("prompt, credential, tool output, and unrestricted descriptions never enter lineage or index", async () => {
  const secrets = [
    "RAW_PRIVATE_PROMPT",
    "PASSWORD=hunter2",
    "TOOL_OUTPUT_PRIVATE",
    "ARBITRARY_DESCRIPTION",
  ];
  const harness = createHarness();
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, secrets[0]);
  await harness.emit(
    "tool_call",
    event({
      type: "tool_call",
      toolCallId: "privacy-agent",
      toolName: "Agent",
      input: { subagent_type: "reviewer", prompt: secrets[1], description: secrets[3] },
    }),
  );
  await harness.emit(
    "tool_result",
    event({
      type: "tool_result",
      toolCallId: "privacy-agent",
      toolName: "Agent",
      input: {},
      content: [{ type: "text", text: secrets[2] }],
      details: { output: secrets[2] },
      isError: false,
    }),
  );
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  const persisted = JSON.stringify({ entries: harness.entries, writes: harness.writes });
  for (const secret of secrets) assert.equal(persisted.includes(secret), false);
});

test("three Agent resumes emitted by the extension aggregate as exactly three retries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-retries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "root.jsonl");
  const harness = createHarness({ sessionDirectory: directory, sessionFile });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "retry aggregation");
  for (let index = 1; index <= 3; index += 1) {
    await harness.emit(
      "tool_call",
      event({
        type: "tool_call",
        toolCallId: `agent-resume-${index}`,
        toolName: "Agent",
        input: { resume: "agent-run" },
      }),
    );
  }
  await harness.emit("agent_end", agentEnd("stop"));
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  await writeFile(
    sessionFile,
    [
      {
        type: "session",
        version: 3,
        id: rootSessionId,
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: "/project",
      },
      ...harness.branch,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const audited = await auditTaskLineage({
    projectSessionDirectory: directory,
    taskId: "task-1",
    rootSessionId,
    updatedAt: "2026-09-01T00:00:09.000Z",
  });
  assert.equal(audited.metrics.retries, 3);
  assert.deepEqual(
    records(harness, TASK_PARTICIPANT_CUSTOM_TYPE).map((record) => record.toolCallId),
    [rootSessionId, rootSessionId, rootSessionId],
  );
});

test("records a stale index state when the summary lock times out", async () => {
  const harness = createHarness({
    overrides: {
      writeTaskSummary: async () => {
        throw new TaskLineageOperationalError(
          "summary-lock-timeout",
          "timed out acquiring task summary lock",
        );
      },
    },
  });
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "lock timeout");
  await harness.emit("agent_settled", event({ type: "agent_settled" }));
  assert.deepEqual(records(harness, "choco-pi:task-state:resource"), [
    {
      schemaVersion: 1,
      taskId: "task-1",
      resource: "summary-index",
      status: "stale",
      reason: "summary-lock-timeout",
      updatedAt: "2026-09-01T00:00:01.000Z",
    },
  ]);
});

test("rejects token-shaped review revisions while accepting commit and refs shapes", async () => {
  const harness = createHarness();
  await harness.emit("session_start", event({ type: "session_start", reason: "startup" }));
  await startRootTask(harness, "revision shapes");
  for (const [toolCallId, reviewRevision] of [
    ["review-one", "ghp_0123456789abcdef0123456789abcdef"],
    ["review-two", "abcdef1"],
    ["review-three", "refs/heads/review-safe"],
  ] as const) {
    await harness.emit(
      "tool_call",
      event({
        type: "tool_call",
        toolCallId,
        toolName: "Agent",
        input: { subagent_type: "reviewer", reviewRevision },
      }),
    );
    await harness.emit(
      "tool_result",
      event({
        type: "tool_result",
        toolCallId,
        toolName: "Agent",
        input: {},
        content: [],
        details: { sessionId: `${toolCallId}-session` },
        isError: false,
      }),
    );
  }
  const spawned = records(harness, TASK_PARTICIPANT_CUSTOM_TYPE);
  assert.equal(spawned[0]?.reviewRevision, undefined);
  assert.equal(spawned[1]?.reviewRevision, "abcdef1");
  assert.equal(spawned[2]?.reviewRevision, "refs/heads/review-safe");
});
