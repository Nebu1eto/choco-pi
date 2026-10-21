/**
 * Capability gate hooks: the cooldown observer fires only when a cooldown
 * starts, `setCooldownMs` applies to the next failure, and `auth` cools for a
 * fixed, capped wait that never doubles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicCapabilityGate,
  type AnthropicSupportEntry,
  FIXED_COOLDOWN_CAP_MS,
} from "../src/anthropic/capability.ts";
import type { FailureReason, ProviderScope } from "../src/background/contract.ts";

const SCOPE: ProviderScope = {
  provider: "anthropic",
  model: "claude-opus-4-6",
  baseUrl: "https://api.anthropic.com",
  authMode: "oauth",
};

interface Started {
  readonly entry: AnthropicSupportEntry;
  readonly reason: FailureReason;
  readonly until: number;
}

function gate(cooldownMs: number) {
  let time = 1_000;
  const started: Started[] = [];
  const instance = new AnthropicCapabilityGate({
    enabled: true,
    cooldownMs,
    now: () => time,
    onCooldown: (entry, reason, until) => started.push({ entry, reason, until }),
  });
  return {
    gate: instance,
    started,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

test("a transient failure below the streak starts no cooldown and calls no observer", () => {
  const g = gate(60_000);
  g.gate.recordFailure(SCOPE, "timeout");
  g.gate.recordFailure(SCOPE, "529");
  assert.deepEqual(g.started, []);
  assert.deepEqual(g.gate.check(SCOPE), { supported: true });
});

test("the observer is called once when a cooldown starts, with a future until", () => {
  const g = gate(60_000);
  for (let attempt = 0; attempt < 3; attempt++) g.gate.recordFailure(SCOPE, "timeout");
  assert.equal(g.started.length, 1);
  const [started] = g.started;
  assert.equal(started?.reason, "timeout");
  assert.equal(started?.entry.model, SCOPE.model);
  assert.ok((started?.until ?? 0) > g.now());
  assert.equal(started?.until, g.now() + 60_000);
});

test("setCooldownMs applies to the next failure", () => {
  const g = gate(60_000);
  g.gate.setCooldownMs(5_000);
  g.gate.recordFailure(SCOPE, "malformed");
  assert.equal(g.started.at(-1)?.until, g.now() + 5_000);
  assert.equal(g.gate.cooldownRemaining(SCOPE), 5_000);
});

test("auth cools for min(cooldownMs, 300000) and never doubles", () => {
  const g = gate(3_600_000);
  g.gate.recordFailure(SCOPE, "auth");
  assert.equal(g.gate.cooldownRemaining(SCOPE), FIXED_COOLDOWN_CAP_MS);
  g.advance(FIXED_COOLDOWN_CAP_MS);
  g.gate.recordFailure(SCOPE, "auth");
  assert.equal(g.gate.cooldownRemaining(SCOPE), FIXED_COOLDOWN_CAP_MS);
  assert.deepEqual(
    g.started.map((started) => started.until),
    [1_000 + FIXED_COOLDOWN_CAP_MS, 1_000 + 2 * FIXED_COOLDOWN_CAP_MS],
  );

  const short = gate(10_000);
  for (let attempt = 0; attempt < 3; attempt++) short.gate.recordFailure(SCOPE, "auth");
  assert.equal(short.gate.cooldownRemaining(SCOPE), 10_000);
});

test("a non-fixed reason keeps doubling on repeats", () => {
  const g = gate(1_000);
  g.gate.recordFailure(SCOPE, "malformed");
  g.gate.recordFailure(SCOPE, "malformed");
  assert.equal(g.gate.cooldownRemaining(SCOPE), 2_000);
});
