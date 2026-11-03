import assert from "node:assert/strict";
import { test } from "node:test";
import { arr, obj } from "@earendil-works/pi-schema";
import {
  InputSchema,
  JsonSchema,
  withArtifactDefs,
} from "./live/background-compaction/artifacts.ts";
import { matches } from "./live/background-compaction/schema-check.ts";

// Regression: an embedded recursive schema needs its $defs on the compiled root;
// without hoisting, pi-schema throws "Unresolved $ref #/$defs/Input".
test("recursive artifact schemas embed inside object schemas", () => {
  const lane = withArtifactDefs(obj({ compaction: InputSchema }, { open: true }));
  assert.equal(matches(lane, { compaction: { a: [1, "x", null, { b: true }] }, extra: 1 }), true);
  assert.equal(matches(lane, { compaction: { a: [Number.NaN] } }), false);
  const nested = withArtifactDefs(
    obj({ payload: obj({ messages: arr(JsonSchema) }, { open: true }) }),
  );
  assert.equal(matches(nested, { payload: { messages: [{ role: "user", content: "hi" }] } }), true);
  assert.equal(matches(nested, { payload: { messages: "no" } }), false);
});

test("an embedded recursive schema without hoisted defs fails closed", () => {
  const bare = obj({ compaction: InputSchema }, { open: true });
  assert.throws(() => matches(bare, { compaction: 1 }), /Unresolved \$ref/);
});
