import assert from "node:assert/strict";
import test from "node:test";

import { toolGoalStatus, toToolText } from "../src/format.ts";
import type { ThreadGoal } from "../src/types.ts";

const goal: ThreadGoal = {
  goalId: "g1",
  objective: "ship it",
  status: "complete",
  tokenBudget: 1000,
  usage: { tokensUsed: 250, activeSeconds: 61 },
  createdAt: 1,
  updatedAt: 2,
};

test("goal tool text uses snake_case keys only", () => {
  const parsed = JSON.parse(toToolText(goal, true));
  assert.deepEqual(Object.keys(parsed), ["goal", "remaining_tokens", "completion_budget_report"]);
  assert.deepEqual(Object.keys(parsed.goal), [
    "goal_id",
    "objective",
    "status",
    "token_budget",
    "tokens_used",
    "time_used_seconds",
    "created_at",
    "updated_at",
  ]);
  assert.equal(parsed.remaining_tokens, 750);
  assert.match(parsed.completion_budget_report, /Goal achieved/);
  assert.equal(
    /[a-z][A-Z]/.test(Object.keys(parsed).concat(Object.keys(parsed.goal)).join(",")),
    false,
  );
});

test("goal tool text for no goal keeps snake_case envelope", () => {
  assert.deepEqual(JSON.parse(toToolText(null)), {
    goal: null,
    remaining_tokens: null,
    completion_budget_report: null,
  });
});

test("goal tool text shows budgetLimited as budget_limited", () => {
  const limited: ThreadGoal = {
    ...goal,
    status: "budgetLimited",
    usage: { tokensUsed: 1000, activeSeconds: 61 },
  };
  const text = toToolText(limited);
  assert.equal(JSON.parse(text).goal.status, "budget_limited");
  assert.doesNotMatch(text, /budgetLimited/);
  assert.equal(toolGoalStatus("active"), "active");
  assert.equal(toolGoalStatus("budgetLimited"), "budget_limited");
});
