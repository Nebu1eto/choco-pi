import assert from "node:assert/strict";
import test from "node:test";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";

test("nested Agent exposes name and forwards it to the manager alias option", async () => {
  const parent: AgentRecord = {
    id: "parent",
    type: "general-purpose",
    handle: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
  let capturedOptions: Parameters<NestedAgentManager["spawn"]>[4] | undefined;
  const manager: NestedAgentManager = {
    spawn(_pi, _ctx, _type, _prompt, options) {
      capturedOptions = options;
      return "child";
    },
    spawnAndWait: () => assert.fail("background spawn must not wait"),
    getRecord: (id: string) => (id === parent.id ? parent : undefined),
    listAgents: () => [parent],
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  // SAFETY: The manager fixture implements every NestedAgentManager member used by these tools.
  const [agentTool] = createNestedSubagentTools({
    manager,
    // SAFETY: This path only forwards the ExtensionAPI value to the manager fixture above.
    pi: {} as never,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: "/tmp/choco-pi-nested-name-test",
  });
  assert.match(JSON.stringify(agentTool.parameters), /"name":/, "nested Agent schema accepts name");

  // SAFETY: The nested execute path reads only cwd, model, and modelRegistry from this fixture.
  const result = await agentTool.execute(
    "call",
    {
      prompt: "do work",
      description: "child work",
      name: "beta",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    {
      cwd: "/tmp/choco-pi-nested-name-test",
      model: undefined,
      modelRegistry: {},
    } as never,
  );

  assert.deepEqual(result.content, [
    { type: "text", text: "Nested agent started in background. Agent ID: child" },
  ]);
  assert.equal(capturedOptions?.name, "beta");
});
