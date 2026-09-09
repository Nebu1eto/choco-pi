import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { NUDGE_HOLD_MS } from "../src/notification-gate.ts";

function partialFixture<T extends object>(value: Partial<T>): T {
  // SAFETY: Fixtures supply only the host members exercised by the registered tools and injected runner.
  return value as T;
}

type RuntimeValue = {} | null | undefined;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;
interface ActualManagerRef {
  current?: AgentManager;
}

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The host fixture implements the runtime registration and delivery methods exercised here.
  return value as ExtensionAPI;
}

async function fixture(t: TestContext, initialMaxConcurrent = 1) {
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const notices: RuntimeValue[] = [];
  const deliveryOptions: Array<Parameters<ExtensionAPI["sendMessage"]>[1]> = [];
  const events: string[] = [];
  const pi = asExtensionAPI({
    events: {
      emit: (name: string) => {
        events.push(name);
      },
      on: () => () => undefined,
    },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    appendEntry: () => undefined,
    sendMessage: (message: RuntimeValue, options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
      notices.push(message);
      deliveryOptions.push(options);
    },
  });
  subagentsExtension(pi);
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: Root activation owns this documented manager slot in this isolated test process.
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: Pick<AgentManager, "spawn" | "getRecord" | "waitForAll"> | undefined;
  };
  const manager = registry[key];
  assert.ok(manager);
  let maxConcurrent = initialMaxConcurrent;
  const pending: Array<() => void> = [];
  let aborts = 0;
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      options.signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true },
      );
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            responseText: "preserved partial output",
            session: partialFixture<AgentSession>({ dispose: () => undefined }),
            aborted: options.signal?.aborted === true,
            steered: false,
          }),
        );
      });
    },
    async resumeAgent() {
      throw new Error("unexpected resume");
    },
  };
  // Capture the internally constructed real manager at its existing spawn
  // boundary and replace only its runner seam, without copying tool logic.
  const spawn = AgentManager.prototype.spawn;
  const actualManagerRef: ActualManagerRef = {};
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      actualManagerRef.current = this;
      assert.equal(Reflect.set(this, "runner", runner), true);
      this.setMaxConcurrent(maxConcurrent);
      return spawn.apply(this, args);
    },
  );
  const abort = AgentManager.prototype.abort;
  let stopCalls = 0;
  t.mock.method(AgentManager.prototype, "abort", function (this: AgentManager, id: string) {
    stopCalls += 1;
    return abort.call(this, id);
  });
  const ctx = partialFixture<ExtensionContext>({
    cwd: process.cwd(),
    sessionManager: partialFixture<ExtensionContext["sessionManager"]>({
      getSessionId: () => "stop-result-delivery",
      getEntries: () => [],
    }),
  });
  const start = handlers.get("session_start");
  assert.ok(start);
  await start({}, ctx);
  return {
    manager,
    notices,
    deliveryOptions,
    tools,
    ctx,
    pi,
    events,
    pending,
    aborts: () => aborts,
    stopCalls: () => stopCalls,
    setMaxConcurrent(value: number) {
      maxConcurrent = value;
    },
    actualManager() {
      assert.ok(actualManagerRef.current);
      return actualManagerRef.current;
    },
    spawn() {
      return manager.spawn(pi, ctx, "implementer", "delayed cancellation", {
        description: "delayed cancellation",
        isBackground: true,
        isolated: true,
      });
    },
    async call(name: string, id: string) {
      const tool = tools.get(name);
      assert.ok(tool);
      const result = await tool.execute(name, { agent_id: id }, undefined, undefined, ctx);
      const first = result.content[0];
      assert.equal(first?.type, "text");
      return first.type === "text" ? first.text : "";
    },
    async close() {
      for (const settle of pending) settle();
      await manager.waitForAll();
      const shutdown = handlers.get("session_shutdown");
      assert.ok(shutdown);
      await shutdown();
      assert.equal(registry[key], undefined);
    },
  };
}

const waitForGate = () => new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 50));

