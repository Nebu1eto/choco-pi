import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatProviderUsage,
  formatUsageReport,
  GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS,
  googleAntigravityUsage,
  normalizeGoogleAntigravityUsage,
  providerUsageSnapshot,
  readProviderUsages,
} from "../profile/extensions/provider-usage.ts";
import { providerDisplayName } from "../profile/extensions/lib/stats/names.ts";
import { createUsageCache } from "../profile/extensions/lib/usage-cache.ts";
import {
  reinterpretHostValue,
  type RuntimeValue,
} from "../profile/extensions/lib/runtime-values.ts";
import { createAntigravityOAuth } from "../packages/choco-pi-provider-google-antigravity/src/auth/oauth.ts";

const FIXTURE = new URL(
  "../packages/choco-pi-provider-google-antigravity/tests/fixtures/quota-summary.json",
  import.meta.url,
);
const TOKEN = "fake-antigravity-access-token";
const PROJECT = "fake-project-4711";
const API_KEY = JSON.stringify({ token: TOKEN, project_id: PROJECT });
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
const TIER_PATH = "/v1internal:loadCodeAssist";

async function fixture(): Promise<RuntimeValue> {
  return JSON.parse(await readFile(FIXTURE, "utf8"));
}

/** An obviously fake raw Gemini API key, as Pi's inherited google API-key auth resolves one. */
const GEMINI_KEY = "AIzaFAKE-gemini-api-key-for-tests";

/**
 * A host whose `google` credential is `apiKey`. `type` is what the registry reports for it:
 * `oauth` for a Google Antigravity sign-in, `api_key` for a stored API key or GEMINI_API_KEY,
 * `unknown` when the host cannot tell (no google model listed).
 */
function context(
  apiKey: string | undefined,
  type: "oauth" | "api_key" | "unknown" = "oauth",
  keyReads: string[] = [],
): ExtensionContext {
  return reinterpretHostValue<ExtensionContext>({
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({
        configured: provider === "google" && apiKey !== undefined,
      }),
      getApiKeyForProvider: async (provider: string) => {
        keyReads.push(provider);
        return provider === "google" ? apiKey : undefined;
      },
      getAll: () => (type === "unknown" ? [] : [{ provider: "google", id: "gemini-3.8-flash" }]),
      isUsingOAuth: (model: { provider: string }) =>
        model.provider === "google" && type === "oauth",
    },
  });
}

type Call = { url: string; body: string; authorization: string | null };

function mockFetch(t: TestContext, respond: (url: string) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({
        url,
        body: String(init?.body ?? ""),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return respond(url);
    },
  );
  return calls;
}

const json = (body: RuntimeValue, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const TIER = {
  currentTier: { id: "free-tier", name: "Antigravity Free" },
  paidTier: {
    id: "g1-pro-tier",
    name: "Google AI Pro",
    availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "1000" }],
  },
};

test("google is absent without a credential and makes no request", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no request expected")));
  const cache = createUsageCache();
  assert.equal(await googleAntigravityUsage(context(undefined), cache), undefined);
  const report = await readProviderUsages(context(undefined), { cache });
  assert.deepEqual(report.absent, ["Claude", "ChatGPT", "Google", "Grok", "Synthetic"]);
  assert.deepEqual(calls, []);
});

test("a Gemini API key on google is not signed in: no key read, no request", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no request expected")));
  const cache = createUsageCache();
  // A stored API-key credential or GEMINI_API_KEY: the host reports API-key auth.
  const keyReads: string[] = [];
  assert.equal(
    await googleAntigravityUsage(context(GEMINI_KEY, "api_key", keyReads), cache),
    undefined,
  );
  assert.deepEqual(keyReads, [], "the raw key is never resolved");
  const report = await readProviderUsages(context(GEMINI_KEY, "api_key"), { cache });
  assert.deepEqual(report.providers, []);
  assert.deepEqual(report.absent, ["Claude", "ChatGPT", "Google", "Grok", "Synthetic"]);
  assert.equal(formatUsageReport(report), "");
  // A host that cannot report the type: the resolved raw key is still not a sign-in.
  assert.equal(await googleAntigravityUsage(context(GEMINI_KEY, "unknown"), cache), undefined);
  assert.doesNotMatch(formatUsageReport(report), /AIza/u);
  assert.deepEqual(calls, []);
});

