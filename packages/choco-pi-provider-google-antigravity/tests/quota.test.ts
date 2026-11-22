import assert from "node:assert/strict";
import test from "node:test";
import { planLabelFor, readQuotaSummary, readTier } from "../src/client/quota.ts";
import { AntigravityError } from "../src/errors.ts";
import { fakeFetch, fixture, json } from "./helpers.ts";

const ENDPOINTS = ["https://cloudcode.test"];

test("the captured quota summary parses into two groups of weekly and 5h buckets", async () => {
  const body = await fixture("quota-summary.json");
  const fake = fakeFetch(() => json(200, body));
  const summary = await readQuotaSummary({
    token: "fake",
    projectId: "aicode-consumers",
    fetch: fake.fetch,
    endpoints: ENDPOINTS,
  });
  assert.equal(fake.calls[0]?.url, "https://cloudcode.test/v1internal:retrieveUserQuotaSummary");
  assert.equal(fake.calls[0]?.body, '{"project":"aicode-consumers"}');
  assert.equal(summary.kind, "summary");
  assert.ok(summary.kind === "summary");
  assert.deepEqual(
    summary.groups.map((group) => [
      group.displayName,
      group.buckets.map((bucket) => [
        bucket.bucketId,
        bucket.window,
        bucket.remainingFraction,
        bucket.resetTime,
      ]),
    ]),
    [
      [
        "Gemini Models",
        [
          ["gemini-weekly", "weekly", 1, "2026-11-28T15:06:23Z"],
          ["gemini-5h", "5h", 1, "2026-11-21T20:06:23Z"],
        ],
      ],
      [
        "Claude and GPT models",
        [
          ["3p-weekly", "weekly", 1, "2026-11-28T15:06:23Z"],
          ["3p-5h", "5h", 1, "2026-11-21T20:06:23Z"],
        ],
      ],
    ],
  );
  assert.match(summary.description ?? "", /weekly limit and a 5-hour limit/u);
});

test("403 SUBSCRIPTION_REQUIRED is a typed no-quota result; other failures throw", async () => {
  const noQuota = fakeFetch(() =>
    json(
      403,
      '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Subscription required","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SUBSCRIPTION_REQUIRED"}]}}',
    ),
  );
  const result = await readQuotaSummary({
    token: "fake",
    projectId: "p",
    fetch: noQuota.fetch,
    endpoints: ENDPOINTS,
  });
  assert.equal(result.kind, "no_quota_for_tier");
  const denied = fakeFetch(() =>
    json(401, '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"bad"}}'),
  );
  await assert.rejects(
    readQuotaSummary({ token: "fake", projectId: "p", fetch: denied.fetch, endpoints: ENDPOINTS }),
    (error) => error instanceof AntigravityError && error.kind === "auth",
  );
});

test("readTier prefers the paid tier and reports AI credits", async () => {
  const body = await fixture("load-code-assist.json");
  const fake = fakeFetch(() => json(200, body));
  assert.deepEqual(await readTier({ token: "fake", fetch: fake.fetch, endpoints: ENDPOINTS }), {
    planLabel: "Google AI Ultra (5x)",
    tierId: "free-tier",
    paidTierId: "g1-ultra-lite-tier",
    credits: [
      { creditType: "GOOGLE_ONE_AI", creditAmount: undefined, minimumCreditAmountForUsage: 50 },
    ],
  });
});

test("planLabelFor names the Ultra plan size by tier id and leaves other tiers alone", () => {
  assert.equal(planLabelFor("Google AI Ultra", "g1-ultra-lite-tier"), "Google AI Ultra (5x)");
  assert.equal(planLabelFor("Google AI Ultra", "g1-ultra-tier"), "Google AI Ultra (20x)");
  assert.equal(planLabelFor("Google AI Pro", "g1-pro-tier"), "Google AI Pro");
  assert.equal(planLabelFor("Google AI Ultra", "g1-ultra-business-tier"), "Google AI Ultra");
  assert.equal(planLabelFor("Antigravity", "free-tier"), "Antigravity");
  assert.equal(planLabelFor("Antigravity", undefined), "Antigravity");
});

test("readTier labels a 20x Ultra account from its tier id", async () => {
  const body = (await fixture("load-code-assist.json")).replace(
    '"g1-ultra-lite-tier"',
    '"g1-ultra-tier"',
  );
  const fake = fakeFetch(() => json(200, body));
  const tier = await readTier({ token: "fake", fetch: fake.fetch, endpoints: ENDPOINTS });
  assert.equal(tier.planLabel, "Google AI Ultra (20x)");
  assert.equal(tier.paidTierId, "g1-ultra-tier");
});
