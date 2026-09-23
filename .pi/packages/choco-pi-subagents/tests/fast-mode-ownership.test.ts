import assert from "node:assert/strict";
import test from "node:test";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import type { RunOptions } from "../src/agent-runner.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

function record(id: string, parentAgentId?: string): AgentRecord {
  return {
    id,
    parentAgentId,
    type: "implementer",
    handle: id,
    description: id,
    status: "completed",
    toolUses: 0,
    startedAt: 1,
    completedAt: 2,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

test("nested fast-mode control reaches retained descendants but rejects siblings", async () => {
  const fixture = await createSdkFixture();
  const parent = record("parent");
  const child = record("child", parent.id);
  const grandchild = record("grandchild", child.id);
  const sibling = record("sibling", "other-parent");
  const records = new Map([parent, child, grandchild, sibling].map((item) => [item.id, item]));
  const updates: string[] = [];
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("control must not spawn"),
    spawnAndWait: () => assert.fail("control must not spawn"),
    getRecord: (id) => records.get(id),
    listAgents: () => [...records.values()],
    getActiveCount: () => 0,
    getScheduledActiveCount: () => 0,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
    setFastMode(id, requested) {
      const target = records.get(id);
      if (!target) return undefined;
      target.fastModeRequested = requested;
      target.fastModeRevision = (target.fastModeRevision ?? 0) + 1;
      updates.push(id);
      return target;
    },
  };
  const tools = createNestedSubagentTools({
    manager,
    pi: fixture.pi,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: "/tmp/choco-pi-fast-ownership",
  });
  const tool = tools.find((candidate) => candidate.name === "set_subagent_fast_mode");
  assert.ok(tool);

  try {
    const descendant = await tool.execute(
      "call",
      { agent_id: grandchild.id, enabled: true },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.match(
      descendant.content[0]?.type === "text" ? descendant.content[0].text : "",
      /enabled/,
    );
    assert.deepEqual(updates, [grandchild.id]);

    const denied = await tool.execute(
      "call",
      { agent_id: sibling.id, enabled: true },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.match(
      denied.content[0]?.type === "text" ? denied.content[0].text : "",
      /not found or not owned/,
    );
    assert.deepEqual(updates, [grandchild.id]);
  } finally {
    fixture.session.dispose();
  }
});

test("an accepted update mutates initialization before the first child request", async () => {
  const fixture = await createSdkFixture();
  let captured: RunOptions | undefined;
  let settle: (() => void) | undefined;
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      captured = options;
      return new Promise((resolve) => {
        settle = () =>
          resolve({
            responseText: "done",
            session: fixture.session,
            aborted: false,
            steered: false,
          });
      });
    },
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  try {
    const id = manager.spawn(fixture.pi, fixture.ctx, "implementer", "probe", {
      description: "probe",
      isBackground: true,
      isolated: true,
    });
    assert.equal(captured?.fastMode?.requested, false);
    manager.setFastMode(id, true);
    assert.deepEqual(captured?.fastMode, {
      requested: true,
      source: "explicit",
      revision: 1,
    });
    settle?.();
    await manager.getRecord(id)?.promise;
  } finally {
    manager.dispose();
    fixture.session.dispose();
  }
});