test("the captured quota summary becomes four used-share windows with resets", async () => {
  const usage = normalizeGoogleAntigravityUsage(await fixture());
  assert.equal(usage.name, "Google");
  assert.deepEqual(
    usage.windows.map((window) => [
      window.label,
      window.percent,
      window.qualifier,
      window.eventAt?.toISOString(),
      window.windowSeconds,
      window.scope,
    ]),
    [
      ["Gemini Models 5-hours", 0, "used", "2026-11-21T20:06:23.000Z", 18_000, "Gemini Models"],
      ["Gemini Models Weekly", 0, "used", "2026-11-28T15:06:23.000Z", 604_800, "Gemini Models"],
      [
        "Claude and GPT models 5-hours",
        0,
        "used",
        "2026-11-21T20:06:23.000Z",
        18_000,
        "Claude and GPT models",
      ],
      [
        "Claude and GPT models Weekly",
        0,
        "used",
        "2026-11-28T15:06:23.000Z",
        604_800,
        "Claude and GPT models",
      ],
    ],
  );
  // A full bucket is fresh capacity, never "exhausted".
  const now = Date.parse("2026-11-21T15:06:23Z");
  const text = formatProviderUsage(usage, undefined, now);
  assert.match(text, /^Google\n {2}Gemini Models 5-hours\n.* 0% used\n {2}resets in /);
});

test("Google usage places Gemini groups before other models and 5h before weekly regardless of API order", () => {
  const usage = normalizeGoogleAntigravityUsage({
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { window: "weekly", remainingFraction: 0.75, resetTime: "2026-11-28T15:06:23Z" },
          { window: "5h", remainingFraction: 0.5, resetTime: "2026-11-21T20:06:23Z" },
        ],
      },
      {
        displayName: "Gemini Models",
        buckets: [
          { window: "weekly", remainingFraction: 0.25, resetTime: "2026-11-28T15:06:23Z" },
          { window: "5h", remainingFraction: 0, resetTime: "2026-11-21T20:06:23Z" },
        ],
      },
    ],
  });
  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.percent]),
    [
      ["Gemini Models 5-hours", 100],
      ["Gemini Models Weekly", 75],
      ["Claude and GPT models 5-hours", 50],
      ["Claude and GPT models Weekly", 25],
    ],
  );
});

test("remaining fractions convert to used shares; disabled and amount-only buckets are skipped", () => {
  const usage = normalizeGoogleAntigravityUsage({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { window: "5h", remainingFraction: 0.25, resetTime: "2026-11-21T20:06:23Z" },
          { window: "weekly", remainingFraction: 0, resetTime: "2026-11-28T15:06:23Z" },
          { window: "weekly", remainingFraction: 0.5, disabled: true },
          { window: "daily", remainingAmount: "12" },
        ],
      },
      "not a group",
    ],
  });
  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.percent, window.windowSeconds]),
    [
      ["Gemini Models 5-hours", 75, 18_000],
      ["Gemini Models Weekly", 100, 604_800],
    ],
  );
  assert.deepEqual(normalizeGoogleAntigravityUsage(undefined).windows, []);
});

test("a live read sends the parsed token and project, adds plan and credits, and leaks neither", async (t) => {
  const quota = await fixture();
  const calls = mockFetch(t, (url) => {
    if (url.endsWith(QUOTA_PATH)) return json(quota);
    if (url.endsWith(TIER_PATH)) return json(TIER);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const usage = await googleAntigravityUsage(context(API_KEY), createUsageCache());
  assert.ok(usage);
  assert.equal(usage.plan, "Google AI Pro");
  assert.equal(usage.status, "1000 AI credits");
  assert.equal(usage.cached, undefined);
  assert.equal(usage.windows.length, 4);
  const quotaCall = calls.find((call) => call.url.endsWith(QUOTA_PATH));
  assert.equal(quotaCall?.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(quotaCall?.body ?? "{}"), { project: PROJECT });
  const text = formatProviderUsage(usage);
  assert.match(text, /^Google — Google AI Pro · 1000 AI credits\n/);
  assert.doesNotMatch(JSON.stringify(usage), new RegExp(`${TOKEN}|${PROJECT}`));
});

test("a tier without a quota summary is a status-only row", async (t) => {
  mockFetch(t, (url) => {
    if (url.endsWith(QUOTA_PATH)) {
      return json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "SUBSCRIPTION_REQUIRED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SUBSCRIPTION_REQUIRED",
              },
            ],
          },
        },
        403,
      );
    }
    if (url.endsWith(TIER_PATH)) return json({ currentTier: { id: "free-tier", name: "Free" } });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const usage = await googleAntigravityUsage(context(API_KEY), createUsageCache());
  assert.deepEqual(usage, {
    name: "Google",
    plan: "Free",
    status: GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS,
    windows: [],
  });
  assert.equal(formatProviderUsage(usage), `Google — Free · ${GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS}`);
});

