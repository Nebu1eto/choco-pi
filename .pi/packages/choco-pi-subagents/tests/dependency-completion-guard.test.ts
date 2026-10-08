import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { resumeAgent } from "../src/agent-runner.ts";
import { buildRecordDetails } from "../src/delegation-render.ts";
import subagentsExtension from "../src/index.ts";
import { createNestedSubagentTools } from "../src/nested-tools.ts";
import type { AgentRecord } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const answer: AssistantMessage = {
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

type Scenario = "persist" | "settle" | "none" | "cancel" | "stale";

async function harness(scenario: Scenario, factories: Parameters<typeof createSdkFixture>[1] = []) {
  let currentScenario = scenario;
  const sdk = await createSdkFixture(undefined, factories);
  const child = factories.length > 0 ? await createSdkFixture() : sdk;
  const listeners = new Set<AgentSessionEventListener>();
  const steers: string[] = [];
  let manager: AgentManager;
  let ownerId = "";
  let dependent: AgentRecord | undefined;
  let dependentStatus: "running" | "queued" | "waiting_for_reset" = "running";
  let injectDependent = true;
  const releases: (() => void)[] = [];
  const fire = (message = answer) => {
    for (const listener of listeners) listener({ type: "turn_end", message, toolResults: [] });
  };
  Object.defineProperties(child.session, {
    subscribe: {
      value: (listener: AgentSessionEventListener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    steer: {
      value: async (message: string) => {
        steers.push(message);
      },
    },
    clearQueue: { value: () => undefined },
    abort: { value: async () => undefined },
    prompt: {
      value: async () => {
        steers.length = 0;
        if (currentScenario !== "none" && injectDependent) {
          const id = manager.spawn(sdk.pi, sdk.ctx, "general-purpose", "dependent", {
            description: "dependent",
            isBackground: true,
            parentAgentId: ownerId,
          });
          dependent = manager.getRecord(id);
          assert.ok(dependent);
          dependent.status = dependentStatus;
        }
        // Tool-bearing turns cannot be completion attempts.
        fire({
          ...answer,
          content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        });
        assert.equal(steers.length, 0);
        if (currentScenario === "stale") {
          const owner = manager.getRecord(ownerId);
          assert.ok(owner);
          owner.resultGeneration = (owner.resultGeneration ?? 1) + 1;
        }
        fire();
        if (steers.length > 0) {
          if (currentScenario === "settle") {
            assert.ok(dependent);
            for (const release of releases) release();
            await dependent.promise;
            assert.equal(dependent.status, "completed");
          }
          if (currentScenario === "cancel") manager.abort(ownerId);
          fire();
          fire();
        }
        child.session.messages.push(answer);
      },
    },
  });
  const runner: AgentManagerRunner = {
    async runAgent(_ctx, _type, prompt, options) {
      if (prompt === "dependent") {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return {
          responseText: "dependent output",
          session: child.session,
          aborted: false,
          steered: false,
        };
      }
      ownerId = options.agentId ?? assert.fail("missing owner id");
      options.onSessionCreated?.(child.session);
      const result = await resumeAgent(child.session, prompt, options);
      return {
        responseText: result.text,
        session: child.session,
        aborted: result.aborted ?? false,
        steered: result.steered ?? false,
        failure: result.failure,
      };
    },
    resumeAgent,
  };
  manager = new AgentManager(undefined, 4, undefined, undefined, runner);
  return {
    ...sdk,
    runner,
    steers,
    fire,
    manager: () => manager,
    useManager: (value: AgentManager) => {
      manager.dispose();
      manager = value;
    },
    dependent: () => dependent,
    setDependentStatus: (value: typeof dependentStatus) => {
      dependentStatus = value;
    },
    setOwner: (id: string) => {
      ownerId = id;
    },
    setScenario: (value: Scenario) => {
      currentScenario = value;
    },
    reset: () => {
      injectDependent = true;
    },
    withoutDependent: () => {
      injectDependent = false;
    },
    async cleanup() {
      const records = manager.listAgents();
      for (const record of records) manager.abort(record.id);
      for (const release of releases) release();
      await Promise.all(records.map((record) => record.promise));
      manager.dispose();
      if (child !== sdk) child.session.dispose();
      sdk.session.dispose();
    },
  };
}

for (const scenario of ["persist", "settle", "none", "cancel", "stale"] as const) {
  test(`spawn completion guard: ${scenario}`, async () => {
    const fixture = await harness(scenario);
    try {
      const { record } = await fixture
        .manager()
        .spawnAndWait(fixture.pi, fixture.ctx, "general-purpose", "owner", {
          description: "owner",
        });
      assert.equal(fixture.steers.length, scenario === "none" || scenario === "stale" ? 0 : 1);
      if (scenario === "stale") {
        assert.equal(record.pendingDependents, undefined);
        assert.equal(record.terminalResultGeneration, undefined);
        return;
      }
      assert.equal(
        record.status,
        scenario === "persist" ? "error" : scenario === "cancel" ? "stopped" : "completed",
      );
      if (scenario === "persist") {
        const child = fixture.dependent();
        assert.ok(child);
        assert.deepEqual(record.pendingDependents, [
          { id: child.id, handle: child.handle, status: "running", generation: 1 },
        ]);
        assert.deepEqual(buildRecordDetails(record).pendingDependents, record.pendingDependents);
        assert.equal(record.result, "partial answer");
        assert.match(
          fixture.steers[0],
          /Await their result with get_subagent_result \(or stop them\)/,
        );
      } else assert.equal(record.pendingDependents, undefined);
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const isBackground of [false, true]) {
  for (const status of ["running", "queued", "waiting_for_reset"] as const) {
    test(`resume completion guard: background=${isBackground}, dependent=${status}`, async () => {
      const fixture = await harness("persist");
      try {
        fixture.withoutDependent();
        const { id, record } = await fixture
          .manager()
          .spawnAndWait(fixture.pi, fixture.ctx, "general-purpose", "owner", {
            description: "owner",
          });
        assert.equal(record.status, "completed");
        fixture.setOwner(id);
        fixture.reset();
        fixture.setDependentStatus(status);
        const resumed = await fixture.manager().resume(id, "resume", undefined, { isBackground });
        assert.ok(resumed);
        await resumed.promise;
        assert.equal(resumed.status, "error");
        assert.equal(fixture.steers.length, 1);
        assert.equal(resumed.pendingDependents?.[0]?.status, status);
        assert.equal(resumed.result, "partial answer");
        fixture.withoutDependent();
        const clean = await fixture.manager().resume(id, "clean", undefined, { isBackground });
        assert.ok(clean);
        await clean.promise;
        assert.equal(clean.status, "completed");
        assert.equal(clean.pendingDependents, undefined);
        assert.equal(fixture.steers.length, 0);
      } finally {
        await fixture.cleanup();
      }
    });
  }
}

for (const isBackground of [false, true]) {
  for (const scenario of ["settle", "none", "cancel", "stale"] as const) {
    test(`resume completion guard: background=${isBackground}, ${scenario}`, async () => {
      const fixture = await harness("none");
      try {
        const { id, record } = await fixture
          .manager()
          .spawnAndWait(fixture.pi, fixture.ctx, "general-purpose", "owner", {
            description: "owner",
          });
        assert.equal(record.status, "completed");
        fixture.setScenario(scenario);
        const resumed = await fixture.manager().resume(id, "resume", undefined, { isBackground });
        assert.ok(resumed);
        await resumed.promise;
        assert.equal(fixture.steers.length, scenario === "none" || scenario === "stale" ? 0 : 1);
        assert.equal(resumed.pendingDependents, undefined);
        if (scenario !== "stale") {
          assert.equal(resumed.status, scenario === "cancel" ? "stopped" : "completed");
          assert.equal(resumed.terminalResultGeneration, resumed.resultGeneration);
        } else assert.notEqual(resumed.terminalResultGeneration, resumed.resultGeneration);
      } finally {
        await fixture.cleanup();
      }
    });
  }
}

const PendingPayload = Type.Object({
  pendingDependents: Type.Array(
    Type.Object({
      id: Type.String(),
      handle: Type.Optional(Type.String()),
      status: Type.String(),
      generation: Type.Optional(Type.Number()),
    }),
  ),
});

test("root notification, failed lifecycle and root/nested fetched details retain the snapshot", async (t) => {
  const notices: string[] = [];
  const failed: unknown[] = [];
  const spawn = AgentManager.prototype.spawn;
  const fixture = await harness("persist", [
    (pi) => {
      pi.sendMessage = (message) => {
        assert.ok(Value.Check(Type.String(), message.content));
        notices.push(message.content);
      };
      pi.events.on("subagents:failed", (payload) => {
        failed.push(payload);
      });
      subagentsExtension(pi);
    },
  ]);
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      if (this !== fixture.manager()) {
        fixture.useManager(this);
        assert.equal(Reflect.set(this, "runner", fixture.runner), true);
      }
      return spawn.apply(this, args);
    },
  );
  try {
    const agent = fixture.session.extensionRunner.getToolDefinition("Agent");
    assert.ok(agent);
    const inline = await agent.execute(
      "owner",
      {
        subagent_type: "general-purpose",
        prompt: "owner",
        description: "owner",
        run_in_background: false,
      },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assert.ok(Value.Check(PendingPayload, inline.details), JSON.stringify(inline));
    const actual = fixture.manager();
    const record = actual.listAgents().find((item) => !item.parentAgentId);
    assert.ok(record);
    assert.equal(record.status, "error");
    assert.equal(failed.length, 1);
    assert.ok(Value.Check(PendingPayload, failed[0]));
    assert.deepEqual(failed[0].pendingDependents, record.pendingDependents);
    const fetched = fixture.session.extensionRunner.getToolDefinition("get_subagent_result");
    assert.ok(fetched);
    record.resultConsumed = false;
    record.consumedResultGeneration = undefined;
    const result = await fetched.execute(
      "fetch",
      { agent_id: record.id },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assert.ok(Value.Check(PendingPayload, result.details), JSON.stringify(result));
    assert.deepEqual(result.details.pendingDependents, record.pendingDependents);
    // Nested retrieval exercises the same shared details builder with scoped ownership.
    record.parentAgentId = "outer";
    record.resultConsumed = false;
    record.consumedResultGeneration = undefined;
    const nested = createNestedSubagentTools({
      manager: actual,
      pi: fixture.pi,
      parentAgentId: "outer",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: fixture.ctx.cwd,
    }).find((tool) => tool.name === "get_subagent_result");
    assert.ok(nested);
    const nestedResult = await nested.execute(
      "nested-fetch",
      { agent_id: record.id },
      undefined,
      undefined,
      toolContext(fixture.ctx),
    );
    assert.ok(Value.Check(PendingPayload, nestedResult.details));
    assert.deepEqual(nestedResult.details.pendingDependents, record.pendingDependents);
    // A detached run publishes a notification independently of tool batches.
    const notificationId = actual.spawn(
      fixture.pi,
      fixture.ctx,
      "general-purpose",
      "notification",
      {
        description: "notification",
        isBackground: true,
      },
    );
    await actual.getRecord(notificationId)?.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.ok(
      notices.some((notice) => notice.includes("Pending dependents (terminal-boundary snapshot):")),
    );
  } finally {
    await fixture.cleanup();
  }
});
