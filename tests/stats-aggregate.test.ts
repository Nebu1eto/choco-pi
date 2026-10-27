import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateStats,
  dayKey,
  dedupeRecords,
  filterRecords,
  nextPeriod,
  periodLabel,
  periodStart,
  scopeLabel,
  toggleScope,
  type PriceLookup,
} from "../.pi/extensions/lib/stats/aggregate.ts";
import type { CallRecord } from "../.pi/extensions/lib/stats/records.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

function record(overrides: Partial<CallRecord> & { key: string }): CallRecord {
  return {
    sessionId: "s1",
    file: "/sessions/s1.jsonl",
    cwd: "/work/app",
    at: NOW - DAY,
    kind: "assistant",
    provider: "anthropic",
    model: "claude-opus-5-5",
    tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 },
    cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.05, total: 0.4 },
    durationMs: 2000,
    ttftMs: undefined,
    stopReason: "stop",
    responseModel: undefined,
    fastRequested: undefined,
    feature: "conversation",
    nestedCalls: [],
    isSubagent: false,
    failed: false,
    ...overrides,
  };
}

test("period and scope helpers cycle and label as the hint promises", () => {
  assert.equal(nextPeriod("30d"), "7d");
  assert.equal(nextPeriod("7d"), "all");
  assert.equal(nextPeriod("all"), "30d");
  assert.equal(periodLabel("30d"), "Last 30 days");
  assert.equal(periodLabel("7d"), "Last 7 days");
  assert.equal(periodLabel("all"), "All time");
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - 6);
  assert.equal(periodStart("7d", NOW), midnight.getTime(), "local midnight six days back");
  assert.equal(periodStart("all", NOW), undefined);
  assert.equal(toggleScope("all"), "project");
  assert.equal(toggleScope("project"), "all");
  assert.equal(scopeLabel("project"), "this project");
});

test("dedupe keeps the first occurrence of a key and counts the rest", () => {
  const records = [
    record({ key: "a|1|1" }),
    record({ key: "b|2|2" }),
    record({ key: "a|1|1", sessionId: "fork" }),
  ];
  const result = dedupeRecords(records);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(
    result.records.map((item) => `${item.key}:${item.sessionId}`),
    ["a|1|1:s1", "b|2|2:s1"],
  );
});

test("filter honours the period boundary inclusively and the project scope by header cwd", () => {
  const records = [
    record({ key: "old", at: (periodStart("30d", NOW) ?? 0) - 1 }),
    record({ key: "edge", at: periodStart("30d", NOW) ?? 0 }),
    record({ key: "recent", at: NOW - DAY }),
    record({ key: "elsewhere", at: NOW - DAY, cwd: "/work/other" }),
  ];
  const month = filterRecords(records, {
    period: "30d",
    scope: "all",
    projectDirs: ["/work/app"],
    now: NOW,
  });
  assert.deepEqual(
    month.map((item) => item.key),
    ["edge", "recent", "elsewhere"],
  );
  const week = filterRecords(records, {
    period: "7d",
    scope: "project",
    projectDirs: ["/work/app/"],
    now: NOW,
  });
  assert.deepEqual(
    week.map((item) => item.key),
    ["recent"],
  );
  assert.equal(
    filterRecords(records, { period: "all", scope: "all", projectDirs: [], now: NOW }).length,
    4,
  );
  const repo = filterRecords(records, {
    period: "all",
    scope: "project",
    projectDirs: ["/work/app", "/work/other"],
    now: NOW,
  });
  assert.equal(repo.length, 4, "a worktree of the same repository counts as this project");
});

