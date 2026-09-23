import assert from "node:assert/strict";
import test from "node:test";
import {
  limitSessionWait,
  SESSION_WAIT_LIMIT_MS,
  submitSessionDelivery,
} from "../.pi/extensions/lib/session-communication.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

test("session waits are limited to one five-second grace period", () => {
  assert.equal(SESSION_WAIT_LIMIT_MS, 5_000);
  assert.equal(limitSessionWait(30_000), 5_000);
  assert.equal(limitSessionWait(250), 250);
  assert.equal(limitSessionWait(-1), 0);
});

test("subsequent steering delivery starts while the first receiving turn is unresolved", async () => {
  let finishFirst: (() => void) | undefined;
  const starts: number[] = [];
  const errors: RuntimeValue[] = [];
  const tracker = {
    deliveries: new Set<Promise<void>>(),
    onError: (error: RuntimeValue) => errors.push(error),
  };

  submitSessionDelivery(
    tracker,
    () =>
      new Promise<void>((resolve) => {
        starts.push(1);
        finishFirst = resolve;
      }),
  );
  submitSessionDelivery(tracker, async () => {
    starts.push(2);
  });

  assert.deepEqual(starts, [1, 2]);
  await Promise.resolve();
  assert.equal(tracker.deliveries.size, 1);
  finishFirst?.();
  await Promise.resolve();
  assert.equal(tracker.deliveries.size, 0);
  assert.deepEqual(errors, []);
});

test("delivery rejection is observed without blocking later submission", async () => {
  let rejectFirst: ((error: Error) => void) | undefined;
  const errors: RuntimeValue[] = [];
  const tracker = {
    deliveries: new Set<Promise<void>>(),
    onError: (error: RuntimeValue) => errors.push(error),
  };
  submitSessionDelivery(
    tracker,
    () => new Promise<void>((_resolve, reject) => (rejectFirst = reject)),
  );
  submitSessionDelivery(tracker, async () => undefined);
  rejectFirst?.(new Error("receiver rejected"));
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /receiver rejected/);
});
