import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyUsageLimit,
  corroborateUsageLimit,
  createUsageLimitPolicy,
  DEFAULT_MODEL_FALLBACKS_PATH,
  loadModelFallbacks,
  MAX_CLOSE_MS,
  pickFallback,
  type ModelFallbacks,
  type SyntheticQuotaEvents,
} from "../.pi/extensions/lib/usage-limit.ts";
import type { UsageLimitClassification } from "../.pi/extensions/lib/usage-limit-contract.ts";
import type { ProviderUsageSnapshot, UsageWindow } from "../.pi/extensions/provider-usage.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

// Anthropic SDK `APIError.makeMessage`: `${status} ${JSON.stringify(body)}` or `${status} status code (no body)`.
const ANTHROPIC_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_1"}';
const ANTHROPIC_503 = "503 status code (no body)";
// pi-ai provider-retry.js:25 wrapper.
const wrap = (seconds: number, inner: string): string =>
  `Server requested ${seconds}s retry delay (max: 60s). ${inner}`;

function classify(provider: string, errorMessage: string): UsageLimitClassification | undefined {
  return classifyUsageLimit({ provider, modelId: "m", errorMessage, now: NOW });
}

test("codex usage-limit messages classify as quota with parsed lower-bound resets", () => {
  // choco-pi-codex errors.ts formatCodexUsageLimitError / parseErrorResponse.
  assert.deepEqual(
    classify("openai-codex", "Codex usage limit reached (plus plan). Resets in ~12m."),
    {
      provider: "openai-codex",
      modelId: "m",
      kind: "quota",
      confidence: "parsed",
      resetAt: NOW + 12 * MIN,
    },
  );
  assert.equal(
    classify("openai-codex", "Codex usage limit reached (pro plan). Resets in ~1.5h.")?.resetAt,
    NOW + 1.5 * HOUR,
  );
  assert.equal(
    classify(
      "openai-codex",
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.",
    )?.resetAt,
    NOW + 5 * MIN,
  );
  const noReset = classify("openai-codex", "Codex usage limit reached (plus plan).");
  assert.equal(noReset?.kind, "quota");
  assert.equal(noReset?.confidence, "inferred");
  assert.equal(noReset?.resetAt, undefined);
  assert.equal(classify("openai-codex", "usage_limit_reached")?.kind, "quota");
  assert.equal(classify("openai-codex", "Connection error: WebSocket closed"), undefined);
});

test("anthropic 429 is an inferred quota; the retry-delay wrapper depends on its inner status", () => {
  const plain = classify("anthropic", ANTHROPIC_429);
  assert.equal(plain?.kind, "quota");
  assert.equal(plain?.confidence, "inferred");
  assert.equal(plain?.resetAt, undefined);
  assert.equal(classify("anthropic", "429 status code (no body)")?.kind, "quota");

  const wrapped429 = classify("anthropic", wrap(3600, ANTHROPIC_429));
  assert.equal(wrapped429?.kind, "quota");
  assert.equal(wrapped429?.resetAt, NOW + 3600 * 1000);

  const wrapped503 = classify("anthropic", wrap(120, ANTHROPIC_503));
  assert.equal(wrapped503?.kind, "transient");
  assert.equal(wrapped503?.resetAt, undefined);
  assert.equal(classify("anthropic", wrap(90, "408 status code (no body)"))?.kind, "transient");
  assert.equal(classify("anthropic", ANTHROPIC_503), undefined);
});

test("synthetic 429 is an inferred quota; other text is not a limit", () => {
  // No captured Synthetic limit body exists; only the status prefix is asserted.
  assert.equal(classify("synthetic", "429 status code (no body)")?.kind, "quota");
  assert.equal(classify("synthetic", "429 status code (no body)")?.confidence, "inferred");
  assert.equal(classify("synthetic", "500 status code (no body)"), undefined);
  assert.equal(classify("some-other", ANTHROPIC_429), undefined);
});

test("host billing patterns classify as billing on every provider", () => {
  for (const provider of ["anthropic", "openai-codex", "synthetic", "opencode"]) {
    for (const message of [
      "insufficient_quota",
      "Quota exceeded for this project",
      "Please check your billing details",
      "Monthly usage limit reached",
      "GoUsageLimitError",
      "FreeUsageLimitError",
      "out of budget",
      "add to your available balance",
    ]) {
      assert.equal(classify(provider, message)?.kind, "billing", `${provider}: ${message}`);
    }
  }
});

