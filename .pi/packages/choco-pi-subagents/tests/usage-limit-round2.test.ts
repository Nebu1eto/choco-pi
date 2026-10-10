/**
 * Second review round for the "On Usage Limit" manager paths: billing through
 * the real classifier, owner-policy account keys, availability-gated resumes,
 * re-parking a queued continuation, and the child's own Codex limit entry.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createUsageLimitPolicy } from "../../../extensions/lib/usage-limit.ts";
import { ResumeModelError } from "../src/agent-manager.ts";
import { closeUntil, ProviderUnavailableError } from "../src/provider-health.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  accountIdWithPolicy,
  isUsageLimitPolicy,
  latestCodexUsageLimitEntry,
  readUsageLimitPolicy,
} from "../src/usage-limit-seam.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicy,
  installPolicyObject,
  policyState,
  type FakePolicyState,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const SOL = "openai/gpt-5.6-sol";
const OPUS = "anthropic/claude-opus-4-5";
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const BILLING =
  '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}';
const background = { description: "usage limit", isBackground: true, isolated: true };

async function setup(t: TestContext): Promise<{ env: UsageLimitEnv; session: AgentSession }> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  return { env, session: await env.childSession() };
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
}

function codexModel(env: UsageLimitEnv): Model<Api> {
  const model = env.base.modelRegistry.getAll().find((entry) => entry.provider === "openai-codex");
  if (model === undefined) throw new Error("No built-in openai-codex model.");
  return model;
}

/** Closed state shared by `closeProvider` and `isClosed`, like the root policy. */
function closedFrom(state: FakePolicyState): FakePolicyState["isClosed"] {
  return (providerKey, accountId, now = Date.now()) =>
    state.closed.some(
      ([provider, account, until]) =>
        provider === providerKey && account === accountId && now < until,
    );
}

test("a billing failure through the real classifier is reported with a suggestion, never parked", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "auto-resume",
    fallbacks: { tiers: { workhorse: { primary: [OPUS, SOL] } }, lastResort: [] },
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs, completions, usageEvents } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: BILLING,
    });
    await promise;
    await flush();
    const record = manager.getRecord(id);
    assert.equal(record?.status, "error", "billing never parks, even under auto-resume");
    assert.deepEqual(record?.usageLimit, {
      provider: "anthropic",
      accountId: "default",
      kind: "billing",
      resetAt: undefined,
      suggestedModel: SOL,
      status: "reported",
    });
    assert.match(record?.error ?? "", /Usage limit: Anthropic usage limit \(billing\)/);
    assert.deepEqual(completions, ["error"]);
    assert.deepEqual(usageEvents, ["error:reported"]);
    // Closed for 30 minutes under the owner's policy and the manager's closure.
    assert.equal(policy.isClosed("anthropic", "default"), true);
    assert.equal(policy.isClosed("anthropic", "default", Date.now() + 30 * 60_000), false);
    assert.equal(
      manager.providerUnavailableMessage("anthropic", env.owner),
      `Provider anthropic unavailable (temporarily rate limited). Usage limit until ${new Date(
        Date.now() + 30 * 60_000,
      ).toISOString()}; suggested: ${SOL}.`,
    );
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("the owner policy's account keys both the spawn gate and the closure writes", async (t) => {
  const { env } = await setup(t);
  const codex = codexModel(env);
  const codexSession = await env.childSession(codex);
  let account = "acct-A";
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
    accountId: (provider) => (provider === "openai-codex" ? account : "default"),
  });
  state.isClosed = closedFrom(state);
  const installed = installPolicy(state, env.owner);
  const { manager, runs } = harness();
  const onCodex = { ...background, model: codex };
  try {
    // The root closed (openai-codex, acct-A); no child has classified anything yet.
    state.closed.push(["openai-codex", "acct-A", Date.now() + HOUR]);
    assert.throws(
      () => manager.spawn(env.pi, env.context(), "implementer", "refused", onCodex),
      (error: Error) =>
        error instanceof ProviderUnavailableError &&
        /Provider openai-codex unavailable/.test(error.message),
    );
    assert.equal(runs.length, 0);
    assert.equal(manager.isProviderAvailable("openai-codex", env.owner), false);

    // A child limit without an account in its classification closes the same key.
    state.closed.length = 0;
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", onCodex);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session: codexSession,
      aborted: false,
      steered: false,
      failure: LIMIT,
    });
    await promise;
    assert.equal(manager.getRecord(id)?.usageLimit?.accountId, "acct-A");
    assert.deepEqual(
      state.closed.map(([provider, closedAccount]) => [provider, closedAccount]),
      [["openai-codex", "acct-A"]],
    );
    assert.equal(manager.isProviderAvailable("openai-codex", env.owner), false);
    // Another account of the same owner is open.
    account = "acct-B";
    assert.equal(manager.isProviderAvailable("openai-codex", env.owner), true);
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("resume is refused while the child's provider is closed, with the reset and suggestion", async (t) => {
  const { env, session } = await setup(t);
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + HOUR },
    pick: { provider: "openai", id: "gpt-5.6-sol" },
  });
  state.isClosed = closedFrom(state);
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, resumePrompts } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "error");
    const refusal = (error: Error) =>
      error instanceof ResumeModelError &&
      /^Provider anthropic unavailable \(temporarily rate limited\)\. Usage limit until \S+; suggested: openai\/gpt-5\.6-sol\.$/.test(
        error.message,
      );
    await assert.rejects(manager.resume(id, "foreground"), refusal);
    await assert.rejects(
      manager.resume(id, "background", undefined, { isBackground: true }),
      refusal,
    );
    assert.equal(record?.status, "error", "refused before any state change");
    assert.equal(record?.resultGeneration, 1);
    assert.equal(record?.usageLimit?.status, "reported");
    assert.deepEqual(resumePrompts, []);

    // Once the owner's closures lift, the same resume dispatches.
    state.closed.length = 0;
    cleanupProviders();
    const resumed = manager.resume(id, "again");
    await flush();
    assert.deepEqual(resumePrompts, ["again"]);
    resumes[0].resolve({ text: "done" });
    assert.equal((await resumed)?.status, "completed");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

