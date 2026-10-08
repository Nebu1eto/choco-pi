import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DAYBREAK_BRIDGE_SYMBOL,
  DAYBREAK_ENTRY,
  createDaybreakBridge,
  daybreakStatusValue,
  getDaybreakBridge,
  installDaybreakExtension,
  restoreDaybreakInitialization,
  stripStaleDaybreakAccess,
  type DaybreakBridge,
  type DaybreakExtensionContext,
  type DaybreakState,
} from "../.pi/extensions/lib/daybreak-state.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

type ChildHandlers = {
  start?: (ctx: DaybreakExtensionContext) => void;
  tree?: (ctx: DaybreakExtensionContext) => void;
  request?: (payload: RuntimeValue, ctx: DaybreakExtensionContext) => RuntimeValue;
  shutdown?: () => void;
};

function entry(data: Record<string, boolean | number | string>): SessionEntry {
  return {
    type: "custom",
    customType: DAYBREAK_ENTRY,
    id: `e-${Math.random()}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    data,
  };
}

test("the bridge is a version 1 global registry under Symbol.for", () => {
  assert.equal(DAYBREAK_BRIDGE_SYMBOL, Symbol.for("choco-pi.daybreak-state"));
  const bridge = getDaybreakBridge();
  assert.equal(bridge.version, 1);
  assert.equal(getDaybreakBridge(), bridge);
  const host: typeof globalThis & { [DAYBREAK_BRIDGE_SYMBOL]?: DaybreakBridge } = globalThis;
  assert.equal(host[DAYBREAK_BRIDGE_SYMBOL], bridge);
});

test("default state is off; turning on advances the revision and is honestly unknown", () => {
  const bridge = createDaybreakBridge();
  const controller = bridge.register({
    sessionId: "s-default",
    owner: {},
    generation: 0,
    initial: { requested: false, source: "default" },
  });
  try {
    assert.deepEqual(controller.getState(), {
      sessionId: "s-default",
      requested: false,
      source: "default",
      revision: 0,
      generation: 0,
      outcome: "off",
    });
    const on = controller.set(true);
    assert.equal(on.revision, 1);
    assert.equal(on.source, "explicit");
    assert.equal(on.outcome, "pending");
    const requestedInitially = bridge.register({
      sessionId: "s-requested",
      owner: {},
      generation: 0,
      initial: { requested: true, source: "inherited" },
    });
    assert.equal(requestedInitially.getState().outcome, "pending");
    requestedInitially.dispose();
  } finally {
    controller.dispose();
  }
});

test("report applies only to the current controller at the matching revision", () => {
  const bridge = createDaybreakBridge();
  const persisted: DaybreakState[] = [];
  const owner = {};
  const controller = bridge.register({
    sessionId: "s-report",
    owner,
    generation: 0,
    initial: { requested: false, source: "default" },
    persist: (state) => persisted.push(state),
  });
  const { revision } = controller.set(true);
  controller.report("blue", revision - 1);
  assert.equal(controller.getState().outcome, "pending");
  controller.report("off", revision);
  assert.equal(controller.getState().outcome, "pending");
  controller.report("red", revision);
  assert.equal(controller.getState().outcome, "red");
  assert.ok(
    persisted.every((state) => state.outcome !== "red"),
    "outcome is never persisted",
  );

  // The same owner and generation reuses the controller; a new owner replaces it.
  assert.equal(
    bridge.register({
      sessionId: "s-report",
      owner,
      generation: 0,
      initial: { requested: false, source: "default" },
    }),
    controller,
  );
  const replacement = bridge.register({
    sessionId: "s-report",
    owner: {},
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  assert.notEqual(replacement, controller);
  controller.report("blue", controller.getState().revision);
  assert.equal(controller.getState().outcome, "red", "stale controller ignores reports");
  assert.throws(() => controller.set(false), /stale/);
  controller.dispose();
  assert.equal(bridge.get("s-report"), replacement);
  replacement.dispose();
  assert.equal(bridge.get("s-report"), undefined);
});

test("subscriptions notify mutations and reports, unsubscribe once, and retire on disposal", () => {
  const bridge = createDaybreakBridge();
  const input = {
    sessionId: "s-subscribe",
    owner: {},
    generation: 0,
    initial: { requested: false, source: "default" as const },
  };
  const controller = bridge.register(input);
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => notifications++);
  controller.set(true);
  controller.report("blue", 1);
  controller.report("blue", 1);
  controller.report("red", 0);
  assert.equal(notifications, 2);
  unsubscribe();
  unsubscribe();
  controller.set(false);
  assert.equal(notifications, 2);
  controller.subscribe(() => notifications++);
  const replacement = bridge.register({ ...input, generation: 1 });
  controller.dispose();
  controller.report("red", 2);
  assert.equal(notifications, 2, "replacement clears old listeners");
  replacement.subscribe(() => notifications++);
  replacement.dispose();
  replacement.dispose();
  replacement.report("blue", 0);
  assert.equal(notifications, 2, "disposed controllers retain no listeners");
});

test("an unrequested session ignores entitlement reports", () => {
  const bridge = createDaybreakBridge();
  const controller = bridge.register({
    sessionId: "s-off",
    owner: {},
    generation: 0,
    initial: { requested: false, source: "default" },
  });
  controller.report("blue", 0);
  assert.equal(controller.getState().outcome, "off");
  controller.dispose();
});

test("restoration replays the latest request and never the outcome", () => {
  const fallback = { requested: false, source: "default" } as const;
  assert.deepEqual(restoreDaybreakInitialization([], fallback), { ...fallback, revision: 0 });
  const restored = restoreDaybreakInitialization(
    [
      entry({ enabled: true, source: "explicit", revision: 3 }),
      entry({ enabled: false, source: "explicit", revision: 4, outcome: "blue" }),
      entry({ enabled: "nope" }),
    ],
    fallback,
  );
  assert.deepEqual(restored, { requested: false, source: "explicit", revision: 4 });

  // A stored default seed yields to the current default and invalidates older lookups.
  assert.deepEqual(
    restoreDaybreakInitialization([entry({ enabled: false, source: "default", revision: 2 })], {
      requested: true,
      source: "default",
    }),
    { requested: true, source: "default", revision: 3 },
  );
  // An explicit choice outranks the default seed.
  assert.deepEqual(
    restoreDaybreakInitialization([entry({ enabled: false, source: "explicit", revision: 2 })], {
      requested: true,
      source: "default",
    }),
    { requested: false, source: "explicit", revision: 2 },
  );

  const bridge = createDaybreakBridge();
  const controller = bridge.register({
    sessionId: "s-restore",
    owner: {},
    generation: 0,
    initial: fallback,
    entries: [entry({ enabled: true, source: "explicit", revision: 5 })],
  });
  assert.equal(controller.getState().requested, true);
  assert.equal(controller.getState().revision, 5);
  assert.equal(controller.getState().outcome, "pending");
  controller.dispose();
});

test("strip always removes access_programs and never adds it", () => {
  const bridge = createDaybreakBridge();
  const controller = bridge.register({
    sessionId: "s-strip",
    owner: {},
    generation: 0,
    initial: { requested: false, source: "default" },
  });
  const { revision } = controller.set(true);
  controller.report("blue", revision);
  assert.equal(controller.getState().outcome, "blue");
  // A previously granted session still has a stale or stock body stripped.
  assert.deepEqual(stripStaleDaybreakAccess({ model: "m", access_programs: ["daybreak_blue"] }), {
    model: "m",
  });
  assert.equal(stripStaleDaybreakAccess({ model: "m" }), undefined);
  assert.equal(stripStaleDaybreakAccess("raw"), undefined);
  controller.dispose();
});

test("status text distinguishes every outcome", () => {
  const base: DaybreakState = {
    sessionId: "s",
    requested: true,
    source: "explicit",
    revision: 1,
    generation: 0,
    outcome: "lookup-failed",
  };
  assert.equal(daybreakStatusValue(undefined), "not initialized");
  assert.equal(daybreakStatusValue({ ...base, requested: false, outcome: "off" }), "off");
  assert.equal(daybreakStatusValue({ ...base, outcome: "blue" }), "on (blue)");
  assert.equal(daybreakStatusValue({ ...base, outcome: "red" }), "on (red)");
  assert.match(daybreakStatusValue({ ...base, outcome: "not-granted" }), /not granted/);
  assert.match(daybreakStatusValue({ ...base, outcome: "auth-not-eligible" }), /not eligible/);
  assert.match(daybreakStatusValue(base), /lookup failed/);
  assert.equal(
    daybreakStatusValue({ ...base, outcome: "pending" }),
    "requested; checking availability",
  );
  assert.match(
    daybreakStatusValue({ ...base, outcome: "model-not-supported" }),
    /model does not support Daybreak/,
  );
});

test("hidden child extension registers inherited state, restores on tree, strips only", () => {
  const bridge = createDaybreakBridge();
  const appended: { type: string; data: RuntimeValue }[] = [];
  const handlers: ChildHandlers = {};
  let branch: SessionEntry[] = [];
  const ctx: DaybreakExtensionContext = {
    model: undefined,
    sessionManager: { getBranch: () => branch, getSessionId: () => "child" },
  };
  installDaybreakExtension(
    bridge,
    { owner: {}, generation: 0, initial: { requested: true, source: "inherited" } },
    {
      appendEntry: (type, data) => appended.push({ type, data }),
      onSessionStart: (handler) => (handlers.start = handler),
      onSessionTree: (handler) => (handlers.tree = handler),
      onBeforeProviderRequest: (handler) => (handlers.request = handler),
      onSessionShutdown: (handler) => (handlers.shutdown = handler),
    },
  );
  handlers.start?.(ctx);
  const state = bridge.get("child")?.getState();
  assert.equal(state?.requested, true);
  assert.equal(state?.source, "inherited");
  assert.equal(state?.outcome, "pending");
  assert.deepEqual(appended, [
    { type: DAYBREAK_ENTRY, data: { enabled: true, source: "inherited", revision: 0 } },
  ]);

  assert.equal(handlers.request?.({ model: "m" }, ctx), undefined, "never adds entitlement");
  assert.deepEqual(handlers.request?.({ model: "m", access_programs: ["x"] }, ctx), {
    model: "m",
  });

  // A tree move restores from the branch and does not re-append the inherited snapshot.
  branch = [entry({ enabled: false, source: "explicit", revision: 2 })];
  handlers.tree?.(ctx);
  const restored = bridge.get("child")?.getState();
  assert.equal(restored?.requested, false);
  assert.equal(restored?.generation, 1);
  assert.equal(appended.length, 1);
  handlers.shutdown?.();
  assert.equal(bridge.get("child"), undefined);
});
