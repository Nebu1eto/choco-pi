import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatUsageReport,
  grokPlanLabel,
  grokSubscription,
  grokPeriodLabel,
  grokUsage,
  normalizeGrokUsage,
  providerUsageWindows,
  readProviderUsages,
  type ProviderUsageReport,
} from "../.pi/extensions/provider-usage.ts";
import { createUsageCache } from "../.pi/extensions/lib/usage-cache.ts";
import { hasUsageWindows, usageReportFrame } from "../.pi/extensions/lib/usage-report.ts";
import { ReportFrameSchema } from "../.pi/extensions/lib/host-bridge/report-schema.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const XAI_TOKEN = "fake-xai-oauth-token";

/** Fields of the Grok billing `config` object a test may replace. */
type BillingOverrides = {
  currentPeriod?: { type?: string; start?: string; end?: string };
  creditUsagePercent?: number;
  productUsage?: Array<{ product: string; usagePercent: number }>;
  prepaidBalance?: { val: number | string };
};

function billing(overrides: BillingOverrides = {}) {
  return {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-10-16T05:44:20.695+00:00",
        end: "2026-10-23T05:44:20.695+00:00",
      },
      creditUsagePercent: 2,
      productUsage: [
        { product: "Api", usagePercent: 1 },
        { product: "GrokBot", usagePercent: 1 },
      ],
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
      ...overrides,
    },
  };
}

type Credential = "oauth" | "api_key";
type Fixture = { ctx: ExtensionContext; tokenRequests: string[] };

/** Registry fake: each configured provider maps to its credential type. */
function registry(credentials: Partial<Record<string, Credential>>): Fixture {
  const tokenRequests: string[] = [];
  const models = [
    { provider: "xai", id: "grok-4.7" },
    { provider: "openai", id: "gpt-6.1-sol" },
    { provider: "anthropic", id: "claude-opus-5-5" },
    { provider: "synthetic", id: "syn-1" },
  ];
  const ctx = reinterpretHostValue<ExtensionContext>({
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({
        configured: credentials[provider] !== undefined,
      }),
      getApiKeyForProvider: async (provider: string) => {
        tokenRequests.push(provider);
        if (provider === "openai") throw new Error("openai token must not be resolved");
        return credentials[provider] === undefined ? undefined : `fake-${provider}-token`;
      },
      getAll: () => models,
      isUsingOAuth: (model: { provider: string }) => credentials[model.provider] === "oauth",
    },
  });
  return { ctx, tokenRequests };
}

type FetchCall = { url: string; authorization: string | null };
type Responder = (url: string) => Promise<Response>;

function mockFetch(t: TestContext, respond: Responder): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return respond(url);
    },
  );
  return calls;
}

function json(body: RuntimeValue, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function grokReading(ctx: ExtensionContext): Promise<ProviderUsageReport> {
  return readProviderUsages(ctx, { cache: createUsageCache() });
}

test("normalizes a weekly Grok billing response into one credit window", () => {
  const usage = normalizeGrokUsage(billing());
  assert.deepEqual(usage, {
    name: "Grok",
    windows: [
      {
        label: "Weekly",
        percent: 2,
        qualifier: "used",
        eventAt: new Date("2026-10-23T05:44:20.695Z"),
        eventLabel: "resets",
        detail: "Api 1% · GrokBot 1%",
        windowSeconds: 7 * 86_400,
      },
    ],
  });
});

test("normalizes a monthly period and reports a positive prepaid balance in dollars", () => {
  const usage = normalizeGrokUsage(
    billing({
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-31T00:00:00Z",
      },
      creditUsagePercent: 37.5,
      productUsage: [],
      prepaidBalance: { val: 1234 },
    }),
  );
  assert.equal(usage.status, "$12.34 prepaid balance");
  const window = usage.windows[0];
  assert.ok(window);
  assert.equal(window.label, "Monthly");
  assert.equal(window.percent, 37.5);
  assert.equal(window.windowSeconds, 30 * 86_400);
  assert.equal(window.detail, undefined);
  // proto int64 values may be serialized as strings.
  assert.equal(
    normalizeGrokUsage(billing({ prepaidBalance: { val: "250" } })).status,
    "$2.50 prepaid balance",
  );
});

test("labels unknown and missing Grok period types generically", () => {
  assert.equal(grokPeriodLabel("USAGE_PERIOD_TYPE_WEEKLY"), "Weekly");
  assert.equal(grokPeriodLabel("USAGE_PERIOD_TYPE_MONTHLY"), "Monthly");
  assert.equal(grokPeriodLabel("USAGE_PERIOD_TYPE_BI_WEEKLY"), "Bi Weekly");
  assert.equal(grokPeriodLabel("USAGE_PERIOD_TYPE_UNSPECIFIED"), "Credits");
  assert.equal(grokPeriodLabel(undefined), "Credits");
  const usage = normalizeGrokUsage(billing({ currentPeriod: {}, creditUsagePercent: 150 }));
  assert.deepEqual(usage.windows, [
    {
      label: "Credits",
      percent: 100,
      qualifier: "used",
      eventAt: undefined,
      eventLabel: "resets",
      detail: "Api 1% · GrokBot 1%",
    },
  ]);
});

