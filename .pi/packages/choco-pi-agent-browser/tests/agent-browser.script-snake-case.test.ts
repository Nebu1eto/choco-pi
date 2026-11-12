import assert from "node:assert/strict";
import test from "node:test";

import {
  runAgentBrowserScript,
  toScriptBrowserEnvelopeView,
  validateAgentBrowserScriptBrowserParams,
} from "../extensions/agent-browser/lib/input-modes/script.ts";

test("script browser() accepts timeout_ms and rejects the former timeoutMs", () => {
  const accepted = validateAgentBrowserScriptBrowserParams({
    args: ["get", "title"],
    timeout_ms: 2_000,
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.params?.timeoutMs, 2_000);

  const rejected = validateAgentBrowserScriptBrowserParams({
    args: ["get", "title"],
    timeoutMs: 2_000,
  });
  assert.equal(rejected.params, undefined);
  assert.match(
    String(rejected.error),
    /does not support timeoutMs; use only args, stdin, and timeout_ms/,
  );

  const invalid = validateAgentBrowserScriptBrowserParams({
    args: ["get", "title"],
    timeout_ms: 0,
  });
  assert.match(String(invalid.error), /timeout_ms must be a positive integer/);
});

test("the script-visible browser() envelope uses snake_case keys", () => {
  const view = toScriptBrowserEnvelopeView({
    data: { title: "Fixture" },
    details: { resultCategory: "failure", failureCategory: "timeout" },
    diagnostic: {
      code: "timeout",
      hint: "Retry later.",
      origin: "cli",
      outcome: "unknown",
      retryAfterMs: 50,
      retryable: true,
    },
    error: "Timed out.",
    failureCategory: "timeout",
    nextActions: [
      { id: "retry", params: { args: ["get", "title"] }, reason: "Retry.", tool: "agent_browser" },
    ],
    ok: false,
    resultCategory: "failure",
    summary: "Timed out.",
    text: "Timed out.",
  });
  assert.deepEqual(Object.keys(view).sort(), [
    "data",
    "details",
    "diagnostic",
    "error",
    "failure_category",
    "next_actions",
    "ok",
    "result_category",
    "success_category",
    "summary",
    "text",
  ]);
  assert.deepEqual(view.details, { result_category: "failure", failure_category: "timeout" });
  assert.deepEqual(view.diagnostic, {
    code: "timeout",
    hint: "Retry later.",
    origin: "cli",
    outcome: "unknown",
    retry_after_ms: 50,
    retryable: true,
  });
  assert.equal(JSON.stringify(view).match(/"[a-z]+[A-Z][A-Za-z]*":/), null);
});

test("a sandboxed script reads the snake_case envelope and cannot pass timeoutMs", async () => {
  const run = await runAgentBrowserScript({
    code: [
      'const ok = await browser({ args: ["get", "title"], timeout_ms: 1000 });',
      'const old = await browser({ args: ["get", "title"], timeoutMs: 1000 });',
      "emit({ category: ok.result_category, success: ok.success_category, legacy: ok.resultCategory,",
      "  rejected: old.ok, rejectedCategory: old.failure_category });",
    ].join("\n"),
    dispatch: async (params) => {
      assert.equal(params.timeoutMs, 1_000);
      return {
        data: { title: "Fixture" },
        ok: true,
        resultCategory: "success",
        successCategory: "inspection",
        summary: "Fixture",
        text: "Fixture",
      };
    },
    timeoutMs: 5_000,
  });
  assert.equal(run.ok, true, run.error ?? "script failed");
  assert.equal(run.callCount, 2);
  assert.equal(run.rejectedCallCount, 1);
  assert.deepEqual(run.data, {
    category: "success",
    success: "inspection",
    rejected: false,
    rejectedCategory: "validation-error",
  });
});
