import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { AGENT_BROWSER_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.ts";

test("provider schema omits prose without weakening representative constraints", () => {
  assert.doesNotMatch(JSON.stringify(AGENT_BROWSER_PARAMS), /"description"/);
  assert.equal(Value.Check(AGENT_BROWSER_PARAMS, { args: ["open", "https://example.com"] }), true);
  assert.equal(
    Value.Check(AGENT_BROWSER_PARAMS, { electron: { action: "cleanup", all: true } }),
    true,
  );
  assert.equal(Value.Check(AGENT_BROWSER_PARAMS, { args: [] }), false);
  assert.equal(Value.Check(AGENT_BROWSER_PARAMS, { electron: { action: "invalid" } }), false);
});
