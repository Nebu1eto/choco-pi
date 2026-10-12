/**
 * Purpose: Guard model-facing output fidelity and job-step compilation regressions.
 * Responsibilities: Assert URL redaction leaves non-sensitive text byte-identical, and job steps compile to upstream argv verbatim.
 * Scope: Pure helpers only; no browser, network, or external CLI.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileAgentBrowserJob } from "../extensions/agent-browser/lib/input-modes/job.ts";
import { AGENT_BROWSER_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.ts";
import {
  redactInvocationArgs,
  redactSensitiveText,
  redactSensitiveValue,
} from "../extensions/agent-browser/lib/runtime.ts";
import { Value } from "typebox/value";

test("redaction does not normalize URLs that carry no secrets", () => {
  assert.equal(redactSensitiveText("wss://waku.example.com"), "wss://waku.example.com");
  assert.equal(
    redactSensitiveText("see https://Example.com/a/../b ok"),
    "see https://Example.com/a/../b ok",
  );
  assert.deepEqual(redactSensitiveValue({ result: "wss://waku.example.com" }), {
    result: "wss://waku.example.com",
  });
  const nested = JSON.stringify({ html: 'placeholder="wss://waku.example.com"' });
  assert.equal(redactSensitiveText(nested), nested);
  assert.deepEqual(
    redactInvocationArgs(["fill", "input[placeholder='wss://waku.example.com']", "x"]),
    ["fill", "input[placeholder='wss://waku.example.com']", "x"],
  );
});

test("redaction still removes URL credentials and sensitive parameters", () => {
  const redacted = redactSensitiveText("https://user:pw@example.com/cb?token=abc&page=2");
  assert.doesNotMatch(redacted, /user|pw|abc/);
  assert.match(redacted, /page=2/);
});

test("job selectors and engines pass through to upstream argv unchanged", () => {
  const compiled = compileAgentBrowserJob({
    steps: [
      { action: "fill", selector: "input[placeholder='Search models…']", text: "haiku" },
      { action: "click", selector: "text=Claude Haiku 5.5" },
    ],
  });
  assert.equal(compiled.error, undefined);
  assert.deepEqual(
    compiled.compiled?.steps.map((step) => step.args),
    [
      ["fill", "input[placeholder='Search models…']", "haiku"],
      ["click", "text=Claude Haiku 5.5"],
    ],
  );
});

test("job press step compiles to upstream press and is schema-valid", () => {
  const job = {
    steps: [
      { action: "click", selector: "@e1" },
      { action: "press", press: "Enter" },
    ],
  };
  assert.equal(Value.Check(AGENT_BROWSER_PARAMS, { job }), true);
  const compiled = compileAgentBrowserJob(job);
  assert.equal(compiled.error, undefined);
  assert.deepEqual(compiled.compiled?.steps[1]?.args, ["press", "Enter"]);
  assert.equal(
    compiled.compiled?.stdin,
    JSON.stringify([
      ["click", "@e1"],
      ["press", "Enter"],
    ]),
  );
  assert.match(
    compileAgentBrowserJob({ steps: [{ action: "press" }] }).error ?? "",
    /press requires a non-empty press key/,
  );
  assert.match(
    compileAgentBrowserJob({ steps: [{ action: "press", press: "Enter", selector: "#a" }] })
      .error ?? "",
    /does not support selector/,
  );
});
