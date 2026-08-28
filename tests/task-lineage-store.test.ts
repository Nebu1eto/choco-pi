import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  TASK_BOUNDARY_CUSTOM_TYPE,
  TASK_OUTCOME_CUSTOM_TYPE,
  TASK_PARTICIPANT_CUSTOM_TYPE,
  auditTaskLineage,
  createParticipantSpawnRecord,
  createParticipantStartRecord,
  createTaskOutcomeRecord,
  createTaskSessionSnapshot,
  createTaskStartRecord,
  listProjectSessionJsonl,
  paginateTaskSummaries,
  snapshotProjectSessions,
  writeTaskSummary,
  TaskLineageOperationalError,
  type FindingCounts,
  type TaskLineageSummary,
} from "../.pi/extensions/task-lineage/store.ts";

const START = "2026-08-28T10:00:00.000Z";
const END = "2026-08-28T10:05:00.000Z";

type SessionHeaderFixture = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

function jsonLine<Value>(value: Value): string {
  return `${JSON.stringify(value)}\n`;
}

function header(id: string, parentSession?: string, timestamp = START): SessionHeaderFixture {
  const record: SessionHeaderFixture = {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: "/privacy-safe/project",
  };
  if (parentSession !== undefined) record.parentSession = parentSession;
  return record;
}

function custom<Data>(id: string, customType: string, data: Data, timestamp = START) {
  return { type: "custom", id, timestamp, customType, data };
}

