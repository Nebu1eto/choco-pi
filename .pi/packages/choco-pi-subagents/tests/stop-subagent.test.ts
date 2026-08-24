import assert from "node:assert/strict";
import test from "node:test";
import { resolveStopOutcome } from "../src/stop-subagent.ts";
import type { AgentRecord } from "../src/types.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

function recordFixture(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return partialFixture<AgentRecord>({
    id: "agent-1",
    status: "running",
    ...overrides,
  });
}

test("classifies a missing record", () => {
  assert.deepEqual(resolveStopOutcome(undefined), { kind: "not_found" });
});

test("refuses nested records before considering their other state", () => {
  const record = recordFixture({
    parentAgentId: "parent-1",
    workflowId: "workflow-1",
    status: "completed",
  });
  assert.deepEqual(resolveStopOutcome(record), { kind: "nested", record });
});

test("allows workflow records because their scheduler observes manager settlement", () => {
  const workflowRecord = recordFixture({ workflowId: "workflow-1", workflowStepId: "step-1" });
  assert.deepEqual(resolveStopOutcome(workflowRecord), { kind: "stop", record: workflowRecord });

  const stepRecord = recordFixture({ workflowStepId: "step-2", status: "queued" });
  assert.deepEqual(resolveStopOutcome(stepRecord), { kind: "stop", record: stepRecord });
});

test("classifies every terminal record as already settled", () => {
  const statuses = ["completed", "steered", "aborted", "stopped", "error"] as const;
  for (const status of statuses) {
    const record = recordFixture({ status });
    assert.deepEqual(resolveStopOutcome(record), { kind: "already_settled", record });
  }
});

test("allows running and queued records to stop", () => {
  for (const status of ["running", "queued"] as const) {
    const record = recordFixture({ status });
    assert.deepEqual(resolveStopOutcome(record), { kind: "stop", record });
  }
});
