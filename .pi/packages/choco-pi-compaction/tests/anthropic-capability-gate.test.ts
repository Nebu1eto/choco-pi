/**
 * Static server-side compaction policy: family floors, first-party endpoint,
 * OAuth only, no network; plus replay rejection detection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "@earendil-works/pi-ai";

import type { ProviderScope } from "../src/background/contract.ts";
import {
  AnthropicCapabilityGate,
  capturedProviders,
  modelSupportsServerSideCompaction,
  parseAnthropicModelId,
} from "../src/anthropic/capability.ts";
import { OAUTH_ENTITLEMENT_CODE, replayRejectionCode } from "../src/anthropic/replay-binding.ts";

function scope(model: string, overrides: Partial<ProviderScope> = {}): ProviderScope {
  return {
    provider: "anthropic",
    model,
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    ...overrides,
  };
}

const ADMITTED = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-preview",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-opus-4-6-20260301",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  // Later versions pass the numeric floor.
  "claude-opus-5-6",
  "claude-sonnet-6",
  "claude-haiku-6",
  "claude-fable-10",
];

const REJECTED = [
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4",
  "claude-opus-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-haiku-5",
  "claude-haiku-5-4",
  "claude-mythos-4-9",
  "claude-3-7-sonnet-20250219",
  "claude-unknown-9",
  "claude-mythos-preview-2",
  "opus-4-6",
  "claude-opus-4-6-extra",
];

test("the family floor table admits the documented models and rejects prior versions", () => {
  const gate = new AnthropicCapabilityGate({ enabled: true, cooldownMs: 0 });
  for (const model of ADMITTED) {
    assert.equal(modelSupportsServerSideCompaction(model), true, model);
    assert.deepEqual(gate.check(scope(model)), { supported: true }, model);
  }
  for (const model of REJECTED) {
    assert.equal(modelSupportsServerSideCompaction(model), false, model);
    assert.deepEqual(gate.check(scope(model)), { supported: false, reason: "unsupported" }, model);
  }
  assert.deepEqual(parseAnthropicModelId("claude-opus-4-6-20260301"), {
    family: "opus",
    major: 4,
    minor: 6,
  });
  assert.deepEqual(parseAnthropicModelId("claude-sonnet-6"), {
    family: "sonnet",
    major: 6,
    minor: 0,
  });
});

test("only first-party OAuth on api.anthropic.com is admitted", () => {
  const gate = new AnthropicCapabilityGate({ enabled: true, cooldownMs: 0 });
  const model = "claude-opus-4-6";
  assert.deepEqual(gate.check(scope(model, { baseUrl: "https://api.anthropic.com/" })), {
    supported: true,
  });
  const refused: readonly [string, ProviderScope][] = [
    ["api key", scope(model, { authMode: "api-key" })],
    ["unknown auth mode", scope(model, { authMode: undefined })],
    ["foreign base URL", scope(model, { baseUrl: "https://proxy.example.invalid" })],
    ["base URL with path", scope(model, { baseUrl: "https://api.anthropic.com/v2" })],
    ["no base URL", scope(model, { baseUrl: undefined })],
    ["other provider", scope(model, { provider: "anthropic-proxy" })],
  ];
  for (const [name, item] of refused) {
    assert.deepEqual(gate.check(item), { supported: false, reason: "unsupported" }, name);
  }
  const off = new AnthropicCapabilityGate({ enabled: false, cooldownMs: 0 });
  assert.deepEqual(off.check(scope(model)), { supported: false, reason: "unsupported" });
});

test("cooldown applies per admitted scope under the default policy", () => {
  let clock = 0;
  const gate = new AnthropicCapabilityGate({ enabled: true, cooldownMs: 1_000, now: () => clock });
  const opus = scope("claude-opus-4-6");
  gate.recordFailure(opus, "malformed");
  assert.deepEqual(gate.check(opus), { supported: false, reason: "malformed" });
  assert.deepEqual(gate.check(scope("claude-sonnet-4-6")), { supported: true }, "other model");
  clock += 1_000;
  assert.deepEqual(gate.check(opus), { supported: true });
  // Refused scopes are never tracked.
  gate.recordFailure(scope("claude-opus-4-5"), "malformed");
  assert.equal(gate.cooldownRemaining(scope("claude-opus-4-5")), 0);
});

test("an explicit allow-list replaces the default policy", () => {
  const entry = {
    provider: "synthetic",
    model: "synthetic-model",
    baseUrl: "https://synthetic.invalid",
    authMode: "api-key" as const,
  };
  const gate = new AnthropicCapabilityGate({ enabled: true, cooldownMs: 0, allowList: [entry] });
  assert.deepEqual(gate.check({ ...entry }), { supported: true });
  assert.deepEqual(gate.check(scope("claude-opus-4-6")), {
    supported: false,
    reason: "unsupported",
  });
  assert.deepEqual(capturedProviders(), ["anthropic"]);
  assert.deepEqual(capturedProviders([entry, entry]), ["synthetic"]);
});

function errorResponse(status: number, error: JsonObject): Response {
  return new Response(JSON.stringify({ type: "error", error }), { status });
}

test("replay rejections: compaction_ error codes and the OAuth extra-usage refusal", async () => {
  assert.equal(
    await replayRejectionCode(
      errorResponse(400, {
        type: "invalid_request_error",
        message: "x",
        details: { error_code: "compaction_block_misplaced" },
      }),
    ),
    "compaction_block_misplaced",
  );
  assert.equal(
    await replayRejectionCode(
      errorResponse(400, {
        type: "invalid_request_error",
        message: "Third-party apps now draw from your extra usage, not your plan limits",
      }),
    ),
    OAUTH_ENTITLEMENT_CODE,
  );
  const ignored: readonly Response[] = [
    errorResponse(400, { type: "invalid_request_error", message: "max_tokens too large" }),
    errorResponse(400, { type: "invalid_request_error", details: { error_code: "other_code" } }),
    // Transient: retry, never disable.
    errorResponse(529, {
      type: "overloaded_error",
      message: "x",
      details: { error_code: "compaction_unavailable" },
    }),
    new Response("not json", { status: 400 }),
    new Response("{}", { status: 200 }),
  ];
  for (const response of ignored) {
    assert.equal(await replayRejectionCode(response), undefined);
  }
  // The observer reads a clone: the original body stays readable for the adapter.
  const original = errorResponse(400, {
    type: "invalid_request_error",
    details: { error_code: "compaction_content_mismatch" },
  });
  assert.equal(await replayRejectionCode(original), "compaction_content_mismatch");
  assert.ok((await original.text()).includes("compaction_content_mismatch"));
});
