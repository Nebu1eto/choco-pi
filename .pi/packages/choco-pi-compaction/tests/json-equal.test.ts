import assert from "node:assert/strict";
import test from "node:test";

import { jsonEqual } from "../src/background/json-equal.ts";

test("jsonEqual compares arrays in order and objects regardless of key order", () => {
  assert.ok(jsonEqual([1, 2], [1, 2]));
  assert.ok(!jsonEqual([1, 2], [2, 1]));
  assert.ok(!jsonEqual([1], [1, 2]));
  assert.ok(jsonEqual({ a: 1, b: { c: [1, null] } }, { b: { c: [1, null] }, a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }), "an extra key on either side differs");
  assert.ok(!jsonEqual({ a: 1, b: 2 }, { a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { b: 1 }));
  assert.ok(!jsonEqual({ a: { b: 1 } }, { a: { b: 2 } }));
});

test("jsonEqual separates kinds and compares primitives with ===", () => {
  assert.ok(jsonEqual("x", "x") && !jsonEqual("x", "y"));
  assert.ok(jsonEqual(null, null) && !jsonEqual(null, undefined) && !jsonEqual(null, {}));
  assert.ok(!jsonEqual({}, []), "an object is not an array");
  assert.ok(!jsonEqual([], {}));
  assert.ok(!jsonEqual(1, "1") && !jsonEqual(0, false));
  assert.ok(jsonEqual(0, -0), "+0 equals -0");
  assert.ok(!jsonEqual(Number.NaN, Number.NaN), "NaN differs from itself");
  assert.ok(!jsonEqual({ a: undefined }, {}), "an undefined-valued key is still a key");
});
