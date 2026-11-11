/**
 * `session_start` (reason "resume") asks whether to resume a paused goal. The
 * answer arrives after an await, so a confirmation that outlived its session
 * or its goal must do nothing: no goal entry, no continuation message.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createGoalRuntimeController } from "../src/goal-runtime-controller.ts";
import { createGoal, setEntry, updateGoalStatus } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "../src/types.ts";

/** Host-owned value as recorded by the fakes; mirrors the repository `RuntimeValue` alias. */
type RuntimeValue = {} | null | undefined;

/** Reinterprets a deliberate partial host fixture as the full host type it stands in for. */
function hostFixture<Target>(value: RuntimeValue): Target {
  // SAFETY: Callers pass partial fixtures covering every member the code under test reads.
  return value as Target;
}

function pausedGoal(): ThreadGoal {
  const created = createGoal(null, "Ship the feature");
  assert.ok(created.goal);
  const paused = updateGoalStatus(created.goal, "paused");
  assert.ok(paused.ok && paused.goal);
  return paused.goal;
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

function fixture() {
  const entries: string[] = [];
  const messages: string[] = [];
  const pi = {
    appendEntry<Entry>(customType: string, data?: Entry): void {
      entries.push(`${customType}:${JSON.stringify(data)}`);
    },
    events: { emit: () => {}, on: () => () => {} },
    sendMessage: () => {},
    sendUserMessage: (text: string) => {
      messages.push(text);
    },
  };
  // The controller uses only entry, event, and message APIs in this fixture.
  const controller = createGoalRuntimeController(hostFixture<ExtensionAPI>(pi));
  let answer: (value: boolean) => void = () => {};
  let asked = false;
  const goal = pausedGoal();
  const ctx = hostFixture<ExtensionContext>({
    hasUI: true,
    ui: {
      setStatus: () => {},
      notify: () => {},
      confirm: () =>
        new Promise<boolean>((resolve) => {
          asked = true;
          answer = resolve;
        }),
    },
    sessionManager: { getSessionId: () => "session-old", getBranch: () => branchWith(goal) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
  });
  // SAFETY: The handlers read only the start reason and ignore shutdown event fields.
  const resume = { type: "session_start", reason: "resume" } as SessionStartEvent;
  // SAFETY: The shutdown handler ignores its event fields.
  const shutdownEvent = { type: "session_shutdown" } as SessionShutdownEvent;
  return {
    controller,
    ctx,
    entries,
    messages,
    start: () => controller.onSessionStart(resume, ctx),
    shutdown: () => controller.onSessionShutdown(shutdownEvent, ctx),
    asked: () => asked,
    answer: (value: boolean) => answer(value),
  };
}

test("control: accepting the dialog in a live session resumes the paused goal", async () => {
  const f = fixture();
  const started = f.start();
  assert.equal(f.asked(), true);
  f.answer(true);
  await started;
  assert.equal(f.messages.length, 1);
  assert.match(f.controller.getGoalForDisplay()?.status ?? "", /active/);
  await f.shutdown();
});

test("a confirmation answered after session shutdown does nothing", async () => {
  const f = fixture();
  const started = f.start();
  assert.equal(f.asked(), true);
  await f.shutdown();
  const entriesAtShutdown = f.entries.length;
  f.answer(true);
  await started;
  assert.deepEqual(f.messages, []);
  assert.equal(f.entries.length, entriesAtShutdown);
});

test("a confirmation answered after the goal was cleared does nothing", async () => {
  const f = fixture();
  const started = f.start();
  f.controller.clearGoal("command", f.ctx);
  const entriesAfterClear = f.entries.length;
  f.answer(true);
  await started;
  assert.deepEqual(f.messages, []);
  assert.equal(f.entries.length, entriesAfterClear);
  assert.equal(f.controller.getGoalForDisplay(), null);
  await f.shutdown();
});

test("a confirmation answered after the goal was replaced does nothing", async () => {
  const f = fixture();
  const started = f.start();
  const replacement = pausedGoal();
  f.controller.setGoal(replacement, "command", f.ctx);
  const entriesAfterReplace = f.entries.length;
  f.answer(true);
  await started;
  assert.deepEqual(f.messages, []);
  assert.equal(f.entries.length, entriesAfterReplace);
  assert.equal(f.controller.getGoalForDisplay()?.status, "paused");
  await f.shutdown();
});