for (const ending of ["continuation", "stop"] as const) {
  test(`a queued continuation whose provider closes again re-parks on the new reset (${ending})`, async (t) => {
    const { env, session } = await setup(t);
    enableTimers(t);
    const state = policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
      corroborate: (count) => ({ ready: count >= 2 }),
    });
    const installed = installPolicy(state, env.owner);
    const { manager, runs, resumes, resumePrompts, completions, usageEvents } = harness({
      maxConcurrent: 1,
    });
    try {
      const id = manager.spawn(env.pi, env.context(), "implementer", "A", background);
      const first = manager.getRecord(id)?.promise;
      runs[0].resolve({
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: LIMIT,
      });
      await first;
      const record = manager.getRecord(id);
      assert.equal(record?.status, "waiting_for_reset");
      manager.spawn(env.pi, env.context(), "implementer", "B", {
        ...background,
        model: env.models.sol,
      });

      t.mock.timers.tick(90_000);
      await flush();
      assert.equal(record?.status, "queued", "reset confirmed; waiting for the slot");
      const owned = record?.promise;
      assert.ok(owned);

      // The same account is limited again before the slot frees.
      const until = Date.now() + HOUR;
      closeUntil({ owner: env.owner, providerKey: "anthropic", accountId: "default" }, until, {
        suggestedModel: SOL,
      });
      runs[1].resolve({ responseText: "B done", session, aborted: false, steered: false });
      await flush();
      assert.equal(record?.status, "waiting_for_reset", "re-parked, not dispatched or dropped");
      assert.equal(record?.usageLimit?.resetAt, until);
      assert.equal(record?.promise, owned, "the parked promise is kept");
      assert.deepEqual(resumePrompts, []);
      assert.deepEqual(completions, ["completed"], "only B has settled");
      assert.deepEqual(usageEvents, [
        "waiting_for_reset:waiting_for_reset",
        "queued:resumed",
        "waiting_for_reset:waiting_for_reset",
      ]);

      if (ending === "continuation") {
        t.mock.timers.tick(HOUR + 31_000);
        await flush();
        assert.equal(resumePrompts.length, 1, "continues after the new reset");
        resumes[0].resolve({ text: "finished" });
        assert.equal(await owned, "finished");
        assert.equal(record?.status, "completed");
        assert.deepEqual(completions, ["completed", "completed"]);
      } else {
        assert.equal(manager.abort(id), true);
        assert.equal(await owned, "");
        assert.equal(record?.status, "stopped");
        assert.equal(record?.usageLimit?.status, "exhausted");
        assert.deepEqual(completions, ["completed", "stopped"], "one final notification");
      }
    } finally {
      manager.dispose();
      installed.remove();
      cleanupProviders();
    }
  });
}

