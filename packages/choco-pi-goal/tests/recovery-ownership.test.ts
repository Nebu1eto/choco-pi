import assert from "node:assert/strict";
import test from "node:test";

import { createGoalRecoveryMachine } from "../src/recovery-machine.ts";
import {
  createGoalRecoveryOwnershipPublisher,
  GOAL_RECOVERY_SYMBOL,
  type GoalRecoveryOwnership,
} from "../src/recovery-ownership.ts";
import { createGoalRecoveryRuntime } from "../src/recovery-runtime.ts";
import { isProviderLimitError, type AssistantErrorMessage } from "../src/recovery.ts";
import { createGoal, updateGoalStatus } from "../src/state.ts";
import type { ThreadGoal } from "../src/types.ts";
import {
  classifyViaSeam,
  USAGE_LIMIT_POLICY_SYMBOL,
  type UsageLimitClassification,
  type UsageLimitClassifyInput,
  type UsageLimitKind,
} from "../src/usage-limit-seam.ts";

const OWNER = "root-session";
const CODEX_PROSE = "Codex usage limit reached. Try again later.";

type Classifier = (input: UsageLimitClassifyInput) => UsageLimitClassification | undefined;

function newGoal(): ThreadGoal {
  const created = createGoal(null, "Ship the feature");
  assert.ok(created.goal);
  return created.goal;
}

function pausedGoal(goal: ThreadGoal): ThreadGoal {
  const paused = updateGoalStatus(goal, "paused");
  assert.ok(paused.goal);
  return paused.goal;
}

/** Mirrors the root contract reader: validate the entry, then call it with the entry as receiver. */
function readOwnership(owner?: string): GoalRecoveryOwnership | undefined {
  const entry = Object.getOwnPropertyDescriptor(globalThis, GOAL_RECOVERY_SYMBOL)?.value;
  if (entry === undefined) return undefined;
  assert.ok(entry instanceof Object);
  const read = Object.getOwnPropertyDescriptor(entry, "recoveryOwnership")?.value;
  assert.ok(read instanceof Function);
  return read.call(entry, owner);
}

function hasRecoverySlot(): boolean {
  return Object.getOwnPropertyDescriptor(globalThis, GOAL_RECOVERY_SYMBOL) !== undefined;
}

function installPolicies(policies: Map<string, { classify: Classifier }>): () => void {
  Object.defineProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL, {
    configurable: true,
    writable: true,
    value: policies,
  });
  return () => {
    Reflect.deleteProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL);
  };
}

function classifyAs(kind: UsageLimitKind, calls: UsageLimitClassifyInput[] = []): Classifier {
  return (input) => {
    calls.push(input);
    return { kind, provider: input.provider, modelId: input.modelId, confidence: "parsed" };
  };
}

function seamContext(ownerSessionId: string | undefined = OWNER) {
  return { ownerSessionId, provider: "openai-codex", modelId: "gpt-5" };
}

test("ownership is undefined without a goal and after completion", () => {
  let goal: ThreadGoal | null = null;
  const publisher = createGoalRecoveryOwnershipPublisher({
    getOwnerSessionId: () => OWNER,
    getGoal: () => goal,
    isProviderLimitAutoResumeScheduled: () => false,
  });
  publisher.install();
  try {
    assert.equal(readOwnership(), undefined);
    const complete = updateGoalStatus(newGoal(), "complete");
    goal = complete.goal;
    assert.equal(goal?.status, "complete");
    assert.equal(readOwnership(), undefined);
  } finally {
    publisher.dispose();
  }
});

test("ownership reports active and paused goals with the scheduled resume flag", () => {
  let goal: ThreadGoal | null = newGoal();
  let scheduledFor: string | null = null;
  const publisher = createGoalRecoveryOwnershipPublisher({
    getOwnerSessionId: () => OWNER,
    getGoal: () => goal,
    isProviderLimitAutoResumeScheduled: (goalId) => goalId === scheduledFor,
  });
  publisher.install();
  try {
    assert.ok(goal);
    assert.deepEqual(readOwnership(), {
      owner: OWNER,
      goalId: goal.goalId,
      status: "active",
      providerLimitResumeScheduled: false,
    });
    goal = pausedGoal(goal);
    scheduledFor = goal.goalId;
    assert.deepEqual(readOwnership(), {
      owner: OWNER,
      goalId: goal.goalId,
      status: "paused",
      providerLimitResumeScheduled: true,
    });
  } finally {
    publisher.dispose();
  }
});

test("dispose removes the slot and keeps another runtime's ownership", () => {
  const rootGoal = newGoal();
  const root = createGoalRecoveryOwnershipPublisher({
    getOwnerSessionId: () => "A",
    getGoal: () => rootGoal,
    isProviderLimitAutoResumeScheduled: () => false,
  });
  const child = createGoalRecoveryOwnershipPublisher({
    getOwnerSessionId: () => "B",
    getGoal: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
  });
  root.install();
  root.install();
  child.install();
  assert.equal(readOwnership()?.goalId, rootGoal.goalId);
  assert.equal(readOwnership("B"), undefined);
  assert.equal(readOwnership("A")?.owner, "A");

  child.dispose();
  assert.equal(readOwnership()?.goalId, rootGoal.goalId);

  root.dispose();
  assert.equal(hasRecoverySlot(), false);
  assert.equal(readOwnership(), undefined);

  root.dispose();
  assert.equal(hasRecoverySlot(), false);
});

