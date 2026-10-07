import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentSession,
  defineTool,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type AgentMessageRecord, deliverAgentMessage } from "../src/agent-message.ts";
import { createMentionCloneAgentTool } from "../src/mention-clone.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

/** An input handler that consumes every message, as Pi 1.0.4 permits. */
const consumeAllInput: ExtensionFactory = (pi) => {
  pi.on("input", () => ({ action: "handled" }));
};

type ResultContent = { type: "text"; text: string } | { type: "image" };

function resultText(result: { content: ResultContent[] }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

interface EmittedMessage {
  channel: string;
  data: unknown;
}

async function deliverToRealSession(factories: readonly ExtensionFactory[]) {
  const fixture = await createSdkFixture(undefined, factories);
  const recipient: AgentMessageRecord = {
    id: "recipient-id",
    handle: "recipient",
    status: "running",
    session: fixture.session,
  };
  const emitted: EmittedMessage[] = [];
  try {
    const result = await deliverAgentMessage(
      {
        manager: {
          getRecord: (id) => (id === recipient.id ? recipient : undefined),
          listAgents: () => [recipient],
        },
        pi: {
          events: {
            emit: (channel, data) => {
              emitted.push({ channel, data });
            },
            on: () => () => undefined,
          },
          sendMessage: () => assert.fail("agent-to-agent delivery must not use the root route"),
        },
      },
      { to: "recipient", message: "status?" },
    );
    return {
      result,
      emitted,
      steering: [...fixture.session.getSteeringMessages()],
    };
  } finally {
    fixture.session.dispose();
  }
}

test("agent_message reports a handler-consumed message as handled, not steered", async () => {
  const { result, steering } = await deliverToRealSession([consumeAllInput]);
  const text = resultText(result);
  assert.equal(result.isError, false);
  assert.match(text, /handled by an input handler/);
  assert.match(text, /was not queued/);
  assert.doesNotMatch(text, /steered/i);
  assert.deepEqual(steering, [], "a handled message must not enter the steering queue");
});

test("agent_message keeps the steered wording when Pi queues the message", async () => {
  const { result, emitted, steering } = await deliverToRealSession([]);
  assert.equal(result.isError, false);
  assert.equal(
    resultText(result),
    "Message steered to recipient; it arrives at the recipient's next safe boundary.",
  );
  assert.equal(steering.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.channel, "subagents:message");
});

function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
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

async function steerNestedRealSession(factories: readonly ExtensionFactory[]) {
  const fixture = await createSdkFixture(undefined, factories);
  const parent = record("nested-parent", { handle: "nested-parent" });
  const child = record("nested-child", {
    handle: "nested-child",
    parentAgentId: parent.id,
    session: fixture.session,
  });
  const records = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("steering must not spawn"),
    spawnAndWait: () => assert.fail("steering must not spawn and wait"),
    getRecord: (id) => records.get(id),
    listAgents: () => [parent, child],
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  try {
    const steerTool = createNestedSubagentTools({
      manager,
      pi: fixture.pi,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: process.cwd(),
    }).find((tool) => tool.name === "steer_subagent");
    assert.ok(steerTool, "the nested tool set must include steer_subagent");
    const result = await steerTool.execute(
      "steer-call",
      { agent_id: child.id, message: "status?" },
      undefined,
      undefined,
      fixture.session.extensionRunner.createToolContext("steer-call", undefined),
    );
    return { result, steering: [...fixture.session.getSteeringMessages()] };
  } finally {
    fixture.session.dispose();
  }
}

test("steer_subagent reports a handler-consumed message as handled, not sent", async () => {
  const { result, steering } = await steerNestedRealSession([consumeAllInput]);
  const text = resultText(result);
  assert.equal(result.isError, false);
  assert.match(text, /handled by an input handler/);
  assert.doesNotMatch(text, /sent to nested agent/);
  assert.deepEqual(steering, []);
});

test("steer_subagent keeps the sent wording when Pi queues the message", async () => {
  const { result, steering } = await steerNestedRealSession([]);
  assert.equal(result.isError, false);
  assert.equal(resultText(result), "Steering message sent to nested agent nested-child.");
  assert.equal(steering.length, 1);
});

test("the mention clone runs the Agent tool on the main session with the clone call's tools", async () => {
  const main = await createSdkFixture();
  const clone = await createSdkFixture();
  let received: ExtensionToolContext | undefined;
  const agentTool = defineTool({
    name: "Agent",
    label: "Agent",
    description: "probe",
    parameters: Type.Object({ run_in_background: Type.Optional(Type.Boolean()) }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      received = ctx;
      assert.equal(params.run_in_background, true);
      return { content: [{ type: "text", text: "started" }], details: undefined };
    },
  });
  const mainSession: AgentSession = main.session;
  const mainCtx: ExtensionContext = main.ctx;
  try {
    const cloneTool = createMentionCloneAgentTool(agentTool, mainCtx, { spawned: false });
    const cloneToolContext = clone.session.extensionRunner.createToolContext(
      "clone-call",
      undefined,
    );
    await cloneTool.execute("clone-call", {}, undefined, undefined, cloneToolContext);
    assert.ok(received, "the registered Agent tool must run");
    const ctx = received;
    assert.equal(
      ctx.sessionManager.getSessionId(),
      mainSession.sessionManager.getSessionId(),
      "the spawn must be attributed to the main session, not the throwaway clone",
    );
    assert.notEqual(ctx.sessionManager.getSessionId(), clone.session.sessionManager.getSessionId());
    assert.equal(ctx.cwd, mainCtx.cwd);
    assert.equal(ctx.getSystemPrompt(), mainCtx.getSystemPrompt());
    assert.deepEqual(
      ctx.tools.map((tool) => tool.name),
      cloneToolContext.tools.map((tool) => tool.name),
    );
    const nested = await ctx.executeTool("no-such-tool", {});
    assert.equal(nested.isError, true, "executeTool must reach the clone call's real runner");

    // A background spawn keeps the context after the clone is discarded. The
    // main-session members must outlive the clone; the clone's own nested-tool
    // surface must turn stale with it rather than reach a disposed session.
    clone.session.dispose();
    assert.equal(ctx.sessionManager.getSessionId(), mainSession.sessionManager.getSessionId());
    assert.equal(ctx.cwd, mainCtx.cwd);
    assert.throws(() => ctx.tools, /stale/);
  } finally {
    clone.session.dispose();
    main.session.dispose();
  }
});