for (const fresh of [true, false]) {
  test(`the child's own Codex limit entry upgrades the classification (${fresh ? "fresh" : "stale"})`, async (t) => {
    const { env } = await setup(t);
    const codex = codexModel(env);
    const codexSession = await env.childSession(codex);
    enableTimers(t);
    // A writable root session: its branch gets an entry that must not be read for a child.
    const rootManager = env.freshSessionManager();
    const owner = rootManager.getSessionId();
    const state = policyState({
      preference: "auto-resume",
      classification: { kind: "quota", confidence: "inferred" },
    });
    // Like the root policy: only the structured entry confirms the limit.
    state.corroborate = (count) => ({
      ready: false,
      evidence:
        state.corroborated[count - 1]?.confidence === "structured" ? "confirmed" : "unavailable",
    });
    const installed = installPolicy(state, owner);
    const { manager, runs } = harness();
    try {
      const resetAt = Date.now() + 2 * HOUR;
      rootManager.appendCustomEntry(CODEX_USAGE_LIMIT_ENTRY, {
        resetAt: Date.now() + 9 * HOUR,
        accountId: "root-account",
        observedAt: Date.now(),
      });
      codexSession.sessionManager.appendCustomEntry(CODEX_USAGE_LIMIT_ENTRY, {
        resetAt,
        accountId: "acct-C",
        observedAt: Date.now() - (fresh ? 5_000 : 120_000),
      });
      const id = manager.spawn(
        env.pi,
        env.context({ sessionManager: rootManager }),
        "implementer",
        "task",
        { ...background, model: codex },
      );
      const promise = manager.getRecord(id)?.promise;
      runs[0].resolve({
        responseText: "",
        session: codexSession,
        aborted: false,
        steered: false,
        failure: "Codex usage limit reached (plus plan).",
      });
      await promise;
      const record = manager.getRecord(id);
      const sent = state.corroborated[0];
      if (fresh) {
        assert.equal(sent?.confidence, "structured");
        assert.equal(sent?.resetAt, resetAt);
        assert.equal(sent?.accountId, "acct-C");
        assert.equal(record?.status, "waiting_for_reset");
        assert.equal(record?.usageLimit?.resetAt, resetAt);
        assert.equal(record?.usageLimit?.accountId, "acct-C");
        assert.deepEqual(state.closed, [["openai-codex", "acct-C", resetAt]]);
      } else {
        assert.equal(sent?.confidence, "inferred", "a stale entry describes another failure");
        assert.equal(sent?.accountId, undefined);
        assert.equal(record?.status, "error");
        assert.equal(record?.usageLimit, undefined, "uncorroborated inferred limit is transient");
      }
    } finally {
      manager.dispose();
      installed.remove();
      cleanupProviders();
    }
  });
}

test("seam: Codex entries are validated structurally and accountId is optional", () => {
  const now = 10_000_000_000_000;
  interface RawCodexEntry {
    resetAt?: number;
    accountId?: string;
    observedAt: number | string;
  }
  const custom = (data: RawCodexEntry) => ({
    type: "custom",
    customType: CODEX_USAGE_LIMIT_ENTRY,
    data,
  });
  assert.deepEqual(
    latestCodexUsageLimitEntry(
      [
        custom({ resetAt: now + 1, accountId: "old", observedAt: now - 1_000 }),
        custom({ resetAt: now + 2, observedAt: now }),
        { type: "message" },
        custom({ resetAt: 1_700, observedAt: now }),
        custom({ observedAt: "now" }),
      ],
      now,
    ),
    { resetAt: now + 2, observedAt: now },
    "latest valid entry; a reset before its observation (seconds epoch) is rejected",
  );
  assert.equal(latestCodexUsageLimitEntry([custom({ observedAt: now - 61_000 })], now), undefined);
  assert.equal(
    latestCodexUsageLimitEntry(
      [{ type: "custom", customType: "other", data: { observedAt: now } }],
      now,
    ),
    undefined,
  );

  const base = {
    owner: "o",
    generation: 1,
    preference: async () => "none",
    classify: () => undefined,
    corroborate: async () => undefined,
    pickFallback: () => undefined,
    closeProvider: () => undefined,
    isClosed: () => false,
  };
  assert.equal(isUsageLimitPolicy(base), true, "absent accountId is accepted");
  assert.equal(isUsageLimitPolicy({ ...base, accountId: "acct" }), false);
  const withAccount = { ...base, accountId: (provider: string) => `${provider}-acct` };
  assert.ok(isUsageLimitPolicy(withAccount));
  assert.equal(accountIdWithPolicy(withAccount, "openai-codex"), "openai-codex-acct");
  const throwing = {
    ...base,
    accountId: (): string => {
      throw new Error("x");
    },
  };
  assert.ok(isUsageLimitPolicy(throwing));
  assert.equal(accountIdWithPolicy(throwing, "openai-codex"), undefined);
  assert.equal(readUsageLimitPolicy(undefined), undefined);
});
