import assert from "node:assert/strict";
import test from "node:test";
import { discoverAntigravityProject } from "../src/auth/project.ts";
import { AntigravityError } from "../src/errors.ts";
import { fakeFetch, fixture, json, type RecordedCall } from "./helpers.ts";

const ENDPOINT = "https://cloudcode.test";

function routes(load: string, onboard: readonly string[] = []) {
  let step = 0;
  return fakeFetch((call: RecordedCall) => {
    if (call.url.endsWith(":loadCodeAssist")) return json(200, load);
    if (call.url.endsWith(":onboardUser"))
      return json(200, onboard[Math.min(step++, onboard.length - 1)] ?? "{}");
    return json(404, "{}");
  });
}

function discover(
  fake: ReturnType<typeof fakeFetch>,
  extra: { configuredProjectId?: string; onboardMaxAttempts?: number } = {},
) {
  return discoverAntigravityProject({
    token: "fake-access",
    fetch: fake.fetch,
    endpoints: [ENDPOINT],
    onboardPollIntervalMs: 1,
    ...extra,
  });
}

test("the captured loadCodeAssist yields the shared consumer project and both tiers", async () => {
  const fake = routes(await fixture("load-code-assist.json"));
  assert.deepEqual(await discover(fake), {
    projectId: "aicode-consumers",
    tierId: "free-tier",
    tierName: "Antigravity",
    paidTierId: "g1-ultra-lite-tier",
    paidTierName: "Google AI Ultra",
  });
  assert.equal(fake.calls.length, 1);
});

test("an account without a tier is onboarded to the default tier with a bounded LRO poll", async () => {
  const fake = routes(
    '{"allowedTiers":[{"id":"standard-tier"},{"id":"free-tier","isDefault":true}]}',
    [
      '{"name":"operations/fake","done":false}',
      '{"name":"operations/fake","done":true,"response":{"cloudaicompanionProject":{"id":"fake-project-1"}}}',
    ],
  );
  const info = await discover(fake);
  assert.equal(info.projectId, "fake-project-1");
  assert.equal(info.tierId, "free-tier");
  const onboardCalls = fake.calls.filter((call) => call.url.endsWith(":onboardUser"));
  assert.equal(onboardCalls.length, 2);
  assert.equal(
    onboardCalls[0]?.body,
    '{"tierId":"free-tier","metadata":{"ideType":"ANTIGRAVITY"}}',
  );
});

test("onboarding that never completes fails after the attempt bound", async () => {
  const fake = routes('{"allowedTiers":[{"id":"free-tier","isDefault":true}]}', ['{"done":false}']);
  await assert.rejects(
    discover(fake, { onboardMaxAttempts: 3 }),
    (error) => error instanceof AntigravityError && error.kind === "server",
  );
  assert.equal(fake.calls.filter((call) => call.url.endsWith(":onboardUser")).length, 3);
});

test("UNSUPPORTED_CLIENT and GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT become unsupported_client", async () => {
  for (const code of ["UNSUPPORTED_CLIENT", "11"]) {
    const fake = routes(
      `{"ineligibleTiers":[{"reasonCode":"${code}","reasonMessage":"Not supported","tierId":"free-tier"}]}`,
    );
    await assert.rejects(
      discover(fake),
      (error) => error instanceof AntigravityError && error.kind === "unsupported_client",
    );
    assert.equal(fake.calls.length, 1);
  }
});

test("a project id is never invented", async () => {
  const tierOnly = routes('{"currentTier":{"id":"free-tier"}}');
  await assert.rejects(
    discover(tierOnly),
    (error) => error instanceof AntigravityError && error.kind === "malformed_response",
  );
  const noProject = routes('{"allowedTiers":[{"id":"free-tier","isDefault":true}]}', [
    '{"done":true,"response":{}}',
  ]);
  await assert.rejects(discover(noProject), /without a project/u);
  const configured = routes('{"currentTier":{"id":"standard-tier"}}');
  assert.equal(
    (await discover(configured, { configuredProjectId: "my-own-project" })).projectId,
    "my-own-project",
  );
  assert.equal(
    configured.calls[0]?.body,
    '{"metadata":{"ideType":"ANTIGRAVITY"},"cloudaicompanionProject":"my-own-project"}',
  );
});

test("a tier that needs the user's own project is refused without one", async () => {
  const fake = routes(
    '{"allowedTiers":[{"id":"standard-tier","isDefault":true,"userDefinedCloudaicompanionProject":true}]}',
  );
  await assert.rejects(discover(fake), /requires your own Google Cloud project/u);
  assert.equal(fake.calls.length, 1);
});