test("rejects a Grok response without a config object", () => {
  assert.throws(() => normalizeGrokUsage({}), /Unexpected response/);
  assert.throws(() => normalizeGrokUsage([]), /Unexpected response/);
  assert.throws(() => normalizeGrokUsage(null), /Unexpected response/);
});

test("a Grok OAuth sign-in reads the billing endpoint with its bearer token", async (t) => {
  const calls = mockFetch(t, (url) =>
    url === BILLING_URL ? json(billing()) : Promise.reject(new Error(`unexpected ${url}`)),
  );
  const { ctx, tokenRequests } = registry({ xai: "oauth" });
  const report = await grokReading(ctx);
  assert.deepEqual(
    calls.toSorted((left, right) => left.url.localeCompare(right.url)),
    [
      { url: BILLING_URL, authorization: `Bearer fake-xai-token` },
      { url: USER_URL, authorization: `Bearer fake-xai-token` },
    ],
  );
  assert.deepEqual(tokenRequests, ["xai"]);
  assert.equal(report.providers.length, 1);
  const grok = report.providers[0];
  assert.ok(grok?.ok);
  assert.equal(grok.usage.name, "Grok");
  // The user endpoint failed here, so the plan is simply omitted.
  assert.equal(grok.usage.plan, undefined);
  assert.equal(grok.usage.windows[0]?.label, "Weekly");
  assert.equal(grok.usage.windows[0]?.percent, 2);
  assert.deepEqual(report.absent, ["Claude", "ChatGPT", "Synthetic"]);
  assert.ok(hasUsageWindows(report));
  const text = formatUsageReport(report);
  assert.match(text, /^Grok\n {2}Weekly\n/);
  assert.match(text, /2% used/);
  assert.match(text, /\n\nNot signed in: Claude, ChatGPT, Synthetic$/);
  assert.doesNotMatch(text, new RegExp(XAI_TOKEN));
});

/** A `/v1/user` response carrying personal fields next to the subscription tier. */
function user(tier?: string): RuntimeValue {
  const personal = {
    email: "person@example.invalid",
    givenName: "Given",
    familyName: "Family",
    userId: "user-id-123",
    hasGrokCodeAccess: true,
  };
  return tier === undefined ? personal : { ...personal, subscriptionTier: tier };
}

async function grokWithUser(t: TestContext, respond: Responder): Promise<ProviderUsageReport> {
  mockFetch(t, (url) => (url === BILLING_URL ? json(billing()) : respond(url)));
  return grokReading(registry({ xai: "oauth" }).ctx);
}

test("maps Grok subscription tiers to plan labels and passes unknown tiers through", () => {
  assert.equal(grokPlanLabel("SuperGrokPlus"), "SuperGrok Plus");
  assert.equal(grokPlanLabel("SuperGrokLite"), "SuperGrok Lite");
  assert.equal(grokPlanLabel("SuperGrokPro"), "SuperGrok Pro");
  assert.equal(grokPlanLabel("GrokPro"), "SuperGrok");
  assert.equal(grokPlanLabel("XBasic"), "X Basic");
  assert.equal(grokPlanLabel("XPremium"), "X Premium");
  assert.equal(grokPlanLabel("XPremiumPlus"), "X Premium+");
  assert.equal(grokPlanLabel("EnterpriseMystery"), "EnterpriseMystery");
  assert.equal(grokPlanLabel("7"), "7");
  assert.equal(grokPlanLabel("toString"), "toString");
  assert.equal(grokPlanLabel(""), undefined);
  assert.equal(grokPlanLabel(undefined), undefined);
  // Only the tier survives parsing; a non-string tier or a non-object is dropped.
  assert.deepEqual(grokSubscription(user("SuperGrokPlus")), { subscriptionTier: "SuperGrokPlus" });
  assert.deepEqual(grokSubscription({ subscriptionTier: 3 }), {});
  assert.deepEqual(grokSubscription(null), {});
});

