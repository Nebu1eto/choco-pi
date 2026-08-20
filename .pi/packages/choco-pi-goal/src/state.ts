import { randomUUID } from "node:crypto";

import { Type } from "typebox";
import { Check } from "typebox/value";

import {
  CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type GoalUsage,
  type RuntimeUsageGoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

const GoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("budgetLimited"),
  Type.Literal("complete"),
]);
const RuntimeUsageGoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("budgetLimited"),
]);
const GoalUsageSchema = Type.Object({
  tokensUsed: Type.Number(),
  activeSeconds: Type.Number(),
});
const ThreadGoalSchema = Type.Object({
  goalId: Type.String(),
  objective: Type.String(),
  status: GoalStatusSchema,
  tokenBudget: Type.Union([Type.Number(), Type.Null()]),
  usage: GoalUsageSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
const GoalCustomEntrySchema = Type.Union([
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("set"),
    goal: ThreadGoalSchema,
    at: Type.Number(),
  }),
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("usage"),
    source: Type.Literal("runtime"),
    goalId: Type.String(),
    status: RuntimeUsageGoalStatusSchema,
    usage: GoalUsageSchema,
    updatedAt: Type.Number(),
    at: Type.Number(),
  }),
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("clear"),
    clearedGoalId: Type.Union([Type.String(), Type.Null()]),
    at: Type.Number(),
  }),
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("host_overflow_cap_reset"),
    active: Type.Boolean(),
    at: Type.Number(),
  }),
]);

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountBudgetLimited?: boolean;
}

export interface ApplyUsageResult {
  goal: ThreadGoal | null;
  changed: boolean;
  crossedBudget: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneUsage(usage: GoalUsage): GoalUsage {
  return { ...usage };
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    usage: cloneUsage(goal.usage),
  };
}

export function goalsEquivalent(left: ThreadGoal, right: ThreadGoal): boolean {
  return (
    left.goalId === right.goalId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.tokenBudget === right.tokenBudget &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.usage.tokensUsed === right.usage.tokensUsed &&
    left.usage.activeSeconds === right.usage.activeSeconds
  );
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}

export function statusAfterBudgetLimit(
  status: GoalStatus,
  tokensUsed: number,
  tokenBudget: number | null,
): GoalStatus {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budgetLimited";
  }
  return status;
}

export function createThreadGoal(
  objective: string,
  tokenBudget?: number | null,
  now = unixSeconds(),
): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(
  goal: ThreadGoal,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function runtimeUsageEntry(goal: ThreadGoal, at = unixSeconds()): GoalCustomEntry {
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    throw new Error(`Cannot persist ${goal.status} goal as runtime usage entry.`);
  }
  return {
    version: 1,
    kind: "usage",
    source: "runtime",
    goalId: goal.goalId,
    status: goal.status,
    usage: cloneUsage(goal.usage),
    updatedAt: goal.updatedAt,
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function hostOverflowCapResetEntry(active: boolean, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at,
  };
}

export function isGoalCustomEntry(data: SessionEntryLike["data"]): data is GoalCustomEntry {
  return Check(GoalCustomEntrySchema, data);
}

export function isGoalUsage(usage: SessionEntryLike["data"]): usage is GoalUsage {
  return Check(GoalUsageSchema, usage);
}

export function isRuntimeUsageGoalStatus(
  status: SessionEntryLike["data"],
): status is RuntimeUsageGoalStatus {
  return Check(RuntimeUsageGoalStatusSchema, status);
}

export function isThreadGoal(goal: SessionEntryLike["data"]): goal is ThreadGoal {
  return Check(ThreadGoalSchema, goal);
}

export function isGoalStatus(status: SessionEntryLike["data"]): status is GoalStatus {
  return Check(GoalStatusSchema, status);
}

function canApplyRuntimeUsageEntry(
  goal: ThreadGoal | null,
  entry: Extract<GoalCustomEntry, { kind: "usage" }>,
): goal is ThreadGoal {
  if (!goal || goal.goalId !== entry.goalId) {
    return false;
  }
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    return false;
  }
  if (goal.status === "budgetLimited" && entry.status === "active") {
    return false;
  }
  return (
    entry.updatedAt >= goal.updatedAt &&
    entry.usage.tokensUsed >= goal.usage.tokensUsed &&
    entry.usage.activeSeconds >= goal.usage.activeSeconds
  );
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else if (entry.data.kind === "set") {
      goal = cloneGoal(entry.data.goal);
    } else if (entry.data.kind === "usage") {
      if (!canApplyRuntimeUsageEntry(goal, entry.data)) {
        continue;
      }
      goal = cloneGoal(goal);
      goal.status = entry.data.status;
      goal.usage = cloneUsage(entry.data.usage);
      goal.updatedAt = entry.data.updatedAt;
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function reconstructHostOverflowCapNeedsUserReset(
  entries: Iterable<SessionEntryLike>,
): boolean {
  let needsReset = false;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }

  return needsReset;
}

export function createGoal(
  current: ThreadGoal | null,
  objective: string,
  tokenBudget?: number | null,
): GoalResult {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a non-complete goal; use update_goal to mark it complete, /goal clear, or /goal <objective> to replace it",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(objective: string, tokenBudget?: number | null): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current,
      };
    }
    return {
      ok: false,
      message:
        "Completed goals are terminal; use /goal <objective> to replace or /goal clear before changing status.",
      goal: current,
    };
  }

  if (status === "complete") {
    const goal = cloneGoal(current);
    goal.status = "complete";
    goal.updatedAt = unixSeconds();
    return {
      ok: true,
      message: "Goal marked complete.",
      goal,
    };
  }

  if (status === "paused" && current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current,
    };
  }

  if (status === "active" && current.status !== "paused") {
    return {
      ok: false,
      message: "Only paused goals can be resumed.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  if (current.status === "budgetLimited" && (status === "active" || status === "paused")) {
    goal.status = "budgetLimited";
  } else {
    goal.status = statusAfterBudgetLimit(status, goal.usage.tokensUsed, goal.tokenBudget);
  }
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): ApplyUsageResult {
  if (!current) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const canAccount =
    current.status === "active" ||
    (options.accountBudgetLimited === true && current.status === "budgetLimited");
  if (!canAccount) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterBudgetLimit(goal.status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = unixSeconds();

  const crossedBudget =
    current.status === "active" &&
    wasUnderBudget &&
    goal.tokenBudget !== null &&
    goal.usage.tokensUsed >= goal.tokenBudget;

  return { goal, changed: true, crossedBudget };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (
    !current ||
    current.status !== "active" ||
    activeGoalId !== current.goalId ||
    lastAccountedAt === null
  ) {
    return current;
  }

  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
