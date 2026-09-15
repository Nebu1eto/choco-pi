import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "../src/math.ts";

test("sum adds two numbers", () => {
  assert.equal(sum(2, 3), 5);
});