function quota(
  provider: string,
  extra: Partial<UsageLimitClassification> = {},
): UsageLimitClassification {
  return { kind: "quota", provider, modelId: "m", confidence: "inferred", ...extra };
}

function windowAt(percent: number, resetAt?: number): UsageWindow {
  return {
    label: "5h",
    percent,
    qualifier: "used",
    eventAt: resetAt === undefined ? undefined : new Date(resetAt),
  };
}

function snapshots(snapshot: ProviderUsageSnapshot | undefined) {
  return async (): Promise<ProviderUsageSnapshot | undefined> => snapshot;
}

test("anthropic corroboration: exhausted windows give the earliest reset; fresh capacity is ready", async () => {
  const base = { now: () => NOW, failedAt: NOW - 1000 };
  const exhausted = await corroborateUsageLimit(
    {
      ...base,
      usageSnapshot: snapshots({
        observedAt: NOW,
        windows: [
          windowAt(100, NOW + 3 * HOUR),
          windowAt(100, NOW + HOUR),
          windowAt(40, NOW + MIN),
        ],
      }),
    },
    quota("anthropic"),
  );
  assert.equal(exhausted.ready, false);
  assert.equal(exhausted.classification.resetAt, NOW + HOUR);
  assert.equal(exhausted.evidence, "confirmed");

  const ready = await corroborateUsageLimit(
    { ...base, usageSnapshot: snapshots({ observedAt: NOW, windows: [windowAt(99, NOW + HOUR)] }) },
    quota("anthropic"),
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.evidence, "capacity");
});

test("a reading older than the failure proves exhaustion but never readiness", async () => {
  const stale = { observedAt: NOW - 5 * MIN, windows: [windowAt(20, NOW + HOUR)] };
  const result = await corroborateUsageLimit(
    { now: () => NOW, failedAt: NOW - MIN, usageSnapshot: snapshots(stale) },
    quota("anthropic"),
  );
  assert.deepEqual(result, {
    ready: false,
    classification: quota("anthropic"),
    evidence: "unavailable",
  });

  const staleExhausted = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW - MIN,
      usageSnapshot: snapshots({ observedAt: NOW - 5 * MIN, windows: [windowAt(100, NOW + HOUR)] }),
    },
    quota("anthropic"),
  );
  assert.equal(staleExhausted.ready, false);
  assert.equal(staleExhausted.classification.resetAt, NOW + HOUR);
  assert.equal(staleExhausted.evidence, "confirmed");
});

test("codex corroboration uses a nearby structured entry and ignores a distant one", async () => {
  const usageSnapshot = snapshots({ observedAt: NOW, windows: [windowAt(50, NOW + HOUR)] });
  const near = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      usageSnapshot,
      codexEntry: { observedAt: NOW - 30_000, resetAt: NOW + 2 * HOUR, accountId: "acct" },
    },
    quota("openai-codex", { confidence: "parsed", resetAt: NOW + HOUR }),
  );
  assert.equal(near.ready, false);
  assert.equal(near.classification.confidence, "structured");
  assert.equal(near.classification.resetAt, NOW + 2 * HOUR);
  assert.equal(near.classification.accountId, "acct");
  assert.equal(near.evidence, "confirmed", "a structured entry with a pending reset confirms");

  const far = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      usageSnapshot,
      codexEntry: { observedAt: NOW - 61_000, resetAt: NOW + 2 * HOUR },
    },
    quota("openai-codex", { confidence: "parsed", resetAt: NOW + HOUR }),
  );
  assert.equal(far.classification.confidence, "parsed");
  assert.equal(far.ready, true);
  assert.equal(far.evidence, "capacity");

  const exhausted = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      usageSnapshot: snapshots({ observedAt: NOW, windows: [windowAt(100, NOW + 4 * HOUR)] }),
    },
    quota("openai-codex"),
  );
  assert.equal(exhausted.ready, false);
  assert.equal(exhausted.classification.resetAt, NOW + 4 * HOUR);
  assert.equal(exhausted.evidence, "confirmed");
});