test("aggregate reconciles model and feature breakdowns with the totals and separates failed calls", () => {
  const records = [
    record({ key: "a" }),
    record({ key: "b", feature: "code mode", model: "claude-fable-5-1", sessionId: "s2" }),
    record({ key: "c", feature: "built-in tools", isSubagent: true }),
    record({
      key: "fail",
      failed: true,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
    }),
  ];
  const report = aggregateStats(records);
  assert.equal(report.calls, 3);
  assert.equal(report.failedCalls, 1);
  assert.equal(report.sessions, 2);
  assert.deepEqual(report.tokens, { input: 300, output: 150, cacheRead: 3000, cacheWrite: 600 });
  assert.ok(Math.abs(report.recordedCost - 1.2) < 1e-9);
  const modelTokens = report.byModel.reduce(
    (sum, row) =>
      sum + row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite,
    0,
  );
  const featureTokens = report.byFeature.reduce(
    (sum, row) =>
      sum + row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite,
    0,
  );
  assert.equal(modelTokens, 4050);
  assert.equal(featureTokens, 4050);
  assert.deepEqual(
    report.byModel.map((row) => [row.key, row.calls]),
    [
      ["anthropic/claude-opus-5-5", 2],
      ["anthropic/claude-fable-5-1", 1],
    ],
  );
  assert.ok(
    report.byFeature.every(
      (row, index) => index === 0 || (report.byFeature[index - 1]?.share ?? 0) >= row.share,
    ),
    "feature rows are ordered by the share their bars draw",
  );
  assert.deepEqual(
    report.byFeature.map((row) => row.key).sort(),
    ["code mode", "conversation", "subagents"],
    "a subagent child's calls land in the subagents bucket whatever triggered them",
  );
  assert.ok(Math.abs(report.byModel.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.equal(report.byDay.length, 1);
  assert.equal(report.byDay[0]?.day, dayKey(NOW - DAY));
  assert.equal(report.byDay[0]?.calls, 3);
});

test("zero-cost calls are repriced at current list prices when known and reported as unpriced otherwise", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const prices: PriceLookup = (provider, model) =>
    provider === "openai-codex" && model === "daybreak"
      ? { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 }
      : undefined;
  const records = [
    record({ key: "paid" }),
    record({
      key: "est",
      provider: "openai-codex",
      model: "daybreak",
      cost: zero,
      tokens: { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 },
    }),
    record({
      key: "none",
      provider: "apex",
      model: "free",
      cost: zero,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    }),
  ];
  const report = aggregateStats(records, { priceLookup: prices });
  assert.ok(Math.abs(report.recordedCost - 0.4) < 1e-9);
  assert.ok(
    Math.abs(report.estimatedCost - 4) < 1e-9,
    "2 + 1 + 1 dollars at the listed per-million rates",
  );
  assert.equal(report.estimatedCalls, 1);
  assert.equal(report.unpricedCalls, 1);
  assert.equal(report.unpricedTokens, 15);
  const estimated = report.byModel.find((row) => row.key === "openai-codex/daybreak");
  assert.ok(
    estimated && Math.abs(estimated.cost - 4) < 1e-9,
    "the estimate flows into the model's bucket",
  );
});

test("speed rows weight tok/s by tokens, use TTFT only where recorded, and skip aborted or untimed calls", () => {
  const records = [
    record({
      key: "a",
      tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 },
      durationMs: 1000,
      ttftMs: 200,
    }),
    record({
      key: "b",
      tokens: { input: 1, output: 300, cacheRead: 0, cacheWrite: 0 },
      durationMs: 3000,
      ttftMs: 600,
    }),
    record({
      key: "c",
      tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 },
      durationMs: 2000,
    }),
    record({
      key: "d",
      tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: 500,
      stopReason: "aborted",
    }),
    record({
      key: "e",
      tokens: { input: 1, output: 50, cacheRead: 0, cacheWrite: 0 },
      durationMs: undefined,
    }),
    record({
      key: "x",
      provider: "xai",
      model: "grok-4.7",
      tokens: { input: 1, output: 400, cacheRead: 0, cacheWrite: 0 },
      durationMs: 2000,
      ttftMs: 100,
    }),
    record({
      key: "k",
      kind: "compaction",
      feature: "compaction & summaries",
      tokens: { input: 1, output: 999, cacheRead: 0, cacheWrite: 0 },
      durationMs: 1,
    }),
  ];
  const report = aggregateStats(records);
  const anthropic = report.speed.byProvider.find((row) => row.key === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.calls, 3, "aborted and untimed calls do not count");
  assert.equal(anthropic.outputTokens, 500);
  assert.equal(anthropic.timedCalls, 2);
  assert.ok(Math.abs((anthropic.generationTokPerSec ?? 0) - 400 / 3.2) < 1e-9);
  assert.equal(anthropic.ttftMedianMs, 200);
  assert.equal(anthropic.ttftP90Ms, 600);
  const xai = report.speed.byProvider.find((row) => row.key === "xai");
  assert.ok(
    Math.abs((xai?.generationTokPerSec ?? 0) - 400 / 1.9) < 1e-9,
    "tok/s is output over the time after the first token",
  );
  assert.equal(xai?.ttftMedianMs, 100);
  assert.deepEqual(
    report.speed.byModel.map((row) => row.key),
    ["anthropic/claude-opus-5-5", "xai/grok-4.7|unknown"],
    "summaries carry no stream timing and stay out of the speed tables",
  );
});

