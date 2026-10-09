import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  CodexUsageLimitEntrySchema,
  DEFAULT_ON_USAGE_LIMIT,
  GOAL_RECOVERY_SYMBOL,
  ON_USAGE_LIMIT_VALUES,
  OnUsageLimitSchema,
  SUBAGENTS_USAGE_LIMIT_EVENT,
  USAGE_LIMIT_PENDING_ENTRY,
  USAGE_LIMIT_POLICY_SYMBOL,
  USAGE_LIMIT_RESOLVED_ENTRY,
  SubagentUsageLimitSchema,
  UsageLimitClassificationSchema,
  UsageLimitPendingEntrySchema,
  UsageLimitResolvedEntrySchema,
  getUsageLimitPolicy,
  getUsageLimitPolicyMap,
  isUsageLimitPolicy,
  parseCodexUsageLimitEntry,
  parseOnUsageLimit,
  parseSubagentUsageLimit,
  parseUsageLimitPendingEntry,
  parseUsageLimitResolvedEntry,
  readChildSessionProbe,
  readGoalRecoveryOwnership,
  registerUsageLimitPolicy,
  type UsageLimitPolicy,
} from "../.pi/extensions/lib/usage-limit-contract.ts";

const managerSymbol = Symbol.for("pi-subagents:manager");

function policy(owner: string): UsageLimitPolicy {
  return {
    owner,
    generation: 1,
    preference: async () => "none",
    classify: () => undefined,
    corroborate: async (classification) => ({ ready: false, classification }),
    pickFallback: () => undefined,
    closeProvider: () => undefined,
    isClosed: () => false,
  };
}

function withSlot(symbol: symbol, value: RuntimeValue, run: () => void): void {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const hadValue = Object.prototype.hasOwnProperty.call(globalThis, symbol);
  const previous = slots[symbol];
  try {
    slots[symbol] = value;
    run();
  } finally {
    if (hadValue) slots[symbol] = previous;
    else Reflect.deleteProperty(globalThis, symbol);
  }
}

test("on-usage-limit values and classification schema accept valid data and reject invalid data", () => {
  assert.deepEqual(ON_USAGE_LIMIT_VALUES, ["auto-resume", "fallback", "none"]);
  assert.equal(DEFAULT_ON_USAGE_LIMIT, "none");
  assert.equal(parseOnUsageLimit("fallback"), "fallback");
  assert.equal(parseOnUsageLimit("FALLBACK"), undefined);
  assert.equal(Value.Check(OnUsageLimitSchema, "none"), true);
  assert.equal(Value.Check(OnUsageLimitSchema, "later"), false);
  assert.equal(
    Value.Check(UsageLimitClassificationSchema, {
      kind: "quota",
      provider: "openai-codex",
      modelId: "gpt",
      confidence: "parsed",
    }),
    true,
  );
  assert.equal(
    Value.Check(UsageLimitClassificationSchema, {
      kind: "unknown",
      provider: "openai-codex",
      modelId: "gpt",
      confidence: "parsed",
    }),
    false,
  );
  assert.equal(
    Value.Check(UsageLimitClassificationSchema, {
      kind: "quota",
      provider: "openai-codex",
      modelId: "gpt",
      confidence: "structured",
      sessionId: "child-1",
    }),
    true,
    "sessionId is an optional string",
  );
  assert.equal(
    Value.Check(UsageLimitClassificationSchema, {
      kind: "quota",
      provider: "openai-codex",
      modelId: "gpt",
      confidence: "structured",
      sessionId: 7,
    }),
    false,
  );
});

test("usage-limit policy guard rejects malformed entries and registration preserves newer ownership", () => {
  const first = policy("root");
  assert.equal(isUsageLimitPolicy(first), true);
  assert.equal(isUsageLimitPolicy({ ...first, classify: "not-a-function" }), false);
  assert.equal(isUsageLimitPolicy({ ...first, generation: "1" }), false);
  assert.equal(isUsageLimitPolicy({ ...first, accountId: () => "acct" }), true);
  assert.equal(isUsageLimitPolicy({ ...first, accountId: "acct" }), false);
  assert.equal(isUsageLimitPolicy({ ...first, accountId: undefined }), true);
  withSlot(USAGE_LIMIT_POLICY_SYMBOL, undefined, () => {
    const firstUnregister = registerUsageLimitPolicy(first);
    assert.equal(getUsageLimitPolicy("root"), first);
    const second = policy("root");
    const secondUnregister = registerUsageLimitPolicy(second);
    firstUnregister();
    assert.equal(getUsageLimitPolicy("root"), second);
    secondUnregister();
    assert.equal(getUsageLimitPolicy("root"), undefined);
    assert.equal(getUsageLimitPolicyMap() instanceof Map, true);
  });
  withSlot(USAGE_LIMIT_POLICY_SYMBOL, new Map([["root", { owner: "root" }]]), () => {
    assert.throws(() => getUsageLimitPolicyMap(), TypeError);
  });
});

