import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import subagentsExtension from "../src/index.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";

interface GlobalManagerEntry {
  getRecord(id: string): AgentRecord | undefined;
  waitForAll(): Promise<void>;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: { description: string; isBackground: boolean; isolated: boolean },
  ): string;
}

type RuntimeValue = {} | null | undefined;
type LifecycleResult = RuntimeValue | Promise<RuntimeValue>;
type LifecycleHandler = (...args: RuntimeValue[]) => LifecycleResult;
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type ToolParams = Parameters<ToolDefinition["execute"]>[1];

interface ExtensionHostFixture {
  events: { emit(): undefined; on(): () => undefined };
  on(name: string, handler: LifecycleHandler): Map<string, LifecycleHandler>;
  registerCommand(): undefined;
  registerMessageRenderer(): undefined;
  registerTool(tool: ToolDefinition): Map<string, ToolDefinition>;
  appendEntry(): undefined;
  sendMessage(): undefined;
}

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The fixture implements every ExtensionAPI member these tools exercise.
  return value as ExtensionAPI;
}

function asExtensionContext(value: RuntimeValue): ExtensionContext {
  // SAFETY: The fixture supplies the session-binding reads; child setup is
  // deliberately incomplete, so spawned agents settle with an error.
  return value as ExtensionContext;
}

function managerRegistry(): { [registryKey: symbol]: GlobalManagerEntry | undefined } {
  // SAFETY: This test reads only the package's documented process-global manager slot.
  return globalThis as typeof globalThis & {
    [registryKey: symbol]: GlobalManagerEntry | undefined;
  };
}

function resultText(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function isErrorResult(result: ToolResult): boolean {
  return "isError" in result && result.isError === true;
}

async function withRootTools(
  sessionId: string,
  run: (
    tools: Map<string, ToolDefinition>,
    context: ExtensionContext,
    pi: ExtensionAPI,
  ) => Promise<void>,
): Promise<void> {
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const noop = () => undefined;
  const host: ExtensionHostFixture = {
    events: { emit: noop, on: () => noop },
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: noop,
    sendMessage: noop,
  };
  const pi = asExtensionAPI(host);
  subagentsExtension(pi);
  const context = asExtensionContext({
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
  });
  const start = handlers.get("session_start");
  assert.ok(start);
  await start({}, context);
  try {
    await run(tools, context, pi);
  } finally {
    const shutdown = handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
}

function tool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
  const found = tools.get(name);
  assert.ok(found, `${name} must be registered`);
  return found;
}

async function call(
  tools: Map<string, ToolDefinition>,
  context: ExtensionContext,
  name: string,
  params: ToolParams,
): Promise<ToolResult> {
  return tool(tools, name).execute(name, params, undefined, undefined, toolContext(context));
}

test("root failure results set isError for not-found and invalid input", async () => {
  await withRootTools("tool-error-results", async (tools, context) => {
    const missing = "no-such-id";
    const cases: [string, ToolParams][] = [
      ["workflow_run", { name: "bad", steps: [] }],
      ["workflow_update", { workflow_id: missing }],
      ["workflow_update", { workflow_id: missing, finish: true }],
      ["get_workflow_result", { workflow_id: missing }],
      ["workflow_cancel", { workflow_id: missing }],
      ["set_subagent_fast_mode", { agent_id: missing, enabled: true }],
      ["set_subagent_daybreak", { agent_id: missing, enabled: true }],
      ["get_subagent_result", { agent_id: missing }],
      ["steer_subagent", { agent_id: missing, message: "hi" }],
      ["stop_subagent", { agent_id: missing }],
    ];
    for (const [name, params] of cases) {
      const result = await call(tools, context, name, params);
      assert.equal(isErrorResult(result), true, `${name} ${JSON.stringify(params)}`);
    }
    const update = await call(tools, context, "workflow_update", { workflow_id: missing });
    assert.match(resultText(update), /requires `steps` or `finish: true`/);
  });
});

test("root steer_subagent accepts a queued agent and rejects a settled one", async () => {
  await withRootTools("tool-error-steer", async (tools, context, pi) => {
    const manager = managerRegistry()[Symbol.for("pi-subagents:manager")];
    assert.ok(manager);
    await call(tools, context, "subagent_limits", { maxConcurrent: 1 });
    const spawn = (label: string) =>
      manager.spawn(pi, context, "implementer", label, {
        description: label,
        isBackground: true,
        isolated: true,
      });
    spawn("occupies the only slot");
    const queuedId = spawn("waits in the queue");
    const queued = manager.getRecord(queuedId);
    assert.equal(queued?.status, "queued");

    const steered = await call(tools, context, "steer_subagent", {
      agent_id: queuedId,
      message: "use the other approach",
    });
    assert.equal(isErrorResult(steered), false, resultText(steered));
    assert.match(resultText(steered), /queued for agent/);
    assert.equal(queued?.pendingSteers?.length, 1);

    await manager.waitForAll();
    assert.notEqual(queued?.status, "running");
    assert.notEqual(queued?.status, "queued");
    const settled = await call(tools, context, "steer_subagent", {
      agent_id: queuedId,
      message: "too late",
    });
    assert.equal(isErrorResult(settled), true);
    assert.match(resultText(settled), /not running or queued/);
  });
});

test("root Agent schema rejects an unknown thinking level", async () => {
  await withRootTools("tool-error-thinking", async (tools) => {
    const schema = tool(tools, "Agent").parameters;
    const base = { prompt: "p", description: "d", subagent_type: "implementer" };
    assert.equal(Value.Check(schema, { ...base, thinking: "high" }), true);
    assert.equal(Value.Check(schema, { ...base, thinking: "extreme" }), false);
  });
});

function nestedRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

function nestedTools(records: AgentRecord[]) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("must not spawn"),
    spawnAndWait: () => assert.fail("must not spawn and wait"),
    getRecord: (id) => byId.get(id),
    listAgents: () => records,
    getActiveCount: () => 0,
    getScheduledActiveCount: () => 0,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  return createNestedSubagentTools({
    manager,
    pi: asExtensionAPI({}),
    parentAgentId: "parent",
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: process.cwd(),
  });
}

test("nested steer_subagent queues for a queued child and rejects a settled one", async () => {
  const parent = nestedRecord("parent", { handle: "parent" });
  const queued = nestedRecord("queued-child", { parentAgentId: "parent", status: "queued" });
  const done = nestedRecord("done-child", { parentAgentId: "parent", status: "completed" });
  const steer = nestedTools([parent, queued, done]).find((t) => t.name === "steer_subagent");
  assert.ok(steer);
  const context = toolContext(asExtensionContext({ cwd: process.cwd() }));

  const accepted = await steer.execute(
    "steer-queued",
    { agent_id: queued.id, message: "hi" },
    undefined,
    undefined,
    context,
  );
  assert.equal(accepted.isError, false, resultText(accepted));
  assert.match(resultText(accepted), /queued for nested agent/);
  assert.equal(queued.pendingSteers?.length, 1);

  const refused = await steer.execute(
    "steer-done",
    { agent_id: done.id, message: "hi" },
    undefined,
    undefined,
    context,
  );
  assert.equal(refused.isError, true);
});

test("nested Agent schema rejects an unknown thinking level", () => {
  const agent = nestedTools([nestedRecord("parent")]).find((t) => t.name === "Agent");
  assert.ok(agent);
  const base = { prompt: "p", description: "d", subagent_type: "general" };
  assert.equal(Value.Check(agent.parameters, { ...base, thinking: "max" }), true);
  assert.equal(Value.Check(agent.parameters, { ...base, thinking: "extreme" }), false);
});
