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

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The host fixture implements the runtime registration and delivery methods exercised here.
  return value as ExtensionAPI;
}

async function fixture(t: TestContext) {
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const notices: RuntimeValue[] = [];
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
    sendMessage: (message: RuntimeValue) => {
      notices.push(message);
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
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      assert.equal(Reflect.set(this, "runner", runner), true);
      this.setMaxConcurrent(1);
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
    events,
    pending,
    aborts: () => aborts,
    stopCalls: () => stopCalls,
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
