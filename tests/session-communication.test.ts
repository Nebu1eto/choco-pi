import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueSessionDelivery,
  limitSessionWait,
  SESSION_WAIT_LIMIT_MS,
} from "../.pi/extensions/lib/session-communication.ts";

test("session waits are limited to one five-second grace period", () => {
  assert.equal(SESSION_WAIT_LIMIT_MS, 5_000);
  assert.equal(limitSessionWait(30_000), 5_000);
  assert.equal(limitSessionWait(250), 250);
  assert.equal(limitSessionWait(-1), 0);
});

test("session delivery is queued without awaiting the receiving turn", async () => {
  let finishDelivery: (() => void) | undefined;
  let started = false;
  const queue = { deliveryChain: Promise.resolve() };

  enqueueSessionDelivery(
    queue,
    () =>
      new Promise<void>((resolve) => {
        started = true;
        finishDelivery = resolve;
      }),
  );

  assert.equal(started, false);
  await Promise.resolve();
  assert.equal(started, true);
  finishDelivery?.();
  await queue.deliveryChain;
});
