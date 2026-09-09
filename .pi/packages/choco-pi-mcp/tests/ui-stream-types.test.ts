import assert from "node:assert/strict";
import { test } from "node:test";
import * as Value from "typebox/value";
import * as Stream from "../ui-stream-types.ts";

const host = {
  mode: "eager",
  streamId: "id",
  intermediateResultPatches: true,
  partialInput: false,
};
const envelope = { streamId: "id", sequence: 0, frameType: "patch", phase: "shell", status: "ok" };
const result = {
  content: [null, "text"],
  structuredContent: { any: 1 },
  isError: false,
  _meta: {},
  extension: "kept",
};
const fixtures = [
  [Stream.uiStreamModeSchema, "eager", "invalid"],
  [Stream.visualizationStreamPhaseSchema, "shell", "invalid"],
  [Stream.visualizationStreamFrameTypeSchema, "patch", "invalid"],
  [Stream.visualizationStreamStatusSchema, "ok", "invalid"],
  [Stream.uiStreamHostContextSchema, host, { ...host, streamId: "" }],
  [Stream.visualizationStreamEnvelopeSchema, envelope, { ...envelope, sequence: -1 }],
  [Stream.uiStreamCallToolResultSchema, result, { content: "wrong" }],
  [
    Stream.uiStreamResultPatchNotificationSchema,
    { method: Stream.UI_STREAM_RESULT_PATCH_METHOD, params: result },
    { method: "wrong", params: result },
  ],
  [
    Stream.serverStreamResultPatchNotificationSchema,
    { method: Stream.SERVER_STREAM_RESULT_PATCH_METHOD, params: { streamToken: "token", result } },
    { method: Stream.SERVER_STREAM_RESULT_PATCH_METHOD, params: { streamToken: "", result } },
  ],
] as const;
for (const [index, [schema, good, bad]] of fixtures.entries()) {
  test(`stream schema ${index}`, () => {
    assert.equal(Value.Check(schema, good), true);
    assert.equal(Value.Check(schema, bad), false);
  });
}
test("passthrough result retains unknown fields", () => {
  assert.deepEqual(Value.Clean(Stream.uiStreamCallToolResultSchema, Value.Clone(result)), result);
});
test("getters strip unknown keys without mutating input or loose records", () => {
  const inputHost = { ...host, extra: "removed" };
  assert.deepEqual(
    Stream.getUiStreamHostContext({ [Stream.UI_STREAM_HOST_CONTEXT_KEY]: inputHost }),
    host,
  );
  assert.equal(inputHost.extra, "removed");
  const spec = { arbitrary: { nested: 1 } };
  const inputEnvelope = { ...envelope, spec, checkpoint: { extension: true }, extra: "removed" };
  assert.deepEqual(
    Stream.getVisualizationStreamEnvelope({
      [Stream.UI_STREAM_STRUCTURED_CONTENT_KEY]: inputEnvelope,
    }),
    { ...envelope, spec, checkpoint: { extension: true } },
  );
  assert.equal(inputEnvelope.extra, "removed");
  assert.deepEqual(spec, { arbitrary: { nested: 1 } });
});
test("getters reject malformed and missing candidates", () => {
  assert.equal(Stream.getUiStreamHostContext(undefined), undefined);
  assert.equal(
    Stream.getUiStreamHostContext({
      [Stream.UI_STREAM_HOST_CONTEXT_KEY]: { ...host, partialInput: "bad" },
    }),
    undefined,
  );
  for (const value of [
    null,
    [],
    {},
    { [Stream.UI_STREAM_STRUCTURED_CONTENT_KEY]: { ...envelope, sequence: 1.5 } },
  ]) {
    assert.equal(Stream.getVisualizationStreamEnvelope(value), undefined);
  }
});
