import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../src/index.ts";

interface GlobalManagerEntry {
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

interface ExtensionHostFixture {
  events: { emit(): undefined; on(): () => undefined };
  on(name: string, handler: LifecycleHandler): Map<string, LifecycleHandler>;
  registerCommand(): undefined;
  registerMessageRenderer(): undefined;
  registerTool(tool: ToolDefinition): Map<string, ToolDefinition>;
  appendEntry(): undefined;
  sendMessage(): never;
}

interface PiFixture {
  pi: ExtensionAPI;
  handlers: Map<string, LifecycleHandler>;
  tools: Map<string, ToolDefinition>;
  missedNotifications: { count: number };
}

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: Callers supply a fixture implementing every ExtensionAPI member exercised by this test.
  return value as ExtensionAPI;
}

function fixture(): PiFixture {
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const missedNotifications = { count: 0 };
  const noop = () => undefined;
  const host: ExtensionHostFixture = {
    events: { emit: noop, on: () => noop },
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: noop,
    sendMessage() {
      missedNotifications.count += 1;
      throw new Error("notification UI unavailable");
    },
  };
  return { pi: asExtensionAPI(host), handlers, tools, missedNotifications };
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("top-level get_subagent_result refuses repeated generation reads and retains missed results", async () => {
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: This test reads only the package's documented process-global manager slot.
  const registry = globalThis as typeof globalThis & {
    [registryKey: symbol]: GlobalManagerEntry | undefined;
  };
  const root = fixture();
  subagentsExtension(root.pi);
  const manager = registry[key];
  assert.ok(manager);
  const resultTool = root.tools.get("get_subagent_result");
  assert.ok(resultTool);

  try {
    // SAFETY: The detached runner reads cwd before failing on the deliberately incomplete host context.
    const context = { cwd: process.cwd() } as ExtensionContext;
    const id = manager.spawn(root.pi, context, "implementer", "generation probe", {
      description: "generation probe",
      isBackground: true,
      isolated: true,
    });

    const first = await resultTool.execute(
      "active-first",
      { agent_id: id },
      undefined,
      undefined,
      context,
    );
    assert.match(resultText(first), /Status: running/);

    const repeated = await resultTool.execute(
      "active-repeated",
      { agent_id: id },
      undefined,
      undefined,
      context,
    );
    assert.equal(JSON.parse(resultText(repeated)).reason, "active_generation_already_read");

    await manager.waitForAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(
      root.missedNotifications.count,
      1,
      "completion notification was attempted and missed",
    );

    const terminal = await resultTool.execute(
      "terminal-first",
      { agent_id: id },
      undefined,
      undefined,
      context,
    );
    assert.match(resultText(terminal), new RegExp(`Agent: ${id}`));
    assert.match(resultText(terminal), /Status: error/);

    const consumed = await resultTool.execute(
      "terminal-repeated",
      { agent_id: id },
      undefined,
      undefined,
      context,
    );
    assert.equal(JSON.parse(resultText(consumed)).reason, "terminal_generation_already_consumed");
  } finally {
    const shutdown = root.handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
  assert.equal(registry[key], undefined);
});
