import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { isNativeSteerPending, NotificationGate } from "../src/notification-gate.ts";

interface RecordFixture {
  id: string;
  resultConsumed: boolean;
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const records = new Map<string, RecordFixture>();
  const messages: string[][] = [];
  const errors: unknown[] = [];
  let pending = false;
  const gate = new NotificationGate({
    resolve: (key) => records.get(key),
    send: (batch) => messages.push(batch.map((record) => record.id)),
    isSteerPending: () => pending,
    onError: (error) => errors.push(error),
  });
  gate.start("session-a");
  t.after(() => gate.shutdown());
  return {
    gate,
    records,
    messages,
    errors,
    pending(value: boolean) {
      pending = value;
    },
    complete(id: string) {
      records.set(id, { id, resultConsumed: false });
      gate.enqueue(id);
    },
    tick(ms: number) {
      t.mock.timers.tick(ms);
    },
  };
}

test("three held completions produce one batch, deduplicated by record id", (t) => {
  const f = fixture(t);
  f.complete("a");
  f.tick(50);
  f.complete("b");
  f.complete("c");
  f.gate.enqueue("a");
  f.tick(199);
  assert.deepEqual(f.messages, []);
  f.tick(1);
  assert.deepEqual(f.messages, [["a", "b", "c"]]);
  f.tick(30_000);
  assert.equal(f.messages.length, 1);
});

test("send-time consumption, missing records, and cancellation suppress nudges", (t) => {
  const f = fixture(t);
  for (const id of ["consumed", "cancelled", "missing", "fresh"]) f.complete(id);
  f.records.get("consumed")!.resultConsumed = true;
  f.records.delete("missing");
  f.gate.cancel("cancelled");
  f.tick(200);
  assert.deepEqual(f.messages, [["fresh"]]);
  f.complete("only-consumed");
  f.records.get("only-consumed")!.resultConsumed = true;
  f.tick(200);
  assert.equal(f.messages.length, 1);
});

test("turn end releases streaming holds without violating the idle minimum", (t) => {
  const f = fixture(t);
  f.gate.agentStart();
  f.complete("a");
  f.tick(100);
  f.gate.turnEnd();
  assert.equal(f.messages.length, 0);
  f.tick(100);
  assert.deepEqual(f.messages, [["a"]]);
  f.complete("b");
  f.tick(200);
  assert.equal(f.messages.length, 1);
  f.gate.turnEnd();
  assert.deepEqual(f.messages, [["a"], ["b"]]);
});

test("streaming hold is capped at five seconds and agent end releases it", (t) => {
  const f = fixture(t);
  f.gate.agentStart();
  f.complete("a");
  f.tick(4_999);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.deepEqual(f.messages, [["a"]]);
  f.complete("b");
  f.tick(200);
  f.gate.agentEnd();
  assert.deepEqual(f.messages, [["a"], ["b"]]);
});

test("native steering wins over turn end and releases on its 250ms recheck", (t) => {
  const f = fixture(t);
  f.pending(true);
  f.gate.agentStart();
  f.complete("a");
  f.tick(200);
  f.gate.turnEnd();
  f.tick(250);
  assert.equal(f.messages.length, 0);
  f.pending(false);
  f.tick(249);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.deepEqual(f.messages, [["a"]]);
});

test("native steering has a thirty-second cap even while streaming", (t) => {
  const f = fixture(t);
  f.pending(true);
  f.gate.agentStart();
  f.complete("a");
  f.tick(200);
  f.tick(29_799);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.deepEqual(f.messages, [["a"]]);
});

test("late arrivals cannot postpone the streaming cap or lose their cancellation hold", (t) => {
  const f = fixture(t);
  f.gate.agentStart();
  f.complete("old");
  f.tick(4_999);
  f.complete("young");
  f.tick(1);
  assert.deepEqual(f.messages, [["old"]]);
  f.gate.turnEnd();
  f.tick(198);
  assert.equal(f.messages.length, 1);
  f.tick(1);
  assert.deepEqual(f.messages, [["old"], ["young"]]);
});

