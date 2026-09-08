import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { SHELL_COMPLETION_PENDING_ENTRY, ShellNotificationGate } from "../src/notification-gate.ts";
import type { ShellManager, ShellResult } from "../src/shell-manager.ts";

const nativeSteeringSymbol = Symbol.for("choco-pi-codex:native-steering");

interface NativeSteeringRegistry {
  [nativeSteeringSymbol]?: unknown;
}

interface PendingEntry {
  type: "custom";
  customType: string;
  data: object;
}

function shell(index: number, ownerId = "session"): ShellResult {
  return {
    shellId: `shell-${index}`,
    ownerId,
    command: `command-${index}`,
    cwd: "/tmp",
    state: "exited",
    exitCode: 0,
    startedAt: index,
    endedAt: 1_000 + index,
  };
}

function fakeManager(shells: readonly ShellResult[]): ShellManager {
  const byId = new Map(shells.map((result) => [result.shellId, result]));
  // SAFETY: The gate uses only ShellManager.read, which this fixture implements with full results.
  return {
    read(input: { shellId: string }) {
      const result = byId.get(input.shellId);
      if (!result) throw new Error(`Shell not found: ${input.shellId}`);
      return {
        shell: result,
        stdout: { data: "", startOffset: 0, nextOffset: 0, endOffset: 0, dropped: false },
        stderr: { data: "", startOffset: 0, nextOffset: 0, endOffset: 0, dropped: false },
      };
    },
  } as ShellManager;
}

function setup(t: TestContext, shells: readonly ShellResult[] = []) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const flushed: ShellResult[][] = [];
  const entries: PendingEntry[] = [];
  const gate = new ShellNotificationGate({
    manager: fakeManager(shells),
    flush: (completed) => flushed.push(completed),
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
  });
  gate.sessionStart("session", []);
  return { gate, flushed, entries };
}

function registry(): typeof globalThis & NativeSteeringRegistry {
  // SAFETY: Tests isolate and restore only the symbol-keyed native-steering bridge slot.
  return globalThis as typeof globalThis & NativeSteeringRegistry;
}

function heldCompletions(gate: ShellNotificationGate): ShellResult[] {
  const held = Object.getOwnPropertyDescriptor(gate, "held")?.value;
  assert.ok(held instanceof Map);
  return [...held.values()];
}

test("idle completions flush after the 250ms debounce", (t) => {
  delete registry()[nativeSteeringSymbol];
  const completed = shell(1);
  const { gate, flushed } = setup(t, [completed]);
  gate.enqueue(completed);

  t.mock.timers.tick(249);
  assert.equal(flushed.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(flushed, [[completed]]);
});

test("streaming completions flush once at turn_end", (t) => {
  delete registry()[nativeSteeringSymbol];
  const completed = Array.from({ length: 5 }, (_, index) => shell(index));
  const { gate, flushed } = setup(t, completed);
  gate.agentStart();
  for (const result of completed) gate.enqueue(result);

  t.mock.timers.tick(4_999);
  assert.equal(flushed.length, 0);
  gate.agentEnd();
  gate.turnEnd();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.length, 5);
});

test("streaming max hold flushes without turn_end", (t) => {
  delete registry()[nativeSteeringSymbol];
  const completed = shell(1);
  const { gate, flushed } = setup(t, [completed]);
  gate.agentStart();
  gate.enqueue(completed);

  t.mock.timers.tick(4_999);
  assert.equal(flushed.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(flushed, [[completed]]);
});

test("native steer pending holds for the matching session until it clears", (t) => {
  let pending = true;
  const observed: string[] = [];
  registry()[nativeSteeringSymbol] = {
    isNativeSteerPending(sessionId: string) {
      observed.push(sessionId);
      return pending;
    },
  };
  t.after(() => delete registry()[nativeSteeringSymbol]);
  const completed = shell(1);
  const { gate, flushed } = setup(t, [completed]);
  gate.enqueue(completed);

  t.mock.timers.tick(500);
  assert.equal(flushed.length, 0);
  pending = false;
  t.mock.timers.tick(250);
  assert.deepEqual(flushed, [[completed]]);
  assert.ok(observed.every((sessionId) => sessionId === "session"));
});

test("native steer pending hard cap flushes after 30 seconds", (t) => {
  registry()[nativeSteeringSymbol] = { isNativeSteerPending: () => true };
  t.after(() => delete registry()[nativeSteeringSymbol]);
  const completed = shell(1);
  const { gate, flushed } = setup(t, [completed]);
  gate.enqueue(completed);

  t.mock.timers.tick(250);
  t.mock.timers.tick(29_999);
  assert.equal(flushed.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(flushed, [[completed]]);
});

test("non-stale delivery failures are reported without stopping future batches", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = shell(1);
  const later = shell(2);
  const attempted: ShellResult[][] = [];
  const diagnostics: unknown[][] = [];
  const failure = new Error("delivery failed");
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const gate = new ShellNotificationGate({
    manager: fakeManager([first, later]),
    flush: (completed) => {
      attempted.push(completed);
      if (attempted.length === 1) throw failure;
    },
    appendEntry: () => {},
  });
  gate.sessionStart("session", []);

  gate.enqueue(first);
  t.mock.timers.tick(250);
  assert.deepEqual(diagnostics, [["[choco-pi-shells] Shell completion delivery failed", failure]]);

  gate.enqueue(first);
  gate.enqueue(later);
  t.mock.timers.tick(250);
  assert.deepEqual(attempted, [[first], [later]]);
});

test("turn_end delivery failures are contained and future batches still flush", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = shell(1);
  const later = shell(2);
  const attempted: ShellResult[][] = [];
  const diagnostics: unknown[][] = [];
  const failure = new Error("delivery failed at turn_end");
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const gate = new ShellNotificationGate({
    manager: fakeManager([first, later]),
    flush: (completed) => {
      attempted.push(completed);
      if (attempted.length === 1) throw failure;
    },
    appendEntry: () => {},
  });
  gate.sessionStart("session", []);

  gate.enqueue(first);
  gate.turnEnd();
  assert.deepEqual(diagnostics, [["[choco-pi-shells] Shell completion delivery failed", failure]]);

  gate.enqueue(first);
  gate.enqueue(later);
  gate.turnEnd();
  assert.deepEqual(attempted, [[first], [later]]);
});

