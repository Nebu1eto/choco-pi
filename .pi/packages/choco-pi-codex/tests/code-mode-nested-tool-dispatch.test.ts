import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createBashTool,
  createBashToolDefinition,
  createSyntheticSourceInfo,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isObjectValue } from "../src/tools/boundary.ts";
import type { BoundaryValue } from "../src/tools/boundary.ts";
import { toNestedTool } from "../src/adapter/code-mode/nested-tool-adapter.ts";
import { collectBridgedTools } from "../src/tools/code-mode/registered-tool-bridge.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

const ShellResultSchema = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String()),
  exit_code: Type.Number(),
  wall_time_seconds: Type.Number(),
});

async function scratchDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-nested-dispatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function shellResult(value: BoundaryValue) {
  assert.ok(Value.Check(ShellResultSchema, value), `not a shell result: ${JSON.stringify(value)}`);
  return value;
}

function nestedBash(cwd: string) {
  return toNestedTool(
    createBashToolDefinition(cwd, { exposeSessionEnvironment: false }),
    "await tools.bash({ command })",
  );
}

function directContext(cwd: string) {
  return { cwd, toolCallId: "exec-1", extensionContext: createToolContextFixture({ cwd }) };
}

test("nested bash with empty output resolves to an empty string", async (t) => {
  const cwd = await scratchDir(t);
  const value = await nestedBash(cwd).invoke(
    { command: "true" },
    directContext(cwd),
    new AbortController().signal,
  );
  const result = shellResult(value);
  assert.equal(result.output, "");
  assert.notEqual(result.output, "(no output)");
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.full_output_path, undefined);
});

test("nested bash failure propagates its non-zero exit code and output", async (t) => {
  const cwd = await scratchDir(t);
  const value = await nestedBash(cwd).invoke(
    { command: "printf 'boom'; exit 3" },
    directContext(cwd),
    new AbortController().signal,
  );
  const result = shellResult(value);
  assert.equal(result.exit_code, 3);
  assert.equal(result.output, "boom");
});

test("nested bash truncation surfaces truncated and the full output path", async (t) => {
  const cwd = await scratchDir(t);
  // Structured output keeps up to 1 MiB; 1.5 MiB forces truncation and a spill file.
  const value = await nestedBash(cwd).invoke(
    { command: "head -c 1572864 /dev/zero | tr '\\0' a" },
    directContext(cwd),
    new AbortController().signal,
  );
  const result = shellResult(value);
  const fullOutputPath = result.full_output_path;
  if (fullOutputPath) t.after(() => rm(fullOutputPath, { force: true }));
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.ok(fullOutputPath);
  await access(fullOutputPath);
  // Head and tail of the first 1 MiB around Pi's omission marker, not the whole 1.5 MiB.
  assert.match(result.output, /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
  assert.ok(result.output.length < 1572864);
});

test("the direct path hands the caller's own tool context to execute", async () => {
  const extensionContext = createToolContextFixture();
  let received: ExtensionToolContext | undefined;
  const tool = toNestedTool(
    {
      name: "probe",
      label: "probe",
      description: "probe",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        received = ctx;
        return { content: [{ type: "text", text: "" }], details: undefined };
      },
    },
    "await tools.probe()",
  );
  const value = await tool.invoke(
    {},
    { cwd: "/tmp", extensionContext },
    new AbortController().signal,
  );
  assert.equal(received, extensionContext);
  assert.equal(value, "(no output)", "non-shell text fallback is unchanged");
});

function bridged(definition: ToolDefinition) {
  const [tool] = collectBridgedTools({
    getAllRegisteredTools: () => [
      { definition, sourceInfo: createSyntheticSourceInfo("test", { source: "test" }) },
    ],
  });
  assert.ok(tool);
  return tool;
}

test("callable bridged tools dispatch through ctx.executeTool", async (t) => {
  const cwd = await scratchDir(t);
  const bashTool = createBashTool(cwd, { exposeSessionEnvironment: false });
  let directExecutions = 0;
  const calls: Array<{ name: string; args: unknown; signal: AbortSignal | undefined }> = [];
  const extensionContext = createToolContextFixture({
    cwd,
    tools: [bashTool],
    async executeTool(name, args, options) {
      calls.push({ name, args, signal: options?.signal });
      assert.ok(Value.Check(bashTool.parameters, args));
      const toolCall = {
        type: "toolCall" as const,
        id: `exec-1/${calls.length}`,
        name,
        arguments: { command: args.command },
      };
      const result = await bashTool.execute(toolCall.id, args, options?.signal);
      return { toolCall, result, isError: result.isError === true };
    },
  });
  const tool = bridged({
    name: "bash",
    label: "bash",
    description: "bash",
    parameters: bashTool.parameters,
    async execute() {
      directExecutions += 1;
      throw new Error("direct execution must not run");
    },
  });
  const controller = new AbortController();
  const context = { cwd, toolCallId: "exec-1", extensionContext };

  const empty = shellResult(await tool.invoke({ command: "true" }, context, controller.signal));
  assert.equal(empty.output, "");

  const failed = shellResult(
    await tool.invoke({ command: "printf 'bad'; exit 4" }, context, controller.signal),
  );
  assert.equal(failed.exit_code, 4);
  assert.equal(failed.output, "bad");

  assert.equal(directExecutions, 0);
  assert.deepEqual(
    calls.map((call) => [call.name, call.args]),
    [
      ["bash", { command: "true" }],
      ["bash", { command: "printf 'bad'; exit 4" }],
    ],
  );
  assert.ok(calls.every((call) => call.signal === controller.signal));
});

test("session errors without structured content reject with the tool's text", async () => {
  const definition: ToolDefinition = {
    name: "lookup",
    label: "lookup",
    description: "lookup",
    parameters: Type.Object({ key: Type.String() }),
    async execute() {
      throw new Error("direct execution must not run");
    },
  };
  const extensionContext = createToolContextFixture({
    tools: [
      {
        ...definition,
        execute: async () => ({ content: [], details: undefined }),
      },
    ],
    async executeTool(name, args) {
      return {
        toolCall: { type: "toolCall", id: "exec-1/1", name, arguments: {} },
        result: {
          content: [{ type: "text", text: `blocked ${isObjectValue(args) ? "object" : "?"}` }],
          details: {},
        },
        isError: true,
      };
    },
  });
  await assert.rejects(
    bridged(definition).invoke(
      { key: "a" },
      { cwd: "/tmp", toolCallId: "exec-1", extensionContext },
      new AbortController().signal,
    ),
    /blocked object/,
  );
});

test("registered tools the session cannot call keep running their definition", async () => {
  let directExecutions = 0;
  const extensionContext = createToolContextFixture();
  const tool = bridged({
    name: "inactive",
    label: "inactive",
    description: "inactive",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      directExecutions += 1;
      assert.equal(ctx, extensionContext);
      return { content: [{ type: "text", text: "ran" }], details: undefined };
    },
  });
  assert.equal(
    await tool.invoke({}, { cwd: "/tmp", extensionContext }, new AbortController().signal),
    "ran",
  );
  assert.equal(directExecutions, 1);
});
