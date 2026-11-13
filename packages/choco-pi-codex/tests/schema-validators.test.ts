import assert from "node:assert/strict";
import test from "node:test";

import { obj, str } from "@earendil-works/pi-schema";
import { toNestedTool } from "../src/adapter/code-mode/nested-tool-adapter.ts";
import { cloneCodexCompactionJson } from "../src/adapter/compaction/details-store.ts";
import { hostParams } from "../src/schema-bridge.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

const extensionContext = createToolContextFixture();
const context = { cwd: "/tmp", extensionContext };

function nested(parameters: ReturnType<typeof hostParams>) {
  let received: unknown;
  const tool = toNestedTool(
    {
      name: "probe",
      label: "probe",
      description: "probe",
      parameters,
      async execute(_id, params) {
        received = params;
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    },
    "await tools.probe()",
  );
  return { tool, received: () => received };
}

test("nested validation: open objects keep unknown keys; missing and mistyped fields are rejected", async () => {
  const probe = nested(hostParams(obj({ key: str() }, { open: true })));
  const signal = new AbortController().signal;
  assert.equal(await probe.tool.invoke({ key: "a", extra: 1 }, context, signal), "ok");
  assert.deepEqual(probe.received(), { key: "a", extra: 1 });
  await assert.rejects(probe.tool.invoke({}, context, signal), /\[invalid_arguments\].*key/);
  await assert.rejects(
    probe.tool.invoke({ key: { nested: 1 } }, context, signal),
    /\[invalid_arguments\]/,
  );
});

test("nested validation: closed objects reject unknown keys", async () => {
  const probe = nested(hostParams(obj({ key: str() })));
  const signal = new AbortController().signal;
  assert.equal(await probe.tool.invoke({ key: "a" }, context, signal), "ok");
  await assert.rejects(
    probe.tool.invoke({ key: "a", extra: 1 }, context, signal),
    /\[invalid_arguments\]/,
  );
});

test("nested validation mirrors the host: coercion on, formats checked, dangling refs reject", async () => {
  const signal = new AbortController().signal;
  const coerced = nested(
    hostParams({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    }),
  );
  await coerced.tool.invoke({ count: "42" }, context, signal);
  assert.deepEqual(coerced.received(), { count: 42 });

  const formatted = nested(
    hostParams({ type: "object", properties: { url: { type: "string", format: "uri" } } }),
  );
  assert.equal(
    await formatted.tool.invoke({ url: "https://example.com/a" }, context, signal),
    "ok",
  );
  await assert.rejects(
    formatted.tool.invoke({ url: "not a uri" }, context, signal),
    /\[invalid_arguments\]/,
  );

  const dangling = nested(
    hostParams({
      type: "object",
      properties: { a: { $ref: "#/$defs/missing" }, b: { type: "string" } },
    }),
  );
  assert.equal(await dangling.tool.invoke({ b: "x" }, context, signal), "ok");
  await assert.rejects(dangling.tool.invoke({ a: 1 }, context, signal), /\[invalid_arguments\]/);
});

test("cloneCodexCompactionJson detaches plain JSON, omits undefined, and rejects everything else", () => {
  const source = { a: [1, "x", null, true, { b: undefined, c: 2 }], d: undefined };
  const cloned = cloneCodexCompactionJson(source);
  assert.deepEqual(cloned, { a: [1, "x", null, true, { c: 2 }] });
  assert.notEqual(cloned, source);
  const detached = cloneCodexCompactionJson(Object.assign(Object.create(null), { k: 1 }));
  assert.deepEqual(detached, { k: 1 });
  const sparse: number[] = [1];
  sparse[2] = 3;
  for (const rejected of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    10n,
    Symbol("s"),
    () => 1,
    new Date(0),
    new Map(),
    { nested: new Date(0) },
    sparse,
    { fn: () => 1 },
  ]) {
    assert.equal(cloneCodexCompactionJson(rejected), undefined, String(rejected));
  }
});
