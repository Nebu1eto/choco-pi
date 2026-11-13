import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createGoalPersistence, GOAL_CHANGED_EVENT } from "../src/goal-persistence.ts";
import {
  createGoalRuntimeAccessPublisher,
  GOAL_RUNTIME_SYMBOL,
  isStaleContextError,
  type SessionOwnedContext,
} from "../src/goal-runtime-access.ts";
import { createGoalRuntimeController } from "../src/goal-runtime-controller.ts";
import { createGoalStateController } from "../src/goal-state-controller.ts";
import { createGoalRecoveryMachine } from "../src/recovery-machine.ts";
import { applyUsage, createGoal, setEntry, updateGoalStatus } from "../src/state.ts";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalEntrySource,
  type GoalResult,
  type ThreadGoal,
} from "../src/types.ts";

/** Host-owned value as recorded by the fakes; mirrors the repository `RuntimeValue` alias. */
type RuntimeValue = {} | null | undefined;

interface Recorded {
  /** Each appended entry, serialized so assertions read it without reinterpreting its type. */
  entries: { customType: string; json: string }[];
  events: { channel: string; data: RuntimeValue }[];
}

function fakePi(recorded: Recorded) {
  return {
    appendEntry<Entry>(customType: string, data?: Entry): void {
      recorded.entries.push({ customType, json: JSON.stringify(data) });
    },
    events: {
      emit(channel: string, data: RuntimeValue): void {
        recorded.events.push({ channel, data });
      },
      on(): () => void {
        return () => {};
      },
    },
  };
}

const noopEffects = {
  clearContinuation: () => {},
  clearActiveAccounting: () => {},
  resetRecovery: () => {},
  clearBudgetWarning: () => {},
  clearHostOverflowRecovery: () => {},
  setRecoveryPausedAttention: () => {},
  markContinuationQueued: () => {},
  stopStatusRefresh: () => {},
};

function fixture() {
  const recorded: Recorded = { entries: [], events: [] };
  const pi = fakePi(recorded);
  const persistence = createGoalPersistence({ pi });
  const recoveryState = createGoalRecoveryMachine();
  const controller = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => recoveryState,
    transitionEffectHandlers: noopEffects,
    refreshUi: () => {},
  });
  return { recorded, persistence, controller };
}

function goalChanges(recorded: Recorded): RuntimeValue[] {
  return recorded.events.filter((e) => e.channel === GOAL_CHANGED_EVENT).map((e) => e.data);
}

function newGoal(budget?: number): ThreadGoal {
  const created = createGoal(null, "Ship the feature", budget);
  assert.ok(created.goal);
  return created.goal;
}

function withStatus(goal: ThreadGoal, status: ThreadGoal["status"]): ThreadGoal {
  const result = updateGoalStatus(goal, status);
  assert.ok(result.ok && result.goal);
  return result.goal;
}

function branchWith(goal: ThreadGoal): SessionEntry[] {
  return [
    {
      type: "custom",
      id: "e1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: CUSTOM_ENTRY_TYPE,
      data: setEntry(goal, "tool"),
    },
  ];
}

