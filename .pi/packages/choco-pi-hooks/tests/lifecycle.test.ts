import assert from "node:assert/strict";
import test from "node:test";
import { isStaleContextError, rethrowUnlessStaleContext } from "../src/lifecycle.ts";

test("only the canonical stale-context error is contained", () => {
  const stale = new Error(
    "This extension ctx is stale after session replacement or reload. Additional SDK guidance.",
  );
  const lookalike = new Error(
    "This extension ctx is stale after session replacement or reload.unrelated",
  );
  const unrelated = new Error("dispatch failed");

  assert.equal(isStaleContextError(stale), true);
  assert.doesNotThrow(() => rethrowUnlessStaleContext(stale));
  assert.equal(isStaleContextError(lookalike), false);
  assert.throws(
    () => rethrowUnlessStaleContext(lookalike),
    (error) => error === lookalike,
  );
  assert.equal(isStaleContextError(unrelated), false);
  assert.throws(
    () => rethrowUnlessStaleContext(unrelated),
    (error) => error === unrelated,
  );
});