function assistant(id: string, cost: number, secret: string) {
  return {
    type: "message",
    id,
    timestamp: START,
    message: {
      role: "assistant",
      provider: "test",
      model: "test",
      content: [{ type: "text", text: secret }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  };
}

function toolFailure(id: string, secret: string) {
  return {
    type: "message",
    id,
    timestamp: START,
    message: {
      role: "toolResult",
      toolCallId: `tool-${id}`,
      toolName: "shell",
      isError: true,
      content: [{ type: "text", text: secret }],
    },
  };
}

function outcome(
  taskId: string,
  participantKey: string,
  durationMs: number,
  retryCount: number,
  findings: FindingCounts,
  result: "completed" | "failed" = "completed",
): object {
  return createTaskOutcomeRecord({
    taskId,
    participantKey,
    outcome: result,
    finishedAt: END,
    durationMs,
    retryCount,
    findings,
  });
}

async function writeSession<RecordValue>(
  file: string,
  id: string,
  parentSession: string | undefined,
  records: readonly RecordValue[],
  timestamp = START,
): Promise<void> {
  const lines = [header(id, parentSession, timestamp), ...records].map(jsonLine).join("");
  await writeFile(file, lines, { mode: 0o600 });
}

function noFindings(): FindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

test("audits recursive implementation, review, and E2E lineage once with explicit gaps and privacy", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-jsonl-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootFile = path.join(directory, "root.jsonl");
  const implementationFile = path.join(directory, "implementation.jsonl");
  const reviewFile = path.join(directory, "review.jsonl");
  const e2eFile = path.join(directory, "e2e.jsonl");
  const auditFile = path.join(directory, "audit.jsonl");
  const auditChildFile = path.join(directory, "audit-child.jsonl");
  const taskId = "task-unit-5";
  const rawSecret = "credential=sk-do-not-copy";
  const rawPrompt = "raw prompt: deploy everything";
  const rawToolOutput = "unrestricted tool output";

  const invalidSpawnJson = [
    '{"taskId":"task-unit-5","toolCallId":"unsafe-purpose","role":"implementation","purpose":"raw prompt: deploy everything","auditWorker":false}',
    '{"taskId":"task-unit-5","toolCallId":"unsafe-role","role":"credential=sk-do-not-copy","purpose":"implementation","auditWorker":false}',
    '{"taskId":"task-unit-5","toolCallId":"unsafe-revision","role":"review","purpose":"review","reviewRevision":"secret-token","auditWorker":false}',
    '{"taskId":"task-unit-5","toolCallId":"token-shaped-revision","role":"review","purpose":"review","reviewRevision":"ghp_0123456789abcdef0123456789abcdef","auditWorker":false}',
  ];
  for (const encoded of invalidSpawnJson) {
    const externalInput = JSON.parse(encoded);
    assert.throws(() => createParticipantSpawnRecord(externalInput));
  }

  await writeSession(rootFile, "root-session", undefined, []);
  await writeSession(e2eFile, "e2e-session", undefined, [
    assistant("old-e2e-usage", 90, rawSecret),
  ]);
  const before = await snapshotProjectSessions(directory, START);
  assert.deepEqual(
    before.sessions.map((entry) => entry.sessionId),
    ["e2e-session", "root-session"],
  );
  const start = createTaskStartRecord({
    taskId,
    rootSessionId: "root-session",
    parentSessionId: null,
    role: "root",
    purpose: "implementation",
    reviewRevision: "0123456789abcdef0123456789abcdef01234567",
    startedAt: START,
    snapshot: before,
  });
  const rootRecords = [
    custom("task-start", TASK_BOUNDARY_CUSTOM_TYPE, start),
    custom(
      "spawn-implementation",
      TASK_PARTICIPANT_CUSTOM_TYPE,
      createParticipantSpawnRecord({
        taskId,
        toolCallId: "spawn-implementation",
        role: "implementation",
        purpose: "implementation",
        linkedSessionId: "implementation-session",
        auditWorker: false,
      }),
    ),
    custom(
      "spawn-audit",
      TASK_PARTICIPANT_CUSTOM_TYPE,
      createParticipantSpawnRecord({
        taskId,
        toolCallId: "spawn-audit",
        role: "review",
        purpose: "audit",
        linkedSessionId: "audit-session",
        auditWorker: true,
      }),
    ),
    custom(
      "spawn-missing",
      TASK_PARTICIPANT_CUSTOM_TYPE,
      createParticipantSpawnRecord({
        taskId,
        toolCallId: "spawn-missing",
        role: "review",
        purpose: "review",
        auditWorker: false,
      }),
    ),
    custom("retry-one", TASK_PARTICIPANT_CUSTOM_TYPE, {
      schemaVersion: 1,
      event: "retry",
      taskId,
      toolCallId: "implementation-session",
    }),
    custom("retry-two", TASK_PARTICIPANT_CUSTOM_TYPE, {
      schemaVersion: 1,
      event: "retry",
      taskId,
      toolCallId: "implementation-session",
    }),
    assistant("root-usage", 1.25, rawSecret),
    toolFailure("root-failure", rawToolOutput),
    custom(
      "root-outcome",
      TASK_OUTCOME_CUSTOM_TYPE,
      outcome(taskId, "root-session", 100, 0, noFindings()),
    ),
    custom("archive", TASK_BOUNDARY_CUSTOM_TYPE, {
      schemaVersion: 1,
      event: "archive",
      taskId,
      archivedAt: END,
      outcome: "completed",
    }),
    assistant("after-archive", 99, "must not count"),
  ];
  await appendFile(rootFile, `${rootRecords.map(jsonLine).join("")}{malformed-json\n`);

  const implementationOutcome = custom(
    "implementation-outcome",
    TASK_OUTCOME_CUSTOM_TYPE,
    outcome(taskId, "implementation-session", 200, 0, {
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
    }),
  );
  await writeSession(
    implementationFile,
    "implementation-session",
    rootFile,
    [
      custom(
        "spawn-review",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantSpawnRecord({
          taskId,
          toolCallId: "spawn-review",
          role: "review",
          purpose: "review",
          reviewRevision: "refs/heads/review-42",
          linkedSessionId: "review-session",
          auditWorker: false,
        }),
      ),
      assistant("implementation-usage", 2, rawPrompt),
      toolFailure("implementation-failure", rawToolOutput),
      implementationOutcome,
      implementationOutcome,
    ],
    "2026-08-28T10:01:00.000Z",
  );

  await writeSession(
    reviewFile,
    "review-session",
    implementationFile,
    [
      custom(
        "spawn-e2e",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantSpawnRecord({
          taskId,
          toolCallId: "spawn-e2e",
          role: "e2e",
          purpose: "e2e",
          linkedSessionId: "e2e-session",
          auditWorker: false,
        }),
      ),
      assistant("review-usage", 0.5, rawSecret),
      custom(
        "review-outcome",
        TASK_OUTCOME_CUSTOM_TYPE,
        outcome(taskId, "review-session", 300, 1, {
          critical: 0,
          high: 0,
          medium: 2,
          low: 0,
          info: 0,
        }),
      ),
    ],
    "2026-08-28T10:02:30.000Z",
  );

  const duplicatedE2eUsage = assistant("e2e-usage", 0.25, rawPrompt);
  await appendFile(
    e2eFile,
    [
      duplicatedE2eUsage,
      duplicatedE2eUsage,
      custom(
        "e2e-outcome",
        TASK_OUTCOME_CUSTOM_TYPE,
        outcome(taskId, "e2e-session", 400, 0, {
          critical: 0,
          high: 0,
          medium: 0,
          low: 3,
          info: 4,
        }),
      ),
    ]
      .map(jsonLine)
      .join(""),
  );

  await writeSession(
    auditFile,
    "audit-session",
    rootFile,
    [
      custom(
        "audit-start",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantStartRecord({
          taskId,
          toolCallId: "spawn-audit",
          role: "review",
          purpose: "audit",
          auditWorker: true,
        }),
      ),
      assistant("audit-usage", 50, rawSecret),
    ],
    "2026-08-28T10:00:30.000Z",
  );
  await writeSession(
    auditChildFile,
    "audit-child-session",
    auditFile,
    [assistant("audit-child-usage", 50, rawSecret)],
    "2026-08-28T10:03:00.000Z",
  );

  const summary = await auditTaskLineage({
    projectSessionDirectory: directory,
    taskId,
    rootSessionId: "root-session",
    updatedAt: END,
  });

  assert.deepEqual(
    summary.participants.map((participant) => [
      participant.sessionId,
      participant.role,
      participant.purpose,
    ]),
    [
      ["e2e-session", "e2e", "e2e"],
      ["implementation-session", "implementation", "implementation"],
      ["review-session", "review", "review"],
      ["root-session", "root", "implementation"],
    ],
  );
  assert.equal(summary.parentSessionId, null);
  assert.equal(summary.reviewRevision, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(summary.terminalOutcome, "completed");
  assert.deepEqual(summary.roles, ["e2e", "implementation", "review", "root"]);
  assert.equal(summary.metrics.participantDurationMs, 1_000);
  assert.equal(summary.metrics.usageCost, 4);
  assert.equal(summary.metrics.toolResultFailures, 2);
  assert.equal(summary.metrics.retries, 3);
  assert.deepEqual(summary.metrics.findings, { critical: 0, high: 1, medium: 2, low: 3, info: 4 });
  assert.deepEqual(
    summary.coverage.entries.map((entry) => [
      entry.toolCallId,
      entry.status,
      entry.sessionId,
      entry.reason,
    ]),
    [
      ["spawn-e2e", "available", "e2e-session", undefined],
      ["spawn-implementation", "available", "implementation-session", undefined],
      ["spawn-missing", "unavailable", undefined, "session-jsonl-unavailable"],
      ["spawn-review", "available", "review-session", undefined],
    ],
  );
  assert.deepEqual(summary.coverage, {
    expected: 4,
    available: 3,
    unavailable: 1,
    entries: summary.coverage.entries,
  });
  assert.equal(Object.hasOwn(summary.coverage.entries[2]!, "sessionId"), false);
  assert.equal(summary.completedAt, END);
  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    rawSecret,
    rawPrompt,
    rawToolOutput,
    "description",
    "content",
    "credential",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("lists headers and bounded cursors without accepting malformed JSONL", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-list-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeSession(path.join(directory, "one.jsonl"), "one", undefined, [
    assistant("usage", 1, "private"),
  ]);
  await writeFile(path.join(directory, "invalid.jsonl"), "not-json\n", { mode: 0o600 });

  const listing = await listProjectSessionJsonl(directory);
  assert.equal(listing.truncated, false);
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0]?.sessionId, "one");
  assert.equal(listing.sessions[0]?.cursor, (await stat(path.join(directory, "one.jsonl"))).size);
  const snapshot = createTaskSessionSnapshot(listing, START);
  assert.deepEqual(snapshot.sessions, [{ sessionId: "one", cursor: listing.sessions[0]?.cursor }]);
});

function historicalSummary(index: number): TaskLineageSummary {
  const day = String(1 + Math.floor(index / 20)).padStart(2, "0");
  const minute = String(index % 20).padStart(2, "0");
  const taskId = `history-${String(index).padStart(3, "0")}`;
  const role = index % 2 === 0 ? "review" : "implementation";
  return {
    schemaVersion: 1,
    taskId,
    rootSessionId: `root-${index}`,
    parentSessionId: null,
    role: "root",
    purpose: "implementation",
    startedAt: `2026-08-${day}T10:${minute}:00.000Z`,
    updatedAt: `2026-08-${day}T11:${minute}:00.000Z`,
    roles: ["root", role],
    participants: [{ sessionId: `root-${index}`, role: "root", purpose: "implementation" }],
    metrics: {
      participantDurationMs: index,
      usageCost: index / 100,
      toolResultFailures: 0,
      retries: 0,
      findings: noFindings(),
    },
    coverage: { expected: 0, available: 0, unavailable: 0, entries: [] },
  };
}

test("atomically writes private compact summaries and paginates a long history", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-index-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const summaries = Array.from({ length: 47 }, (_, index) => historicalSummary(index));
  await Promise.all(summaries.map((summary) => writeTaskSummary(directory, summary)));

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const firstPage = await paginateTaskSummaries(directory, { limit: 11 });
  assert.equal(firstPage.items.length, 11);
  assert.ok(firstPage.nextCursor);
  const secondPage = await paginateTaskSummaries(directory, {
    limit: 11,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 11);
  assert.equal(
    new Set([...firstPage.items, ...secondPage.items].map((summary) => summary.taskId)).size,
    22,
  );
  assert.ok(firstPage.items[0]!.startedAt >= firstPage.items[10]!.startedAt);

  const reviewPage = await paginateTaskSummaries(directory, { role: "review", limit: 100 });
  assert.equal(reviewPage.items.length, 24);
  assert.ok(reviewPage.items.every((summary) => summary.roles.includes("review")));
  const exact = await paginateTaskSummaries(directory, { taskId: "history-012" });
  assert.deepEqual(
    exact.items.map((summary) => summary.taskId),
    ["history-012"],
  );
  const ranged = await paginateTaskSummaries(directory, {
    from: "2026-08-02T10:00:00.000Z",
    to: "2026-08-02T10:05:00.000Z",
    limit: 100,
  });
  assert.equal(ranged.items.length, 6);

  const samplePath = await writeTaskSummary(directory, historicalSummary(46));
  assert.equal((await stat(samplePath)).mode & 0o777, 0o600);
  const sampleBody = await readFile(samplePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(sampleBody));
});

test("concurrent same-task writes preserve the newest summary against stale reloads", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-concurrent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const versions = Array.from({ length: 30 }, (_, index) => {
    const summary = historicalSummary(99);
    summary.metrics.participantDurationMs = index;
    summary.updatedAt = `2026-08-28T12:${String(index).padStart(2, "0")}:00.000Z`;
    return summary;
  });
  await Promise.all(versions.map((summary) => writeTaskSummary(directory, summary)));
  await writeTaskSummary(directory, versions[0]!);

  const page = await paginateTaskSummaries(directory, { taskId: versions[0]!.taskId });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.metrics.participantDurationMs, 29);
  assert.equal(page.items[0]?.updatedAt, "2026-08-28T12:29:00.000Z");
  const files = await readFile(await writeTaskSummary(directory, page.items[0]!), "utf8");
  assert.deepEqual(JSON.parse(files), page.items[0]);
});