test("the Grok row shows the subscription plan and keeps no personal fields", async (t) => {
  const report = await grokWithUser(t, () => json(user("SuperGrokPlus")));
  const grok = report.providers[0];
  assert.ok(grok?.ok);
  assert.equal(grok.usage.plan, "SuperGrok Plus");
  assert.equal(grok.usage.windows[0]?.percent, 2);
  assert.match(formatUsageReport(report), /^Grok — SuperGrok Plus\n {2}Weekly\n/);
  const serialized = JSON.stringify(report);
  assert.ok(!("email" in grok.usage));
  for (const field of ["email", "person@example.invalid", "Given", "user-id-123"]) {
    assert.ok(!serialized.includes(field), `the reading must not retain ${field}`);
  }
  const frame = usageReportFrame("session-xai", report);
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.deepEqual(frame.sections[0]?.rows[0], { label: "Plan", value: "SuperGrok Plus" });
  assert.ok(!JSON.stringify(frame).includes("person@example.invalid"));
});

test("the Grok cache stores only the subscription tier from the user endpoint", async (t) => {
  mockFetch(t, (url) => (url === BILLING_URL ? json(billing()) : json(user("SuperGrokPro"))));
  const written: string[] = [];
  const cache = createUsageCache({
    storage: {
      read: () => Promise.resolve({}),
      write: (entries) => {
        written.push(JSON.stringify(entries));
        return Promise.resolve();
      },
    },
  });
  const usage = await grokUsage(registry({ xai: "oauth" }).ctx, cache);
  await cache.flush();
  assert.equal(usage?.plan, "SuperGrok Pro");
  assert.ok(written.length > 0);
  for (const entry of written) {
    assert.ok(!entry.includes("person@example.invalid") && !entry.includes("user-id-123"));
  }
  assert.ok(written.some((entry) => entry.includes('"subscriptionTier":"SuperGrokPro"')));
});

test("a Grok user response without subscriptionTier shows no plan", async (t) => {
  const report = await grokWithUser(t, () => json(user()));
  const grok = report.providers[0];
  assert.ok(grok?.ok);
  assert.equal(grok.usage.plan, undefined);
  assert.match(formatUsageReport(report), /^Grok\n {2}Weekly\n/);
});

test("a failing Grok user endpoint still renders the billing reading", async (t) => {
  const report = await grokWithUser(t, () => json({ error: "boom" }, 500));
  const grok = report.providers[0];
  assert.ok(grok?.ok);
  assert.equal(grok.usage.plan, undefined);
  assert.equal(grok.usage.windows[0]?.label, "Weekly");
  assert.doesNotMatch(formatUsageReport(report), /unavailable/);
});

test("an unknown Grok subscription tier is shown verbatim", async (t) => {
  const report = await grokWithUser(t, () => json(user("EnterpriseMystery")));
  const grok = report.providers[0];
  assert.ok(grok?.ok);
  assert.equal(grok.usage.plan, "EnterpriseMystery");
});

const FAILURES: Array<[string, Responder, RegExp]> = [
  ["HTTP 401", () => json({ error: "unauthorized" }, 401), /^HTTP 401$/],
  ["HTTP 429", () => json({ error: "slow down" }, 429), /^HTTP 429$/],
  [
    "malformed JSON",
    () => Promise.resolve(new Response("{not json", { status: 200 })),
    /JSON|Unexpected|Expected/,
  ],
  ["a non-object payload", () => json(["unexpected"]), /^Unexpected response$/],
  [
    "a timeout",
    () =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    /aborted due to timeout/,
  ],
];

for (const [label, respond, error] of FAILURES) {
  test(`a signed-in Grok reader that fails with ${label} becomes an unavailable row`, async (t) => {
    mockFetch(t, respond);
    const report = await grokReading(registry({ xai: "oauth" }).ctx);
    assert.equal(report.providers.length, 1);
    const grok = report.providers[0];
    assert.ok(grok && !grok.ok);
    assert.equal(grok.name, "Grok");
    assert.match(grok.error, error);
    assert.equal(hasUsageWindows(report), false);
    assert.match(formatUsageReport(report), /^Grok — unavailable \(.+\)\n\nNot signed in: /);
  });
}

test("a Grok API key reports its state without resolving the key or fetching", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no network in tests")));
  const { ctx, tokenRequests } = registry({ xai: "api_key" });
  assert.deepEqual(await grokUsage(ctx, createUsageCache()), {
    name: "Grok",
    status: "API key; no subscription quota window",
    windows: [],
  });
  const report = await grokReading(ctx);
  assert.equal(report.providers.length, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(tokenRequests, []);
});

test("an xai credential of unknown type fails closed: no token, no fetch", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no network in tests")));
  const tokenRequests: string[] = [];
  // Configured, but the host cannot report the credential type (no xai model, no isUsingOAuth).
  const ctx = reinterpretHostValue<ExtensionContext>({
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({ configured: provider === "xai" }),
      getApiKeyForProvider: async (provider: string) => {
        tokenRequests.push(provider);
        return "fake-xai-token";
      },
      getAll: () => [],
    },
  });
  assert.deepEqual(await grokUsage(ctx, createUsageCache()), {
    name: "Grok",
    status: "API key; no subscription quota window",
    windows: [],
  });
  const report = await grokReading(ctx);
  assert.equal(report.providers.length, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(tokenRequests, []);
});

