import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { compile, num } from "@earendil-works/pi-schema";

import subagentsExtension from "../src/index.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import { isHostObject } from "../src/value-guards.ts";

type RuntimeValue = {} | null | undefined;
type LifecycleResult = RuntimeValue | Promise<RuntimeValue>;
type LifecycleHandler = (...args: RuntimeValue[]) => LifecycleResult;

// xAI rejects a whole request with 400 "Invalid arguments passed to the model."
// when any tool parameter of type integer carries a bound outside int64; a
// `Number.MAX_VALUE` cap on an Agent field made every Grok turn fail.
const INTEGER_BOUND_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
// pi-schema `num()` also accepts NaN and ±Infinity, so a non-finite bound is reported too.
const isNumber = compile(num()).check;

/** Integer fields reached by a schema walk and the bounds among them that are not safe integers. */
interface IntegerBoundScan {
  unsafe: string[];
  integers: number;
}

function isIntegerSchema(type: RuntimeValue): boolean {
  return type === "integer" || (Array.isArray(type) && type.includes("integer"));
}

/** Paths of integer bounds a provider cannot hold as a safe integer, plus the integer field count. */
function integerBounds(schema: RuntimeValue, path: string): IntegerBoundScan {
  const unsafe: string[] = [];
  const found: IntegerBoundScan = { unsafe, integers: 0 };
  if (!isHostObject(schema)) return found;
  const entries: [string, RuntimeValue][] = Object.entries(schema);
  const fields = new Map(entries);
  if (isIntegerSchema(fields.get("type"))) {
    found.integers += 1;
    for (const key of INTEGER_BOUND_KEYS) {
      const bound = fields.get(key);
      if (isNumber(bound) && !Number.isSafeInteger(bound)) {
        unsafe.push(`${path}.${key}=${bound}`);
      }
    }
  }
  for (const [key, child] of entries) {
    const nested = integerBounds(child, `${path}.${key}`);
    unsafe.push(...nested.unsafe);
    found.integers += nested.integers;
  }
  return found;
}

function assertProviderSafeIntegers(tools: Iterable<ToolDefinition>, expected: string[]): void {
  const byName = new Map([...tools].map((tool) => [tool.name, tool]));
  for (const name of expected) assert.ok(byName.has(name), `${name} must be registered`);
  let integers = 0;
  const unsafe: string[] = [];
  for (const tool of byName.values()) {
    const bounds = integerBounds(tool.parameters, tool.name);
    integers += bounds.integers;
    unsafe.push(...bounds.unsafe);
  }
  assert.ok(integers > 0, "the scan must reach integer parameters");
  assert.deepEqual(unsafe, []);
}

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The fixture implements every ExtensionAPI member tool registration exercises.
  return value as ExtensionAPI;
}

function asExtensionContext(value: RuntimeValue): ExtensionContext {
  // SAFETY: The fixture supplies the session-binding reads session_start performs.
  return value as ExtensionContext;
}

test("root tool schemas keep integer bounds within the safe integer range", async () => {
  const handlers = new Map<string, LifecycleHandler>();
  const tools = new Map<string, ToolDefinition>();
  const noop = () => undefined;
  const pi = asExtensionAPI({
    events: { emit: noop, on: () => noop },
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: noop,
    sendMessage: noop,
  });
  await subagentsExtension(pi);
  const start = handlers.get("session_start");
  assert.ok(start);
  await start(
    {},
    asExtensionContext({
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "tool-schema-integer-bounds", getEntries: () => [] },
    }),
  );
  try {
    assertProviderSafeIntegers(tools.values(), ["Agent", "subagent_limits", "workflow_run"]);
  } finally {
    const shutdown = handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
  }
});

test("nested tool schemas keep integer bounds within the safe integer range", async () => {
  const manager: NestedAgentManager = {
    spawn: () => assert.fail("must not spawn"),
    spawnAndWait: () => assert.fail("must not spawn and wait"),
    getRecord: () => undefined,
    listAgents: () => [],
    getActiveCount: () => 0,
    getScheduledActiveCount: () => 0,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  const tools = await createNestedSubagentTools({
    manager,
    pi: asExtensionAPI({}),
    parentAgentId: "parent",
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: process.cwd(),
  });
  assertProviderSafeIntegers(tools, ["Agent"]);
});