test("stale-context delivery failures stop all further gate activity", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = shell(1);
  const later = shell(2);
  const attempted: ShellResult[][] = [];
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const gate = new ShellNotificationGate({
    manager: fakeManager([first, later]),
    flush: (completed) => {
      attempted.push(completed);
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
    appendEntry: () => {},
  });
  gate.sessionStart("session", []);

  gate.enqueue(first);
  t.mock.timers.tick(250);
  gate.enqueue(later);
  gate.turnEnd();
  t.mock.timers.tick(5_000);

  assert.deepEqual(attempted, [[first]]);
  assert.deepEqual(diagnostics, []);
});

test("shutdown persistence restores each completion exactly once", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const completed = [shell(1), shell(2)];
  const entries: PendingEntry[] = [];
  const first = new ShellNotificationGate({
    manager: fakeManager(completed),
    flush: () => assert.fail("shutdown must not flush held completions"),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  first.sessionStart("session", []);
  first.agentStart();
  completed.forEach((result) => first.enqueue(result));
  first.shutdown();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, SHELL_COMPLETION_PENDING_ENTRY);

  const flushed: ShellResult[][] = [];
  const successor = new ShellNotificationGate({
    manager: fakeManager(completed),
    flush: (shells) => flushed.push(shells),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  successor.sessionStart("session", entries);
  t.mock.timers.tick(250);
  assert.deepEqual(flushed, [completed]);

  successor.sessionStart("session", entries);
  t.mock.timers.tick(250);
  assert.deepEqual(flushed, [completed]);

  const laterReloads: ShellResult[][] = [];
  const laterSuccessor = new ShellNotificationGate({
    manager: fakeManager(completed),
    flush: (shells) => laterReloads.push(shells),
    appendEntry: () => {},
  });
  laterSuccessor.sessionStart("session", entries);
  t.mock.timers.tick(250);
  assert.deepEqual(laterReloads, []);
});

test("non-stale shutdown persistence failures are reported and retain held completions", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const completed = shell(1);
  const diagnostics: unknown[][] = [];
  const failure = new Error("persistence failed");
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const gate = new ShellNotificationGate({
    manager: fakeManager([completed]),
    flush: () => assert.fail("shutdown must not flush held completions"),
    appendEntry: () => {
      throw failure;
    },
  });
  gate.sessionStart("session", []);
  gate.enqueue(completed);

  gate.shutdown();

  assert.deepEqual(diagnostics, [
    ["[choco-pi-shells] Shell completion persistence failed", failure],
  ]);
  assert.deepEqual(heldCompletions(gate), [completed]);
});

test("stale-context persistence failures stay silent during restore and shutdown", (t) => {
  delete registry()[nativeSteeringSymbol];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const completed = shell(1);
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const staleAppend = () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  const restored = new ShellNotificationGate({
    manager: fakeManager([completed]),
    flush: () => {},
    appendEntry: staleAppend,
  });
  restored.sessionStart("session", [
    {
      type: "custom",
      customType: SHELL_COMPLETION_PENDING_ENTRY,
      data: { keys: [`${completed.shellId}:${completed.endedAt}`], shells: [completed] },
    },
  ]);

  const shuttingDown = new ShellNotificationGate({
    manager: fakeManager([completed]),
    flush: () => assert.fail("shutdown must not flush held completions"),
    appendEntry: staleAppend,
  });
  shuttingDown.sessionStart("session", []);
  shuttingDown.enqueue(completed);
  shuttingDown.shutdown();

  assert.deepEqual(diagnostics, []);
});

test("an absent native steering bridge behaves as not pending", (t) => {
  delete registry()[nativeSteeringSymbol];
  const completed = shell(1);
  const { gate, flushed } = setup(t, [completed]);
  gate.enqueue(completed);
  t.mock.timers.tick(250);
  assert.deepEqual(flushed, [[completed]]);
});
