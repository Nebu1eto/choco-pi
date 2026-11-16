/**
 * Model-scoped usage limits: Anthropic's Fable weekly limit covers the Claude
 * Fable and Claude Mythos series only, so it must never close Opus, Sonnet or
 * Haiku. A scoped window of unknown coverage closes only the model that failed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  corroborateUsageLimit,
  createUsageLimitPolicy,
  loadModelFallbacks,
  pickFallback,
} from "../profile/extensions/lib/usage-limit.ts";
import type { UsageLimitClassification } from "../profile/extensions/lib/usage-limit-contract.ts";
import {
  normalizeClaudeUsage,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "../profile/extensions/provider-usage.ts";

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FABLE_SCOPE = { name: "fable", models: ["claude-fable", "claude-mythos"] };

function window(label: string, percent: number, resetAt: number, scope?: string): UsageWindow {
  const result: UsageWindow = { label, percent, qualifier: "used", eventAt: new Date(resetAt) };
  if (scope !== undefined) result.scope = scope;
  return result;
}

const fableExhausted = (): UsageWindow => window("Fable 7d", 100, NOW + 3 * DAY, "Fable");
const sessionAt = (percent: number): UsageWindow => window("5h", percent, NOW + 2 * HOUR);

function reading(...windows: UsageWindow[]) {
  return async (): Promise<ProviderUsageSnapshot | undefined> => ({ observedAt: NOW, windows });
}

function quota(modelId: string): UsageLimitClassification {
  return { kind: "quota", provider: "anthropic", modelId, confidence: "inferred" };
}

async function corroborate(modelId: string, ...windows: UsageWindow[]) {
  return corroborateUsageLimit(
    { now: () => NOW, failedAt: NOW - 1000, usageSnapshot: reading(...windows) },
    quota(modelId),
  );
}

test("the Anthropic usage payload marks the Fable window as scoped, live and legacy", () => {
  const live = normalizeClaudeUsage({
    limits: [
      { kind: "session", percent: 10, resets_at: "2026-05-01T14:00:00Z" },
      { kind: "weekly_all", percent: 20, resets_at: "2026-05-04T00:00:00Z" },
      {
        kind: "weekly_scoped",
        percent: 100,
        resets_at: "2026-05-04T00:00:00Z",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  });
  assert.deepEqual(
    live.windows.map((entry) => [entry.label, entry.scope]),
    [
      ["5h", undefined],
      ["7d", undefined],
      ["Fable 7d", "Fable"],
    ],
  );
  const legacy = normalizeClaudeUsage({
    five_hour: { utilization: 10, resets_at: "2026-05-01T14:00:00Z" },
    seven_day_fable: { utilization: 100, resets_at: "2026-05-04T00:00:00Z" },
  });
  assert.deepEqual(
    legacy.windows.map((entry) => [entry.label, entry.scope]),
    [
      ["5h", undefined],
      ["Fable 7d", "Fable"],
    ],
  );
});

test("an exhausted Fable window confirms a Fable or Mythos limit scoped to that series", async () => {
  for (const modelId of ["claude-fable-5-2", "claude-mythos-5-1"]) {
    const result = await corroborate(modelId, sessionAt(30), fableExhausted());
    assert.equal(result.ready, false, modelId);
    assert.equal(result.evidence, "confirmed", modelId);
    assert.deepEqual(result.classification.scope, FABLE_SCOPE, modelId);
    assert.equal(result.classification.resetAt, NOW + 3 * DAY, modelId);
  }
});

test("an exhausted Fable window never explains an Opus, Sonnet or Haiku limit", async () => {
  for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const result = await corroborate(modelId, sessionAt(30), fableExhausted());
    assert.equal(result.ready, true, modelId);
    assert.equal(result.evidence, "capacity", modelId);
    assert.equal(result.classification.scope, undefined, modelId);
  }
});

test("an exhausted account-wide window makes the limit provider-wide for every model", async () => {
  for (const modelId of ["claude-fable-5-2", "claude-opus-5-5"]) {
    const result = await corroborate(modelId, sessionAt(100), fableExhausted());
    assert.equal(result.evidence, "confirmed", modelId);
    assert.equal(result.classification.scope, undefined, modelId);
  }
});

test("a scoped window of unknown coverage closes only the model whose request failed", async () => {
  const nova = window("Nova 7d", 100, NOW + DAY, "Nova");
  // claude-opus-5 is an id prefix of claude-opus-5-5, which did not fail.
  const result = await corroborate("claude-opus-5", sessionAt(30), nova);
  assert.equal(result.evidence, "confirmed");
  assert.deepEqual(result.classification.scope, {
    name: "nova",
    models: ["claude-opus-5"],
    exact: true,
  });

  const policy = createUsageLimitPolicy({
    owner: "unknown-scope",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => NOW,
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY, result.classification.scope);
  assert.equal(policy.isClosed("anthropic", "acct", NOW, "claude-opus-5"), true);
  for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]) {
    assert.equal(policy.isClosed("anthropic", "acct", NOW, modelId), false, modelId);
  }
  assert.equal(policy.isClosed("anthropic", "acct"), false, "the provider itself stays open");
});

test("a Fable closure widens to the account once an account-wide window is exhausted", async () => {
  let clock = NOW;
  const policy = createUsageLimitPolicy({
    owner: "scope-widen",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
    usageSnapshot: async () => ({
      observedAt: clock,
      windows: [sessionAt(100), fableExhausted()],
    }),
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY, FABLE_SCOPE);
  clock += MIN;
  const answer = await policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2");
  assert.equal(answer.open, false);
  assert.equal(answer.scope, undefined, "the limit in force covers every model");
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), true);
  assert.equal(policy.isClosed("anthropic", "acct"), true);
});

test("a Fable closure blocks only Fable and Mythos models", () => {
  const policy = createUsageLimitPolicy({
    owner: "fable-closure",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => NOW,
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY, FABLE_SCOPE);
  for (const modelId of ["claude-fable-5-2", "claude-fable-5-1", "claude-mythos-5-2"]) {
    assert.equal(policy.isClosed("anthropic", "acct", NOW, modelId), true, modelId);
  }
  for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    assert.equal(policy.isClosed("anthropic", "acct", NOW, modelId), false, modelId);
  }
  assert.equal(policy.isClosed("anthropic", "acct"), false);
  assert.equal(policy.isClosed("anthropic", "acct", NOW + DAY, "claude-fable-5-2"), false);
});

test("a Fable limit falls back to gpt-6-astra, then to Opus before any last resort", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-fallbacks-scope-"));
  try {
    const table = await loadModelFallbacks(agentDir);
    const refs = [
      ...Object.values(table.tiers).flatMap((tier) => [...tier.primary, ...(tier.secondary ?? [])]),
      ...table.lastResort,
    ];
    const available = refs.map((ref) => {
      const slash = ref.indexOf("/");
      return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
    });
    const current = { provider: "anthropic", id: "claude-fable-5-2" };
    const fableClosed = (provider: string, _account: string, modelId?: string): boolean =>
      provider === "anthropic" &&
      modelId !== undefined &&
      /^claude-(fable|mythos)(-|$)/.test(modelId);
    const pick = (isClosed: (provider: string, account: string, modelId?: string) => boolean) =>
      pickFallback(table, current, { available, scoped: [], isClosed });

    assert.deepEqual(pick(fableClosed), { provider: "openai-codex", id: "gpt-6-astra" });
    // Codex closed as well: Opus on the same provider, never xai first.
    assert.deepEqual(
      pick((provider, account, modelId) =>
        provider === "openai-codex" ? true : fableClosed(provider, account, modelId),
      ),
      { provider: "anthropic", id: "claude-opus-5-5" },
    );
    // A provider-wide Anthropic limit with Codex closed still reaches the last resort.
    assert.deepEqual(
      pick((provider) => provider === "openai-codex" || provider === "anthropic"),
      { provider: "xai", id: "grok-4.7" },
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("re-checks judge each closure by the windows of its own scope", async () => {
  let clock = NOW;
  let windows: UsageWindow[] = [sessionAt(30), fableExhausted()];
  const policy = createUsageLimitPolicy({
    owner: "scope-recheck",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
    usageSnapshot: async () => ({ observedAt: clock, windows }),
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY);
  policy.closeProvider("anthropic", "acct", NOW + DAY, FABLE_SCOPE);
  clock += MIN;

  // Opus: only the provider-wide closure blocks it, and no account-wide window is exhausted.
  assert.deepEqual(await policy.recheck("anthropic", "acct", undefined, "claude-opus-5-5"), {
    open: true,
    detail: "live usage shows capacity",
  });
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), false);

  // Fable: its closure stays while the Fable window is exhausted (capped at 24 h), and says so.
  assert.deepEqual(await policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2"), {
    open: false,
    until: clock + DAY,
    detail: "live usage shows Fable 7d exhausted",
    scope: FABLE_SCOPE,
    inForce: [{ scope: FABLE_SCOPE, until: clock + DAY }],
  });
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), true);

  // With no closure on record, a re-check for a model reads the windows that block it.
  windows = [sessionAt(30), fableExhausted()];
  const fresh = createUsageLimitPolicy({
    owner: "scope-recheck-unrecorded",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
    usageSnapshot: async () => ({ observedAt: clock, windows }),
  });
  assert.equal((await fresh.recheck("anthropic", "acct", NOW, "claude-sonnet-5-5")).open, true);
  const fable = await fresh.recheck("anthropic", "acct", NOW, "claude-mythos-5-2");
  assert.equal(fable.open, false);
  assert.deepEqual(fable.scope, FABLE_SCOPE);
});

test("a success on Opus reopens the account but not the Fable closure", () => {
  let clock = NOW;
  const policy = createUsageLimitPolicy({
    owner: "scope-reopen",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY);
  policy.closeProvider("anthropic", "acct", NOW + DAY, FABLE_SCOPE);
  clock += MIN;
  policy.reopen("anthropic", "acct", clock, "claude-opus-5-5");
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), false);
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), true);
  policy.reopen("anthropic", "acct", clock, "claude-mythos-5-2");
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), false);
});
test("after a switch to astra, an astra limit still reaches Opus before the last resort", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-fallbacks-second-hop-"));
  try {
    const table = await loadModelFallbacks(agentDir);
    const refs = [
      ...Object.values(table.tiers).flatMap((tier) => [...tier.primary, ...(tier.secondary ?? [])]),
      ...table.lastResort,
    ];
    const available = refs.map((ref) => {
      const slash = ref.indexOf("/");
      return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
    });
    // Fable is closed by its scoped limit; Codex (astra's account) is closed as a whole.
    const isClosed = (provider: string, _account: string, modelId?: string): boolean =>
      provider === "openai-codex" ||
      (provider === "anthropic" &&
        modelId !== undefined &&
        /^claude-(fable|mythos)(-|$)/.test(modelId));
    const picked = pickFallback(
      table,
      { provider: "openai-codex", id: "gpt-6-astra" },
      { available, scoped: [], isClosed },
    );
    assert.deepEqual(picked, { provider: "anthropic", id: "claude-opus-5-5" });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a widened Fable closure keeps Fable closed after the account-wide window resets", async () => {
  let clock = NOW;
  let windows: UsageWindow[] = [sessionAt(100), fableExhausted()];
  const policy = createUsageLimitPolicy({
    owner: "scope-widen-reset",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
    usageSnapshot: async () => ({ observedAt: clock, windows }),
  });
  policy.closeProvider("anthropic", "acct", NOW + DAY, FABLE_SCOPE);
  clock += MIN;
  const widened = await policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2");
  assert.equal(widened.open, false);
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), true);

  // The account-wide window resets; the Fable window is still exhausted.
  windows = [sessionAt(30), fableExhausted()];
  clock += MIN;
  const answer = await policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2");
  assert.equal(answer.open, false);
  assert.deepEqual(answer.scope, FABLE_SCOPE);
  assert.deepEqual(
    answer.inForce?.map((state) => state.scope),
    [FABLE_SCOPE],
  );
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), true);
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), false);
});
test("without live usage data a limit closes only the failed model, never the account", async () => {
  const policy = createUsageLimitPolicy({
    owner: "no-usage-data",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => NOW,
    usageSnapshot: async () => undefined,
  });
  const result = await policy.corroborate(quota("claude-fable-5-2"));
  assert.equal(result.evidence, "unavailable");
  assert.deepEqual(result.classification.scope, {
    name: "unconfirmed",
    models: ["claude-fable-5-2"],
    exact: true,
  });
  policy.closeProvider("anthropic", "acct", NOW + HOUR, result.classification.scope);
  assert.equal(policy.isClosed("anthropic", "acct", NOW, "claude-fable-5-2"), true);
  for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-mythos-5-2"]) {
    assert.equal(policy.isClosed("anthropic", "acct", NOW, modelId), false, modelId);
  }
  assert.equal(policy.isClosed("anthropic", "acct"), false);
  // Still no data on the next gate: the failed model is tried again.
  const recheck = await policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2");
  assert.equal(recheck.open, true);
});
test("a success during an in-flight re-check is not undone by the older reading", async () => {
  let clock = 1000;
  let release: (snapshot: ProviderUsageSnapshot) => void = () => undefined;
  const policy = createUsageLimitPolicy({
    owner: "recheck-race",
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    now: () => clock,
    usageSnapshot: () =>
      new Promise<ProviderUsageSnapshot>((resolve) => {
        release = resolve;
      }),
  });
  policy.closeProvider("anthropic", "acct", clock + DAY, FABLE_SCOPE);
  clock = 2000;
  const pending = policy.recheck("anthropic", "acct", undefined, "claude-fable-5-2");
  clock = 3000;
  policy.reopen("anthropic", "acct", 3000, "claude-fable-5-2");
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), false);
  // The reading was taken at 2000, before the success, and shows the account exhausted.
  release({
    observedAt: 2000,
    windows: [window("5h", 100, 2000 + HOUR), window("Fable 7d", 100, 2000 + 3 * DAY, "Fable")],
  });
  const answer = await pending;
  assert.equal(answer.open, true);
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-opus-5-5"), false);
  assert.equal(policy.isClosed("anthropic", "acct", clock, "claude-fable-5-2"), false);
  assert.equal(policy.isClosed("anthropic", "acct", clock), false);
});
