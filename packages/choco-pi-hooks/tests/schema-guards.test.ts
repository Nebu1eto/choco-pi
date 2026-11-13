import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonSchema } from "@earendil-works/pi-schema";
import { registerClaudeTaskTools } from "../src/tasks.ts";
import {
  isBooleanValue,
  isFunctionValue,
  isStringValue,
  parseRuntimeRecord,
} from "../src/validation.ts";

test("primitive guards accept primitives and reject boxed or foreign values", () => {
  assert.equal(isStringValue("a"), true);
  assert.equal(isStringValue(Object("a")), false);
  assert.equal(isStringValue(1), false);
  assert.equal(isStringValue(null), false);
  assert.equal(isBooleanValue(false), true);
  assert.equal(isBooleanValue(Object(true)), false);
  assert.equal(isBooleanValue("true"), false);
  assert.equal(
    isFunctionValue(() => 1),
    true,
  );
  assert.equal(isFunctionValue({}), false);
});

test("parseRuntimeRecord accepts property bags and rejects arrays, null, functions, primitives", () => {
  const bag = { id: "x", extra: 1 };
  assert.equal(parseRuntimeRecord(bag), bag);
  const bare = Object.create(null);
  assert.equal(parseRuntimeRecord(bare), bare);
  assert.equal(parseRuntimeRecord([]), undefined);
  assert.equal(parseRuntimeRecord(null), undefined);
  assert.equal(parseRuntimeRecord(undefined), undefined);
  assert.equal(
    parseRuntimeRecord(() => 1),
    undefined,
  );
  assert.equal(parseRuntimeRecord("s"), undefined);
});

function registeredParameters(): Map<string, JsonSchema> {
  const registered = new Map<string, JsonSchema>();
  const pi: Partial<ExtensionAPI> = {
    registerTool: (tool: { name: string; parameters: JsonSchema }) => {
      registered.set(tool.name, tool.parameters);
    },
  };
  // SAFETY: registerClaudeTaskTools only calls registerTool on the API.
  registerClaudeTaskTools(pi as ExtensionAPI, () =>
    Promise.reject(new Error("dispatch is not used by schema checks")),
  );
  return registered;
}

test("task tool parameters keep open objects, optional fields and the status enum", () => {
  const parameters = registeredParameters();
  const create = compile(parameters.get("TaskCreate") ?? {});
  assert.equal(create.check({ subject: "s" }), true);
  assert.equal(create.check({ subject: "s", description: "d", extra: 1 }), true);
  assert.equal(create.check({}), false);
  assert.equal(create.check({ subject: 1 }), false);
  assert.equal(create.check({ subject: "s", description: null }), false);
  const update = compile(parameters.get("TaskUpdate") ?? {});
  assert.equal(update.check({ task_id: "1", status: "in_progress", extra: true }), true);
  assert.equal(update.check({ task_id: "1" }), true);
  assert.equal(update.check({ task_id: "1", status: "done" }), false);
  assert.equal(update.check({ status: "pending" }), false);
});
