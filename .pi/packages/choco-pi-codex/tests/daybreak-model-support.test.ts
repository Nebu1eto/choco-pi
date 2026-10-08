import assert from "node:assert/strict";
import test from "node:test";
import {
  daybreakAccount,
  invalidateCodexDaybreakEntitlement,
  DAYBREAK_ENTITLEMENT_TTL_MS,
  DAYBREAK_FAILURE_TTL_MS,
  configureCodexDaybreakEntitlementForTest,
  lookupCodexDaybreakEntitlement,
  hasCodexDaybreakEntitlementEntry,
} from "../src/providers/openai-codex/daybreak-entitlement.ts";
import {
  configureCodexDaybreakModelSupportForTest,
  lookupCodexDaybreakModelSupport,
} from "../src/providers/openai-codex/daybreak-model-support.ts";

function credentials(nonce = "a", accountId = "models-account") {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      nonce,
    }),
  ).toString("base64url");
  return { apiKey: `e30.${payload}.signature`, headers: undefined, modelHeaders: undefined };
}
const backend = "https://chatgpt.com/backend-api/codex";
function accountFor(auth = credentials()) {
  const account = daybreakAccount(auth.apiKey, backend);
  assert.ok(account);
  return account;
}
function catalog() {
  return {
    models: [
      {
        slug: "blue",
        available_access_programs: { cyber: ["standard", "daybreak_blue"] },
        unrelated: true,
      },
      { slug: "red", available_access_programs: { cyber: ["daybreak_red"] } },
      { slug: "standard", available_access_programs: { cyber: ["standard"] } },
      { slug: "no-programs" },
      { slug: "no-cyber", available_access_programs: { bio: ["other"] } },
      { slug: 42 },
      null,
      "not a model",
      { slug: "malformed", available_access_programs: { cyber: ["daybreak_blue", 42] } },
    ],
    extra: "tolerated",
  };
}
function cleanup() {
  configureCodexDaybreakModelSupportForTest(undefined);
  configureCodexDaybreakEntitlementForTest(undefined);
}

test("catalog schema tolerates extra fields, skips malformed entries, and checks exact program", async (t) => {
  t.after(cleanup);
  configureCodexDaybreakModelSupportForTest({
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("chatgpt-account-id"), "models-account");
      assert.equal(headers.get("authorization"), `Bearer ${credentials().apiKey}`);
      assert.ok(headers.get("originator"));
      assert.equal(headers.get("accept"), "application/json");
      return Response.json(catalog());
    },
  });
  const account = accountFor();
  const lookup = (id: string, program: "daybreak_blue" | "daybreak_red" = "daybreak_blue") =>
    lookupCodexDaybreakModelSupport(account, credentials(), id, program);
  assert.equal(await lookup("blue"), "supported");
  assert.equal(await lookup("blue", "daybreak_red"), "unsupported");
  assert.equal(await lookup("red", "daybreak_red"), "supported");
  for (const id of ["standard", "absent", "malformed", "no-programs", "no-cyber"])
    assert.equal(await lookup(id), "unsupported", id);
});

test("whole-catalog single flight, success/failure TTL, token change, account isolation and auth invalidation", async (t) => {
  t.after(cleanup);
  let now = 0;
  let calls = 0;
  let status = 200;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  configureCodexDaybreakModelSupportForTest({
    now: () => now,
    fetch: async () => {
      calls++;
      await gate;
      return status === 200 ? Response.json(catalog()) : new Response("failed", { status });
    },
  });
  const auth = credentials();
  const account = accountFor(auth);
  const lookup = (id = "blue", next = auth) =>
    lookupCodexDaybreakModelSupport(account, next, id, "daybreak_blue");
  const a = lookup();
  const b = lookup("absent");
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([a, b]), ["supported", "unsupported"]);
  await lookup("standard");
  assert.equal(calls, 1);
  now += DAYBREAK_ENTITLEMENT_TTL_MS;
  await lookup();
  assert.equal(calls, 2);
  await lookup("blue", credentials("rotated"));
  assert.equal(calls, 3);
  const other = credentials("a", "other-account");
  await lookupCodexDaybreakModelSupport(accountFor(other), other, "blue", "daybreak_blue");
  assert.equal(calls, 4);

  invalidateCodexDaybreakEntitlement(auth.apiKey, backend);
  status = 500;
  assert.equal(await lookup(), "lookup-failed");
  await lookup();
  assert.equal(calls, 5);
  now += DAYBREAK_FAILURE_TTL_MS;
  await lookup();
  assert.equal(calls, 6);
  for (const denied of [401, 403]) {
    status = denied;
    invalidateCodexDaybreakEntitlement(auth.apiKey, backend);
    const before: number = calls;
    assert.equal(await lookup(), "lookup-failed");
    assert.equal(await lookup(), "lookup-failed");
    assert.equal(calls, before + 2, "auth failures must not remain cached");
  }
});

test("catalog auth rejection invalidates the granted entitlement too", async (t) => {
  t.after(cleanup);
  const auth = credentials();
  const account = accountFor(auth);
  configureCodexDaybreakEntitlementForTest({
    fetch: async () =>
      Response.json({
        programs: [{ program: "cyber", state: "active", grants: [{ level: "tac1" }] }],
      }),
  });
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => new Response("denied", { status: 401 }),
  });
  assert.equal((await lookupCodexDaybreakEntitlement(account, auth, false)).entitlement, "blue");
  assert.equal(hasCodexDaybreakEntitlementEntry(account), true);
  assert.equal(
    await lookupCodexDaybreakModelSupport(account, auth, "blue", "daybreak_blue"),
    "lookup-failed",
  );
  assert.equal(hasCodexDaybreakEntitlementEntry(account), false);
});

test("malformed catalog and timeout fail closed; invalidated pending flights cannot refill", async (t) => {
  t.after(cleanup);
  const auth = credentials();
  const account = accountFor(auth);
  const lookup = () => lookupCodexDaybreakModelSupport(account, auth, "blue", "daybreak_blue");
  for (const payload of [{}, { models: "wrong" }, null]) {
    configureCodexDaybreakModelSupportForTest({ fetch: async () => Response.json(payload) });
    assert.equal(await lookup(), "lookup-failed");
  }
  configureCodexDaybreakModelSupportForTest({ fetch: async () => new Response("{bad") });
  assert.equal(await lookup(), "lookup-failed");
  configureCodexDaybreakModelSupportForTest({
    timeoutMs: 10,
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
  });
  assert.equal(await lookup(), "lookup-failed");

  let release: (value: Response) => void = () => undefined;
  const gate = new Promise<Response>((done) => {
    release = done;
  });
  let calls = 0;
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => {
      calls++;
      return calls === 1 ? gate : Response.json({ models: [] });
    },
  });
  const stale = lookup();
  invalidateCodexDaybreakEntitlement(auth.apiKey, backend);
  assert.equal(await lookup(), "unsupported");
  release(Response.json(catalog()));
  assert.equal(await stale, "supported");
  assert.equal(await lookup(), "unsupported");
  assert.equal(calls, 2);
});
