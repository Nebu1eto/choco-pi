import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticSourceInfo, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  arr,
  lit,
  nullable as nullableSchema,
  num,
  obj,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import { hostParams } from "../src/schema-bridge.ts";
import { collectBridgedTools } from "../src/tools/code-mode/registered-tool-bridge.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

// No callable session tools: bridged calls run their definitions directly.
const extensionContext = createToolContextFixture();
const context = { cwd: "/tmp", extensionContext };

function bridge(definition: ToolDefinition) {
  const [tool] = collectBridgedTools({
    getAllRegisteredTools: () => [
      { definition, sourceInfo: createSyntheticSourceInfo("test", { source: "test" }) },
    ],
  });
  assert.ok(tool);
  return tool;
}

function success(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

test("invalid bridged arguments are rejected before executor side effects", async () => {
  let executions = 0;
  const tool = bridge({
    name: "read_text",
    label: "read_text",
    description: "Read observed UI text",
    parameters: hostParams(
      obj({ ref: str(), offset: opt(num({ minimum: 0 })), state_id: opt(str()) }, { open: true }),
    ),
    async execute() {
      executions += 1;
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke({ path: "/secret/file" }, context, new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /\[invalid_arguments\]/);
      assert.match(error.message, /read_text accepts UI refs, not filesystem paths/);
      assert.doesNotMatch(error.message, /\/secret\/file/);
      assert.doesNotMatch(error.message, /observe_ui/);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("explicit null and missing required arguments are not normalized", async () => {
  let executions = 0;
  const tool = bridge({
    name: "required",
    label: "required",
    description: "required",
    parameters: hostParams(obj({ value: str() }, { open: true })),
    async execute() {
      executions += 1;
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke(null, context, new AbortController().signal),
    /\[invalid_arguments\]/,
  );
  await assert.rejects(
    tool.invoke(undefined, context, new AbortController().signal),
    /\[invalid_arguments\]/,
  );
  assert.equal(executions, 0);
});

test("nullable input still reaches prepareArguments unchanged", async () => {
  let sawNull = false;
  let executions = 0;
  const tool = bridge({
    name: "nullable",
    label: "nullable",
    description: "nullable",
    parameters: hostParams(obj({ value: str() }, { open: true })),
    prepareArguments(input) {
      sawNull = input === null;
      return input === null ? { value: "from-null" } : input;
    },
    async execute() {
      executions += 1;
      return success("from-null");
    },
  });

  assert.equal(await tool.invoke(null, context, new AbortController().signal), "from-null");
  assert.equal(sawNull, true);
  assert.equal(executions, 1);
});

test("valid read_text input preserves UI observation failure", async () => {
  let executions = 0;
  const tool = bridge({
    name: "read_text",
    label: "read_text",
    description: "Read observed UI text",
    parameters: hostParams(
      obj({ ref: str(), offset: opt(num({ minimum: 0 })), state_id: opt(str()) }, { open: true }),
    ),
    async execute() {
      executions += 1;
      throw new Error("No observation state is available. Call observe_ui first.");
    },
  });

  await assert.rejects(
    tool.invoke({ ref: "@e1" }, context, new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /\[observation_required\]/);
      assert.match(error.message, /if observe_ui is available/);
      return true;
    },
  );
  assert.equal(executions, 1);
});

test("valid, prepared, and no-argument bridged calls execute exactly once", async () => {
  let validExecutions = 0;
  const valid = bridge({
    name: "valid",
    label: "valid",
    description: "valid",
    parameters: hostParams(obj({ value: str() }, { open: true })),
    async execute() {
      validExecutions += 1;
      return success("ok");
    },
  });
  assert.equal(await valid.invoke({ value: "ok" }, context, new AbortController().signal), "ok");
  assert.equal(validExecutions, 1);

  let preparedExecutions = 0;
  const prepared = bridge({
    name: "prepared",
    label: "prepared",
    description: "prepared",
    parameters: hostParams(obj({ value: num() }, { open: true })),
    prepareArguments() {
      return { value: 7 };
    },
    async execute() {
      preparedExecutions += 1;
      return success("7");
    },
  });
  assert.equal(await prepared.invoke({ value: "7" }, context, new AbortController().signal), "7");
  assert.equal(preparedExecutions, 1);

  let noArgExecutions = 0;
  const noArg = bridge({
    name: "get_goal",
    label: "get_goal",
    description: "get goal",
    parameters: hostParams(obj({}, { open: true })),
    async execute(_id, input) {
      noArgExecutions += 1;
      assert.deepEqual(input, {});
      return success("goal");
    },
  });
  assert.equal(await noArg.invoke(undefined, context, new AbortController().signal), "goal");
  assert.equal(noArgExecutions, 1);
});

test("bridged runtime rejection remains a single failed execution", async () => {
  let executions = 0;
  const tool = bridge({
    name: "fails",
    label: "fails",
    description: "fails",
    parameters: hostParams(obj({}, { open: true })),
    async execute() {
      executions += 1;
      throw new Error("runtime rejection");
    },
  });

  await assert.rejects(tool.invoke({}, context, new AbortController().signal), /runtime rejection/);
  assert.equal(executions, 1);
});

function recordingTool(parameters: ToolDefinition["parameters"]) {
  let calls = 0;
  let last: unknown;
  const tool = bridge({
    name: "recorded",
    label: "recorded",
    description: "recorded",
    parameters,
    async execute(_id, input) {
      calls += 1;
      last = input;
      return success("ok");
    },
  });
  return {
    tool,
    get calls() {
      return calls;
    },
    get last() {
      return last;
    },
  };
}

const ReadSchema = hostParams(
  obj({ path: str(), offset: opt(num()), limit: opt(num()) }, { open: true }),
);

test("bridged arguments match native normalization for optional nulls and coercible scalars", async () => {
  const optional = recordingTool(ReadSchema);
  const raw = { path: "package.json", offset: null };
  assert.equal(await optional.tool.invoke(raw, context, new AbortController().signal), "ok");
  assert.deepEqual(optional.last, { path: "package.json" });
  assert.deepEqual(raw, { path: "package.json", offset: null }, "caller input stays unmodified");
  assert.notEqual(optional.last, raw, "executor receives the native cloned arguments");

  const coercible = recordingTool(ReadSchema);
  assert.equal(
    await coercible.tool.invoke(
      { path: "package.json", limit: "50" },
      context,
      new AbortController().signal,
    ),
    "ok",
  );
  assert.deepEqual(coercible.last, { path: "package.json", limit: 50 });

  const nested = recordingTool(
    hostParams(
      obj(
        { edits: arr(obj({ oldText: str(), newText: opt(str()) }, { open: true })) },
        { open: true },
      ),
    ),
  );
  assert.equal(
    await nested.tool.invoke(
      { edits: [{ oldText: "a", newText: null }] },
      context,
      new AbortController().signal,
    ),
    "ok",
  );
  assert.deepEqual(nested.last, { edits: [{ oldText: "a" }] });

  const nullable = recordingTool(hostParams(obj({ value: nullableSchema(str()) }, { open: true })));
  assert.equal(
    await nullable.tool.invoke({ value: null }, context, new AbortController().signal),
    "ok",
  );
  assert.deepEqual(nullable.last, { value: null }, "nullable properties keep explicit null");
  assert.equal(nullable.calls, 1);
});

test("invalid nested arguments report their path without the rejected payload", async () => {
  let executions = 0;
  const tool = bridge({
    name: "edit",
    label: "edit",
    description: "edit",
    parameters: hostParams(
      obj({ edits: arr(obj({ oldText: str(), newText: str() }, { open: true })) }, { open: true }),
    ),
    async execute() {
      executions += 1;
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke(
      { edits: [{ oldText: { secret: "s3cret-value" }, newText: "n" }] },
      context,
      new AbortController().signal,
    ),
    (error: Error) => {
      assert.match(error.message, /\[invalid_arguments\]/);
      assert.match(error.message, /edits\.0\.oldText/);
      assert.doesNotMatch(error.message, /s3cret-value/);
      assert.doesNotMatch(error.message, /Received arguments/);
      assert.doesNotMatch(error.message, /read_text accepts UI refs/);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("non-validation failures from the native validator propagate without executing", async () => {
  let executions = 0;
  const tool = bridge({
    name: "permissive",
    label: "permissive",
    description: "permissive",
    parameters: hostParams(obj({ handler: unknown() }, { open: true })),
    prepareArguments() {
      // A schema-valid but structured-clone-hostile member: the native validator clones first.
      return { handler: () => undefined };
    },
    async execute() {
      executions += 1;
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke({ handler: "replaced" }, context, new AbortController().signal),
    (error: Error) => {
      assert.doesNotMatch(error.message, /\[invalid_arguments\]/);
      assert.match(error.message, /could not be cloned|DataCloneError/);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("missing required properties are named without executing the tool", async () => {
  let executions = 0;
  const tool = bridge({
    name: "missing",
    label: "missing",
    description: "missing",
    parameters: ReadSchema,
    async execute() {
      executions += 1;
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke({ offset: 1 }, context, new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /\[invalid_arguments\]/);
      assert.match(error.message, /path/);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("object-union failures name the discriminator and its accepted values once", async () => {
  const tool = bridge({
    name: "act_ui",
    label: "act_ui",
    description: "act",
    parameters: hostParams(
      obj(
        {
          actions: arr(
            union([
              obj({ action: lit("press"), ref: str() }, { open: true }),
              obj({ action: lit("click"), ref: str() }, { open: true }),
              obj({ action: lit("click"), x: num(), y: num() }, { open: true }),
            ]),
            { minItems: 1 },
          ),
        },
        { open: true },
      ),
    ),
    async execute() {
      return success("unexpected");
    },
  });

  await assert.rejects(
    tool.invoke(
      { actions: [{ kind: "press", target: "e1" }] },
      context,
      new AbortController().signal,
    ),
    (error: Error) => {
      assert.match(error.message, /\[invalid_arguments\]/);
      assert.match(
        error.message,
        /actions\.0: expected one of the 3 shapes selected by "action": "press", "click", "click"/,
      );
      // No per-branch repetition and no echo of the rejected value.
      assert.equal(error.message.split("actions.0").length - 1, 1, error.message);
      assert.doesNotMatch(error.message, /target|e1/);
      return true;
    },
  );
});
