import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PreparationLimiter,
  processPreparationLimiter,
  waitUntil,
  type SchedulerClock,
} from "../src/background/scheduler.ts";
import { deferred } from "./background-fakes.ts";

class Clock implements SchedulerClock {
  time = 0;
  callbacks: (() => void)[] = [];
  now(): number {
    return this.time;
  }
  setTimer(callback: () => void, _delayMs: number): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((value) => value !== callback);
    };
  }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function work(
  limiter: PreparationLimiter,
  clock: Clock,
  ownerKey: string,
  options: {
    cap?: number;
    maxQueued?: number;
    headroom?: number;
    run?: () => Promise<void>;
  } = {},
) {
  const abort = new AbortController();
  const started = deferred<void>();
  const release = deferred<void>();
  const scheduled = limiter.submit({
    ownerKey,
    cap: options.cap ?? 1,
    maxQueued: options.maxQueued ?? 10,
    headroom: options.headroom ?? 100,
    clock,
    signal: abort.signal,
    run: async () => {
      started.resolve();
      await (options.run?.() ?? release.promise);
    },
  });
  return { abort, started, release, scheduled };
}

test("process-local shared limiter caps different owners and rejects a second request for the same owner", async () => {
  const clock = new Clock();
  const first = work(processPreparationLimiter, clock, "main", { cap: 2 });
  const second = work(processPreparationLimiter, clock, "child-a", { cap: 2 });
  const third = work(processPreparationLimiter, clock, "child-b", { cap: 2 });
  await Promise.all([first.started.promise, second.started.promise]);
  let thirdStarted = false;
  void third.started.promise.then(() => {
    thirdStarted = true;
  });
  assert.equal(work(processPreparationLimiter, clock, "main").scheduled.accepted, false);
  await flush();
  assert.equal(thirdStarted, false);
  first.release.resolve();
  await first.scheduled.completed;
  await third.started.promise;
  second.release.resolve();
  third.release.resolve();
  await Promise.all([second.scheduled.completed, third.scheduled.completed]);
});

test("age dominates urgency so queued children do not starve; headroom orders equal-age ties", async () => {
  const limiter = new PreparationLimiter();
  const clock = new Clock();
  const active = work(limiter, clock, "active");
  await active.started.promise;
  const olderChild = work(limiter, clock, "older-child", { headroom: 1000 });
  clock.time = 1;
  const laterParent = work(limiter, clock, "later-parent", { headroom: 0 });
  const laterChild = work(limiter, clock, "later-child", { headroom: 1 });
  const order: string[] = [];
  void olderChild.started.promise.then(() => {
    order.push("older-child");
  });
  void laterParent.started.promise.then(() => {
    order.push("later-parent");
  });
  void laterChild.started.promise.then(() => {
    order.push("later-child");
  });
  active.release.resolve();
  await olderChild.started.promise;
  await flush();
  assert.deepEqual(order, ["older-child"]);
  olderChild.release.resolve();
  await laterParent.started.promise;
  await flush();
  assert.deepEqual(order, ["older-child", "later-parent"]);
  laterParent.release.resolve();
  await laterChild.started.promise;
  laterChild.release.resolve();
  await laterChild.scheduled.completed;
  assert.deepEqual(order, ["older-child", "later-parent", "later-child"]);
});

test("queued cancellation settles once without running; queue bounds and pre-aborted requests refuse", async () => {
  const limiter = new PreparationLimiter();
  const clock = new Clock();
  const active = work(limiter, clock, "active");
  await active.started.promise;
  const queued = work(limiter, clock, "queued", { maxQueued: 1 });
  assert.equal(work(limiter, clock, "over-limit", { maxQueued: 1 }).scheduled.accepted, false);
  let runs = 0;
  void queued.started.promise.then(() => {
    runs++;
  });
  queued.abort.abort();
  queued.abort.abort();
  await queued.scheduled.completed;
  active.release.resolve();
  await active.scheduled.completed;
  await flush();
  assert.equal(runs, 0);
  const aborted = new AbortController();
  aborted.abort();
  const scheduled = limiter.submit({
    ownerKey: "aborted",
    cap: 1,
    maxQueued: 1,
    headroom: 0,
    clock,
    signal: aborted.signal,
    run: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(scheduled.accepted, false);
});

test("abort-ignoring active work retains its slot until physical settlement", async () => {
  const limiter = new PreparationLimiter();
  const clock = new Clock();
  const active = work(limiter, clock, "active");
  await active.started.promise;
  const next = work(limiter, clock, "next");
  let runs = 0;
  void next.started.promise.then(() => {
    runs++;
  });
  active.abort.abort();
  await flush();
  assert.equal(runs, 0);
  active.release.resolve();
  await next.started.promise;
  next.release.resolve();
  await next.scheduled.completed;
  assert.equal(runs, 1);
});

test("different cap configurations obey the lower active limit and rejected work releases capacity", async () => {
  const limiter = new PreparationLimiter();
  const clock = new Clock();
  const error = new Error("backend throw");
  const active = work(limiter, clock, "active", { cap: 1 });
  await active.started.promise;
  const next = work(limiter, clock, "next", { cap: 4, run: () => Promise.reject(error) });
  let nextStarted = false;
  void next.started.promise.then(() => {
    nextStarted = true;
  });
  await flush();
  assert.equal(nextStarted, false);
  active.release.resolve();
  assert.deepEqual(await next.scheduled.completed, { ok: false, cause: error });
  const last = work(limiter, clock, "last");
  await last.started.promise;
  last.release.resolve();
  await last.scheduled.completed;
});

test("backoff is abortable, timer resources are released, and already-aborted waits do not schedule", async () => {
  const clock = new Clock();
  const abort = new AbortController();
  const waiting = waitUntil(clock, 10, abort.signal);
  assert.equal(clock.callbacks.length, 1);
  abort.abort();
  await waiting;
  assert.equal(clock.callbacks.length, 0);
  await waitUntil(clock, 10, abort.signal);
  assert.equal(clock.callbacks.length, 0);
  const running = new AbortController();
  const timeout = waitUntil(clock, 1, running.signal);
  clock.callbacks[0]?.();
  await timeout;
  assert.equal(clock.callbacks.length, 0);
});

test("new urgent parents cannot starve an older child even when all timestamps are identical", async () => {
  const limiter = new PreparationLimiter();
  const clock = new Clock();
  const first = work(limiter, clock, "first");
  await first.started.promise;
  const child = work(limiter, clock, "child", { headroom: 1000 });
  const urgent = work(limiter, clock, "urgent", { headroom: 0 });
  first.release.resolve();
  await urgent.started.promise;
  const newer = work(limiter, clock, "newer-urgent", { headroom: 0 });
  let newerStarted = false;
  void newer.started.promise.then(() => {
    newerStarted = true;
  });
  urgent.release.resolve();
  await child.started.promise;
  await flush();
  assert.equal(newerStarted, false);
  child.release.resolve();
  await newer.started.promise;
  newer.release.resolve();
  await newer.scheduled.completed;
});