test("codex evidence without a quota reading: structured confirms, parsed is unavailable", async () => {
  const noSnapshot = snapshots(undefined);
  const structured = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      usageSnapshot: noSnapshot,
      codexEntry: { observedAt: NOW, resetAt: NOW + HOUR, accountId: "acct" },
    },
    quota("openai-codex", { confidence: "parsed", resetAt: NOW + 30 * MIN }),
  );
  assert.equal(structured.ready, false);
  assert.equal(structured.evidence, "confirmed");
  assert.equal(structured.classification.accountId, "acct");

  const elapsed = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      usageSnapshot: noSnapshot,
      codexEntry: { observedAt: NOW, resetAt: NOW - 1 },
    },
    quota("openai-codex", { confidence: "parsed" }),
  );
  assert.equal(elapsed.evidence, "unavailable", "an elapsed structured reset proves nothing");

  const parsed = await corroborateUsageLimit(
    { now: () => NOW, failedAt: NOW, usageSnapshot: noSnapshot },
    quota("openai-codex", { confidence: "parsed", resetAt: NOW + 30 * MIN }),
  );
  assert.deepEqual(parsed, {
    ready: false,
    classification: quota("openai-codex", { confidence: "parsed", resetAt: NOW + 30 * MIN }),
    evidence: "unavailable",
  });
});

type QuotaSnapshot = { quotas: RuntimeValue; source: "api" | "header"; updatedAt: number };

function syntheticBus(
  snapshot: QuotaSnapshot | undefined,
  emitted: string[] = [],
): SyntheticQuotaEvents {
  return {
    emit(channel, data) {
      emitted.push(channel);
      const payload = reinterpretHostValue<{ respond?: (value: RuntimeValue) => void }>(data);
      payload.respond?.(snapshot);
    },
  };
}

test("synthetic corroboration requests then reads the quota store", async () => {
  const emitted: string[] = [];
  const nextTickAt = new Date(NOW + 20 * MIN).toISOString();
  const nextRegenAt = new Date(NOW + 2 * HOUR).toISOString();
  const limited = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      events: syntheticBus(
        {
          source: "api",
          updatedAt: NOW,
          quotas: {
            rollingFiveHourLimit: {
              nextTickAt,
              tickPercent: 5,
              remaining: 0,
              max: 100,
              limited: true,
            },
            weeklyTokenLimit: {
              nextRegenAt,
              percentRemaining: 0,
              maxCredits: "$10",
              remainingCredits: "$0",
              nextRegenCredits: "$1",
            },
          },
        },
        emitted,
      ),
    },
    quota("synthetic"),
  );
  assert.deepEqual(emitted, ["synthetic:quotas:request", "synthetic:quotas:read"]);
  assert.equal(limited.ready, false);
  assert.equal(limited.classification.resetAt, NOW + 20 * MIN);
  assert.equal(limited.evidence, "confirmed");

  const renewsAt = new Date(NOW + 3 * HOUR).toISOString();
  const subscription = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      events: syntheticBus({
        source: "api",
        updatedAt: NOW,
        quotas: { subscription: { limit: 100, requests: 100, renewsAt } },
      }),
    },
    quota("synthetic"),
  );
  assert.equal(subscription.ready, false);
  assert.equal(subscription.evidence, "confirmed");
  assert.equal(subscription.classification.resetAt, NOW + 3 * HOUR);

  const open = await corroborateUsageLimit(
    {
      now: () => NOW,
      failedAt: NOW,
      events: syntheticBus({
        source: "header",
        updatedAt: NOW,
        quotas: {
          rollingFiveHourLimit: {
            nextTickAt,
            tickPercent: 5,
            remaining: 12,
            max: 100,
            limited: false,
          },
        },
      }),
    },
    quota("synthetic"),
  );
  assert.equal(open.ready, true);
  assert.equal(open.evidence, "capacity");
});

