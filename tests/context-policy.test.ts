import assert from "node:assert/strict";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import test from "node:test";
import {
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_SOFT_CAP_TOKENS,
  type AutoCompactionPoint,
  type ContextSoftCap,
} from "../.pi/extensions/lib/agent-preferences.ts";
import {
  computeContextPolicy,
  computeHeadroom,
  NATIVE_COMPACTION_BUDGET_SYMBOL,
  readNativeCompactionBudget,
  type ContextPolicy,
  HEADROOM_MARGIN_TOKENS,
  HEADROOM_MAX_TOKENS,
  HEADROOM_RATIO,
} from "../.pi/extensions/lib/context-policy.ts";

interface PolicyCase {
  name: string;
  native: number;
  softCap: ContextSoftCap;
  point: AutoCompactionPoint;
  budget?: number;
  expected: ContextPolicy;
}

const HOST_RESERVE = 16_384;

const cases: PolicyCase[] = [
  {
    name: "1M-class model under standard presets",
    native: 1_050_000,
    softCap: "standard",
    point: "standard",
    // headroom = min(0.15 × 600_000 = 90_000, 100_000) = 90_000; 450_000 < 510_000.
    expected: { apply: true, cap: 600_000, compactAt: 450_000, headroom: 90_000 },
  },
  {
    name: "permissive presets above the native window collapse to it",
    native: 500_000,
    softCap: "permissive",
    point: "permissive",
    // cap = native; headroom = 0.15 × 500_000 = 75_000; 600_000 ≥ 425_000 → 425_000.
    expected: { apply: true, cap: 500_000, compactAt: 425_000, headroom: 75_000 },
  },
  {
    name: "272K model keeps its window and compacts at cap − 15%",
    native: 272_000,
    softCap: "standard",
    point: "standard",
    // headroom = 0.15 × 272_000 = 40_800; 450_000 ≥ 231_200 → 231_200.
    expected: { apply: true, cap: 272_000, compactAt: 231_200, headroom: 40_800 },
  },
  {
    name: "200K model: the ratio beats the host-reserve floor",
    native: 200_000,
    softCap: "standard",
    point: "standard",
    // headroom = max(16_384 + 8_000 = 24_384, 0.15 × 200_000 = 30_000) = 30_000.
    expected: { apply: true, cap: 200_000, compactAt: 170_000, headroom: 30_000 },
  },
  {
    name: "unlimited presets are bounded by a published native-compaction budget",
    native: 1_050_000,
    softCap: "unlimited",
    point: "unlimited",
    budget: 872_000,
    // headroom = min(157_500, 100_000) = 100_000; min(950_000, 872_000 − 100_000) = 772_000.
    expected: {
      apply: true,
      cap: 1_050_000,
      compactAt: 772_000,
      headroom: 100_000,
    },
  },
  {
    name: "windows under 64K leave Pi's own trigger in place",
    native: 32_000,
    softCap: "standard",
    point: "standard",
    expected: { apply: false },
  },
];

for (const entry of cases) {
  test(`context policy: ${entry.name}`, () => {
    assert.deepEqual(
      computeContextPolicy({
        nativeWindow: entry.native,
        softCap: CONTEXT_SOFT_CAP_TOKENS[entry.softCap],
        compactionPoint: AUTO_COMPACTION_POINT_TOKENS[entry.point],
        hostReserve: HOST_RESERVE,
        budget: entry.budget,
      }),
      entry.expected,
    );
  });
}

test("preset token tables match the documented values", () => {
  assert.deepEqual(CONTEXT_SOFT_CAP_TOKENS, {
    strictest: 250_000,
    strict: 400_000,
    standard: 600_000,
    permissive: 800_000,
    unlimited: "unlimited",
  });
  assert.deepEqual(AUTO_COMPACTION_POINT_TOKENS, {
    strictest: 200_000,
    strict: 300_000,
    standard: 450_000,
    permissive: 600_000,
    unlimited: "unlimited",
  });
});

test("headroom is fixed at min(100K, 15% of the cap) with a host-reserve floor", () => {
  assert.equal(HEADROOM_RATIO, 0.15);
  assert.equal(HEADROOM_MAX_TOKENS, 100_000);
  assert.equal(HEADROOM_MARGIN_TOKENS, 8_000);
  assert.equal(computeHeadroom(600_000, HOST_RESERVE), 90_000);
  assert.equal(computeHeadroom(1_050_000, HOST_RESERVE), 100_000);
  assert.equal(computeHeadroom(100_000, HOST_RESERVE), 24_384);
  assert.equal(computeHeadroom(100_000, 32_000), 40_000);
  // The floor wins over the maximum when the host reserve is very large.
  assert.equal(computeHeadroom(1_050_000, 120_000), 128_000);
  assert.equal(computeHeadroom(200_000), 30_000, "Pi's default reserve applies when omitted");
});

test("a budget that leaves no room under the headroom is ignored", () => {
  assert.deepEqual(
    computeContextPolicy({
      nativeWindow: 1_050_000,
      softCap: 600_000,
      compactionPoint: 450_000,
      budget: 50_000,
    }),
    { apply: true, cap: 600_000, compactAt: 450_000, headroom: 90_000 },
  );
});

/** What a test publishes on the budget slot; foreign shapes are deliberately allowed. */
interface BudgetSlotValue {
  readonly version: number;
  readonly budgetFor: RuntimeValue;
}

/** Publish `value` on the budget slot for the duration of `run`, then remove it. */
function withBudgetHook(value: BudgetSlotValue, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
  Object.defineProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL, {
    configurable: true,
    value,
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL, previous);
    else Reflect.deleteProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
  }
}

const codexModel = { provider: "openai-codex", id: "gpt-6", contextWindow: 1_050_000 };

test("the native-compaction budget hook is read only when valid", () => {
  assert.equal(readNativeCompactionBudget(codexModel), undefined, "absent hook: no clamp");

  const seen: { provider: string; id: string; contextWindow: number }[] = [];
  withBudgetHook(
    {
      version: 1,
      budgetFor: (model: { provider: string; id: string; contextWindow: number }) => {
        seen.push(model);
        return model.provider === "openai-codex" ? 872_000 : undefined;
      },
    },
    () => {
      assert.equal(readNativeCompactionBudget(codexModel), 872_000);
      assert.equal(
        readNativeCompactionBudget({ provider: "anthropic", id: "x", contextWindow: 1 }),
        undefined,
      );
    },
  );
  assert.deepEqual(seen[0], codexModel);

  withBudgetHook({ version: 2, budgetFor: () => 872_000 }, () => {
    assert.equal(readNativeCompactionBudget(codexModel), undefined, "unknown version");
  });
  withBudgetHook({ version: 1, budgetFor: 872_000 }, () => {
    assert.equal(readNativeCompactionBudget(codexModel), undefined, "non-function budgetFor");
  });
  withBudgetHook({ version: 1, budgetFor: () => "872000" }, () => {
    assert.equal(readNativeCompactionBudget(codexModel), undefined, "non-number budget");
  });
  withBudgetHook({ version: 1, budgetFor: () => -1 }, () => {
    assert.equal(readNativeCompactionBudget(codexModel), undefined, "non-positive budget");
  });
  withBudgetHook(
    {
      version: 1,
      budgetFor: () => {
        throw new Error("boom");
      },
    },
    () => {
      assert.equal(readNativeCompactionBudget(codexModel), undefined, "throwing hook");
    },
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL),
    undefined,
    "the fake global is cleaned up",
  );
});
