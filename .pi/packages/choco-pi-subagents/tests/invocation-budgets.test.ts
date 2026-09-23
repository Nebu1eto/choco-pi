import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import { buildInvocationTags } from "../src/ui/agent-widget.ts";

test("per-spawn budget parameters survive invocation resolution and UI metadata", () => {
  const resolved = resolveAgentInvocationConfig(undefined, {
    timeout_ms: 12_000,
    max_tool_calls: 8,
    max_tokens: 50_000,
    idle_timeout_ms: 3_000,
  });

  assert.deepEqual(
    {
      timeoutMs: resolved.timeoutMs,
      maxToolCalls: resolved.maxToolCalls,
      maxTokens: resolved.maxTokens,
      idleTimeoutMs: resolved.idleTimeoutMs,
    },
    { timeoutMs: 12_000, maxToolCalls: 8, maxTokens: 50_000, idleTimeoutMs: 3_000 },
  );
  assert.deepEqual(
    buildInvocationTags({
      timeoutMs: resolved.timeoutMs,
      maxToolCalls: resolved.maxToolCalls,
      maxTokens: resolved.maxTokens,
      idleTimeoutMs: resolved.idleTimeoutMs,
    }).tags,
    ["timeout: 12000ms", "max tools: 8", "max tokens: 50000", "idle: 3000ms"],
  );
});

test("fast mode resolves from caller over definition and renders focused metadata", () => {
  const resolved = resolveAgentInvocationConfig(
    {
      name: "fast-probe",
      description: "probe",
      extensions: false,
      skills: false,
      systemPrompt: "probe",
      promptMode: "replace",
      fastMode: false,
    },
    { fast_mode: true },
  );
  assert.equal(resolved.fastMode, true);
  assert.deepEqual(buildInvocationTags({ fastMode: resolved.fastMode }).tags, ["fast"]);
});

test("run mode defaults to the caller's context while explicit choices win", () => {
  const params = { inherit_context: false };
  const top = { defaultRunInBackground: true };
  assert.equal(resolveAgentInvocationConfig(undefined, params).runInBackground, false);
  assert.equal(resolveAgentInvocationConfig(undefined, params, top).runInBackground, true);
  assert.equal(
    resolveAgentInvocationConfig(undefined, { ...params, run_in_background: false }, top)
      .runInBackground,
    false,
  );
});
