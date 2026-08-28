import assert from "node:assert/strict";
import test from "node:test";
import {
  beginResultGeneration,
  claimSubagentResultRead,
  formatResultReadRefusal,
  formatResultReadTimeout,
  publishTerminalResult,
  releaseActiveResultRead,
  RESULT_WAIT_MECHANICS,
  SUBAGENT_RESULT_WAIT_TIMEOUT_MS,
  TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
  waitForSubagentResult,
} from "../src/result-read.ts";
import type { AgentRecord } from "../src/types.ts";

type ResultWaitRecord = Pick<AgentRecord, "status" | "promise">;

function record(status: AgentRecord["status"], parentAgentId?: string): AgentRecord {
  return {
    id: parentAgentId ? "nested-child" : "top-child",
    type: "implementer",
    description: "generation transition",
    status,
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    resultGeneration: 1,
    parentAgentId,
  };
}

test("top-level active and terminal reads are each claimed once per run", () => {
  const top = record("running");
  assert.deepEqual(claimSubagentResultRead(top), {
    kind: "active",
    generation: 1,
    status: "running",
  });
  const activeRefusal = claimSubagentResultRead(top);
  assert.equal(activeRefusal.kind, "active-refused");
  if (activeRefusal.kind !== "active-refused") assert.fail("expected active refusal");
  assert.deepEqual(JSON.parse(formatResultReadRefusal(top, activeRefusal)), {
    kind: "subagent_result_read_refused",
    agent_id: "top-child",
    status: "running",
    generation: 1,
    reason: "active_generation_already_read",
    action: "Wait for the terminal completion notification; do not poll get_subagent_result.",
  });

  top.status = "completed";
  top.result = "durable terminal output";
  publishTerminalResult(top);
  assert.deepEqual(claimSubagentResultRead(top), { kind: "terminal", generation: 1 });
  assert.equal(top.result, "durable terminal output", "notification delivery does not own output");
  assert.equal(claimSubagentResultRead(top).kind, "terminal-refused");
});

test("queued and running phases share one active-read generation", () => {
  const queued = record("queued");
  assert.equal(claimSubagentResultRead(queued).kind, "active");
  queued.status = "running";
  const refused = claimSubagentResultRead(queued);
  assert.equal(refused.kind, "active-refused");
  assert.equal(refused.generation, 1);
});

test("a resumed run gets a fresh generation without leaking consumed state", () => {
  const resumed = record("completed");
  resumed.result = "first run";
  publishTerminalResult(resumed);
  assert.equal(claimSubagentResultRead(resumed).kind, "terminal");
  assert.equal(resumed.consumedResultGeneration, 1);

  assert.equal(beginResultGeneration(resumed), 2);
  resumed.status = "queued";
  resumed.result = undefined;
  assert.equal(resumed.resultConsumed, false);
  assert.deepEqual(claimSubagentResultRead(resumed), {
    kind: "active",
    generation: 2,
    status: "queued",
  });
  resumed.status = "completed";
  resumed.result = "second run";
  publishTerminalResult(resumed);
  assert.deepEqual(claimSubagentResultRead(resumed), { kind: "terminal", generation: 2 });
});

test("stopped runs refuse reads until partial output is atomically published", () => {
  const stopped = record("stopped");
  assert.equal(claimSubagentResultRead(stopped).kind, "terminal-pending");
  stopped.result = "partial transcript";
  publishTerminalResult(stopped);
  assert.equal(claimSubagentResultRead(stopped).kind, "terminal");
  assert.equal(stopped.result, "partial transcript");
});

test("result reads settle immediately for every terminal status", async () => {
  assert.equal(SUBAGENT_RESULT_WAIT_TIMEOUT_MS, 5_000);
  for (const status of ["completed", "steered", "aborted", "stopped", "error"] as const) {
    assert.equal(await waitForSubagentResult({ status }, undefined, 10, 1), "settled");
  }
});

test("result reads share one deadline across queued and running phases", async () => {
  let resolveRun: ((value: string) => void) | undefined;
  const record: ResultWaitRecord = { status: "queued" };
  queueMicrotask(() => {
    record.status = "running";
    record.promise = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    queueMicrotask(() => {
      record.status = "completed";
      resolveRun?.("done");
    });
  });

  assert.equal(await waitForSubagentResult(record, undefined, 100, 1), "settled");
  assert.equal(record.status, "completed");
});

test("an optimistic timeout leaves an active result unconsumed", async () => {
  const record: ResultWaitRecord = {
    status: "running",
    promise: new Promise<string>(() => {}),
  };
  assert.equal(await waitForSubagentResult(record, undefined, 5, 1), "timed-out");
  assert.equal(record.status, "running");
  assert.match(
    formatResultReadTimeout("child-1", record.status),
    /timed out after 5 seconds.*continues.*unconsumed.*continue other work.*terminal completion notification.*exactly once.*do not poll/i,
  );
});

test("result guidance separates terminal retrieval from the bounded active-status check", () => {
  assert.match(
    TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
    /continue other work.*terminal completion notification.*exactly once with get_subagent_result/i,
  );
  assert.match(
    RESULT_WAIT_MECHANICS,
    /first active read.*current status immediately.*5-second grace period.*further active reads.*refused/i,
  );
  assert.doesNotMatch(
    RESULT_WAIT_MECHANICS,
    /(?:recommended|use|call|invoke).*wait:\s*true|wait:\s*true.*(?:to wait|await)/i,
  );
});

test("caller cancellation ends only the result read", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel read");
  const record: ResultWaitRecord = {
    status: "running",
    promise: new Promise<string>(() => {}),
  };
  const waiting = waitForSubagentResult(record, controller.signal, 100, 1);
  controller.abort(reason);
  await assert.rejects(waiting, reason);
  assert.equal(record.status, "running");
});

test("cancelled generation wait rolls back its active claim", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel generation read");
  const active = record("running");
  active.promise = new Promise<string>(() => {});
  const claim = claimSubagentResultRead(active);
  assert.equal(claim.kind, "active");
  if (claim.kind !== "active") assert.fail("expected active claim");

  const waiting = waitForSubagentResult(active, controller.signal, 100, 1);
  controller.abort(reason);
  await assert.rejects(waiting, reason);
  releaseActiveResultRead(active, claim.generation);

  assert.equal(active.status, "running");
  assert.equal(active.resultConsumed, undefined);
  assert.equal(claimSubagentResultRead(active).kind, "active");
});
