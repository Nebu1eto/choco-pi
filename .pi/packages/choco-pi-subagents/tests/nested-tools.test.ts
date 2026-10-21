import assert from "node:assert/strict";
import test from "node:test";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import { claimSubagentResultRead, publishTerminalResult } from "../src/result-read.ts";
import type { AgentRecord } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import { createUsageLimitEnv } from "./usage-limit-fixture.ts";

test("nested Agent exposes name and forwards it to the manager alias option", async (t) => {
  const env = await createUsageLimitEnv(["anthropic"]);
  t.after(() => env.dispose());
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
  let spawnCalls = 0;
  const manager: NestedAgentManager = {
    spawn(_pi, _ctx, _type, _prompt, options) {
      spawnCalls += 1;
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
  const [agentTool] = await createNestedSubagentTools({
    manager,
    pi: env.pi,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: "/tmp/choco-pi-nested-name-test",
  });
  assert.match(JSON.stringify(agentTool.parameters), /"name":/, "nested Agent schema accepts name");

  // A real host context with no parent model, so only an explicit model can satisfy the gate.
  const hostCtx = toolContext(
    env.context({ cwd: "/tmp/choco-pi-nested-name-test", model: undefined }),
  );

  // requireExplicitModel (default on): no model/thinking → refusal, no spawn.
  const refused = await agentTool.execute(
    "call-refused",
    {
      prompt: "do work",
      description: "child work",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    hostCtx,
  );
  assert.match(
    refused.content[0]?.type === "text" ? refused.content[0].text : "",
    /^Spawn refused: pass model and thinking\. Role "general-purpose" \(/,
  );
  assert.equal(spawnCalls, 0, "a refused spawn never reaches the manager");

  const result = await agentTool.execute(
    "call",
    {
      prompt: "do work",
      description: "child work",
      name: "beta",
      subagent_type: "general-purpose",
      model: "anthropic/claude-opus-4-5",
      thinking: "low",
      run_in_background: true,
    },
    undefined,
    undefined,
    hostCtx,
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /^Nested agent started in background\. Agent ID: child\n/);
  assert.match(
    text,
    /\nModel: anthropic\/claude-opus-4-5 \(source: caller\) · thinking: low · definition: [^\n]+\n/,
  );
  assert.match(text, /retrieve the result exactly once with get_subagent_result/);
  assert.equal(capturedOptions?.name, "beta");
  assert.equal(capturedOptions?.modelProvenance?.source, "caller");
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
    getRecord(id: string) {
      if (id === parent.id) return parent;
      if (id === child.id) return child;
      return undefined;
    },
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
  const [agentTool] = await createNestedSubagentTools({
    manager,
    // SAFETY: This path only forwards the ExtensionAPI value to the manager fixture above.
    // SAFETY: Result reads never dereference the ExtensionAPI fixture.
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

test("nested result reads enforce one shared run generation", async () => {
  const parent: AgentRecord = {
    id: "parent-result",
    type: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    resultGeneration: 1,
  };
  const child: AgentRecord = {
    id: "child-result",
    type: "implementer",
    description: "nested result",
    status: "running",
    toolUses: 0,
    startedAt: 2,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    resultGeneration: 1,
    parentAgentId: parent.id,
  };
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("result read must not spawn"),
    spawnAndWait: () => assert.fail("result read must not spawn and wait"),
    getRecord(id: string) {
      if (id === parent.id) return parent;
      if (id === child.id) return child;
      return undefined;
    },
    listAgents: () => [parent, child],
    getActiveCount: () => 2,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  // SAFETY: Result reads never dereference the ExtensionAPI fixture.
  const tools = await createNestedSubagentTools({
    manager,
    pi: {} as never,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: "/tmp/choco-pi-nested-result-test",
  });
  const resultTool = tools[1];
  assert.ok(resultTool);
  assert.equal(resultTool.name, "get_subagent_result");
  // SAFETY: The nested result execute path does not inspect its ExtensionContext argument.
  const hostContext = {} as never;

  const first = await resultTool.execute(
    "first",
    { agent_id: child.id },
    undefined,
    undefined,
    hostContext,
  );
  assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /is running/);

  const repeated = await resultTool.execute(
    "repeated",
    { agent_id: child.id },
    undefined,
    undefined,
    hostContext,
  );
  const repeatedText = repeated.content[0]?.type === "text" ? repeated.content[0].text : "";
  assert.equal(JSON.parse(repeatedText).reason, "active_generation_already_read");

  child.status = "completed";
  child.result = "nested terminal output";
  child.completedAt = 3;
  publishTerminalResult(child);
  const terminal = await resultTool.execute(
    "terminal",
    { agent_id: child.id },
    undefined,
    undefined,
    hostContext,
  );
  assert.equal(
    terminal.content[0]?.type === "text" ? terminal.content[0].text : "",
    "nested terminal output",
  );
  assert.equal(child.consumedResultGeneration, 1);

  const consumed = await resultTool.execute(
    "consumed",
    { agent_id: child.id },
    undefined,
    undefined,
    hostContext,
  );
  const consumedText = consumed.content[0]?.type === "text" ? consumed.content[0].text : "";
  assert.equal(JSON.parse(consumedText).reason, "terminal_generation_already_consumed");
});

test("nested result wait cancellation is benign and releases its read claim", async () => {
  const parent: AgentRecord = {
    id: "parent-cancelled-result",
    type: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
  const child: AgentRecord = {
    id: "child-cancelled-result",
    type: "implementer",
    description: "nested result",
    status: "running",
    promise: new Promise<string>(() => undefined),
    toolUses: 0,
    startedAt: 2,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    parentAgentId: parent.id,
  };
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("result read must not spawn"),
    spawnAndWait: () => assert.fail("result read must not spawn and wait"),
    getRecord: (id) => (id === parent.id ? parent : id === child.id ? child : undefined),
    listAgents: () => [parent, child],
    getActiveCount: () => 2,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  // SAFETY: Result reads never dereference the ExtensionAPI fixture.
  const resultTool = (
    await createNestedSubagentTools({
      manager,
      pi: {} as never,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: "/tmp/choco-pi-nested-cancelled-result-test",
    })
  )[1];
  assert.ok(resultTool);

  const controller = new AbortController();
  // SAFETY: The nested result execute path does not inspect its ExtensionContext argument.
  const wait = resultTool.execute(
    "cancelled",
    { agent_id: child.id, wait: true },
    controller.signal,
    undefined,
    {} as never,
  );
  controller.abort(new Error("user cancelled tool call"));
  const cancelled = await wait;
  assert.equal("isError" in cancelled && cancelled.isError === true, false);
  assert.match(cancelled.content[0]?.type === "text" ? cancelled.content[0].text : "", /cancelled/);
  assert.equal(child.status, "running");
  assert.equal(claimSubagentResultRead(child).kind, "active");
});

test("nested result wait still propagates non-abort rejections", async () => {
  const failure = new Error("child wait failed");
  const parent = {
    id: "parent-rejected-result",
    type: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } satisfies AgentRecord;
  const child = {
    id: "child-rejected-result",
    type: "implementer",
    description: "nested result",
    status: "running",
    promise: Promise.reject(failure),
    toolUses: 0,
    startedAt: 2,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    parentAgentId: parent.id,
  } satisfies AgentRecord;
  // Tool construction awaits a registry load before the read below observes
  // this rejection; mark it handled so the gap is not an unhandled rejection.
  child.promise.catch(() => undefined);
  const manager = {
    spawn: () => assert.fail("result read must not spawn"),
    spawnAndWait: () => assert.fail("result read must not spawn and wait"),
    getRecord: (id: string) => (id === parent.id ? parent : id === child.id ? child : undefined),
    listAgents: () => [parent, child],
    getActiveCount: () => 2,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  } satisfies NestedAgentManager;
  // SAFETY: Result reads never dereference the ExtensionAPI fixture.
  const resultTool = (
    await createNestedSubagentTools({
      manager,
      pi: {} as never,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: "/tmp/choco-pi-nested-rejected-result-test",
    })
  )[1];
  assert.ok(resultTool);

  // SAFETY: The nested result execute path does not inspect its ExtensionContext argument.
  await assert.rejects(
    resultTool.execute(
      "rejected",
      { agent_id: child.id, wait: true },
      undefined,
      undefined,
      {} as never,
    ),
    failure,
  );
  assert.equal(claimSubagentResultRead(child).kind, "active");
});

test("nested get/stop/resume resolve an owned child by alias and list children when unknown", async (t) => {
  const fixture = await createSdkFixture();
  t.after(() => fixture.session.dispose());
  const hostCtx = toolContext(fixture.ctx);
  const base = {
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
  const parent: AgentRecord = {
    ...base,
    id: "parent-alias",
    type: "general-purpose",
    description: "parent",
    status: "running",
    startedAt: 1,
  };
  const scout: AgentRecord = {
    ...base,
    id: "child-scout",
    type: "explore",
    handle: "explore-3",
    alias: "scout",
    description: "scout",
    status: "running",
    startedAt: 2,
    parentAgentId: parent.id,
  };
  const foreign: AgentRecord = {
    ...base,
    id: "child-foreign",
    type: "explore",
    alias: "foreign",
    description: "other branch",
    status: "running",
    startedAt: 3,
    parentAgentId: "someone-else",
  };
  const records = [parent, scout, foreign];
  const aborted: string[] = [];
  const resumedIds: string[] = [];
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("no spawn"),
    spawnAndWait: () => assert.fail("no spawn"),
    getRecord: (id: string) => records.find((record) => record.id === id),
    listAgents: () => records,
    getActiveCount: () => 2,
    getScheduledActiveCount: () => 2,
    getMaxConcurrent: () => 4,
    abort: (id: string) => {
      aborted.push(id);
      return true;
    },
    async resume(id) {
      resumedIds.push(id);
      return scout;
    },
  };
  const [agentTool, resultTool, , stopTool] = await createNestedSubagentTools({
    manager,
    pi: fixture.pi,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: "/tmp/choco-pi-nested-alias-test",
  });
  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content[0]?.text ?? "";

  const stopped = await stopTool.execute(
    "stop",
    { agent_id: "@scout" },
    undefined,
    undefined,
    hostCtx,
  );
  assert.deepEqual(aborted, ["child-scout"]);
  assert.match(textOf(stopped), /Nested agent child-scout stopped/);

  const unknown = await resultTool.execute(
    "get",
    { agent_id: "foreign" },
    undefined,
    undefined,
    hostCtx,
  );
  assert.equal(unknown.isError, true);
  assert.equal(
    textOf(unknown),
    'Nested agent not found or not owned by this parent: "foreign" — unknown id or alias. ' +
      "This parent's nested agents: @scout (child-scout, running).",
  );

  scout.status = "completed";
  scout.result = "done";
  await agentTool.execute(
    "resume",
    { prompt: "more", description: "more", subagent_type: "explore", resume: "Scout" },
    undefined,
    undefined,
    hostCtx,
  );
  assert.deepEqual(resumedIds, ["child-scout"], "alias resolves to the owned child's id");
});