test("a failed read is a failure reading; a failed plan read only drops the plan", async (t) => {
  mockFetch(t, () => json({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500));
  const report = await readProviderUsages(context(API_KEY), { cache: createUsageCache() });
  const reading = report.providers.find(
    (entry) => (entry.ok ? entry.usage.name : entry.name) === "Google",
  );
  assert.deepEqual(reading, { ok: false, name: "Google", error: "HTTP 500" });
  assert.doesNotMatch(formatUsageReport(report), new RegExp(`${TOKEN}|${PROJECT}`));

  const bad = await readProviderUsages(context("not-json"), { cache: createUsageCache() });
  assert.deepEqual(
    bad.providers.find((entry) => !entry.ok && entry.name === "Google"),
    {
      ok: false,
      name: "Google",
      error:
        "Google Antigravity credential is unusable; run /login google and choose Google Antigravity",
    },
  );
});

test("a stored reading is served with a cached note when the live read fails", async (t) => {
  const quota = await fixture();
  let failing = false;
  mockFetch(t, (url) => {
    if (failing) return json({ error: { code: 503, status: "UNAVAILABLE", message: "x" } }, 503);
    if (url.endsWith(QUOTA_PATH)) return json(quota);
    return Promise.reject(new Error("tier unavailable"));
  });
  let now = Date.parse("2026-11-21T15:00:00Z");
  const cache = createUsageCache({ now: () => now });
  const live = await googleAntigravityUsage(context(API_KEY), cache);
  assert.equal(live?.cached, undefined);
  assert.equal(live?.plan, undefined, "a failed plan read only drops the plan");
  failing = true;
  now += 61_000;
  const served = await googleAntigravityUsage(context(API_KEY), cache);
  assert.ok(served?.cached);
  assert.equal(served.cached.at.getTime(), Date.parse("2026-11-21T15:00:00Z"));
  assert.equal(served.cached.reason, "HTTP 503");
  assert.equal(served.windows.length, 4);
});

test("switching accounts inside the cache gate never shows the previous account's quota or plan", async (t) => {
  // Two consumer accounts share the "aicode-consumers" project; only the credential differs.
  const oauth = createAntigravityOAuth({ env: {} });
  const apiKeyFor = (account: string) =>
    oauth.getApiKey({
      refresh: `fake-refresh-${account}`,
      access: `fake-access-${account}`,
      expires: 0,
      project_id: "aicode-consumers",
    });
  const quotaFor = (remainingFraction: number) => ({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ window: "5h", remainingFraction, resetTime: "2026-11-21T20:06:23Z" }],
      },
    ],
  });
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, body: String(init?.body ?? ""), authorization });
      const account = authorization === "Bearer fake-access-a" ? "a" : "b";
      if (url.endsWith(QUOTA_PATH)) return json(quotaFor(account === "a" ? 0.75 : 0.1));
      if (url.endsWith(TIER_PATH)) {
        return json({
          currentTier: { id: "free-tier", name: account === "a" ? "Plan A" : "Plan B" },
        });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    },
  );
  const now = Date.parse("2026-11-21T15:00:00Z");
  const cache = createUsageCache({ now: () => now });
  const first = await googleAntigravityUsage(context(apiKeyFor("a")), cache);
  assert.equal(first?.plan, "Plan A");
  assert.equal(first?.windows[0]?.percent, 25);
  const second = await googleAntigravityUsage(context(apiKeyFor("b")), cache);
  assert.equal(second?.plan, "Plan B", "the plan belongs to the signed-in account");
  assert.equal(second?.windows[0]?.percent, 90, "the quota belongs to the signed-in account");
  assert.ok(calls.some((call) => call.authorization === "Bearer fake-access-b"));
  // Neither the refresh token nor the access token shapes a report.
  assert.doesNotMatch(JSON.stringify(second), /fake-refresh|fake-access/u);
});

test("google has no quota snapshot for the usage-limit policy", async (t) => {
  const calls = mockFetch(t, () => Promise.reject(new Error("no request expected")));
  assert.equal(await providerUsageSnapshot(context(API_KEY), "google"), undefined);
  assert.deepEqual(calls, []);
});

test("the statistics tab names the provider", () => {
  assert.equal(providerDisplayName("google"), "Google");
});