test("absent and malformed native bridges are not pending; callable bridge gets session id", () => {
  const symbol = Symbol.for("choco-pi-codex:native-steering");
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  try {
    Reflect.deleteProperty(globalThis, symbol);
    assert.equal(isNativeSteerPending("owner"), false);
    Reflect.set(globalThis, symbol, { isNativeSteerPending: true });
    assert.equal(isNativeSteerPending("owner"), false);
    Reflect.set(globalThis, symbol, { isNativeSteerPending: (id: string) => id === "owner" });
    assert.equal(isNativeSteerPending("owner"), true);
    assert.equal(isNativeSteerPending("other"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, symbol, previous);
    else Reflect.deleteProperty(globalThis, symbol);
  }
});

test("shutdown snapshots held keys, ignores late completions, and restores exactly once", (t) => {
  const f = fixture(t);
  f.complete("a");
  f.complete("b");
  const keys = f.gate.shutdown();
  assert.deepEqual(keys, ["a", "b"]);
  f.complete("late");
  f.tick(30_000);
  assert.deepEqual(f.messages, []);
  f.records.get("b")!.resultConsumed = true;
  f.gate.start("session-a", [...keys, "a"]);
  // A repeated bind after the durable snapshot was cleared must retain its hold.
  f.gate.start("session-a");
  f.tick(200);
  assert.deepEqual(f.messages, [["a"]]);
  const nextKeys = f.gate.shutdown();
  assert.deepEqual(nextKeys, []);
  f.gate.start("session-a", nextKeys);
  f.tick(30_000);
  assert.equal(f.messages.length, 1);
});

test("stale delivery stops scheduling but unrelated failures allow later deliveries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const prefix = "This extension ctx is stale after session replacement or reload.";
  for (const message of [
    prefix,
    `${prefix} old owner`,
    `${prefix}\nold owner`,
    "broken delivery",
  ]) {
    const stale = message !== "broken delivery";
    const failure = new Error(message);
    const errors: unknown[] = [];
    const delivered: string[][] = [];
    let sends = 0;
    const gate = new NotificationGate({
      resolve: (key) => ({ id: key, resultConsumed: false }),
      send: (records) => {
        sends++;
        if (sends === 1) throw failure;
        delivered.push(records.map((record) => record.id));
      },
      onError: (error) => errors.push(error),
    });
    gate.start("owner");
    gate.enqueue("a");
    assert.doesNotThrow(() => t.mock.timers.tick(200));
    assert.deepEqual(errors, stale ? [] : [failure]);
    gate.enqueue("b");
    t.mock.timers.tick(199);
    assert.equal(sends, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(delivered, stale ? [] : [["b"]]);
    t.mock.timers.tick(30_000);
    assert.equal(sends, stale ? 1 : 2);
    assert.deepEqual(errors, stale ? [] : [failure]);
    assert.deepEqual(gate.shutdown(), stale ? ["a"] : []);
  }
});

test("non-stale failure discards only the ready batch and reschedules younger keys", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const failure = new Error("broken delivery");
  const errors: unknown[] = [];
  const attempts: string[][] = [];
  const gate = new NotificationGate({
    resolve: (key) => ({ id: key, resultConsumed: false }),
    send: (records) => {
      attempts.push(records.map((record) => record.id));
      if (attempts.length === 1) throw failure;
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => gate.shutdown());
  gate.start("owner");
  gate.agentStart();
  gate.enqueue("old");
  t.mock.timers.tick(4_999);
  gate.enqueue("young");
  t.mock.timers.tick(1);
  assert.deepEqual(attempts, [["old"]]);
  assert.deepEqual(errors, [failure]);
  gate.turnEnd();
  t.mock.timers.tick(198);
  assert.deepEqual(attempts, [["old"]]);
  t.mock.timers.tick(1);
  assert.deepEqual(attempts, [["old"], ["young"]]);
  t.mock.timers.tick(30_000);
  assert.equal(attempts.length, 2);
  assert.deepEqual(gate.shutdown(), []);
});