function reloadContext(branch: SessionEntry[]) {
  return {
    ui: { setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
  };
}

test("goal:changed follows each persisted set, status update, and clear", () => {
  const { recorded, controller } = fixture();
  const goal = newGoal();

  controller.applyGoalTransition({ kind: "set", nextGoal: goal, source: "tool" }, null);
  const paused = withStatus(goal, "paused");
  controller.applyGoalTransition({ kind: "set", nextGoal: paused, source: "command" }, null);
  const complete = withStatus(paused, "complete");
  controller.applyGoalTransition({ kind: "set", nextGoal: complete, source: "tool" }, null);
  controller.applyGoalTransition({ kind: "clear", source: "command" }, null);

  assert.equal(recorded.entries.length, 4);
  assert.deepEqual(goalChanges(recorded), [goal, paused, complete, null]);
});

test("an equivalent set persists nothing and emits nothing", () => {
  const { recorded, controller } = fixture();
  const goal = newGoal();
  controller.applyGoalTransition({ kind: "set", nextGoal: goal, source: "tool" }, null);
  controller.applyGoalTransition({ kind: "set", nextGoal: goal, source: "tool" }, null);

  assert.equal(recorded.entries.length, 1);
  assert.equal(goalChanges(recorded).length, 1);
});

test("runtime usage flushes and budget limits emit the persisted goal", () => {
  const { recorded, controller } = fixture();
  const goal = newGoal(1_000);
  controller.applyGoalTransition({ kind: "set", nextGoal: goal, source: "tool" }, null);

  const used = applyUsage(goal, 400, 5).goal;
  assert.ok(used);
  // Deferred accounting changes memory only; the event waits for the persisted entry.
  controller.applyGoalTransition({ kind: "runtime_accounting", nextGoal: used }, null);
  assert.equal(goalChanges(recorded).length, 1);
  assert.equal(controller.flushGoalPersistence("runtime"), true);
  assert.match(recorded.entries.at(-1)?.json ?? "", /"kind":"usage"/);
  assert.deepEqual(goalChanges(recorded).at(-1), used);

  const limited = applyUsage(used, 600, 1).goal;
  assert.ok(limited);
  assert.equal(limited.status, "budgetLimited");
  controller.applyGoalTransition({ kind: "runtime_accounting", nextGoal: limited }, null);
  assert.deepEqual(goalChanges(recorded).at(-1), limited);
  assert.equal(goalChanges(recorded).length, 3);
});

test("host-overflow reset entries do not emit goal:changed", () => {
  const { recorded, controller } = fixture();
  controller.persistHostOverflowUserReset(true);
  assert.equal(recorded.entries.length, 1);
  assert.equal(goalChanges(recorded).length, 0);
});

test("emitted goals are copies that cannot mutate runtime state", () => {
  const { recorded, controller } = fixture();
  const goal = newGoal();
  controller.applyGoalTransition({ kind: "set", nextGoal: goal, source: "tool" }, null);
  const emitted = goalChanges(recorded)[0];
  assert.ok(emitted instanceof Object && "objective" in emitted);
  Object.assign(emitted, { objective: "mutated" });
  assert.equal(controller.getGoal()?.objective, "Ship the feature");
});

test("session reload emits only when the reconstructed goal differs", () => {
  const { recorded, controller } = fixture();
  const goal = newGoal();

  controller.reloadFromSession(reloadContext(branchWith(goal)));
  assert.deepEqual(goalChanges(recorded), [goal]);

  controller.reloadFromSession(reloadContext(branchWith(goal)));
  assert.equal(goalChanges(recorded).length, 1);

  controller.reloadFromSession(reloadContext([]));
  assert.deepEqual(goalChanges(recorded), [goal, null]);

  controller.reloadFromSession(reloadContext([]));
  assert.equal(goalChanges(recorded).length, 2);
  assert.equal(recorded.entries.length, 0);
});

type TestContext = SessionOwnedContext & { label: string };

const STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";

function ownedContext(sessionId: string, label = sessionId): TestContext {
  return { label, sessionManager: { getSessionId: () => sessionId } };
}

function throwingContext(message: string): TestContext {
  return {
    label: "throwing",
    sessionManager: {
      getSessionId: () => {
        throw new Error(message);
      },
    },
  };
}

function readRegistry(): Map<RuntimeValue, RuntimeValue> | undefined {
  const slot: RuntimeValue = Object.getOwnPropertyDescriptor(
    globalThis,
    GOAL_RUNTIME_SYMBOL,
  )?.value;
  return slot instanceof Map ? slot : undefined;
}

function accessSource(initial: ThreadGoal | null) {
  let goal = initial;
  const calls: { source: GoalEntrySource; label: string }[] = [];
  return {
    calls,
    source: {
      getGoal: () => goal,
      completeGoal(source: GoalEntrySource, ctx: TestContext): GoalResult {
        calls.push({ source, label: ctx.label });
        const result = updateGoalStatus(goal, "complete");
        if (result.ok) goal = result.goal;
        return result;
      },
    },
  };
}

test("runtime access is keyed by owner and completes the goal as a command", () => {
  const { source, calls } = accessSource(newGoal());
  const publisher = createGoalRuntimeAccessPublisher(source);
  const access = publisher.install("session-a");
  try {
    assert.ok(access);
    assert.equal(readRegistry()?.get("session-a"), access);
    assert.equal(access.owner, "session-a");
    assert.equal(access.getGoal()?.status, "active");

    const result = access.completeGoal(ownedContext("session-a"));
    assert.equal(result.ok, true);
    assert.equal(result.goal?.status, "complete");
    assert.deepEqual(calls, [{ source: "command", label: "session-a" }]);
  } finally {
    publisher.dispose();
  }
  assert.equal(readRegistry(), undefined);
});

test("runtime access rejects foreign and stale contexts without completing", () => {
  const { source, calls } = accessSource(newGoal());
  const publisher = createGoalRuntimeAccessPublisher(source);
  const access = publisher.install("session-a");
  try {
    assert.ok(access);
    assert.equal(access.completeGoal(ownedContext("session-b")).ok, false);
    assert.equal(access.completeGoal(throwingContext(STALE_MESSAGE)).ok, false);
    assert.equal(calls.length, 0);
  } finally {
    publisher.dispose();
  }
});

test("runtime access rethrows context failures other than staleness", () => {
  const { source, calls } = accessSource(newGoal());
  const publisher = createGoalRuntimeAccessPublisher(source);
  const access = publisher.install("session-a");
  try {
    assert.ok(access);
    assert.throws(() => access.completeGoal(throwingContext("disk full")), /disk full/);
    assert.equal(calls.length, 0);
  } finally {
    publisher.dispose();
  }
});

test("stale-context classifier matches only the host's canonical message", () => {
  assert.equal(isStaleContextError(new Error(STALE_MESSAGE)), true);
  assert.equal(
    isStaleContextError(
      new Error("This extension ctx is stale after session replacement or reload."),
    ),
    true,
  );
  assert.equal(isStaleContextError(new Error("ctx is stale")), false);
  assert.equal(isStaleContextError(STALE_MESSAGE), false);
  assert.equal(isStaleContextError(undefined), false);
});

test("disposed or replaced runtime access stops acting and keeps other owners", () => {
  const first = accessSource(newGoal());
  const second = accessSource(newGoal());
  const publisherA = createGoalRuntimeAccessPublisher(first.source);
  const publisherB = createGoalRuntimeAccessPublisher(second.source);
  const staleA = publisherA.install("session-a");
  const accessB = publisherB.install("session-b");
  assert.ok(staleA);

  // A new session generation replaces the previous owner's entry.
  const accessC = publisherA.install("session-c");
  assert.equal(readRegistry()?.has("session-a"), false);
  assert.equal(readRegistry()?.get("session-c"), accessC);
  assert.equal(staleA.getGoal(), null);
  assert.equal(staleA.completeGoal(ownedContext("session-a")).ok, false);
  assert.equal(first.calls.length, 0);

  publisherA.dispose();
  assert.equal(readRegistry()?.has("session-c"), false);
  assert.equal(readRegistry()?.get("session-b"), accessB);

  publisherB.dispose();
  assert.equal(readRegistry(), undefined);
});

test("runtime access never clobbers a foreign slot value", () => {
  const foreign = { owner: "not-a-map" };
  Object.defineProperty(globalThis, GOAL_RUNTIME_SYMBOL, {
    configurable: true,
    writable: true,
    value: foreign,
  });
  try {
    const publisher = createGoalRuntimeAccessPublisher(accessSource(null).source);
    assert.equal(publisher.install("session-a"), undefined);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, GOAL_RUNTIME_SYMBOL)?.value, foreign);
    publisher.dispose();
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, GOAL_RUNTIME_SYMBOL)?.value, foreign);
  } finally {
    Reflect.deleteProperty(globalThis, GOAL_RUNTIME_SYMBOL);
  }
});

