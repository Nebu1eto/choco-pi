import assert from "node:assert/strict";
import test from "node:test";

import {
  isActiveGoalQueuedDetails,
  toQueuedGoalContextCarrier,
  userContentFromUnknown,
} from "../src/queued-goal-messages.ts";
import { extensionQueuedGoalWorkMessageId } from "../src/queued-goal-work.ts";
import {
  createGoalRecoveryOwnershipPublisher,
  GOAL_RECOVERY_SYMBOL,
} from "../src/recovery-ownership.ts";
import {
  isGoalCustomEntry,
  isGoalStatus,
  isGoalUsage,
  isRuntimeUsageGoalStatus,
  isThreadGoal,
} from "../src/state.ts";
import { registerGoalTools, type ToolHost } from "../src/tools.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import { classifyViaSeam, USAGE_LIMIT_POLICY_SYMBOL } from "../src/usage-limit-seam.ts";

const goalFixture = {
  goalId: "g1",
  objective: "ship",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 1, activeSeconds: 2 },
  createdAt: 1,
  updatedAt: 2,
};

test("goal status validators accept members and reject others", () => {
  assert.equal(isGoalStatus("budgetLimited"), true);
  assert.equal(isGoalStatus("done"), false);
  assert.equal(isGoalStatus(undefined), false);
  assert.equal(isRuntimeUsageGoalStatus("active"), true);
  assert.equal(isRuntimeUsageGoalStatus("paused"), false);
});

test("goal usage and thread goal stay open, require fields and reject non-finite numbers", () => {
  assert.equal(isGoalUsage({ tokensUsed: 1, activeSeconds: 2, extra: true }), true);
  assert.equal(isGoalUsage({ tokensUsed: 1 }), false);
  assert.equal(isGoalUsage({ tokensUsed: Number.NaN, activeSeconds: 2 }), false);
  assert.equal(isGoalUsage({ tokensUsed: Number.POSITIVE_INFINITY, activeSeconds: 2 }), false);
  assert.equal(isGoalUsage([]), false);
  assert.equal(isGoalUsage(null), false);

  assert.equal(isThreadGoal(goalFixture), true);
  assert.equal(isThreadGoal({ ...goalFixture, unknownKey: 1 }), true);
  assert.equal(isThreadGoal({ ...goalFixture, tokenBudget: 5 }), true);
  assert.equal(isThreadGoal({ ...goalFixture, tokenBudget: "5" }), false);
  assert.equal(isThreadGoal({ ...goalFixture, tokenBudget: undefined }), false);
  assert.equal(isThreadGoal({ ...goalFixture, status: "nope" }), false);
  assert.equal(isThreadGoal({ ...goalFixture, createdAt: Number.NaN }), false);
});

test("goal custom entries validate each variant, stay open and reject mismatches", () => {
  assert.equal(isGoalCustomEntry({ version: 1, kind: "set", goal: goalFixture, at: 3 }), true);
  assert.equal(
    isGoalCustomEntry({ version: 1, kind: "set", goal: goalFixture, at: 3, extra: "x" }),
    true,
  );
  assert.equal(
    isGoalCustomEntry({
      version: 1,
      kind: "usage",
      source: "runtime",
      goalId: "g1",
      status: "budgetLimited",
      usage: { tokensUsed: 1, activeSeconds: 2 },
      updatedAt: 2,
      at: 3,
    }),
    true,
  );
  assert.equal(
    isGoalCustomEntry({
      version: 1,
      kind: "usage",
      source: "runtime",
      goalId: "g1",
      status: "paused",
      usage: { tokensUsed: 1, activeSeconds: 2 },
      updatedAt: 2,
      at: 3,
    }),
    false,
  );
  assert.equal(isGoalCustomEntry({ version: 1, kind: "clear", clearedGoalId: null, at: 3 }), true);
  assert.equal(isGoalCustomEntry({ version: 1, kind: "clear", clearedGoalId: "g1", at: 3 }), true);
  assert.equal(isGoalCustomEntry({ version: 1, kind: "clear", clearedGoalId: 1, at: 3 }), false);
  assert.equal(
    isGoalCustomEntry({ version: 1, kind: "host_overflow_cap_reset", active: true, at: 3 }),
    true,
  );
  assert.equal(
    isGoalCustomEntry({ version: 1, kind: "host_overflow_cap_reset", active: "yes", at: 3 }),
    false,
  );
  assert.equal(isGoalCustomEntry({ version: 2, kind: "clear", clearedGoalId: null, at: 3 }), false);
  assert.equal(isGoalCustomEntry({ kind: "clear", clearedGoalId: null, at: 3 }), false);
  assert.equal(isGoalCustomEntry(undefined), false);
  assert.equal(isGoalCustomEntry("set"), false);
});