test("corroboration never throws and leaves the input unchanged when data is missing", async () => {
  const input = quota("synthetic");
  const unchanged = { ready: false, classification: input, evidence: "unavailable" };
  assert.deepEqual(await corroborateUsageLimit({ now: () => NOW }, input), unchanged);
  assert.deepEqual(
    await corroborateUsageLimit(
      { now: () => NOW, events: syntheticBus(undefined), syntheticTimeoutMs: 5 },
      input,
    ),
    unchanged,
  );
  const silent: SyntheticQuotaEvents = { emit() {} };
  assert.equal(
    (await corroborateUsageLimit({ now: () => NOW, events: silent, syntheticTimeoutMs: 5 }, input))
      .ready,
    false,
  );
  const throwing: SyntheticQuotaEvents = {
    emit() {
      throw new Error("bus gone");
    },
  };
  assert.equal(
    (
      await corroborateUsageLimit(
        { now: () => NOW, events: throwing, syntheticTimeoutMs: 5 },
        input,
      )
    ).ready,
    false,
  );
  const failingReader = async (): Promise<ProviderUsageSnapshot | undefined> => {
    throw new Error("network");
  };
  for (const provider of ["anthropic", "openai-codex"]) {
    const result = await corroborateUsageLimit(
      { now: () => NOW, usageSnapshot: failingReader },
      quota(provider),
    );
    assert.deepEqual(result, {
      ready: false,
      classification: quota(provider),
      evidence: "unavailable",
    });
  }
  assert.deepEqual(await corroborateUsageLimit({}, quota("anthropic")), {
    ready: false,
    classification: quota("anthropic"),
    evidence: "unavailable",
  });
});

test("billing is never ready and transient is always ready", async () => {
  const billing = quota("anthropic", { kind: "billing" });
  const transient = quota("anthropic", { kind: "transient" });
  assert.equal((await corroborateUsageLimit({}, billing)).ready, false);
  assert.equal((await corroborateUsageLimit({}, transient)).ready, true);
});

const TABLE: ModelFallbacks = {
  tiers: {
    flagship: {
      primary: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
      secondary: [],
    },
    workhorse: {
      primary: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"],
      secondary: ["anthropic/claude-opus-5", "openai-codex/gpt-5.6-sol"],
    },
    micro: { primary: ["openai-codex/gpt-6-luna"], secondary: [] },
  },
  lastResort: ["synthetic/hf:moonshotai/Kimi-K3"],
};

const ALL = [
  "anthropic/claude-fable-5-1",
  "openai-codex/gpt-6-astra",
  "anthropic/claude-opus-5-5",
  "openai-codex/gpt-6-sol",
  "anthropic/claude-opus-5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-6-luna",
  "synthetic/hf:moonshotai/Kimi-K3",
].map((ref) => {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
});

const open = (): boolean => false;
const opus = { provider: "anthropic", id: "claude-opus-5-5" };

test("pickFallback walks primaries, secondaries, then the last resort", () => {
  assert.deepEqual(pickFallback(TABLE, opus, { available: ALL, scoped: [], isClosed: open }), {
    provider: "openai-codex",
    id: "gpt-6-sol",
  });
  const withoutSol = ALL.filter((model) => model.id !== "gpt-6-sol");
  assert.deepEqual(
    pickFallback(TABLE, opus, { available: withoutSol, scoped: [], isClosed: open }),
    {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    },
  );
  const codexClosed = (provider: string): boolean => provider === "openai-codex";
  assert.deepEqual(
    pickFallback(TABLE, opus, { available: ALL, scoped: [], isClosed: codexClosed }),
    {
      provider: "anthropic",
      id: "claude-opus-5",
    },
  );
  const allClosed = (provider: string): boolean => provider !== "synthetic";
  assert.deepEqual(pickFallback(TABLE, opus, { available: ALL, scoped: [], isClosed: allClosed }), {
    provider: "synthetic",
    id: "hf:moonshotai/Kimi-K3",
  });
  assert.deepEqual(
    pickFallback(TABLE, opus, {
      available: ALL,
      scoped: ["anthropic/claude-opus-5-5", "synthetic/hf:moonshotai/Kimi-K3"],
      isClosed: open,
    }),
    { provider: "synthetic", id: "hf:moonshotai/Kimi-K3" },
  );
  assert.equal(
    pickFallback(TABLE, opus, { available: [opus], scoped: [], isClosed: open }),
    undefined,
  );
  const kimi = { provider: "synthetic", id: "hf:moonshotai/Kimi-K3" };
  assert.equal(
    pickFallback(TABLE, kimi, { available: ALL, scoped: [], isClosed: open }),
    undefined,
  );
});

