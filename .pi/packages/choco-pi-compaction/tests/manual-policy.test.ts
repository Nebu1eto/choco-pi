/**
 * Manual follower fallback policy (D6): every row of the decision table, the
 * guard and eligibility blockers, and the exact outcome notices.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CoordinatorStatus, ReasonCode } from "../src/background/contract.ts";
import {
  isManualCancellation,
  manualFallbackPolicy,
  type ManualPolicyInput,
  NOTHING_TO_SUMMARIZE_NOTICE,
} from "../src/background-host/manual-policy.ts";

function status(
  state: CoordinatorStatus["state"],
  reason?: ReasonCode,
  extra: { readonly detail?: string; readonly backendId?: string } = {},
): CoordinatorStatus {
  const base = {
    ownerKey: "owner",
    ownerGeneration: 1,
    state,
    candidateId: "c1",
    backendId: extra.backendId ?? "anthropic-native",
  } satisfies CoordinatorStatus;
  if (reason === undefined) return base;
  if (extra.detail === undefined) return { ...base, reason };
  return { ...base, reason, detail: extra.detail };
}

function input(
  value: CoordinatorStatus,
  overrides: Partial<Omit<ManualPolicyInput, "status">> = {},
): ManualPolicyInput {
  return {
    status: value,
    failure: undefined,
    opaqueBlocked: false,
    textEnabled: true,
    ...overrides,
  };
}

test("cancellations stop silently and are never retried", () => {
  const cancellations: readonly ReasonCode[] = [
    "canceled",
    "stale-prefix",
    "owner-changed",
    "manual-instructions",
    "checkpoint-changed",
    "disposed",
  ];
  for (const reason of cancellations) {
    for (const state of ["canceled", "discarded-stale"] as const) {
      const outcome = manualFallbackPolicy(input(status(state, reason)));
      assert.deepEqual(outcome, { action: "stop", level: "info" }, `${state}/${reason}`);
      assert.equal(isManualCancellation(status(state, reason)), true);
    }
  }
  // An overflow cancel is `canceled` with detail `overflow`.
  assert.deepEqual(
    manualFallbackPolicy(input(status("canceled", "canceled", { detail: "overflow" }))),
    { action: "stop", level: "info" },
  );
  // A cancellation stays silent even when the guard or eligibility would block a retry.
  assert.deepEqual(
    manualFallbackPolicy(
      input(status("canceled", "owner-changed"), { opaqueBlocked: true, textEnabled: false }),
    ),
    { action: "stop", level: "info" },
  );
});

test("auth stops with the foreground warning and no text retry", () => {
  const outcome = manualFallbackPolicy(input(status("failed", "auth")));
  assert.equal(outcome.action, "stop");
  assert.equal(outcome.level, "warning");
  assert.match(outcome.notice ?? "", /auth/u);
  assert.match(outcome.notice ?? "", /same login/u);
});

test("a disabled lane retries on text with a folded notice", () => {
  const outcome = manualFallbackPolicy(input(status("canceled", "disabled")));
  assert.equal(isManualCancellation(status("canceled", "disabled")), false);
  assert.deepEqual(outcome, {
    action: "retry-text",
    notice: "checkpoint made by the text lane; the Anthropic lane is off for this session",
  });
});

test("retryable failures retry on text; the notice names both lanes and the reason", () => {
  const retryable: readonly ReasonCode[] = [
    "no-legal-cut",
    "incompatible",
    "unsupported",
    "oversized",
    "malformed",
    "timeout",
    "429",
    "529",
    "quota",
    "cooling",
  ];
  for (const reason of retryable) {
    const outcome = manualFallbackPolicy(input(status("failed", reason)));
    assert.deepEqual(
      outcome,
      {
        action: "retry-text",
        notice: `checkpoint made by the text lane after the Anthropic lane failed (${reason})`,
      },
      reason,
    );
  }
  assert.deepEqual(
    manualFallbackPolicy(input(status("failed", "incompatible", { detail: "no-capture" }))),
    {
      action: "retry-text",
      notice:
        "checkpoint made by the text lane after the Anthropic lane failed (incompatible: no-capture)",
    },
  );
});

test("the opaque guard and a disabled text lane block the retry and name the blocker", () => {
  const blocked = manualFallbackPolicy(
    input(status("failed", "incompatible"), {
      opaqueBlocked: true,
      opaqueNotice: "GUARD-NOTICE",
    }),
  );
  assert.deepEqual(blocked, { action: "stop", level: "warning", notice: "GUARD-NOTICE" });
  const blockedDefault = manualFallbackPolicy(
    input(status("failed", "timeout"), { opaqueBlocked: true }),
  );
  assert.equal(blockedDefault.action, "stop");
  assert.match(blockedDefault.notice ?? "", /opaque server-side record/u);
  const noText = manualFallbackPolicy(input(status("failed", "timeout"), { textEnabled: false }));
  assert.equal(noText.action, "stop");
  assert.equal(noText.level, "warning");
  assert.match(noText.notice ?? "", /text lane is off/u);
  // A disabled Anthropic lane is blocked the same way.
  const disabledNoText = manualFallbackPolicy(
    input(status("canceled", "disabled"), { textEnabled: false }),
  );
  assert.equal(disabledNoText.action, "stop");
  assert.match(disabledNoText.notice ?? "", /text lane is off/u);
});

test("a failure on the text lane itself is not retried on text", () => {
  const outcome = manualFallbackPolicy(
    input(status("failed", "timeout", { backendId: "text" }), { failedOnText: true }),
  );
  assert.deepEqual(outcome, {
    action: "stop",
    level: "warning",
    notice: "manual compaction did not produce a checkpoint (timeout); run /compact again",
  });
});

test("nothing to summarize stops with an informational notice", () => {
  const outcome = manualFallbackPolicy(
    input(status("failed", "no-legal-cut", { detail: "nothing-to-summarize" })),
  );
  assert.deepEqual(outcome, { action: "stop", level: "info", notice: NOTHING_TO_SUMMARIZE_NOTICE });
});

test("a thrown wait failure and an unclassified reason stop with a warning", () => {
  const thrown = manualFallbackPolicy(
    input(status("preparing"), { failure: new Error("synthetic wait failure") }),
  );
  assert.deepEqual(thrown, {
    action: "stop",
    level: "warning",
    notice: "manual compaction failed: synthetic wait failure; run /compact again",
  });
  const unclassified = manualFallbackPolicy(
    input(status("failed", "draft-not-committed", { detail: "cap" })),
  );
  assert.deepEqual(unclassified, {
    action: "stop",
    level: "warning",
    notice:
      "manual compaction did not produce a checkpoint (draft-not-committed: cap); run /compact again",
  });
});