async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function waitForPendingRunner(pending: Array<() => void>, priorLength: number) {
  const deadline = Date.now() + 1_000;
  while (pending.length === priorLength && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(pending.length, priorLength + 1, "child runner did not start");
  return pending[priorLength]!;
}

test("registered root MESSAGE/TASK/FINAL use safe-boundary steering with idle wakeup", async (t) => {
  const host = await fixture(t);
  try {
    const tool = host.tools.get("agent_message");
    assert.ok(tool);
    for (const type of ["MESSAGE", "TASK", "FINAL"]) {
      await tool.execute(
        "message",
        { to: "/root", message: "coordination", type },
        undefined,
        undefined,
        host.ctx,
      );
      assert.deepEqual(host.notices.at(-1), {
        customType: "subagent-message",
        content: `<agent-message from="/root" type="${type}">\ncoordination\n</agent-message>`,
        display: true,
      });
      assert.deepEqual(host.deliveryOptions.at(-1), { deliverAs: "steer", triggerTurn: true });
    }
  } finally {
    await host.close();
  }
});

test("registered peer message rejects unpublished cancellation, then reports published settlement", async (t) => {
  const host = await fixture(t);
  try {
    const id = host.spawn();
    const record = host.manager.getRecord(id);
    assert.ok(record);
    const tool = host.tools.get("agent_message");
    assert.ok(tool);
    const generation = record.resultGeneration ?? 1;
    assert.equal(record.status, "running");
    assert.equal(record.session, undefined);
    assert.notEqual(record.terminalResultGeneration, generation);
    assert.ok(record.promise);
    record.cancellation = {
      generation,
      cause: "user_stop",
      reason: "stop",
      requestedAt: Date.now(),
    };

    const beforeSession = await tool.execute(
      "message-before-session",
      { to: id, message: "must not queue" },
      undefined,
      undefined,
      host.ctx,
    );
    const beforeSessionText = beforeSession.content[0];
    assert.equal(beforeSessionText?.type, "text");
    assert.match(
      beforeSessionText?.type === "text" ? beforeSessionText.text : "",
      /is cancelling and cannot receive new work/,
    );
    assert.equal(record.pendingSteers, undefined);

    let steers = 0;
    let fixtureSessionDisposed = false;
    const fixtureSession = partialFixture<AgentSession>({
      async steer() {
        steers += 1;
      },
      dispose() {
        fixtureSessionDisposed = true;
      },
    });
    record.session = fixtureSession;
    const liveSession = await tool.execute(
      "message-live-session",
      { to: id, message: "must not steer" },
      undefined,
      undefined,
      host.ctx,
    );
    const liveSessionText = liveSession.content[0];
    assert.equal(liveSessionText?.type, "text");
    assert.match(
      liveSessionText?.type === "text" ? liveSessionText.text : "",
      /is cancelling and cannot receive new work/,
    );
    assert.equal(steers, 0);
    assert.equal(record.pendingSteers, undefined);
    assert.notEqual(record.resultConsumed, true);
    assert.equal(host.events.includes("subagents:message"), false);

    record.session = undefined;
    fixtureSession.dispose();
    assert.equal(fixtureSessionDisposed, true);
    host.pending[0]!();
    await record.promise;
    assert.equal(record.status, "completed");
    assert.equal(record.cancellation?.generation, generation);
    assert.equal(record.terminalResultGeneration, generation);
    assert.notEqual(record.resultConsumed, true);

    const published = await tool.execute(
      "message-after-publication",
      { to: id, message: "must remain finished" },
      undefined,
      undefined,
      host.ctx,
    );
    const publishedText = published.content[0];
    assert.equal(publishedText?.type, "text");
    assert.match(
      publishedText?.type === "text" ? publishedText.text : "",
      /already finished \(status: completed\)/,
    );
    assert.equal(steers, 0);
    assert.equal(record.pendingSteers, undefined);
    assert.equal(host.events.includes("subagents:message"), false);
  } finally {
    await host.close();
  }
});

test(
  "nested completion steers only an uncancelled parent and never consumes its durable result",
  { timeout: 3_000 },
  async (t) => {
    const host = await fixture(t, 2);
    try {
      const parentId = host.spawn();
      const parent = host.manager.getRecord(parentId);
      assert.ok(parent);
      // Keep the real parent runner active while nested runs settle independently.
      const deliveries: Array<Parameters<AgentSession["sendCustomMessage"]>> = [];
      parent.session = partialFixture<AgentSession>({
        async sendCustomMessage(...args: Parameters<AgentSession["sendCustomMessage"]>) {
          deliveries.push(args);
        },
        dispose() {},
      });
      parent.status = "running";
      assert.equal(parent.session !== undefined, true);
      for (const cancelled of [false, true]) {
        if (cancelled)
          parent.cancellation = {
            generation: parent.resultGeneration ?? 1,
            cause: "parent_signal",
            reason: "cancelled",
            requestedAt: Date.now(),
          };
        const pendingBefore = host.pending.length;
        const childId = host
          .actualManager()
          .spawn(host.pi, host.ctx, "implementer", "nested completion", {
            description: "nested completion",
            parentAgentId: parentId,
            depth: 2,
            isBackground: true,
            isolated: true,
          });
        const settleChild = await waitForPendingRunner(host.pending, pendingBefore);
        settleChild();
        const child = host.actualManager().getRecord(childId);
        assert.ok(child);
        assert.equal(child.parentAgentId, parentId);
        assert.ok(child.promise);
        await bounded(
          child.promise,
          500,
          `nested child ${cancelled ? "cancelled" : "active"} did not settle`,
        );
        assert.equal(child.terminalResultGeneration, child.resultGeneration);
        assert.notEqual(child.resultConsumed, true);
        assert.equal(parent.status, "running");
        assert.equal(parent.session !== undefined, true);
        await Promise.resolve();
        assert.equal(deliveries.length, 1);
      }
      assert.equal(deliveries[0]?.[0].customType, "subagent-notification");
      assert.deepEqual(deliveries[0]?.[1], { deliverAs: "steer", triggerTurn: true });
      host.pending[0]!();
      assert.ok(parent.promise);
      await bounded(parent.promise, 500, "parent fixture did not settle");
    } finally {
      await host.close();
    }
  },
);

test("registered stop preserves pending result ownership, one terminal notice and one terminal read", async (t) => {
  const host = await fixture(t);
  try {
    const id = host.spawn();
    const record = host.manager.getRecord(id);
    assert.ok(record);
    assert.match(await host.call("stop_subagent", id), /Cancellation requested.*pending/);
    const cancellation = record.cancellation;
    assert.notEqual(record.resultConsumed, true);
    assert.equal(record.consumedResultGeneration, undefined);
    assert.notEqual(record.terminalResultGeneration, record.resultGeneration);
    const repeated = await host.call("stop_subagent", id);
    assert.match(repeated, /terminal completion notification/);
    assert.doesNotMatch(repeated, /already settled/);
    assert.equal(host.stopCalls(), 1);
    assert.equal(host.aborts(), 1);
    assert.equal(record.cancellation, cancellation);
    assert.equal(
      JSON.parse(await host.call("get_subagent_result", id)).reason,
      "terminal_result_not_published",
    );
    await waitForGate();
    assert.equal(host.notices.length, 0);
    assert.notEqual(record.resultConsumed, true);

    host.pending[0]();
    await record.promise;
    assert.equal(record.terminalResultGeneration, record.resultGeneration);
    assert.notEqual(record.resultConsumed, true);
    assert.match(await host.call("stop_subagent", id), /already settled/);
    await waitForGate();
    assert.equal(host.notices.length, 1);
    assert.match(JSON.stringify(host.notices[0]), /stopped/);
    assert.equal(host.events.filter((name) => name === "subagents:stopped").length, 1);
    assert.match(await host.call("get_subagent_result", id), /preserved partial output/);
    assert.equal(record.consumedResultGeneration, record.resultGeneration);
    assert.equal(
      JSON.parse(await host.call("get_subagent_result", id)).reason,
      "terminal_generation_already_consumed",
    );
    await waitForGate();
    assert.equal(host.notices.length, 1);
  } finally {
    await host.close();
  }
});

test("registered terminal read before gate delivery suppresses the stopped notice", async (t) => {
  const host = await fixture(t);
  try {
    const id = host.spawn();
    await host.call("stop_subagent", id);
    host.pending[0]();
    const record = host.manager.getRecord(id);
    assert.ok(record);
    await record.promise;
    assert.equal(record.terminalResultGeneration, record.resultGeneration);
    assert.equal(host.notices.length, 0);
    assert.match(await host.call("get_subagent_result", id), /preserved partial output/);
    assert.equal(record.resultConsumed, true);
    await waitForGate();
    assert.equal(host.notices.length, 0);
    assert.equal(
      JSON.parse(await host.call("get_subagent_result", id)).reason,
      "terminal_generation_already_consumed",
    );
  } finally {
    await host.close();
  }
});

test("registered queued stop settles immediately without waiting for a nonexistent notice", async (t) => {
  const host = await fixture(t);
  try {
    host.spawn();
    const id = host.spawn();
    const record = host.manager.getRecord(id);
    assert.ok(record);
    assert.equal(record.status, "queued");
    const stopped = await host.call("stop_subagent", id);
    assert.match(stopped, /stopped and settled/);
    assert.doesNotMatch(stopped, /pending|wait.*notification/i);
    assert.equal(record.terminalResultGeneration, record.resultGeneration);
    assert.notEqual(record.resultConsumed, true);
    assert.equal(host.pending.length, 1, "queued cancellation never starts its runner");
    assert.match(await host.call("stop_subagent", id), /already settled/);
    await waitForGate();
    assert.equal(host.notices.length, 0);
    assert.match(await host.call("get_subagent_result", id), /Status: stopped/);
    assert.equal(
      JSON.parse(await host.call("get_subagent_result", id)).reason,
      "terminal_generation_already_consumed",
    );
  } finally {
    await host.close();
  }
});
