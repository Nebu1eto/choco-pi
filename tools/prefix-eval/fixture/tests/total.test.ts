import assert from "node:assert/strict";
import test from "node:test";
import { computeTotal } from "../src/index.ts";
import { totalLine } from "../src/report.ts";

test("computeTotal remains available through the module API", () => {
  assert.equal(computeTotal([2, 3, 5]), 10);
  assert.equal(totalLine([2, 3, 5]), "Total: 10");
});