/** Reinterprets a deliberate partial host fixture as the full host type it stands in for. */
function hostFixture<Target>(value: RuntimeValue): Target {
  // SAFETY: Callers pass partial fixtures covering every member the code under test reads.
  return value as Target;
}

function controllerContext(sessionId: string): ExtensionContext {
  const context = {
    hasUI: false,
    ui: { setStatus: () => {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
  };
  // Session start/shutdown with no goal reads only this context subset.
  return hostFixture<ExtensionContext>(context);
}

test("a pending shutdown leaves the next session's runtime access installed", async () => {
  const recorded: Recorded = { entries: [], events: [] };
  const pi = { ...fakePi(recorded), sendMessage: () => {}, sendUserMessage: () => {} };
  // The controller uses only entry, event, and message APIs in this no-goal fixture.
  const controller = createGoalRuntimeController(hostFixture<ExtensionAPI>(pi));
  // SAFETY: The handlers read only the start reason and ignore shutdown event fields.
  const startEvent = { type: "session_start", reason: "startup" } as SessionStartEvent;
  // SAFETY: The shutdown handler ignores its event fields.
  const shutdownEvent = { type: "session_shutdown" } as SessionShutdownEvent;
  try {
    await controller.onSessionStart(startEvent, controllerContext("session-old"));
    const oldAccess = readRegistry()?.get("session-old");
    assert.ok(oldAccess);

    const shutdown = controller.onSessionShutdown(shutdownEvent, controllerContext("session-old"));
    // Shutdown invalidates the old access before its first await.
    assert.equal(readRegistry()?.has("session-old") ?? false, false);

    await controller.onSessionStart(startEvent, controllerContext("session-new"));
    const newAccess = readRegistry()?.get("session-new");
    assert.ok(newAccess);
    await shutdown;

    assert.equal(readRegistry()?.get("session-new"), newAccess);
  } finally {
    await controller.onSessionShutdown(shutdownEvent, controllerContext("session-new"));
  }
  assert.equal(readRegistry(), undefined);
});
