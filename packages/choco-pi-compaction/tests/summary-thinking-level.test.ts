import assert from "node:assert/strict";
import { test } from "node:test";

import { summaryThinkingLevel } from "../src/summarize.ts";

// GLM-5.3 as the Synthetic catalog ships it: only high and max are usable.
const GLM = {
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};

test("a summary asks for the lowest thinking level the model supports", () => {
  assert.equal(summaryThinkingLevel(GLM, "high"), "high");
  assert.equal(summaryThinkingLevel(GLM, "max"), "high");
  assert.equal(summaryThinkingLevel({ reasoning: true }, "max"), "minimal");
  assert.equal(
    summaryThinkingLevel({ reasoning: true, thinkingLevelMap: { minimal: null } }, "high"),
    "low",
  );
});

test("a summary never reasons above the session level", () => {
  // A model whose only supported levels sit above the session's level keeps the session level.
  assert.equal(summaryThinkingLevel(GLM, "low"), "low");
  assert.equal(summaryThinkingLevel({ reasoning: true }, "low"), "minimal");
});

test("off and non-reasoning models send no level", () => {
  assert.equal(summaryThinkingLevel(GLM, "off"), undefined);
  assert.equal(summaryThinkingLevel(GLM, undefined), undefined);
  assert.equal(
    summaryThinkingLevel({ reasoning: false, thinkingLevelMap: GLM.thinkingLevelMap }, "high"),
    undefined,
  );
});