test("an absent xai credential is neither fetched nor shown as a row", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no network in tests")));
  const { ctx, tokenRequests } = registry({});
  assert.equal(await grokUsage(ctx, createUsageCache()), undefined);
  const report = await grokReading(ctx);
  assert.deepEqual(report.providers, []);
  assert.deepEqual(report.absent, ["Claude", "ChatGPT", "Synthetic", "Grok"]);
  assert.equal(formatUsageReport(report), "Not signed in: Claude, ChatGPT, Synthetic, Grok");
  assert.deepEqual(calls, []);
  assert.deepEqual(tokenRequests, []);
  // Usage-limit corroboration is unchanged: xai has no snapshot reader.
  assert.equal(await providerUsageWindows(ctx, "xai"), undefined);
});

/** Every provider endpoint answers, so only the credential set decides the rows. */
function allEndpoints(url: string): Promise<Response> {
  if (url === BILLING_URL) return json(billing());
  if (url === USER_URL) return json(user("SuperGrokPlus"));
  if (url === "https://api.anthropic.com/api/oauth/usage") {
    return json({ five_hour: { utilization: 10 } });
  }
  if (url === "https://api.anthropic.com/api/oauth/profile") return json({});
  if (url === "https://api.synthetic.new/v2/quotas") return json({});
  return Promise.reject(new Error(`unexpected ${url}`));
}

test("absent providers: none, one, and three", async (t) => {
  mockFetch(t, allEndpoints);
  const names = (report: ProviderUsageReport): string[] =>
    report.providers.map((reading) => (reading.ok ? reading.usage.name : reading.name));

  const none = await grokReading(
    registry({ anthropic: "oauth", openai: "oauth", synthetic: "api_key", xai: "oauth" }).ctx,
  );
  assert.deepEqual(names(none), ["Claude", "ChatGPT", "Synthetic", "Grok"]);
  assert.deepEqual(none.absent, []);
  assert.doesNotMatch(formatUsageReport(none), /Not signed in/);
  const style = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  assert.doesNotMatch(formatUsageReport(none, style), /Not signed in/);

  const one = await grokReading(
    registry({ anthropic: "oauth", openai: "oauth", synthetic: "api_key" }).ctx,
  );
  assert.deepEqual(names(one), ["Claude", "ChatGPT", "Synthetic"]);
  assert.deepEqual(one.absent, ["Grok"]);
  assert.match(formatUsageReport(one), /\n\nNot signed in: Grok$/);
  assert.match(formatUsageReport(one, style), /\n\n<dim>Not signed in: Grok<\/dim>$/);

  const three = await grokReading(registry({ xai: "oauth" }).ctx);
  assert.deepEqual(names(three), ["Grok"]);
  assert.deepEqual(three.absent, ["Claude", "ChatGPT", "Synthetic"]);
  const text = formatUsageReport(three);
  assert.equal(text.match(/Not signed in/g)?.length, 1);
  assert.doesNotMatch(text, /not connected/);
});

test("the host frame lists absent providers in their own section", () => {
  const at = new Date("2026-10-17T00:00:00.000Z");
  const report: ProviderUsageReport = {
    observedAt: at,
    providers: [{ ok: true, usage: normalizeGrokUsage(billing()) }],
    absent: ["Claude", "Synthetic"],
  };
  const frame = usageReportFrame("session-xai", report, at);
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.deepEqual(
    frame.sections.map((section) => [section.title, section.rows.map((row) => row.label)]),
    [
      ["Grok", ["Weekly"]],
      ["Not signed in", ["Claude", "Synthetic"]],
    ],
  );
  assert.deepEqual(
    frame.usage?.providers.map((provider) => provider.name),
    ["Grok"],
  );
  assert.ok(hasUsageWindows(report));

  const allPresent = usageReportFrame("session-xai", { ...report, absent: [] }, at);
  assert.deepEqual(
    allPresent.sections.map((section) => section.title),
    ["Grok"],
  );
  const onlyAbsent: ProviderUsageReport = { observedAt: at, providers: [], absent: ["Grok"] };
  assert.equal(hasUsageWindows(onlyAbsent), false);
  const absentFrame = usageReportFrame("session-xai", onlyAbsent, at);
  assert.ok(Value.Check(ReportFrameSchema, absentFrame));
  assert.deepEqual(absentFrame.sections, [
    { title: "Not signed in", rows: [{ label: "Grok", value: "not signed in" }] },
  ]);
});
