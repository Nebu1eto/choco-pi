import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import statusCommands, {
  createTabController,
  STATUS_TABS,
  type StatusTabId,
  tabBody,
  USAGE_REFRESH_MS,
} from "../.pi/extensions/status-commands.ts";
import {
  claudePlanLabel,
  codexPlanLabel,
  formatProviderUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  usageFailureMessage,
} from "../.pi/extensions/provider-usage.ts";
import {
  createUsageCache,
  UsageHttpError,
  UsageThrottledError,
  type UsageCacheEntry,
  type UsageCacheStorage,
  type UsageRequestPolicy,
} from "../.pi/extensions/lib/usage-cache.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const POLICY: UsageRequestPolicy = { minIntervalMs: 60_000, maxStaleMs: 60 * 60_000 };

/** In-memory stand-in for the shared cache file. */
function memoryStorage(): UsageCacheStorage & { entries: () => Record<string, UsageCacheEntry> } {
  let stored: Record<string, UsageCacheEntry> = {};
  return {
    read: () => Promise.resolve(stored),
    write: (entries) => {
      stored = entries;
      return Promise.resolve();
    },
    entries: () => stored,
  };
}

test("status tabs expose Status, Usage, and Preferences in order", () => {
  assert.deepEqual(
    STATUS_TABS.map((tab) => tab.title),
    ["Status", "Usage", "Preferences"],
  );
});

test("usage tab keeps the white body text for readability", async () => {
  const body = await tabBody(
    // SAFETY: The fixture supplies every host member exercised by this test.
    {
      modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
      ui: { theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
    } as any,
    "medium",
    "usage",
    true,
  );
  assert.match(body, /^<text>Claude Code — not connected/);
});

test("registers /quota as a white-text alias for /usage", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  // SAFETY: The fixture supplies every host member exercised by this test.
  statusCommands({
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: any) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
    getThinkingLevel: () => "medium",
  } as any);

  assert.equal(commands.get("quota"), commands.get("usage"));
  assert.equal(commands.has("settings"), false);

  const notifications: Array<[string, string]> = [];
  await commands.get("quota")?.handler("", {
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
    },
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      notify: (text: string, level: string) => notifications.push([text, level]),
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.[1], "info");
  assert.match(notifications[0]?.[0] ?? "", /^<text>Claude Code — not connected/);
});

test("labels Claude plans from the live profile, with Team seats before the rate-limit tier", () => {
  const profile = (
    organization: Record<string, RuntimeValue>,
    account: Record<string, RuntimeValue> = {},
  ) => ({
    account,
    organization,
  });
  assert.equal(claudePlanLabel(profile({ rate_limit_tier: "default_claude_pro" })), "Pro");
  assert.equal(claudePlanLabel(profile({ rate_limit_tier: "default_claude_max_5x" })), "Max (5x)");
  assert.equal(
    claudePlanLabel(profile({ rate_limit_tier: "default_claude_max_20x" })),
    "Max (20x)",
  );
  assert.equal(
    claudePlanLabel(
      profile({
        organization_type: "claude_team",
        rate_limit_tier: "default_claude_max_5x",
        seat_tier: "team_tier_1",
      }),
    ),
    "Team",
  );
  assert.equal(
    claudePlanLabel(
      profile({
        organization_type: "claude_team",
        rate_limit_tier: "default_claude_max_20x",
        seat_tier: "team_premium",
      }),
    ),
    "Team Premium",
  );
  assert.equal(claudePlanLabel(profile({ organization_type: "claude_enterprise" })), "Enterprise");
  assert.equal(claudePlanLabel(profile({}, { has_claude_max: true })), "Max");
  assert.equal(claudePlanLabel(undefined), undefined);
  assert.equal(claudePlanLabel(undefined, "max"), "Max");
});

test("shows the Claude plan next to the usage windows", () => {
  const usage = normalizeClaudeUsage(
    {
      five_hour: { utilization: 12, resets_at: "2999-01-01T00:00:00Z" },
      extra_usage: { is_enabled: true, utilization: 4 },
    },
    { organization: { rate_limit_tier: "default_claude_max_20x" } },
  );
  assert.equal(usage.plan, "Max (20x)");
  assert.match(formatProviderUsage(usage), /^Claude Code — Max \(20x\) · extra usage 4% used\n/);
});