test("pickFallback consults the closed map with the resolved account", () => {
  const seen: string[] = [];
  const result = pickFallback(
    TABLE,
    { provider: "openai-codex", id: "gpt-6-luna" },
    {
      available: ALL,
      scoped: [],
      isClosed: (provider, accountId) => {
        seen.push(`${provider}:${accountId}`);
        return accountId === "acct-s";
      },
    },
    (provider) => (provider === "synthetic" ? "acct-s" : "default"),
  );
  assert.equal(result, undefined);
  assert.deepEqual(seen, ["synthetic:acct-s"]);
});

test("policy closes providers per account, expires them, and caps closures at 24 h", async () => {
  let now = NOW;
  const policy = createUsageLimitPolicy({
    owner: "root",
    generation: 3,
    readPreference: async () => "fallback",
    fallbacks: TABLE,
    now: () => now,
  });
  assert.equal(policy.owner, "root");
  assert.equal(policy.generation, 3);
  assert.equal(await policy.preference(), "fallback");
  assert.equal(
    policy.classify({ provider: "anthropic", modelId: "m", errorMessage: ANTHROPIC_429 })?.kind,
    "quota",
  );

  policy.closeProvider("anthropic", "a", NOW + HOUR);
  assert.equal(policy.isClosed("anthropic", "a"), true);
  assert.equal(policy.isClosed("anthropic", "b"), false);
  assert.equal(policy.isClosed("anthropic", "a", NOW + HOUR), false);
  now = NOW + HOUR + 1;
  assert.equal(policy.isClosed("anthropic", "a"), false);

  now = NOW;
  policy.closeProvider("openai-codex", "default", NOW + 72 * HOUR);
  assert.equal(policy.isClosed("openai-codex", "default", NOW + MAX_CLOSE_MS - 1), true);
  assert.equal(policy.isClosed("openai-codex", "default", NOW + MAX_CLOSE_MS), false);

  policy.closeProvider("synthetic", "default", Number.POSITIVE_INFINITY);
  assert.equal(policy.isClosed("synthetic", "default", NOW + MAX_CLOSE_MS - 1), true);
  policy.closeProvider("synthetic", "x", Number.NaN);
  assert.equal(policy.isClosed("synthetic", "x"), false);

  assert.deepEqual(
    policy.pickFallback(opus, {
      available: ALL,
      scoped: [],
      isClosed: (provider, accountId) => policy.isClosed(provider, accountId),
    }),
    { provider: "openai-codex", id: "gpt-6-sol" },
  );
});

test("structured input is confirmed from its own reset, ignoring root-branch data", async () => {
  let snapshotReads = 0;
  const context = {
    now: () => NOW,
    failedAt: NOW,
    usageSnapshot: async (): Promise<ProviderUsageSnapshot | undefined> => {
      snapshotReads += 1;
      return { observedAt: NOW, windows: [windowAt(10, NOW + HOUR)] };
    },
    // A root-session entry near the failure time must not replace the child's own reset.
    codexEntry: { observedAt: NOW, resetAt: NOW + 5 * HOUR, accountId: "root-acct" },
  };
  const child = quota("openai-codex", {
    confidence: "structured",
    resetAt: NOW + HOUR,
    accountId: "child-acct",
  });
  assert.deepEqual(await corroborateUsageLimit(context, child), {
    ready: false,
    classification: child,
    evidence: "confirmed",
  });
  const elapsed = { ...child, resetAt: NOW - 1 };
  assert.deepEqual(await corroborateUsageLimit(context, elapsed), {
    ready: true,
    classification: elapsed,
    evidence: "confirmed",
  });
  const onAnthropic = quota("anthropic", { confidence: "structured", resetAt: NOW + HOUR });
  assert.equal(
    (await corroborateUsageLimit({ now: () => NOW }, onAnthropic)).evidence,
    "confirmed",
  );
  assert.equal(snapshotReads, 2, "window data is read, but shows no exhausted window");

  // Without a reset the structured label alone proves nothing new; normal corroboration runs.
  const noReset = quota("openai-codex", { confidence: "structured" });
  await corroborateUsageLimit(context, noReset);
  assert.equal(snapshotReads, 3);
});

