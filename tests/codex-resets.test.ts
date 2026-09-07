import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexResetError,
  createCodexResetClient,
  runCodexResetFlow,
  type CodexResetClient,
} from "../.pi/extensions/lib/codex-resets.ts";
import { formatProviderUsage, normalizeCodexUsage } from "../.pi/extensions/provider-usage.ts";
import { createUsageCache } from "../.pi/extensions/lib/usage-cache.ts";

test("usage reports saved resets separately from purchased credits", () => {
  for (const count of [0, 1, 4]) {
    const report = formatProviderUsage(
      normalizeCodexUsage({
        credits: { balance: "12" },
        rate_limit_reset_credits: { available_count: count },
      }),
    );
    assert.match(report, new RegExp(`12 credits · ${count} saved reset`));
  }
  for (const count of [undefined, null, "2", -1, 0.5, Infinity]) {
    assert.doesNotMatch(
      formatProviderUsage(
        normalizeCodexUsage({
          rate_limit_reset_credits: { available_count: count },
        }),
      ),
      /saved reset/,
    );
  }
});

test("official reset GET/POST contract preserves auth, credit choice and idempotency", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createCodexResetClient("test-token", "test-account", async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(
      init?.method === "POST"
        ? { code: "reset", windows_reset: 2 }
        : {
            available_count: 9,
            credits: [
              { id: "later", status: "available", expires_at: "2099-02-01T00:00:00Z" },
              { id: "expired", status: "available", expires_at: "2000-01-01T00:00:00Z" },
              { id: "spent", status: "redeemed", expires_at: null },
              { id: "unknown", expires_at: null },
              { id: "no-expiry", status: "available", expires_at: null },
              { id: "first", status: "available", expires_at: "2099-01-01T00:00:00Z" },
            ],
          },
    );
  });
  assert.deepEqual(
    (await client.list()).map((credit) => credit.id),
    ["first", "later", "no-expiry"],
  );
  assert.equal(await client.consume("first", "request-id"), "reset");
  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
  assert.equal(calls[1]?.url, `${calls[0]?.url}/consume`);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    credit_id: "first",
    redeem_request_id: "request-id",
  });
  const headers = new Headers(calls[1]?.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("ChatGPT-Account-ID"), "test-account");
  assert.equal(calls[1]?.init?.redirect, "error");
  assert.ok(calls[1]?.init?.signal);
});

test("transport failures are sanitized and missing result codes never imply success", async () => {
  for (const response of [
    Response.json({}),
    new Response("private upstream body", { status: 403 }),
    new Response("not JSON"),
  ]) {
    const client = createCodexResetClient("secret", "account", async () => response);
    await assert.rejects(client.consume("credit", "request"), (error: Error) => {
      assert.ok(error instanceof CodexResetError);
      assert.doesNotMatch(error.message, /secret|private upstream|not JSON/);
      return true;
    });
  }
});

function flowFixture(accountId: string, code = "reset") {
  const consumed: string[] = [];
  let refreshed = 0;
  let current = true;
  const client: CodexResetClient = {
    accountId,
    list: async () => [{ id: "credit", expiresAt: "2099-01-01" }],
    consume: async (_credit, requestId) => {
      consumed.push(requestId);
      return code;
    },
  };
  const options = {
    client,
    select: async (_title: string, choices: string[]): Promise<string | undefined> => choices[1],
    isCurrent: () => current,
    refresh: async () => {
      refreshed++;
    },
  };
  return {
    options,
    consumed,
    refreshed: () => refreshed,
    invalidate: () => {
      current = false;
    },
  };
}

test("selection and confirmation both default to cancel; cancellation and stale contexts cannot consume", async () => {
  for (const stage of [0, 1]) {
    const fixture = flowFixture(`cancel-${stage}`);
    let calls = 0;
    fixture.options.select = async (_title, choices) => {
      assert.equal(choices[0], "Cancel");
      return choices[calls++ === stage ? 0 : 1];
    };
    assert.equal(await runCodexResetFlow(fixture.options), undefined);
    assert.equal(fixture.consumed.length, 0);
    assert.equal(fixture.refreshed(), 0);
  }
  const fixture = flowFixture("stale");
  fixture.options.select = async (_title, choices) => {
    fixture.invalidate();
    return choices[1];
  };
  await runCodexResetFlow(fixture.options);
  assert.equal(fixture.consumed.length, 0);
});

test("business outcomes refresh usage and never overclaim a reset", async () => {
  for (const [code, message] of [
    ["reset", /reset applied/],
    ["already_redeemed", /already redeemed/],
    ["nothing_to_reset", /no reset was spent/],
    ["no_credit", /No saved/],
    ["future_code", /Unknown reset outcome/],
  ] as const) {
    const fixture = flowFixture(code, code);
    assert.match((await runCodexResetFlow(fixture.options))!, message);
    assert.equal(fixture.consumed.length, 1);
    assert.equal(fixture.refreshed(), 1);
  }
});

test("ambiguous failures refresh usage and explicit retry reuses the idempotency key", async () => {
  const fixture = flowFixture("retry");
  const consume = fixture.options.client.consume;
  fixture.options.client.consume = async (id, requestId) => {
    await consume(id, requestId);
    throw new CodexResetError("Reset outcome unknown.");
  };
  assert.match((await runCodexResetFlow(fixture.options))!, /unknown/);
  assert.equal(fixture.refreshed(), 1);
  fixture.options.client.consume = consume;
  await runCodexResetFlow(fixture.options);
  assert.equal(fixture.consumed[0], fixture.consumed[1]);
});

test("concurrent reset dialogs cannot spend twice", async () => {
  const fixture = flowFixture("concurrent");
  const gate = Promise.withResolvers<string | undefined>();
  fixture.options.select = () => gate.promise;
  const first = runCodexResetFlow(fixture.options);
  assert.match((await runCodexResetFlow(fixture.options))!, /already in progress/);
  gate.resolve(undefined);
  await first;
  assert.equal(fixture.consumed.length, 0);
});

test("a stalled post-reset read times out and releases the account guard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = flowFixture("stalled-refresh");
  const started = Promise.withResolvers<void>();
  fixture.options.refresh = () => {
    started.resolve();
    return new Promise<void>(() => {});
  };
  const result = runCodexResetFlow(fixture.options);
  await started.promise;
  t.mock.timers.tick(10_000);
  assert.match((await result)!, /Codex reset applied.*Usage refresh failed/);
  fixture.options.select = async () => undefined;
  assert.equal(await runCodexResetFlow(fixture.options), undefined);
  assert.equal(fixture.consumed.length, 1);
});

test("post-reset refresh waits for older reads and bypasses the normal cache interval", async () => {
  const cache = createUsageCache();
  const policy = { minIntervalMs: 60_000, maxStaleMs: 60_000 };
  const gate = Promise.withResolvers<number>();
  const old = cache.request("account", () => gate.promise, policy);
  const fresh = cache.request("account", async () => 2, policy, true);
  gate.resolve(1);
  assert.equal((await old).payload, 1);
  assert.equal((await fresh).payload, 2);
  assert.equal((await cache.request("account", async () => 3, policy)).payload, 2);
});