test("linked parallel spawns preserve roles and review revisions across timestamp ties", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-parallel-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootFile = path.join(directory, "root.jsonl");
  const implementationFile = path.join(directory, "implementation.jsonl");
  const reviewFile = path.join(directory, "review.jsonl");
  const taskId = "task-parallel";
  await writeSession(rootFile, "root-session", undefined, []);
  const before = await snapshotProjectSessions(directory, START);
  await appendFile(
    rootFile,
    [
      custom(
        "task-start",
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskStartRecord({
          taskId,
          rootSessionId: "root-session",
          parentSessionId: null,
          role: "root",
          purpose: "coordination",
          startedAt: START,
          snapshot: before,
        }),
      ),
      custom(
        "spawn-implementation",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantSpawnRecord({
          taskId,
          toolCallId: "spawn-implementation",
          role: "implementation",
          purpose: "implementation",
          linkedSessionId: "z-implementation",
          auditWorker: false,
        }),
      ),
      custom(
        "spawn-review",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantSpawnRecord({
          taskId,
          toolCallId: "spawn-review",
          role: "review",
          purpose: "review",
          reviewRevision: "refs/heads/review-parallel",
          linkedSessionId: "agent-review-id",
          auditWorker: false,
        }),
      ),
    ]
      .map(jsonLine)
      .join(""),
  );
  const tiedTimestamp = "2026-08-28T10:00:01.000Z";
  await writeSession(implementationFile, "z-implementation", rootFile, [], tiedTimestamp);
  await writeSession(
    reviewFile,
    "a-review",
    rootFile,
    [
      custom(
        "review-start",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantStartRecord({
          taskId,
          toolCallId: "spawn-review",
          role: "review",
          purpose: "review",
          reviewRevision: "refs/heads/review-parallel",
          auditWorker: false,
        }),
      ),
    ],
    tiedTimestamp,
  );

  const summary = await auditTaskLineage({
    projectSessionDirectory: directory,
    taskId,
    rootSessionId: "root-session",
    updatedAt: END,
  });
  const implementation = summary.participants.find(
    (participant) => participant.sessionId === "z-implementation",
  );
  const review = summary.participants.find((participant) => participant.sessionId === "a-review");
  assert.equal(implementation?.role, "implementation");
  assert.equal(implementation?.reviewRevision, undefined);
  assert.equal(review?.role, "review");
  assert.equal(review?.reviewRevision, "refs/heads/review-parallel");
});