test("labels ChatGPT Codex plans and keeps unknown wire values readable", () => {
  assert.equal(codexPlanLabel("plus"), "Plus");
  assert.equal(codexPlanLabel("prolite"), "Pro (5x)");
  assert.equal(codexPlanLabel("pro"), "Pro (20x)");
  assert.equal(codexPlanLabel("business"), "Business");
  assert.equal(codexPlanLabel("self_serve_business_usage_based"), "Business");
  assert.equal(codexPlanLabel("team"), "Team");
  assert.equal(codexPlanLabel("some_new_plan"), "Some New Plan");
  assert.equal(codexPlanLabel(undefined), undefined);

  const usage = normalizeCodexUsage({
    plan_type: "prolite",
    credits: { balance: "0" },
    rate_limit: {},
  });
  assert.equal(usage.plan, "Pro (5x)");
  assert.equal(formatProviderUsage(usage), "OpenAI Codex — Pro (5x) · 0 credits");
});

test("re-queries the usage tab on every activation and every refresh interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const loads: StatusTabId[] = [];
  const paints: Array<[string, boolean]> = [];
  const controller = createTabController({
    load: (id) => {
      loads.push(id);
      return Promise.resolve(`${id}-body-${loads.length}`);
    },
    paint: (body, view) => paints.push([body, view.preserveScroll]),
    loading: "loading",
    failure: (id, message) => `failed ${id}: ${message}`,
  });

  controller.activate("usage");
  await flush();
  controller.activate("status");
  await flush();
  controller.activate("usage");
  await flush();
  assert.deepEqual(loads, ["usage", "status", "usage"]);
  assert.deepEqual(paints.at(-1), ["usage-body-3", false]);

  t.mock.timers.tick(USAGE_REFRESH_MS);
  await flush();
  assert.deepEqual(loads, ["usage", "status", "usage", "usage"]);
  assert.deepEqual(paints.at(-1), ["usage-body-4", true]);

  controller.dispose();
  t.mock.timers.tick(USAGE_REFRESH_MS * 2);
  assert.equal(loads.length, 4);
});

test("keeps the last good body when a refresh fails and never auto-refreshes Status", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let attempt = 0;
  const loads: StatusTabId[] = [];
  const paints: string[] = [];
  const controller = createTabController({
    load: (id) => {
      loads.push(id);
      attempt += 1;
      return attempt === 1 ? Promise.resolve("fresh") : Promise.reject(new Error("HTTP 500"));
    },
    paint: (body) => paints.push(body),
    loading: "loading",
    failure: (id, message) => `failed ${id}: ${message}`,
  });

  controller.activate("usage");
  await flush();
  assert.deepEqual(paints, ["loading", "fresh"]);

  t.mock.timers.tick(USAGE_REFRESH_MS);
  await flush();
  assert.deepEqual(loads, ["usage", "usage"]);
  assert.deepEqual(paints, ["loading", "fresh"]);

  controller.activate("status");
  await flush();
  assert.deepEqual(loads, ["usage", "usage", "status"]);
  assert.deepEqual(paints.at(-1), "failed status: HTTP 500");

  t.mock.timers.tick(USAGE_REFRESH_MS * 3);
  await flush();
  assert.deepEqual(loads, ["usage", "usage", "status"]);
  controller.dispose();
});

test("spaces live quota requests and serves the stored snapshot in between", async () => {
  let clock = Date.now();
  const storage = memoryStorage();
  const cache = createUsageCache({ storage, now: () => clock });
  let loads = 0;
  const load = (): Promise<RuntimeValue> => {
    loads += 1;
    return Promise.resolve({ five_hour: { utilization: loads } });
  };

  const fetched = await cache.request("anthropic:usage", load, POLICY);
  assert.equal(fetched.cachedAt, undefined);
  assert.deepEqual(fetched.payload, { five_hour: { utilization: 1 } });

  clock += 30_000;
  const throttled = await cache.request("anthropic:usage", load, POLICY);
  assert.equal(loads, 1);
  assert.equal(throttled.cachedAt, clock - 30_000);
  assert.equal(throttled.reason, undefined);
  assert.deepEqual(throttled.payload, { five_hour: { utilization: 1 } });

  clock += 31_000;
  const refreshed = await cache.request("anthropic:usage", load, POLICY);
  assert.equal(loads, 2);
  assert.equal(refreshed.cachedAt, undefined);
  assert.deepEqual(refreshed.payload, { five_hour: { utilization: 2 } });

  await cache.flush();
  assert.equal(storage.entries()["anthropic:usage"]?.failures, 0);
});

