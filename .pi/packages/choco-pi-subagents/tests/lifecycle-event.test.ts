import assert from "node:assert/strict";
import test from "node:test";
import { buildLifecycleMetadata, finalReportSummary } from "../src/lifecycle-event.ts";
import type { AgentRecord } from "../src/types.ts";

function record(): AgentRecord {
  return {
    id: "child",
    type: "implementer",
    description: "Lifecycle test",
    status: "queued",
    toolUses: 0,
    startedAt: 100,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

test("queued lifecycle metadata has explicit flat nullable runtime fields", () => {
  const payload = buildLifecycleMetadata(record());
  const keys: (keyof typeof payload)[] = [
    "toolCallId",
    "outputFile",
    "parentAgentId",
    "model",
    "cwd",
    "completedAt",
  ];
  for (const key of keys) {
    assert.equal(payload[key], null, key);
    assert.equal(Object.hasOwn(payload, key), true, key);
  }
  assert.equal(payload.description, "Lifecycle test");
  assert.equal(payload.status, "queued");
  assert.equal(payload.startedAt, 100);
});

test("lifecycle metadata snapshots nested identity, spawn model and worktree cwd", () => {
  const agent = record();
  agent.parentAgentId = "parent";
  agent.toolCallId = "tool";
  agent.outputFile = "/tmp/transcript";
  agent.spawnModel = { provider: "openai", id: "model" };
  agent.spawnCwd = "/repo";
  agent.isBackground = false;
  assert.equal(buildLifecycleMetadata(agent).cwd, "/repo");
  agent.worktree = { path: "/tree", workPath: "/tree/subdir", branch: "test", baseSha: "base" };
  agent.status = "completed";
  agent.completedAt = 200;
  const payload = buildLifecycleMetadata(agent);
  assert.equal(payload.cwd, "/tree/subdir");
  assert.equal(payload.model, "openai/model");
  assert.equal(payload.toolCallId, "tool");
  assert.equal(payload.outputFile, "/tmp/transcript");
  assert.equal(payload.parentAgentId, "parent");
  assert.equal(payload.isBackground, false);
  assert.equal(payload.completedAt, 200);
  agent.description = "Changed later";
  assert.equal(payload.description, "Lifecycle test");
});

test("terminal summary is only the first final-report line, bounded to 200 characters", () => {
  assert.equal(finalReportSummary(undefined), null);
  assert.equal(finalReportSummary(""), null);
  assert.equal(finalReportSummary("Outcome\r\nDetails"), "Outcome");
  assert.equal(finalReportSummary("Outcome\rDetails"), "Outcome");
  assert.equal(finalReportSummary("Outcome\nDetails"), "Outcome");
  assert.equal(finalReportSummary("\nDetails"), "");
  assert.equal(finalReportSummary(`${"x".repeat(201)}\nignored`), "x".repeat(200));
  assert.equal(finalReportSummary(`${"𝄞".repeat(201)}\nignored`), "𝄞".repeat(200));
});
