import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { installRunnerTurnLimit, resumeAgent, setGraceTurns } from "../src/agent-runner.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

async function turnFixture(wrapUp: boolean) {
  const fixture = await createSdkFixture();
  const listeners = new Set<AgentSessionEventListener>();
  const steers: { turn: number; message: string }[] = [];
  let turns = 0;
  let aborted = false;
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  Object.defineProperties(fixture.session, {
    subscribe: {
      value: (listener: AgentSessionEventListener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    steer: {
      value: async (text: string) => {
        steers.push({ turn: turns, message: text });
        return "queued";
      },
    },
    abort: {
      value: async () => {
        aborted = true;
      },
    },
    prompt: {
      value: async () => {
        turns = 0;
        aborted = false;
        steers.length = 0;
        while (turns < 8 && !aborted) {
          turns++;
          for (const listener of listeners)
            listener({ type: "turn_end", message, toolResults: [] });
          if (wrapUp && steers.length > 0) break;
        }
        fixture.session.messages.push(message);
      },
    },
  });
  return { ...fixture, listeners, steers, turns: () => turns };
}

for (const wrapUp of [true, false]) {
  for (const isBackground of [false, true]) {
    test(`resume mirrors fresh turn limit (wrapUp=${wrapUp}, background=${isBackground})`, async () => {
      setGraceTurns(2);
      const fixture = await turnFixture(wrapUp);
      const runner: AgentManagerRunner = {
        async runAgent(_ctx, _type, prompt, options) {
          const limit = installRunnerTurnLimit(fixture.session, { maxTurns: options.maxTurns });
          try {
            await fixture.session.prompt(prompt);
            return {
              session: fixture.session,
              responseText: "partial answer",
              aborted: limit.getAborted(),
              steered: limit.getSteered(),
            };
          } finally {
            limit.unsubscribe();
          }
        },
        resumeAgent,
      };
      const manager = new AgentManager(undefined, 4, undefined, undefined, runner);
      try {
        const { id, record } = await manager.spawnAndWait(
          fixture.pi,
          fixture.ctx,
          "general-purpose",
          "fresh",
          {
            description: "turn limit",
            maxTurns: 2,
          },
        );
        const freshStatus = record.status;
        const freshTurns = fixture.turns();
        const freshSteers = [...fixture.steers];
        assert.equal(freshStatus, wrapUp ? "steered" : "aborted");
        assert.equal(freshTurns, wrapUp ? 2 : 4);
        const resumed = await manager.resume(id, "resume", undefined, {
          maxTurns: 2,
          isBackground,
        });
        assert.ok(resumed);
        await resumed.promise;
        assert.equal(resumed.status, freshStatus);
        assert.equal(resumed.error, undefined);
        assert.equal(fixture.turns(), freshTurns);
        assert.deepEqual(fixture.steers, freshSteers);
        assert.equal(fixture.listeners.size, 0, "settlement removes run subscriptions");

        const unlimited = await manager.resume(id, "unlimited", undefined, { isBackground });
        assert.ok(unlimited);
        await unlimited.promise;
        assert.equal(unlimited.status, "completed");
        assert.equal(fixture.turns(), 8);
        assert.deepEqual(fixture.steers, []);
        assert.equal(fixture.listeners.size, 0);
      } finally {
        manager.dispose();
      }
    });
  }
}

test("nested resume forwards max_turns without changing omitted values", async () => {
  const fixture = await createSdkFixture();
  const child: AgentRecord = {
    id: "child",
    type: "general-purpose",
    description: "child",
    status: "completed",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    parentAgentId: "parent",
    session: fixture.session,
  };
  const forwarded: (number | undefined)[] = [];
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("must resume"),
    spawnAndWait: async () => assert.fail("must resume"),
    getRecord: (id) => (id === child.id ? child : undefined),
    listAgents: () => [child],
    getActiveCount: () => 0,
    getScheduledActiveCount: () => 0,
    getMaxConcurrent: () => 4,
    abort: () => false,
    async resume(_id, _prompt, _signal, options) {
      forwarded.push(options?.maxTurns);
      return child;
    },
  };
  try {
    const [agentTool] = createNestedSubagentTools({
      manager,
      pi: fixture.pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: fixture.ctx.cwd,
    });
    for (const max_turns of [2, undefined]) {
      await agentTool.execute(
        "resume-call",
        {
          prompt: "continue",
          description: "continue",
          subagent_type: "general-purpose",
          resume: child.id,
          max_turns,
        },
        undefined,
        undefined,
        toolContext(fixture.ctx),
      );
    }
    assert.deepEqual(forwarded, [2, undefined]);
  } finally {
    fixture.session.dispose();
  }
});
