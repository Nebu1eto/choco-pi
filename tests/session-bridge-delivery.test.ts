import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveSessionDeliveryMode,
  submitSessionDelivery,
} from "../.pi/extensions/lib/session-communication.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  releaseMailboxSubmission,
  reserveMailboxSubmission,
  type SubmittedMailboxClaim,
} from "../.pi/extensions/lib/session-mailbox-delivery.ts";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("legacy queue and omitted mode are effective steering deliveries", () => {
  assert.equal(effectiveSessionDeliveryMode(), "steer");
  assert.equal(effectiveSessionDeliveryMode("steer"), "steer");
  assert.equal(effectiveSessionDeliveryMode("queue"), "steer");
});

test("submitted mailbox claims prevent same-process recovery duplicates and can retry failures", () => {
  const submitted = new Map<string, SubmittedMailboxClaim>();
  const claim = { claimedPath: "/mail/one.claimed", sourcePath: "/mail/one.json", submittedAt: 1 };
  assert.equal(reserveMailboxSubmission(submitted, "one", claim), true);
  assert.equal(reserveMailboxSubmission(submitted, "one", claim), false);
  assert.equal(submitted.size, 1);
  releaseMailboxSubmission(submitted, "one");
  assert.equal(reserveMailboxSubmission(submitted, "one", claim), true);
});

test("a burst is submitted in order without waiting for earlier receiving turns", async () => {
  const first = deferred();
  const second = deferred();
  const submitted: string[] = [];
  const errors: RuntimeValue[] = [];
  const tracker = {
    deliveries: new Set<Promise<void>>(),
    onError: (error: RuntimeValue) => errors.push(error),
  };

  submitSessionDelivery(tracker, () => {
    submitted.push("first");
    return first.promise;
  });
  submitSessionDelivery(tracker, () => {
    submitted.push("second");
    return second.promise;
  });

  assert.deepEqual(submitted, ["first", "second"]);
  assert.equal(tracker.deliveries.size, 2);
  second.resolve();
  await Promise.resolve();
  assert.equal(tracker.deliveries.size, 1);
  first.resolve();
  await Promise.resolve();
  assert.equal(tracker.deliveries.size, 0);
  assert.deepEqual(errors, []);
});