test("serves the cached quota after a 429 and waits out the provider's Retry-After", async () => {
  let clock = Date.now();
  const cache = createUsageCache({ storage: memoryStorage(), now: () => clock });
  const storedAt = clock;
  await cache.request("codex:usage", () => Promise.resolve({ plan_type: "pro" }), POLICY);

  clock += 61_000;
  const rejected = await cache.request(
    "codex:usage",
    () => Promise.reject(new UsageHttpError(429, 300_000)),
    POLICY,
  );
  assert.equal(rejected.cachedAt, storedAt);
  assert.equal(rejected.reason, "HTTP 429");
  assert.deepEqual(rejected.payload, { plan_type: "pro" });

  clock += 120_000;
  let attempts = 0;
  const gated = await cache.request(
    "codex:usage",
    () => {
      attempts += 1;
      return Promise.reject(new UsageHttpError(429));
    },
    POLICY,
  );
  assert.equal(attempts, 0);
  assert.equal(gated.reason, "HTTP 429");
  assert.equal(gated.cachedAt, storedAt);

  clock += 200_000;
  const recovered = await cache.request(
    "codex:usage",
    () => Promise.resolve({ plan_type: "plus" }),
    POLICY,
  );
  assert.equal(recovered.cachedAt, undefined);
  assert.deepEqual(recovered.payload, { plan_type: "plus" });
});

test("backs off a failing endpoint and reports when it retries", async () => {
  let clock = Date.now();
  const cache = createUsageCache({ now: () => clock });
  const failing = (): Promise<RuntimeValue> => Promise.reject(new UsageHttpError(503));

  await assert.rejects(cache.request("synthetic:usage", failing, POLICY), /HTTP 503/);

  const throttled = await cache
    .request("synthetic:usage", failing, POLICY)
    .then(() => undefined)
    .catch((error: RuntimeValue) => error);
  assert.ok(throttled instanceof UsageThrottledError);
  assert.equal(throttled.retryAt, clock + 60_000);
  assert.equal(usageFailureMessage(throttled), "HTTP 503 · retrying in 1m");

  clock += 61_000;
  await assert.rejects(cache.request("synthetic:usage", failing, POLICY), /HTTP 503/);
  const second = await cache
    .request("synthetic:usage", failing, POLICY)
    .then(() => undefined)
    .catch((error: RuntimeValue) => error);
  assert.ok(second instanceof UsageThrottledError);
  assert.equal(second.retryAt, clock + 120_000);
});

test("shares the snapshot and the gate with the next session", async () => {
  let clock = Date.now();
  const storage = memoryStorage();
  const first = createUsageCache({ storage, now: () => clock });
  await first.request("anthropic:usage", () => Promise.resolve({ five_hour: {} }), POLICY);
  await first.flush();

  let attempts = 0;
  const second = createUsageCache({ storage, now: () => clock });
  const gated = await second.request(
    "anthropic:usage",
    () => {
      attempts += 1;
      return Promise.resolve({ five_hour: { utilization: 99 } });
    },
    POLICY,
  );
  assert.equal(attempts, 0);
  assert.equal(gated.cachedAt, clock);

  clock += 61_000;
  const afterFailure = await second.request(
    "anthropic:usage",
    () => Promise.reject(new UsageHttpError(500)),
    POLICY,
  );
  assert.equal(afterFailure.cachedAt, clock - 61_000);
  assert.deepEqual(afterFailure.payload, { five_hour: {} });
});

test("marks a usage report that was rebuilt from the cache", () => {
  const report = formatProviderUsage({
    name: "Claude Code",
    plan: "Max (20x)",
    cached: { at: new Date(Date.now() - 12 * 60_000), reason: "HTTP 429" },
    windows: [{ label: "5h", percent: 40, qualifier: "used" }],
  });
  assert.match(report, /^Claude Code — Max \(20x\) · cached 12m ago · HTTP 429\n/);
  assert.match(
    formatProviderUsage({
      name: "Synthetic",
      cached: { at: new Date(Date.now() - 20_000) },
      windows: [{ label: "Weekly credits", percent: 10, qualifier: "used" }],
    }),
    /^Synthetic — cached just now\n/,
  );
});
