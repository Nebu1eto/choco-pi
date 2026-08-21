import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheableSegments,
  canonicalJson,
  diffCacheableSegments,
} from "../.pi/extensions/cache-probe.ts";

test("canonicalJson is stable across object key order", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: true, a: null }], a: "value" }),
    canonicalJson({ a: "value", b: [2, { a: null, z: true }] }),
  );
});

test("cacheableSegments includes messages only through the last cache breakpoint", () => {
  const snapshot = cacheableSegments({
    system: [{ type: "text", text: "system" }],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "cached history" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  });

  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["system", "tools", "message"],
  );
  assert.deepEqual(snapshot.toolNames, ["read"]);
});

test("diffCacheableSegments identifies tool changes and segment growth", () => {
  const previous = cacheableSegments({
    system: "system",
    tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
  });
  const changedTools = cacheableSegments({
    system: "system",
    tools: [{ name: "grep", description: "Search", input_schema: { type: "object" } }],
  });
  const grownMessages = cacheableSegments({
    system: "system",
    tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "cached", cache_control: {} }] }],
  });

  assert.deepEqual(diffCacheableSegments(previous.segments, changedTools.segments), {
    firstDivergence: 1,
    divergedKind: "tools",
    segmentsAdded: 0,
    segmentsRemoved: 0,
  });
  assert.deepEqual(diffCacheableSegments(previous.segments, grownMessages.segments), {
    firstDivergence: 2,
    divergedKind: "message",
    segmentsAdded: 1,
    segmentsRemoved: 0,
  });
});
