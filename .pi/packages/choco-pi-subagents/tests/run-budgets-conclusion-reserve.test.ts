import assert from "node:assert/strict";
import test from "node:test";

import {
  RunBudgetController,
  type ForcedTerminalStatus,
  type RunBudgetLimits,
} from "../src/run-budgets.ts";

function budgetFixture(limits: RunBudgetLimits) {
  const steers: (string | undefined)[] = [];
  const stops: { status: ForcedTerminalStatus; reason: string }[] = [];
  let disposals = 0;
  let active = true;
  const controller = new RunBudgetController(limits, {
    isActive: () => active,
    steerConclusion: (message) => steers.push(message),
    stop: (status, reason) => stops.push({ status, reason }),
    onDispose: () => disposals++,
  });
  return {
    controller,
    steers,
    stops,
    get disposals() {
      return disposals;
    },
    retire: () => {
      active = false;
    },
  };
}

function charge(controller: RunBudgetController, tokens: number): void {
  controller.noteUsage({ input: tokens * 0.5, output: tokens * 0.25, cacheWrite: tokens * 0.25 });
}

test("20% conclusion reserve steers once at the threshold and preserves the hard limit", () => {
  const run = budgetFixture({ maxTokens: 1000 });
  try {
    for (let request = 0; request < 7; request++) charge(run.controller, 100);
    charge(run.controller, 99);
    assert.deepEqual(run.steers, []);
    charge(run.controller, 1);
    assert.deepEqual(run.steers, [
      "About 200 tokens remain of your 1000-token budget; conclude now with your current findings in the required output format.",
    ]);
    charge(run.controller, 199);
    assert.equal(run.steers.length, 1);
    assert.deepEqual(run.stops, []);
    charge(run.controller, 1);
    charge(run.controller, 1000);
    run.controller.noteToolActivity("end");
    assert.deepEqual(run.stops, [
      { status: "budget_exceeded", reason: "Token budget exceeded at 1000 tokens (limit 1000)." },
    ]);
    assert.equal(run.steers.length, 1);
    assert.equal(run.disposals, 1);
  } finally {
    run.controller.dispose();
  }
});

test("reserve follows the largest observed request but never steers before half the grant", () => {
  const run = budgetFixture({ maxTokens: 1000 });
  try {
    charge(run.controller, 300);
    charge(run.controller, 199);
    assert.deepEqual(run.steers, []);
    charge(run.controller, 50);
    assert.deepEqual(run.steers, []);
    charge(run.controller, 1);
    assert.match(run.steers[0] ?? "", /About 450 tokens remain of your 1000-token budget/);
    charge(run.controller, 400);
    assert.equal(run.steers.length, 1);
    assert.deepEqual(run.stops, []);
  } finally {
    run.controller.dispose();
  }

  const large = budgetFixture({ maxTokens: 1000 });
  try {
    charge(large.controller, 499);
    assert.deepEqual(large.steers, []);
    charge(large.controller, 1);
    assert.match(large.steers[0] ?? "", /About 500 tokens remain/);
  } finally {
    large.controller.dispose();
  }
});

test("a cold-start request spending 73% steers at message_end without stopping", () => {
  const run = budgetFixture({ maxTokens: 24000 });
  try {
    charge(run.controller, 17520);
    assert.equal(run.steers.length, 1);
    assert.match(run.steers[0] ?? "", /About 6480 tokens remain of your 24000-token budget/);
    assert.deepEqual(run.stops, []);
    charge(run.controller, 1000);
    assert.equal(run.steers.length, 1);
    assert.deepEqual(run.stops, []);
  } finally {
    run.controller.dispose();
  }
});

for (const firstCharge of [1000, 1200]) {
  test(`a single ${firstCharge}-token request exhausting the grant stops once without steering`, () => {
    const run = budgetFixture({ maxTokens: 1000 });
    charge(run.controller, firstCharge);
    charge(run.controller, firstCharge);
    run.controller.dispose();
    assert.deepEqual(run.steers, []);
    assert.deepEqual(run.stops, [
      {
        status: "budget_exceeded",
        reason: `Token budget exceeded at ${firstCharge} tokens (limit 1000).`,
      },
    ]);
    assert.equal(run.disposals, 1);
  });
}

test("retired and unlimited generations do not steer; a fresh generation gets a new reserve", () => {
  const retired = budgetFixture({ maxTokens: 1000 });
  const unlimited = budgetFixture({});
  const fresh = budgetFixture({ maxTokens: 1000 });
  try {
    retired.retire();
    charge(retired.controller, 900);
    charge(unlimited.controller, 10000);
    assert.deepEqual(retired.steers, []);
    assert.deepEqual(retired.stops, []);
    assert.deepEqual(unlimited.steers, []);
    assert.deepEqual(unlimited.stops, []);
    charge(fresh.controller, 730);
    assert.equal(fresh.steers.length, 1);
  } finally {
    retired.controller.dispose();
    unlimited.controller.dispose();
    fresh.controller.dispose();
  }
});

test("token conclusion does not consume the idle watchdog's initial warning", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = budgetFixture({ maxTokens: 1000, idleTimeoutMs: 10 });
  try {
    charge(run.controller, 730);
    t.mock.timers.tick(10);
    assert.equal(run.steers.length, 2);
    assert.equal(run.steers[1], undefined);
    assert.equal(run.stops.length, 0);
    t.mock.timers.tick(10);
    charge(run.controller, 1000);
    assert.equal(run.steers.length, 2);
    assert.equal(run.stops.length, 1);
    assert.equal(run.stops[0]?.status, "watchdog_stopped");
    assert.equal(run.disposals, 1);
  } finally {
    run.controller.dispose();
  }
});