test("queued goal message guards keep openness, strings and finite timestamps", () => {
  assert.deepEqual(
    userContentFromUnknown([
      { type: "text", text: "a", extra: 1 },
      { type: "image", text: "b" },
      { type: "text" },
      { type: "text", text: 3 },
      "text",
      null,
    ]),
    [{ type: "text", text: "a" }],
  );
  assert.deepEqual(userContentFromUnknown("a"), []);

  assert.equal(isActiveGoalQueuedDetails({ kind: "continuation", goalId: "g" }), true);
  assert.equal(isActiveGoalQueuedDetails({ kind: "command_resume", goalId: "g", more: 1 }), true);
  assert.equal(isActiveGoalQueuedDetails({ kind: "other", goalId: "g" }), false);
  assert.equal(isActiveGoalQueuedDetails({ kind: "continuation" }), false);
  assert.equal(isActiveGoalQueuedDetails(undefined), false);

  assert.notEqual(toQueuedGoalContextCarrier({ role: "user", timestamp: 1 }), null);
  assert.equal(toQueuedGoalContextCarrier({ role: "user" }), null);
  assert.equal(toQueuedGoalContextCarrier({ role: "user", timestamp: Number.NaN }), null);

  // Open superseded details are recognised and not treated as active work.
  assert.equal(
    extensionQueuedGoalWorkMessageId({
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: "x",
      details: { kind: "superseded_continuation", goalId: "g", extra: 1 },
    }),
    null,
  );
  assert.equal(
    extensionQueuedGoalWorkMessageId({
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: "x",
      details: { kind: "continuation", goalId: "g" },
    }),
    "g",
  );
});

function withPolicy<T>(policy: {} | null, run: () => T): T {
  Object.defineProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL, {
    configurable: true,
    writable: true,
    value: new Map([["owner", policy]]),
  });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL);
  }
}

const classifyInput = { provider: "p", modelId: "m", errorMessage: "e" };

test("usage limit seam validates the policy shape and the classification result", () => {
  const good = { kind: "quota", provider: "p", modelId: "m", confidence: "parsed", extra: 1 };
  assert.deepEqual(
    withPolicy({ classify: () => good }, () => classifyViaSeam("owner", classifyInput)),
    good,
  );
  const optional = { ...good, accountId: "a", resetAt: 5 };
  assert.deepEqual(
    withPolicy({ classify: () => optional }, () => classifyViaSeam("owner", classifyInput)),
    optional,
  );
  assert.notEqual(
    withPolicy({ classify: () => ({ ...good, accountId: undefined }) }, () =>
      classifyViaSeam("owner", classifyInput),
    ),
    undefined,
  );
  for (const bad of [
    { ...good, kind: "other" },
    { ...good, confidence: "guess" },
    { ...good, resetAt: Number.NaN },
    { ...good, resetAt: "5" },
    { ...good, provider: undefined },
    null,
    "x",
  ]) {
    assert.equal(
      withPolicy({ classify: () => bad }, () => classifyViaSeam("owner", classifyInput)),
      undefined,
    );
  }
  assert.equal(
    withPolicy({ classify: "no" }, () => classifyViaSeam("owner", classifyInput)),
    undefined,
  );
  assert.equal(
    withPolicy({}, () => classifyViaSeam("owner", classifyInput)),
    undefined,
  );
  assert.equal(
    withPolicy(null, () => classifyViaSeam("owner", classifyInput)),
    undefined,
  );
  assert.equal(
    withPolicy({ classify: () => good }, () => classifyViaSeam("other", classifyInput)),
    undefined,
  );
  assert.equal(
    withPolicy(
      {
        classify: () => {
          throw new Error("boom");
        },
      },
      () => classifyViaSeam("owner", classifyInput),
    ),
    undefined,
  );
});

