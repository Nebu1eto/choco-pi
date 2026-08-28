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
    {
      type: "text",
      text:
        "Nested agent started in background. Agent ID: child\n" +
        "Continue other work until the terminal completion notification arrives, then retrieve the result exactly once with get_subagent_result. Use steer_subagent to send it a message mid-run.",
    },
  ]);
  assert.equal(capturedOptions?.name, "beta");
});

test("nested resume forwards alias rename and refuses live records actionably", async () => {
  const parent: AgentRecord = {
    id: "parent-resume",
    type: "general-purpose",
    handle: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
  const child: AgentRecord = {
    id: "child-resume",
    type: "implementer",
    handle: "implementer",
    alias: "old-alias",
    description: "child",
    status: "completed",
    result: "continued",
    toolUses: 0,
    startedAt: 2,
    completedAt: 3,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    parentAgentId: parent.id,
  };
  let resumeCalls = 0;
  let capturedOptions: Parameters<NestedAgentManager["resume"]>[3];
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("resume must not spawn"),
    spawnAndWait: () => assert.fail("resume must not spawn and wait"),
    getRecord: (id: string) => (id === parent.id ? parent : id === child.id ? child : undefined),
    listAgents: () => [parent, child],
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    async resume(_id, _prompt, _signal, options) {
      resumeCalls += 1;
      capturedOptions = options;
      child.alias = options?.name ?? child.alias;
      return child;
    },
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
    configCwd: "/tmp/choco-pi-nested-resume-test",
  });
  const schema = JSON.stringify(agentTool.parameters);
  assert.match(schema, /explicitly renames/, "nested name/resume schema states rename semantics");

  // SAFETY: The nested resume path reads no additional host context from this fixture.
  const resumed = await agentTool.execute(
    "resume-call",
    {
      prompt: "continue",
      description: "continue child",
      name: "new-alias",
      subagent_type: "implementer",
      resume: child.id,
    },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(capturedOptions?.name, "new-alias");
  assert.match(
    resumed.content[0]?.type === "text" ? resumed.content[0].text : "",
    /^Agent alias: @new-alias/,
  );

  child.status = "running";
  // SAFETY: The live-record pre-check returns before reading host context.
  const refused = await agentTool.execute(
    "refused-call",
    {
      prompt: "continue again",
      description: "continue child",
      subagent_type: "implementer",
      resume: child.id,
    },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(resumeCalls, 1, "live pre-check never reaches the manager resume boundary");
  assert.match(
    refused.content[0]?.type === "text" ? refused.content[0].text : "",
    /continue other work.*terminal completion notification.*exactly once with get_subagent_result.*steer_subagent/is,
  );
});
