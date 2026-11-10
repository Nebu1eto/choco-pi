import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRINT_WAIT_MS,
  printWaitLimitMs,
  waitForBackgroundSettle,
} from "../src/print-settle-wait.ts";

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

test("subagents: returns at once when nothing is pending", async () => {
  let slept = false;
  const outcome = await waitForBackgroundSettle({
    isBusy: () => false,
    deliveries: () => 0,
    isCancelled: () => false,
    maxWaitMs: 1_000,
    sleep: async () => {
      slept = true;
    },
  });
  assert.equal(outcome, "idle");
  assert.equal(slept, false);
});

test("subagents: waits until a completion is delivered", async () => {
  const c = clock();
  let delivered = 0;
  const outcome = await waitForBackgroundSettle({
    isBusy: () => delivered === 0,
    deliveries: () => delivered,
    isCancelled: () => false,
    maxWaitMs: 10_000,
    now: c.now,
    sleep: async (ms) => {
      await c.sleep(ms);
      if (c.now() >= 1_000) delivered = 1;
    },
  });
  assert.equal(outcome, "delivered");
  assert.equal(c.now(), 1_000);
});

test("subagents: needs two idle checks before giving up on a delivery", async () => {
  const c = clock();
  const busy = [true, false, false];
  let index = 0;
  const outcome = await waitForBackgroundSettle({
    isBusy: () => busy[Math.min(index++, busy.length - 1)] ?? false,
    deliveries: () => 0,
    isCancelled: () => false,
    maxWaitMs: 10_000,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(outcome, "idle");
  assert.equal(c.now(), 100);
});

test("subagents: stops at the cap and on cancellation", async () => {
  const c = clock();
  const capped = await waitForBackgroundSettle({
    isBusy: () => true,
    deliveries: () => 0,
    isCancelled: () => false,
    maxWaitMs: 1_000,
    pollMs: 250,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(capped, "timeout");
  assert.equal(c.now(), 1_000);
  let cancelled = false;
  const stopped = await waitForBackgroundSettle({
    isBusy: () => true,
    deliveries: () => 0,
    isCancelled: () => cancelled,
    maxWaitMs: 10_000,
    sleep: async () => {
      cancelled = true;
    },
  });
  assert.equal(stopped, "cancelled");
});

test("subagents: parses the wait cap", () => {
  assert.equal(printWaitLimitMs(undefined), DEFAULT_PRINT_WAIT_MS);
  assert.equal(printWaitLimitMs(""), DEFAULT_PRINT_WAIT_MS);
  assert.equal(printWaitLimitMs("0"), 0);
  assert.equal(printWaitLimitMs("1500"), 1_500);
  assert.equal(printWaitLimitMs("-1"), DEFAULT_PRINT_WAIT_MS);
  assert.equal(printWaitLimitMs("abc"), DEFAULT_PRINT_WAIT_MS);
});