test("persisted schemas and parsers accept valid entries and reject malformed entries", () => {
  const pending = {
    recoveryId: "recovery",
    resetAt: 2,
    modelId: "gpt",
    provider: "openai-codex",
    accountId: "account",
    attempts: 1,
    branchEntryId: "branch",
  };
  assert.equal(USAGE_LIMIT_PENDING_ENTRY, "choco-pi-usage-limit-pending");
  assert.equal(Value.Check(UsageLimitPendingEntrySchema, pending), true);
  assert.deepEqual(parseUsageLimitPendingEntry(pending), pending);
  assert.equal(parseUsageLimitPendingEntry({ ...pending, attempts: "1" }), undefined);
  const owned = { ...pending, sessionId: "root" };
  assert.deepEqual(parseUsageLimitPendingEntry(owned), owned);
  assert.equal(parseUsageLimitPendingEntry({ ...pending, sessionId: 1 }), undefined);
  const resolved = { recoveryId: "recovery", outcome: "continued" };
  assert.equal(USAGE_LIMIT_RESOLVED_ENTRY, "choco-pi-usage-limit-resolved");
  assert.equal(Value.Check(UsageLimitResolvedEntrySchema, resolved), true);
  assert.deepEqual(parseUsageLimitResolvedEntry(resolved), resolved);
  assert.equal(parseUsageLimitResolvedEntry({ ...resolved, outcome: "later" }), undefined);
  const codex = { resetAt: 2, planType: "plus", observedAt: 1, accountId: "account" };
  assert.equal(CODEX_USAGE_LIMIT_ENTRY, "choco-pi-codex-usage-limit");
  assert.equal(Value.Check(CodexUsageLimitEntrySchema, codex), true);
  assert.deepEqual(parseCodexUsageLimitEntry(codex), codex);
  assert.equal(parseCodexUsageLimitEntry({ ...codex, observedAt: "1" }), undefined);
});

test("subagent usage-limit schema and parser validate event payload data", () => {
  const limit = {
    provider: "anthropic",
    accountId: "account",
    kind: "quota",
    resetAt: 2,
    suggestedModel: "openai-codex/gpt",
    status: "reported",
  };
  assert.equal(SUBAGENTS_USAGE_LIMIT_EVENT, "subagents:usage_limit");
  assert.equal(Value.Check(SubagentUsageLimitSchema, limit), true);
  assert.deepEqual(parseSubagentUsageLimit(limit), limit);
  assert.equal(parseSubagentUsageLimit({ ...limit, status: "waiting" }), undefined);
});

test("goal recovery and child-session readers reject malformed host slots", () => {
  withSlot(
    GOAL_RECOVERY_SYMBOL,
    {
      recoveryOwnership: () => ({
        goalId: "goal",
        status: "paused",
        providerLimitResumeScheduled: true,
      }),
    },
    () => {
      assert.deepEqual(readGoalRecoveryOwnership(), {
        goalId: "goal",
        status: "paused",
        providerLimitResumeScheduled: true,
      });
    },
  );
  withSlot(GOAL_RECOVERY_SYMBOL, { recoveryOwnership: () => ({ status: "paused" }) }, () => {
    assert.equal(readGoalRecoveryOwnership(), undefined);
  });
  withSlot(
    managerSymbol,
    { isChildSessionContext: () => true, isChildSessionId: (id: string) => id === "child" },
    () => {
      const probe = readChildSessionProbe();
      assert.ok(probe);
      assert.equal(probe.isChildSessionContext(), true);
      assert.equal(probe.isChildSessionId("child"), true);
    },
  );
  withSlot(managerSymbol, { isChildSessionContext: () => true }, () => {
    assert.equal(readChildSessionProbe(), undefined);
  });
});

test("goal recovery reader scopes ownership to the requested owner", () => {
  const goal = { goalId: "goal", status: "active", providerLimitResumeScheduled: false };
  const calls: RuntimeValue[][] = [];
  // A goal package that accepts the owner argument answers only for its own session.
  const scoped = {
    recoveryOwnership: (...args: RuntimeValue[]) => {
      calls.push(args);
      const [owner] = args;
      return owner === undefined || owner === "root-a" ? { ...goal, owner: "root-a" } : undefined;
    },
  };
  withSlot(GOAL_RECOVERY_SYMBOL, scoped, () => {
    assert.deepEqual(readGoalRecoveryOwnership("root-a"), { ...goal, owner: "root-a" });
    assert.equal(readGoalRecoveryOwnership("root-b"), undefined);
    assert.deepEqual(readGoalRecoveryOwnership(), { ...goal, owner: "root-a" });
  });
  assert.deepEqual(calls, [["root-a"], ["root-b"], []]);

  // An entry that ignores the argument but names another owner is rejected.
  withSlot(
    GOAL_RECOVERY_SYMBOL,
    { recoveryOwnership: () => ({ ...goal, owner: "root-a" }) },
    () => {
      assert.equal(readGoalRecoveryOwnership("root-b"), undefined);
      assert.deepEqual(readGoalRecoveryOwnership("root-a"), { ...goal, owner: "root-a" });
    },
  );
  // A result without an owner comes from a goal package that predates it and is accepted.
  withSlot(GOAL_RECOVERY_SYMBOL, { recoveryOwnership: () => goal }, () => {
    assert.deepEqual(readGoalRecoveryOwnership("root-b"), goal);
  });
  withSlot(GOAL_RECOVERY_SYMBOL, { recoveryOwnership: () => ({ ...goal, owner: 7 }) }, () => {
    assert.equal(readGoalRecoveryOwnership("root-a"), undefined, "a non-string owner is malformed");
  });
});
