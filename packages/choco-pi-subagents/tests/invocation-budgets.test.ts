import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import {
  bootstrapFloorRefusal,
  estimateBootstrapTokens,
  RunBudgetController,
} from "../src/run-budgets.ts";
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

function budgetController(maxTokens: number) {
  const stops: Array<{ status: string; reason: string }> = [];
  const controller = new RunBudgetController(
    { maxTokens },
    {
      isActive: () => true,
      steerConclusion: () => {},
      stop: (status, reason) => {
        stops.push({ status, reason });
      },
      onDispose: () => {},
    },
  );
  return { controller, stops };
}

test("bootstrap estimate counts system prompt and tool schemas at four chars per token", () => {
  const estimate = estimateBootstrapTokens({
    systemPrompt: "x".repeat(4000),
    tools: [{ name: "read", description: "y".repeat(396), parameters: { type: "object" } }],
  });
  // 4000 + 4 + 396 + JSON '{"type":"object"}' (17) = 4417 chars → 1105 tokens.
  assert.equal(estimate, 1105);
});

test("a token cap below 1.5x the bootstrap estimate is refused before the first request", () => {
  assert.equal(
    bootstrapFloorRefusal(20_000, 18_000),
    "max_tokens 20000 is below the estimated first request (~18000 tokens); omit the field or set >= 27000",
  );
  assert.equal(bootstrapFloorRefusal(27_000, 18_000), undefined);
  assert.equal(bootstrapFloorRefusal(undefined, 18_000), undefined);

  const refused = budgetController(20_000);
  assert.equal(refused.controller.checkBootstrap(18_000), false);
  assert.deepEqual(refused.stops, [
    {
      status: "budget_exceeded",
      reason:
        "max_tokens 20000 is below the estimated first request (~18000 tokens); omit the field or set >= 27000",
    },
  ]);

  const allowed = budgetController(100_000);
  assert.equal(allowed.controller.checkBootstrap(18_000), true);
  assert.deepEqual(allowed.stops, []);
  allowed.controller.dispose();
});

test("token budget exhaustion names the last request's input, cache write and output", () => {
  const { controller, stops } = budgetController(1_000);
  controller.noteUsage({ input: 700, output: 100, cacheWrite: 300 });
  assert.deepEqual(stops, [
    {
      status: "budget_exceeded",
      reason:
        "Token budget exceeded at 1100 tokens (limit 1000). (last request: input 700, cacheWrite 300, output 100)",
    },
  ]);
});