test("speed rows split a model by Fast state, carry estimates, and keep Fast rows first", () => {
  const prices = (provider: string, model: string) =>
    provider === "openai-codex" && model === "gpt-6-astra"
      ? { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
      : undefined;
  const codex = (key: string, index: number, rate: number): CallRecord =>
    record({
      key,
      provider: "openai-codex",
      model: "gpt-6-astra",
      tokens: { input: 10, output: 100 + index * 50, cacheRead: 0, cacheWrite: 0 },
      cost: {
        input: 0,
        output: ((100 + index * 50) * rate) / 1e6,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1,
      },
      durationMs: 1000 + (100 + index * 50) * 10,
    });
  const report = aggregateStats(
    [
      ...Array.from({ length: 8 }, (_, i) => codex(`s${i}`, i, 50)),
      ...Array.from({ length: 6 }, (_, i) => codex(`f${i}`, i, 100)),
      record({ key: "anthropic", tokens: { input: 1, output: 5000, cacheRead: 0, cacheWrite: 0 } }),
    ],
    { priceLookup: prices },
  );
  assert.deepEqual(
    report.speed.byModel.map((row) => [row.key, row.model, row.fast, row.calls]),
    [
      ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5", undefined, 1],
      ["openai-codex/gpt-6-astra|on", "openai-codex/gpt-6-astra", "on", 6],
      ["openai-codex/gpt-6-astra|off", "openai-codex/gpt-6-astra", "off", 8],
    ],
    "models order by total output; within a model Fast precedes standard",
  );
  const fast = report.speed.byModel[1];
  assert.ok(fast?.estimate);
  assert.equal(fast.estimate.samples, 6);
  assert.equal(fast.estimate.lowConfidence, true);
  assert.ok(Math.abs(fast.estimate.tokPerSec - 100) < 0.01);
  assert.ok(Math.abs(fast.estimate.ttftMs - 1000) < 0.01);
  assert.equal(report.speed.byModel[0]?.estimate, undefined, "one call cannot be fitted");
  assert.equal(
    report.speed.byProvider.find((row) => row.key === "openai-codex")?.estimate?.samples,
    14,
  );
  assert.equal(report.speed.byProvider[0]?.fast, undefined);
});

test("period starts are local calendar days: Asia/Seoul boundaries", async () => {
  // The zone is process-wide, so the check runs in a child with TZ set.
  const script = [
    "import { dayKey, filterRecords, periodStart } from './.pi/extensions/lib/stats/aggregate.ts';",
    "const now = Date.parse('2026-10-28T03:00:00+09:00');",
    "const base = { sessionId: 's', file: '/s', cwd: '/w', kind: 'assistant', provider: 'p', model: 'm', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, durationMs: 1, ttftMs: undefined, stopReason: 'stop', responseModel: undefined, fastRequested: undefined, feature: 'conversation', isSubagent: false, failed: false };",
    "const late = { ...base, key: 'late', at: Date.parse('2026-10-27T16:30:00Z') };",
    "const out = { ...base, key: 'out', at: Date.parse('2026-10-20T14:59:00Z') };",
    "const kept = filterRecords([late, out], { period: '7d', scope: 'all', projectDirs: [], now }).map((r) => r.key);",
    "console.log([dayKey(late.at), dayKey(out.at), new Date(periodStart('7d', now)).toISOString(), kept.join('+')].join(' '));",
  ].join("\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "Asia/Seoul" },
  });
  const [lateDay, outDay, start, kept] = stdout.trim().split(" ");
  const result = { lateDay, outDay, start, kept: (kept ?? "").split("+") };
  assert.equal(result.lateDay, "2026-10-28", "16:30Z is Oct 28 in Seoul");
  assert.equal(result.outDay, "2026-10-20", "14:59Z is Oct 20 23:59 in Seoul");
  assert.equal(result.start, "2026-10-21T15:00:00.000Z", "last 7 days starts at Oct 22 00:00 KST");
  assert.deepEqual(result.kept, ["late"], "Oct 20 23:59 KST is outside the last 7 days");
});

test("zero-cost calls reprice at the tier list rate, times the Fast multiple when the call is fast", () => {
  const grok = {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
  };
  const lookup = (provider: string, model: string) =>
    provider === "xai" && model === "grok-4.7" ? grok : undefined;
  const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const tokens = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
  const standard = record({
    key: "s",
    provider: "xai",
    model: "grok-4.7",
    cost: free,
    tokens,
    fastRequested: false,
  });
  const fastById = record({
    key: "f",
    provider: "xai",
    model: "grok-4.7-build-fast",
    cost: free,
    tokens,
    fastRequested: true,
  });
  const maybe = record({
    key: "m",
    provider: "xai",
    model: "grok-4.7",
    cost: free,
    tokens,
    fastRequested: true,
  });
  const tiered = record({
    key: "t",
    provider: "xai",
    model: "grok-4.7",
    cost: free,
    tokens: { input: 250_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    fastRequested: false,
  });
  const report = aggregateStats([standard, fastById, maybe, tiered], { priceLookup: lookup });
  const list = (1000 * 2 + 1000 * 6) / 1e6;
  const tierList = (250_000 * 4 + 1000 * 12) / 1e6;
  assert.equal(report.estimatedCalls, 4);
  assert.ok(
    Math.abs(report.estimatedCost - (list + list * 2 + list + tierList)) < 1e-9,
    "standard at list, Fast id at 2x, fast? at list, long context at the tier",
  );
  const byModel = new Map(report.byModel.map((row) => [row.key, row.cost]));
  assert.ok(
    Math.abs((byModel.get("xai/grok-4.7-build-fast") ?? 0) - list * 2) < 1e-9,
    "the Fast variant row carries the Fast price",
  );
  const fastRow = report.speed.byModel.find((row) => row.fast === "on");
  assert.equal(
    fastRow?.model,
    "xai/grok-4.7",
    "the Fast variant is classified fast under its base model",
  );
  const unknownRow = report.speed.byModel.find((row) => row.fast === "unknown");
  assert.equal(unknownRow?.calls, 1, "requested without price evidence stays fast?");
});
