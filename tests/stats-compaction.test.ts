import assert from "node:assert/strict";
import test from "node:test";
import {
  compactionMethod,
  isAutoTrigger,
  isNativeFallback,
  isNoOpFallback,
  triggerOfField,
  triggerOfRoute,
  type LaneEvent,
} from "../.pi/extensions/lib/stats/compaction.ts";
import {
  compactionSummary,
  contextStats,
  filterEvents,
} from "../.pi/extensions/lib/stats/aggregate.ts";
import type { CompactionEvent } from "../.pi/extensions/lib/stats/compaction.ts";
import type { CallRecord } from "../.pi/extensions/lib/stats/records.ts";

test("the method comes from the checkpoint strategy, else from who wrote it", () => {
  assert.equal(compactionMethod("local-reconciled", true), "built-in");
  assert.equal(compactionMethod("anthropic-compaction-on-demand-v1", true), "server-side");
  assert.equal(compactionMethod("xai-responses-compaction-v1", true), "server-side");
  assert.equal(compactionMethod("openai-responses-compaction-v2", true), "server-side");
  assert.equal(compactionMethod("openai-native-compact-v1", true), "server-side");
  assert.equal(
    compactionMethod("someone-elses-v9", true),
    "unknown",
    "a strategy this reader does not know is not guessed",
  );
  assert.equal(
    compactionMethod(undefined, false),
    "host",
    "no strategy and not from a hook: pi compacted",
  );
  assert.equal(compactionMethod(undefined, true), "unknown", "an extension that wrote no strategy");
});

test("lane routes map to triggers for legacy entries; ambiguous routes stay undefined", () => {
  assert.equal(triggerOfRoute("manual"), "manual");
  assert.equal(triggerOfRoute("threshold"), "threshold");
  assert.equal(triggerOfRoute("context-cap"), "context-cap");
  assert.equal(triggerOfRoute("idle"), "idle");
  for (const route of [
    "foreground",
    "boundary",
    "resume",
    "replay",
    "mode-change",
    "model-select",
    "config-change",
    undefined,
  ])
    assert.equal(triggerOfRoute(route), undefined, String(route));
  assert.equal(triggerOfField("overflow"), "overflow");
  assert.equal(triggerOfField("auto"), undefined, "only the recorded vocabulary is accepted");
  assert.equal(triggerOfField(undefined), undefined);
  assert.equal(isAutoTrigger("overflow"), true);
  assert.equal(isAutoTrigger("manual"), false);
  assert.equal(isAutoTrigger("unknown"), false);
});

function lane(overrides: Partial<LaneEvent>): LaneEvent {
  return {
    key: overrides.key ?? "lane|x",
    sessionId: "s",
    cwd: "/w",
    at: 10,
    provider: "anthropic",
    event: "fallback",
    from: "anthropic-native",
    reason: "oversized",
    detail: undefined,
    route: "manual",
    trigger: undefined,
    candidateId: undefined,
    ...overrides,
  };
}

function compaction(overrides: Partial<CompactionEvent>): CompactionEvent {
  return {
    key: overrides.key ?? "compaction|x",
    sessionId: "s",
    cwd: "/w",
    at: 10,
    provider: "anthropic",
    method: "built-in",
    strategy: "local-reconciled",
    trigger: "unknown",
    triggerRecorded: false,
    tokensBefore: 500_000,
    candidateId: undefined,
    ...overrides,
  };
}

test("fallbacks count only native lanes giving way; nothing-to-summarize is a no-op", () => {
  assert.equal(isNativeFallback(lane({})), true);
  assert.equal(
    isNativeFallback(lane({ from: "text" })),
    false,
    "the text lane yielding is not a method change",
  );
  assert.equal(isNativeFallback(lane({ event: "cancel" })), false);
  assert.equal(isNoOpFallback(lane({ detail: "nothing-to-summarize" })), true);
  const summary = compactionSummary(
    [
      compaction({ key: "c1", trigger: "manual" }),
      compaction({
        key: "c2",
        provider: "xai",
        method: "server-side",
        strategy: "xai-responses-compaction-v1",
        trigger: "threshold",
      }),
      compaction({ key: "c3", provider: "xai", method: "host", strategy: undefined }),
      compaction({ key: "c4", trigger: "overflow", triggerRecorded: true }),
      compaction({ key: "c5", trigger: "idle", triggerRecorded: true }),
    ],
    [
      lane({ key: "l1" }),
      lane({ key: "l2", detail: "nothing-to-summarize", reason: "no-legal-cut" }),
      lane({ key: "l3", from: "text", route: "resume", reason: "no-legal-cut" }),
      lane({ key: "l4", provider: "xai", from: "xai-native", reason: "auth" }),
    ],
  );
  assert.equal(summary.total, 5);
  assert.deepEqual([summary.manual, summary.auto, summary.unknownTrigger], [1, 3, 1]);
  assert.deepEqual(summary.autoBy, { threshold: 1, overflow: 1, idle: 1, contextCap: 0 });
  assert.deepEqual([summary.fallbacks, summary.noOps], [2, 1]);
  assert.deepEqual(summary.byProvider, [
    {
      provider: "anthropic",
      builtIn: 3,
      serverSide: 0,
      host: 0,
      unknown: 0,
      fallbacks: 1,
      noOps: 1,
    },
    { provider: "xai", builtIn: 0, serverSide: 1, host: 1, unknown: 0, fallbacks: 1, noOps: 0 },
  ]);
});

test("events honour period, scope, and fork dedup like calls do", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const old = compaction({ key: "old", at: now - 40 * 86_400_000 });
  const kept = compaction({ key: "kept", at: now - 1000 });
  const copy = compaction({ key: "kept", at: now - 1000, sessionId: "fork" });
  const elsewhere = compaction({ key: "else", at: now - 1000, cwd: "/other" });
  const month = filterEvents([old, kept, copy, elsewhere], {
    period: "30d",
    scope: "all",
    projectDirs: ["/w"],
    now,
  });
  assert.deepEqual(
    month.map((event) => event.key),
    ["kept", "else"],
  );
  const project = filterEvents([old, kept, copy, elsewhere], {
    period: "all",
    scope: "project",
    projectDirs: ["/w"],
    now,
  });
  assert.deepEqual(
    project.map((event) => event.key),
    ["old", "kept"],
  );
});

test("context shares and percentiles use input plus cache on successful assistant calls", () => {
  const call = (
    key: string,
    input: number,
    cacheRead: number,
    extra: Partial<CallRecord> = {},
  ): CallRecord => ({
    key,
    sessionId: "s",
    file: "/s",
    cwd: "/w",
    at: 1,
    kind: "assistant",
    provider: "anthropic",
    model: "claude-opus-5-5",
    tokens: { input, output: 10, cacheRead, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    durationMs: 1,
    ttftMs: undefined,
    stopReason: "stop",
    responseModel: undefined,
    fastRequested: undefined,
    feature: "conversation",
    nestedCalls: [],
    isSubagent: false,
    failed: false,
    ...extra,
  });
  const stats = contextStats([
    call("a", 1000, 50_000),
    call("b", 2000, 98_000),
    call("c", 500, 250_000),
    call("d", 0, 450_000),
    call("e", 0, 900_000, { failed: true }),
    call("f", 0, 900_000, { kind: "compaction" }),
  ]);
  assert.equal(stats.calls, 4);
  assert.deepEqual([stats.over100k, stats.over200k, stats.over400k], [3, 2, 1]);
  assert.equal(stats.medianContext, 100_000);
  assert.equal(stats.p90Context, 450_000);
});