test("recovery slot skips junk readers and malformed ownership, keeps valid ones", () => {
  const publisher = createGoalRecoveryOwnershipPublisher({
    getOwnerSessionId: () => "s1",
    getGoal: () => ({ ...goalFixture, status: "active" }),
    isProviderLimitAutoResumeScheduled: () => true,
  });
  publisher.install();
  try {
    const entry = Object.getOwnPropertyDescriptor(globalThis, GOAL_RECOVERY_SYMBOL)?.value;
    assert.ok(entry instanceof Object);
    const readers = Object.getOwnPropertyDescriptor(entry, "readers")?.value;
    assert.ok(readers instanceof Set);
    readers.clear();
    readers.add("junk");
    readers.add(() => ({
      owner: 1,
      goalId: "x",
      status: "active",
      providerLimitResumeScheduled: true,
    }));
    readers.add(() => ({
      owner: "o",
      goalId: "x",
      status: "complete",
      providerLimitResumeScheduled: true,
    }));
    readers.add(() => {
      throw new Error("disposed");
    });
    readers.add(() => ({
      owner: "o",
      goalId: "x",
      status: "paused",
      providerLimitResumeScheduled: false,
      extra: 1,
    }));
    const read = Object.getOwnPropertyDescriptor(entry, "recoveryOwnership")?.value;
    assert.ok(read instanceof Function);
    assert.deepEqual(read.call(entry), {
      owner: "o",
      goalId: "x",
      status: "paused",
      providerLimitResumeScheduled: false,
    });
    assert.equal(read.call(entry, "other"), undefined);
  } finally {
    Reflect.deleteProperty(globalThis, GOAL_RECOVERY_SYMBOL);
  }
});

interface ToolProperty {
  type?: string;
  minimum?: number;
  enum?: string[];
}

interface CapturedParameters {
  properties?: Record<string, ToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface CapturedTool {
  name: string;
  parameters: CapturedParameters;
}

function captureTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const host: ToolHost = {
    getGoal: () => null,
    setGoal: () => {},
    completeGoal: () => ({ ok: false, goal: null, message: "none" }),
  };
  registerGoalTools(
    {
      registerTool(definition) {
        // The host schema serializes as plain JSON Schema.
        const parameters: CapturedParameters = JSON.parse(JSON.stringify(definition.parameters));
        captured.push({ name: definition.name, parameters });
      },
    },
    host,
  );
  return captured;
}

test("tool parameter schemas keep names, requiredness, enum and openness", () => {
  const byName = new Map(captureTools().map((tool) => [tool.name, tool.parameters]));
  assert.deepEqual([...byName.keys()], ["get_goal", "create_goal", "update_goal"]);

  const create = byName.get("create_goal");
  assert.ok(create?.properties);
  assert.deepEqual(Object.keys(create.properties), [
    "objective",
    "token_budget",
    "replace_existing",
  ]);
  assert.deepEqual(create.required, ["objective"]);
  assert.notEqual(create.additionalProperties, false);
  assert.equal(create.properties.token_budget?.type, "integer");
  assert.equal(create.properties.token_budget?.minimum, 1);

  const update = byName.get("update_goal");
  assert.ok(update?.properties);
  assert.deepEqual(update.required, ["status"]);
  assert.deepEqual(update.properties.status?.enum, ["complete"]);
  assert.notEqual(update.additionalProperties, false);

  const empty = byName.get("get_goal");
  assert.ok(empty);
  assert.notEqual(empty.additionalProperties, false);
});
