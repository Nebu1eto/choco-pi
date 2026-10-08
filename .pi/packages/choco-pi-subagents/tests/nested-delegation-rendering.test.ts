import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import subagentsExtension, { buildRecordDetails, delegationRenderers } from "../src/index.ts";
import { AgentManager } from "../src/agent-manager.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import { publishTerminalResult, TERMINAL_RESULT_RETRIEVAL_GUIDANCE } from "../src/result-read.ts";
import type { AgentRecord } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

initTheme("dark", false);

function assertActiveCard(
  result: Parameters<typeof delegationRenderers.renderResult>[0],
  ctx: ExtensionContext,
) {
  assert.equal(result.content[0]?.type, "text");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text);
  for (const expanded of [false, true]) {
    const lines = delegationRenderers
      .renderResult(result, { expanded, isPartial: false }, ctx.ui.theme, renderContext)
      .render(240)
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .join("\n");
    assert.ok(lines.includes(expanded ? text : text.split("\n")[0]), lines);
    assert.match(lines, /2 tool uses/);
    assert.doesNotMatch(lines, /thinking…/);
  }
  const partial = delegationRenderers
    .renderResult(result, { expanded: false, isPartial: true }, ctx.ui.theme, renderContext)
    .render(240)
    .map(stripVTControlCharacters)
    .join("\n");
  assert.match(partial, /thinking…/);
  assert.match(partial, /⠋/);
}

function recordFixture(id: string, parentAgentId?: string): AgentRecord {
  return {
    id,
    parentAgentId,
    type: "implementer",
    alias: "implementer-cards",
    handle: "implementer",
    description: "Render nested cards",
    status: "completed",
    result: "Card output.",
    toolUses: 2,
    startedAt: 1000,
    completedAt: 3500,
    lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function managerFixture(parent: AgentRecord, child: AgentRecord): NestedAgentManager {
  return {
    spawn: () => child.id,
    spawnAndWait: async () => ({ id: child.id, record: child }),
    getRecord: (id) => (id === parent.id ? parent : id === child.id ? child : undefined),
    listAgents: () => [parent, child],
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => child,
  };
}

function toolContext(ctx: ExtensionContext): ExtensionToolContext {
  return {
    ...ctx,
    tools: [],
    executeTool: async () => assert.fail("delegation must not execute another tool"),
  };
}

const renderContext = {
  args: { subagent_type: "implementer", description: "Render nested cards" },
  toolCallId: "nested-cards",
  invalidate: () => {},
  lastComponent: undefined,
  state: undefined,
  cwd: process.cwd(),
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
};

for (const background of [false, true]) {
  test(`nested ${background ? "background" : "foreground"} spawn shares root details and card renderers`, async () => {
    const fixture = await createSdkFixture();
    try {
      const parent = recordFixture("parent");
      const child = recordFixture("child", parent.id);
      child.outputFile = "/tmp/nested-cards.output";
      const [agent] = createNestedSubagentTools({
        manager: managerFixture(parent, child),
        pi: fixture.pi,
        parentAgentId: parent.id,
        depth: 1,
        maxSubagentDepth: 3,
        allowedSubagents: "all",
        configCwd: fixture.ctx.cwd,
      });
      const result = await agent.execute(
        "spawn",
        {
          prompt: "Render cards",
          description: child.description,
          subagent_type: child.type,
          run_in_background: background,
        },
        undefined,
        undefined,
        toolContext(fixture.ctx),
      );
      assert.deepEqual(result.details, buildRecordDetails(child, background));
      for (const field of ["alias", "handle", "resumed"]) {
        assert.equal(Object.hasOwn(result.details, field), false, `${field} is not card metadata`);
      }
      assert.equal(result.details.outputFile, child.outputFile);
      assert.deepEqual(result.content, [
        {
          type: "text",
          text: background
            ? `Nested agent started in background. Agent ID: child\n${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Use steer_subagent to send it a message mid-run.`
            : "Card output.",
        },
      ]);
      assert.equal(agent.renderCall, delegationRenderers.renderCall);
      assert.equal(agent.renderResult, delegationRenderers.renderResult);
      const options = { expanded: false, isPartial: false };
      const actual = agent.renderResult(result, options, fixture.ctx.ui.theme, renderContext);
      assert.match(
        actual.render(100).map(stripVTControlCharacters).join("\n"),
        background ? /Running in background \(ID: child\)/ : /Done/,
      );
    } finally {
      fixture.session.dispose();
    }
  });
}

test("root active result retrieval and steering render settled text", async (t) => {
  const child = recordFixture("root-child");
  child.status = "running";
  child.resultGeneration = 1;
  t.mock.method(AgentManager.prototype, "getRecord", (id: string) =>
    id === child.id ? child : undefined,
  );
  t.mock.method(AgentManager.prototype, "steer", () => true);
  const fixture = await createSdkFixture(undefined, [subagentsExtension]);
  try {
    for (const name of ["get_subagent_result", "steer_subagent"]) {
      const tool = fixture.session.extensionRunner.getToolDefinition(name);
      assert.ok(tool);
      const result = await tool.execute(
        name,
        { agent_id: child.id, message: "Continue" },
        undefined,
        undefined,
        toolContext(fixture.ctx),
      );
      assertActiveCard(result, fixture.ctx);
    }
  } finally {
    fixture.session.dispose();
  }
});

test("nested resume, result retrieval, and steering preserve text and attach shared details", async () => {
  const fixture = await createSdkFixture();
  try {
    const parent = recordFixture("parent");
    const child = recordFixture("child", parent.id);
    const [agent, getResult, steer] = createNestedSubagentTools({
      manager: managerFixture(parent, child),
      pi: fixture.pi,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: fixture.ctx.cwd,
    });
    const resumed = await agent.execute(
      "resume",
      {
        prompt: "Continue",
        description: child.description,
        subagent_type: child.type,
        resume: child.id,
      },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assert.deepEqual(resumed.details, buildRecordDetails(child, false, true));
    assert.deepEqual(resumed.content, [
      { type: "text", text: "Agent alias: @implementer-cards\n\nCard output." },
    ]);
    publishTerminalResult(child);
    const retrieved = await getResult.execute(
      "get",
      { agent_id: child.id },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assert.deepEqual(retrieved.details, buildRecordDetails(child));
    assert.deepEqual(retrieved.content, [{ type: "text", text: "Card output." }]);
    child.status = "running";
    child.resultGeneration = 2;
    const active = await getResult.execute(
      "active-get",
      { agent_id: child.id },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assertActiveCard(active, fixture.ctx);
    const steered = await steer.execute(
      "steer",
      { agent_id: child.id, message: "Continue" },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assertActiveCard(steered, fixture.ctx);
    assert.deepEqual(steered.details, buildRecordDetails(child));
    assert.deepEqual(steered.content, [
      { type: "text", text: "Steering message queued for nested agent child." },
    ]);
    for (const tool of [getResult, steer]) {
      assert.equal(tool.renderCall, delegationRenderers.renderCall);
      assert.equal(tool.renderResult, delegationRenderers.renderResult);
    }
  } finally {
    fixture.session.dispose();
  }
});
