import assert from "node:assert/strict";
import test from "node:test";
import {
  formatResultReadTimeout,
  RESULT_WAIT_MECHANICS,
  SUBAGENT_RESULT_WAIT_TIMEOUT_MS,
  TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
  waitForSubagentResult,
} from "../src/result-read.ts";
import type { AgentRecord } from "../src/types.ts";

type ResultWaitRecord = Pick<AgentRecord, "status" | "promise">;

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
    /only a bounded terminal-status check.*5-second grace period.*without consuming the result/i,
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