test("surfaces rejected oversized headers as unavailable coverage", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-header-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootFile = path.join(directory, "root.jsonl");
  await writeSession(rootFile, "root-session", undefined, []);
  const before = await snapshotProjectSessions(directory, START);
  await appendFile(
    rootFile,
    [
      custom(
        "task-start",
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskStartRecord({
          taskId: "task-oversized-header",
          rootSessionId: "root-session",
          parentSessionId: null,
          role: "root",
          purpose: "coordination",
          startedAt: START,
          snapshot: before,
        }),
      ),
      custom(
        "spawn-child",
        TASK_PARTICIPANT_CUSTOM_TYPE,
        createParticipantSpawnRecord({
          taskId: "task-oversized-header",
          toolCallId: "spawn-child",
          role: "implementation",
          purpose: "implementation",
          auditWorker: false,
        }),
      ),
    ]
      .map(jsonLine)
      .join(""),
  );
  await writeFile(
    path.join(directory, "oversized.jsonl"),
    `${JSON.stringify({ ...header("oversized-child", rootFile), padding: "x".repeat(70_000) })}\n`,
  );

  const summary = await auditTaskLineage({
    projectSessionDirectory: directory,
    taskId: "task-oversized-header",
    rootSessionId: "root-session",
    updatedAt: END,
  });
  assert.deepEqual(summary.coverage.entries, [
    {
      toolCallId: "spawn-child",
      role: "implementation",
      status: "unavailable",
      reason: "session-header-unavailable",
    },
  ]);
});

test("reports a fresh per-task lock as an operational timeout", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-lineage-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const initial = historicalSummary(88);
  const destination = await writeTaskSummary(directory, initial);
  await mkdir(`${destination}.lock`, { mode: 0o700 });
  const newer = historicalSummary(88);
  newer.updatedAt = "2026-08-28T23:59:00.000Z";
  await assert.rejects(
    writeTaskSummary(directory, newer),
    (error: RuntimeValue) =>
      error instanceof TaskLineageOperationalError && error.code === "summary-lock-timeout",
  );
});
