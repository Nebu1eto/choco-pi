import assert from "node:assert/strict";
import test from "node:test";
import { shouldHandleMentionCloneCompletion } from "../src/mention-clone.ts";

test("fresh context wrappers in one activation generation allow the completion", () => {
  const sessionStartCtx = {};
  const inputCtx = {};
  const generation = 1;

  assert.notEqual(inputCtx, sessionStartCtx);
  assert.equal(shouldHandleMentionCloneCompletion(generation, generation), true);
});

test("undefined and replacement activation generations reject the completion", () => {
  assert.equal(shouldHandleMentionCloneCompletion(undefined, undefined), false);
  assert.equal(shouldHandleMentionCloneCompletion(1, undefined), false);
  assert.equal(shouldHandleMentionCloneCompletion(undefined, 1), false);
  assert.equal(shouldHandleMentionCloneCompletion(1, 2), false);
});
