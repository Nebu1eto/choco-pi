import assert from "node:assert/strict";
import test from "node:test";
import {
  getSessionContextUsage,
  getSessionCost,
  getSessionCostBaseline,
  type SessionLike,
  type SessionStatsLike,
} from "../src/usage.ts";

function session(stats: () => SessionStatsLike): SessionLike {
  return { getSessionStats: stats };
}

function stats(
  sessionId: string,
  cost: number,
  percent: number | null = 25,
  contextWindow = 200_000,
): SessionStatsLike {
  return {
    sessionId,
    cost,
    tokens: { input: 1, output: 2, cacheWrite: 3 },
    contextUsage: { percent, contextWindow },
  };
}

test("session cost reads live and subtracts only a matching /btw baseline", () => {
  let current = stats("btw-session", 4);
  const child = session(() => current);
  const baseline = getSessionCostBaseline(child);
  assert.deepEqual(baseline, { sessionId: "btw-session", cost: 4 });

  current = stats("btw-session", 5.25);
  assert.equal(getSessionCost(child, baseline ?? undefined), 1.25);
  current = stats("btw-session", 3);
  assert.equal(getSessionCost(child, baseline ?? undefined), 0, "negative deltas clamp to zero");

  current = stats("replacement-session", 0.75);
  assert.equal(
    getSessionCost(child, baseline ?? undefined),
    0.75,
    "a replacement session never inherits the cloned-session baseline",
  );
  assert.equal(getSessionCost(child), 0.75, "ordinary child cost is session-only");
});

test("context preserves a valid window when post-compaction percent is null", () => {
  const child = session(() => stats("child", 1, null, 372_000));
  assert.deepEqual(getSessionContextUsage(child), {
    percent: null,
    contextWindow: 372_000,
  });
});

test("malformed or unavailable session stats return null without throwing", () => {
  const failed = session(() => {
    throw new Error("stats unavailable");
  });
  assert.equal(getSessionCost(failed), null);
  assert.equal(getSessionCostBaseline(failed), null);
  assert.deepEqual(getSessionContextUsage(failed), { percent: null, contextWindow: null });

  const malformed = session(
    () =>
      // SAFETY: This fixture deliberately violates the declared stats value invariants.
      ({
        sessionId: "",
        cost: Number.NaN,
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        contextUsage: { percent: Number.POSITIVE_INFINITY, contextWindow: -1 },
      }) as SessionStatsLike,
  );
  assert.equal(getSessionCost(malformed), null);
  assert.equal(getSessionCostBaseline(malformed), null);
  assert.deepEqual(getSessionContextUsage(malformed), { percent: null, contextWindow: null });
});