test("an elapsed structured reset is not ready while live data shows an exhausted window", async () => {
  let snapshotReads = 0;
  const structured = quota("openai-codex", { confidence: "structured", resetAt: 1000 });
  const blocked = await corroborateUsageLimit(
    {
      now: () => 2000,
      usageSnapshot: async (): Promise<ProviderUsageSnapshot | undefined> => {
        snapshotReads += 1;
        return { observedAt: 2000, windows: [windowAt(100, 100_000)] };
      },
    },
    structured,
  );
  assert.equal(snapshotReads, 1, "live window data is consulted");
  assert.deepEqual(blocked, {
    ready: false,
    classification: { ...structured, resetAt: 100_000 },
    evidence: "confirmed",
  });

  // A later structured reset outranks an earlier window reset.
  const later = quota("openai-codex", { confidence: "structured", resetAt: 200_000 });
  const laterResult = await corroborateUsageLimit(
    {
      now: () => 2000,
      usageSnapshot: snapshots({ observedAt: 2000, windows: [windowAt(100, 100_000)] }),
    },
    later,
  );
  assert.equal(laterResult.ready, false);
  assert.equal(laterResult.classification.resetAt, 200_000);

  // No live data: the elapsed structured reset alone decides readiness.
  for (const context of [
    { now: () => 2000, usageSnapshot: snapshots(undefined) },
    {
      now: () => 2000,
      usageSnapshot: async (): Promise<ProviderUsageSnapshot | undefined> => {
        throw new Error("usage endpoint down");
      },
    },
    { now: () => 2000 },
  ]) {
    assert.deepEqual(await corroborateUsageLimit(context, structured), {
      ready: true,
      classification: structured,
      evidence: "confirmed",
    });
  }

  // A stale reading whose exhausted window already reset does not block.
  const staleElapsed = await corroborateUsageLimit(
    {
      now: () => 2000,
      failedAt: 1500,
      usageSnapshot: snapshots({ observedAt: 500, windows: [windowAt(100, 1800)] }),
    },
    structured,
  );
  assert.equal(staleElapsed.ready, true);
  assert.equal(staleElapsed.evidence, "confirmed");
});

test("policy corroborate reads the owner's Codex entry only for the owner's failures", async () => {
  let entryReads = 0;
  const policy = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "auto-resume",
    fallbacks: TABLE,
    now: () => NOW,
    usageSnapshot: snapshots(undefined),
    readCodexEntry: () => {
      entryReads += 1;
      return { observedAt: NOW, resetAt: NOW + 5 * HOUR, accountId: "root-acct" };
    },
  });
  const foreign = quota("openai-codex", { confidence: "parsed", sessionId: "child-1" });
  const result = await policy.corroborate(foreign);
  assert.equal(entryReads, 0, "a child's failure never reads the root branch entry");
  assert.deepEqual(result, { ready: false, classification: foreign, evidence: "unavailable" });

  const own = await policy.corroborate(quota("openai-codex", { sessionId: "root" }));
  assert.equal(entryReads, 1);
  assert.equal(own.classification.accountId, "root-acct");
  assert.equal(own.classification.sessionId, "root");

  await policy.corroborate(quota("openai-codex"));
  assert.equal(entryReads, 2, "an untagged classification keeps the owner's entry");
});

test('policy accountId reports the resolver\'s id and defaults to "default"', () => {
  const resolved = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: TABLE,
    resolveAccountId: (provider) => (provider === "openai-codex" ? "acct" : "default"),
  });
  assert.equal(resolved.accountId("openai-codex"), "acct");
  assert.equal(resolved.accountId("anthropic"), "default");
  const unresolved = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: TABLE,
  });
  assert.equal(unresolved.accountId("openai-codex"), "default");
});

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: Error) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const pending = (): Promise<boolean> => new Promise((resolve) => setImmediate(() => resolve(true)));

test("policy preference and corroborate wait for a slow fallback table before answering", async () => {
  for (const step of ["preference", "corroborate"] as const) {
    const table = deferred<ModelFallbacks>();
    const policy = createUsageLimitPolicy({
      owner: "root",
      generation: 1,
      readPreference: async () => "none",
      loadFallbacks: () => table.promise,
      usageSnapshot: snapshots(undefined),
    });
    const answer =
      step === "preference"
        ? policy.preference()
        : policy.corroborate(quota("anthropic", { sessionId: "child" }));
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await pending();
    assert.equal(settled, false, `${step} answered before the fallback table loaded`);
    table.resolve(TABLE);
    await answer;
    assert.deepEqual(
      policy.pickFallback(opus, { available: ALL, scoped: [], isClosed: open }),
      { provider: "openai-codex", id: "gpt-6-sol" },
      `${step}: the suggestion must be present once ${step} settles`,
    );
  }
});

