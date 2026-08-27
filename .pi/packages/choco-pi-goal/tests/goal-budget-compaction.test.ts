import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";

import { createGoal, applyUsage } from "../src/state.ts";
import { safeContextWindow } from "../src/goal-runtime-event-utils.ts";
import { createSessionEventHandlers } from "../src/goal-runtime-session-handlers.ts";
import type { GoalRuntimeSessionHandlerContext } from "../src/goal-runtime-event-handler-types.ts";
import { createGoalRecoveryMachine } from "../src/recovery-machine.ts";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.ts";

test("an omitted budget remains unbounded across a context-window worth of usage", () => {
  const contextWindow = 128_000;
  const created = createGoal(null, "Keep working until complete");

  assert.equal(created.ok, true);
  const goal = created.goal;
  assert.ok(goal);
  assert.equal(goal.tokenBudget, null);

  const accounted = applyUsage(goal, contextWindow, 10);
  const accountedGoal = accounted.goal;
  assert.ok(accountedGoal);
  assert.equal(accountedGoal.status, "active");
  assert.equal(accountedGoal.usage.tokensUsed, contextWindow);
});

test("an explicit token budget remains a cumulative cap", () => {
  const created = createGoal(null, "Stop at the requested cap", 1_000);
  const goal = created.goal;
  assert.ok(goal);

  const first = applyUsage(goal, 600, 1);
  const firstGoal = first.goal;
  assert.ok(firstGoal);
  const second = applyUsage(firstGoal, 400, 1);

  const secondGoal = second.goal;
  assert.ok(secondGoal);
  assert.equal(secondGoal.status, "budgetLimited");
  assert.equal(secondGoal.usage.tokensUsed, 1_000);
  assert.equal(second.crossedBudget, true);
});

test("context-window detection uses only a safe active-model bound", () => {
  assert.equal(safeContextWindow(200_000), 200_000);
  assert.equal(safeContextWindow(Number.NaN), 0);
  assert.equal(safeContextWindow(-1), 0);
});

test("compaction keeps the active goal and accounting and re-enables continuation", async () => {
  const created = createGoal(null, "Continue after compaction");
  const createdGoal = created.goal;
  assert.ok(createdGoal);
  const goal = applyUsage(createdGoal, 128_000, 12).goal;
  assert.ok(goal);

  const cleared: string[] = [];
  let continuationChecks = 0;
  let postCompactFallbacks = 0;
  let compactCalls = 0;
  const recoveryState = createGoalRecoveryMachine();
  const deps = {
    runtimeState: {
      currentTurnIndex: 4,
      agentRunSequence: 7,
      recoveryState,
      staleQueuedWorkGuard: createStaleQueuedWorkGuard(),
    },
    stateController: {
      getGoal: () => goal,
      flushGoalPersistence: () => false,
      reloadFromSession: () => {},
      applyGoalTransition: () => {
        throw new Error("not used by compact handler");
      },
    },
    continuation: {
      clearContinuationStateFor: (goalId: string) => cleared.push(goalId),
      maybeContinueAfterCurrentEvent: () => {
        continuationChecks += 1;
      },
      maybeContinueAfterPostCompactFallback: () => {
        postCompactFallbacks += 1;
      },
      clearContinuationTimer: () => {},
      clearPostCompactContinuationFallback: () => {},
      clearPassthroughContinuationInput: () => {},
      maybeContinue: () => {},
    },
    goalAccounting: {
      accountProgress: () => {},
      beginAccounting: () => {},
    },
    recoveryRuntime: {
      onSessionCompact: () => {
        compactCalls += 1;
      },
    },
    status: { refreshUi: () => {}, stopStatusRefresh: () => {} },
    clearActiveAccounting: () => {},
    providerLimitAutoResume: { clear: () => {} },
    resetErrorRecovery: () => {},
    resumeGoalWithContinuation: () => {
      throw new Error("not used by compact handler");
    },
  } satisfies GoalRuntimeSessionHandlerContext;
  const handlers = createSessionEventHandlers(deps);

  // SAFETY: The compact handler does not read the context in this idle-recovery fixture.
  const ctx = {} as ExtensionContext;
  // SAFETY: The compact handler reads only willRetry from the event.
  const withoutRetry = { willRetry: false } as SessionCompactEvent;
  // SAFETY: The compact handler reads only willRetry from the event.
  const withRetry = { willRetry: true } as SessionCompactEvent;
  await handlers.onSessionCompact(withoutRetry, ctx);
  await handlers.onSessionCompact(withRetry, ctx);

  assert.deepEqual(cleared, [goal.goalId, goal.goalId]);
  assert.equal(continuationChecks, 1);
  assert.equal(postCompactFallbacks, 1);
  assert.equal(compactCalls, 2);
  assert.equal(goal.status, "active");
  assert.equal(goal.tokenBudget, null);
  assert.equal(goal.usage.tokensUsed, 128_000);
});