test("the classifier seam is consulted for the owner's policy", () => {
  const calls: UsageLimitClassifyInput[] = [];
  const restore = installPolicies(new Map([[OWNER, { classify: classifyAs("quota", calls) }]]));
  try {
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), true);
    assert.deepEqual(calls, [
      { provider: "openai-codex", modelId: "gpt-5", errorMessage: CODEX_PROSE },
    ]);
    assert.equal(isProviderLimitError("429 Too Many Requests", seamContext()), true);
    assert.equal(
      classifyViaSeam(OWNER, { provider: "p", modelId: "m", errorMessage: "e" })?.kind,
      "quota",
    );
  } finally {
    restore();
  }
});

test("billing classifications are provider limits", () => {
  const restore = installPolicies(new Map([[OWNER, { classify: classifyAs("billing") }]]));
  try {
    assert.equal(isProviderLimitError("402 payment required", seamContext()), true);
  } finally {
    restore();
  }
});

test("the regex decides when the seam or the owner's policy is absent", () => {
  assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), false);
  assert.equal(isProviderLimitError("insufficient_quota", seamContext()), true);

  const restore = installPolicies(new Map([["other-session", { classify: classifyAs("quota") }]]));
  try {
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), false);
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext(undefined)), false);
    assert.equal(isProviderLimitError(CODEX_PROSE), false);
  } finally {
    restore();
  }
});

test("transient classifications never create a provider limit", () => {
  const restore = installPolicies(new Map([[OWNER, { classify: classifyAs("transient") }]]));
  try {
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), false);
    assert.equal(isProviderLimitError("429 Too Many Requests", seamContext()), false);
  } finally {
    restore();
  }
});

test("a throwing policy, invalid result, or malformed slot falls back without throwing", () => {
  const throwing: Classifier = () => {
    throw new Error("policy failure");
  };
  let restore = installPolicies(new Map([[OWNER, { classify: throwing }]]));
  try {
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), false);
    assert.equal(isProviderLimitError("quota exceeded", seamContext()), true);
  } finally {
    restore();
  }

  const invalid: Classifier = () => undefined;
  restore = installPolicies(new Map([[OWNER, { classify: invalid }]]));
  try {
    assert.equal(isProviderLimitError(CODEX_PROSE, seamContext()), false);
  } finally {
    restore();
  }

  Object.defineProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL, {
    configurable: true,
    writable: true,
    value: "not a map",
  });
  try {
    assert.equal(
      classifyViaSeam(OWNER, { provider: "p", modelId: "m", errorMessage: "e" }),
      undefined,
    );
  } finally {
    Reflect.deleteProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL);
  }
});

function recoveryFixture(goal: ThreadGoal) {
  let current: ThreadGoal | null = goal;
  const scheduled: string[] = [];
  const recoveryState = createGoalRecoveryMachine();
  const runtime = createGoalRecoveryRuntime<string>({
    getGoal: () => current,
    getRecoveryState: () => recoveryState,
    getOwnerSessionId: (ctx) => ctx,
    clearContinuationState: () => {},
    pauseGoalForRecovery: () => {
      if (current) current = pausedGoal(current);
    },
    refreshUi: () => {},
    maybeContinue: () => {},
    scheduleProviderLimitAutoResume: (goalId) => {
      scheduled.push(goalId);
    },
  });
  return {
    runtime,
    scheduled,
    recoveryState,
    status: () => current?.status,
  };
}

function errorMessage(text: string): AssistantErrorMessage {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: text,
    provider: "anthropic",
    model: "claude-sonnet",
  };
}

test("a classifier-confirmed 429 pauses the goal and schedules the provider-limit resume", () => {
  const restore = installPolicies(new Map([[OWNER, { classify: classifyAs("quota") }]]));
  try {
    const goal = newGoal();
    const fixture = recoveryFixture(goal);
    fixture.runtime.handlePersistentAssistantError(errorMessage("429 Too Many Requests"), OWNER);
    assert.equal(fixture.status(), "paused");
    assert.deepEqual(fixture.scheduled, [goal.goalId]);
  } finally {
    restore();
  }
});

test("without the seam a bare 429 stays a pending transient failure", () => {
  const goal = newGoal();
  const fixture = recoveryFixture(goal);
  fixture.runtime.handlePersistentAssistantError(errorMessage("429 Too Many Requests"), OWNER);
  assert.equal(fixture.status(), "active");
  assert.equal(fixture.recoveryState.attention?.kind, "pending");
  assert.deepEqual(fixture.scheduled, []);
});

test("regex provider limits still schedule the resume without the seam", () => {
  const goal = newGoal();
  const fixture = recoveryFixture(goal);
  fixture.runtime.handlePersistentAssistantError(errorMessage("insufficient_quota"), OWNER);
  assert.equal(fixture.status(), "paused");
  assert.deepEqual(fixture.scheduled, [goal.goalId]);
});