test("policy answers without fallbacks once a slow fallback table fails to load", async () => {
  const table = deferred<ModelFallbacks>();
  let loads = 0;
  const policy = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "fallback",
    loadFallbacks: () => {
      loads += 1;
      return table.promise;
    },
    usageSnapshot: snapshots(undefined),
  });
  const preference = policy.preference();
  const corroboration = policy.corroborate(quota("anthropic"));
  table.reject(new Error("unreadable"));
  assert.equal(await preference, "fallback");
  assert.equal((await corroboration).classification.provider, "anthropic");
  await policy.fallbacksLoaded;
  assert.equal(
    policy.pickFallback(opus, { available: ALL, scoped: [], isClosed: open }),
    undefined,
  );
  assert.equal(await policy.preference(), "fallback");
  assert.equal(loads, 1, "the table loads once per policy");

  const throwing = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "none",
    loadFallbacks: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal(await throwing.preference(), "none");
});

test("policy preference falls back to none when the reader throws", async () => {
  const policy = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => {
      throw new Error("settings unreadable");
    },
    fallbacks: TABLE,
  });
  assert.equal(await policy.preference(), "none");
});

test("policy corroborate passes the codex entry through and never throws", async () => {
  const policy = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "auto-resume",
    fallbacks: TABLE,
    now: () => NOW,
    usageSnapshot: snapshots({ observedAt: NOW, windows: [] }),
    readCodexEntry: () => ({ observedAt: NOW, resetAt: NOW + HOUR }),
  });
  const result = await policy.corroborate(quota("openai-codex"));
  assert.equal(result.classification.confidence, "structured");
  assert.equal(result.ready, false);

  const broken = createUsageLimitPolicy({
    owner: "root",
    generation: 1,
    readPreference: async () => "auto-resume",
    fallbacks: TABLE,
    readCodexEntry: () => {
      throw new Error("branch gone");
    },
  });
  assert.equal((await broken.corroborate(quota("openai-codex"))).ready, false);
});

test("the repository fallback table loads and mirrors the model-guidance tiers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-fallbacks-"));
  try {
    const table = await loadModelFallbacks(agentDir);
    assert.deepEqual(table.tiers.flagship?.primary, [
      "anthropic/claude-fable-5-1",
      "openai-codex/gpt-6-astra",
    ]);
    assert.deepEqual(table.tiers.workhorse, {
      primary: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"],
      secondary: ["anthropic/claude-opus-5", "openai-codex/gpt-5.6-sol"],
    });
    assert.deepEqual(table.tiers.utility, {
      primary: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-5.6-terra"],
      secondary: ["anthropic/claude-sonnet-5"],
    });
    assert.deepEqual(table.tiers.micro?.primary, [
      "openai-codex/gpt-6-luna",
      "anthropic/claude-haiku-5-5",
    ]);
    assert.deepEqual(table.lastResort, ["synthetic/hf:moonshotai/Kimi-K3"]);

    await writeFile(
      join(agentDir, "model-fallbacks.json"),
      JSON.stringify({
        tiers: { micro: { primary: ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5"] } },
      }),
    );
    const merged = await loadModelFallbacks(agentDir);
    assert.deepEqual(merged.tiers.micro?.primary, [
      "openai-codex/gpt-6-luna",
      "anthropic/claude-sonnet-5",
    ]);
    assert.deepEqual(merged.tiers.flagship, table.tiers.flagship);
    assert.deepEqual(merged.lastResort, table.lastResort);

    await writeFile(
      join(agentDir, "model-fallbacks.json"),
      JSON.stringify({ tiers: { micro: {} } }),
    );
    await assert.rejects(loadModelFallbacks(agentDir), /Invalid model fallback override/);
    await writeFile(join(agentDir, "model-fallbacks.json"), "{");
    await assert.rejects(loadModelFallbacks(agentDir), /Malformed JSON/);
    await assert.rejects(loadModelFallbacks(agentDir, join(agentDir, "missing.json")), /not found/);
    assert.match(DEFAULT_MODEL_FALLBACKS_PATH, /\.pi\/model-fallbacks\.json$/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
