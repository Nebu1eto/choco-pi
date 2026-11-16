/**
 * A child's Fable-only usage limit (Anthropic's Fable weekly window, which
 * covers the Claude Fable and Claude Mythos series) closes only those models:
 * Opus and the provider's other models keep spawning, and refusals name the
 * refused model and what the limit covers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { createUsageLimitPolicy } from "../../../profile/extensions/lib/usage-limit.ts";
import type { ProviderUsageSnapshot } from "../../../profile/extensions/provider-usage.ts";
import {
  clearUsageLimitClosure,
  closeUntil,
  ProviderUnavailableError,
  providerKeyFromUnavailableMessage,
} from "../src/provider-health.ts";
import { journalClassificationOf, usageClassificationOf } from "../src/revival-journal.ts";
import type { UsageLimitPolicy } from "../src/usage-limit-seam.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicy,
  installPolicyObject,
  policyState,
} from "./usage-limit-fixture.ts";

const DAY = 86_400_000;
const SOL = "openai/gpt-5.6-sol";
const ANTHROPIC_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_1"}';
const FABLE_SCOPE = { name: "fable", models: ["claude-fable", "claude-mythos"] };
const background = { description: "fable scope", isBackground: true, isolated: true };

function fableOnlyExhausted(): ProviderUsageSnapshot {
  return {
    observedAt: Date.now(),
    windows: [
      { label: "5h", percent: 30, qualifier: "used" },
      {
        label: "Fable 7d",
        percent: 100,
        qualifier: "used",
        eventAt: new Date(Date.now() + 3 * DAY),
        scope: "Fable",
      },
    ],
  };
}

test("a child's Fable limit closes Fable and Mythos only; Opus still spawns", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const found = env.base.modelRegistry.find("anthropic", "claude-fable-5-2");
  if (found === undefined) throw new Error("Built-in model anthropic/claude-fable-5-2 is missing.");
  const fable: Model<Api> = found;
  const mythos: Model<Api> = { ...fable, id: "claude-mythos-5-2" };
  const fableSession = await env.childSession(fable);
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "none",
    fallbacks: {
      tiers: {
        flagship: { primary: ["anthropic/claude-fable-5-2", SOL], next: "workhorse" },
        workhorse: { primary: ["anthropic/claude-opus-4-5"] },
      },
      lastResort: [],
    },
    usageSnapshot: async () => fableOnlyExhausted(),
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "on fable", {
      ...background,
      model: fable,
    });
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session: fableSession,
      aborted: false,
      steered: false,
      failure: ANTHROPIC_429,
    });
    await promise;
    await flush();

    const record = manager.getRecord(id);
    assert.equal(record?.status, "error");
    assert.deepEqual(record?.usageLimit?.scope, FABLE_SCOPE);
    assert.equal(record?.usageLimit?.suggestedModel, SOL);
    assert.match(
      record?.error ?? "",
      /claude-fable\*, claude-mythos\* only; other models stay available/,
    );

    // Opus, the context's default model, is unaffected.
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-opus-4-5"), true);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true);
    manager.spawn(env.pi, env.context(), "implementer", "on opus", background);
    assert.equal(runs.length, 2);

    // Fable and Mythos are refused with a model-level message the workflow parser reads.
    for (const model of [fable, mythos]) {
      assert.equal(manager.isProviderAvailable("anthropic", env.owner, model.id), false);
      let message = "";
      assert.throws(
        () =>
          manager.spawn(env.pi, env.context(), "implementer", "refused", { ...background, model }),
        (error: Error) => {
          message = error.message;
          return error instanceof ProviderUnavailableError;
        },
      );
      assert.match(
        message,
        new RegExp(
          `^Model anthropic/${model.id} unavailable \\(temporarily rate limited\\)\\. Usage limit until `,
        ),
      );
      assert.equal(providerKeyFromUnavailableMessage(message), `anthropic/${model.id}`);
    }
    assert.equal(runs.length, 2);
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("the revival journal keeps a limit's scope, and omits it for a provider-wide limit", () => {
  const scoped = journalClassificationOf({
    kind: "quota",
    provider: "anthropic",
    modelId: "claude-fable-5-2",
    confidence: "inferred",
    scope: FABLE_SCOPE,
  });
  assert.deepEqual(usageClassificationOf(scoped).scope, FABLE_SCOPE);
  const wide = journalClassificationOf({
    kind: "quota",
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    confidence: "inferred",
  });
  assert.equal("scope" in wide, false);
});
test("a Fable re-check drops the stale account-wide mirror, so Opus runs again", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    usageSnapshot: async () => fableOnlyExhausted(),
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    const account = { owner: env.owner, providerKey: "anthropic", accountId: "default" };
    const until = Date.now() + DAY;
    policy.closeProvider("anthropic", "default", until);
    policy.closeProvider("anthropic", "default", until, FABLE_SCOPE);
    closeUntil(account, until);
    closeUntil({ ...account, scope: FABLE_SCOPE }, until);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-opus-4-5"), false);

    await manager.refreshProviderBlock("anthropic", env.owner, "claude-fable-5-2");

    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-opus-4-5"), true);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-fable-5-2"), false);
    assert.match(
      manager.providerUnavailableMessage("anthropic", env.owner, "claude-fable-5-2"),
      /^Model anthropic\/claude-fable-5-2 unavailable .*Fable 7d exhausted/,
    );
  } finally {
    manager.dispose();
    installed.remove();
  }
});
test("a re-check drops a recovered Fable closure but keeps an unknown-scope one on its model", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const nova = { name: "nova", models: ["claude-fable-5-2"], exact: true };
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    usageSnapshot: async () => ({
      observedAt: Date.now(),
      windows: [
        { label: "5h", percent: 30, qualifier: "used" },
        { label: "Fable 7d", percent: 40, qualifier: "used", scope: "Fable" },
        {
          label: "Nova 7d",
          percent: 100,
          qualifier: "used",
          eventAt: new Date(Date.now() + DAY),
          scope: "Nova",
        },
      ],
    }),
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    const account = { owner: env.owner, providerKey: "anthropic", accountId: "default" };
    const until = Date.now() + 3 * DAY;
    policy.closeProvider("anthropic", "default", until, FABLE_SCOPE);
    policy.closeProvider("anthropic", "default", until, nova);
    closeUntil({ ...account, scope: FABLE_SCOPE }, until);
    closeUntil({ ...account, scope: nova }, until);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-mythos-5-2"), false);

    await manager.refreshProviderBlock("anthropic", env.owner, "claude-fable-5-2");

    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-mythos-5-2"), true);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-fable-5-2"), false);
    assert.match(
      manager.providerUnavailableMessage("anthropic", env.owner, "claude-fable-5-2"),
      /\(claude-fable-5-2 only; other models stay available\)/,
    );
  } finally {
    manager.dispose();
    installed.remove();
  }
});
test("without live usage data, a Fable 429 blocks only Fable; Opus keeps spawning", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const found = env.base.modelRegistry.find("anthropic", "claude-fable-5-2");
  if (found === undefined) throw new Error("Built-in model anthropic/claude-fable-5-2 is missing.");
  const fable: Model<Api> = found;
  const fableSession = await env.childSession(fable);
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "auto-resume",
    fallbacks: { tiers: {}, lastResort: [] },
    // The usage endpoint cannot be read.
    usageSnapshot: async () => undefined,
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "on fable", {
      ...background,
      model: fable,
    });
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session: fableSession,
      aborted: false,
      steered: false,
      failure: ANTHROPIC_429,
    });
    await promise;
    await flush();
    assert.equal(manager.getRecord(id)?.status, "error");

    for (const modelId of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-mythos-5-2"]) {
      assert.equal(manager.isProviderAvailable("anthropic", env.owner, modelId), true, modelId);
    }
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true);
    await manager.refreshProviderBlock("anthropic", env.owner, "claude-opus-4-5");
    manager.spawn(env.pi, env.context(), "implementer", "on opus", background);
    assert.equal(runs.length, 2, "Opus reaches the provider");

    // Fable itself waits out its own failure.
    assert.throws(
      () =>
        manager.spawn(env.pi, env.context(), "implementer", "fable again", {
          ...background,
          model: fable,
        }),
      /^ProviderUnavailableError: Model anthropic\/claude-fable-5-2 unavailable \(temporarily rate limited\)\.$/,
    );
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("a policy whose corroboration fails closes only the failed model", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const state = policyState({
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + DAY },
    corroborate: () => {
      throw new Error("usage endpoint unreachable");
    },
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "on opus", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({
      responseText: "",
      session: await env.childSession(env.models.opus),
      aborted: false,
      steered: false,
      failure: "usage limit reached",
    });
    await promise;
    const record = manager.getRecord(id);
    assert.equal(record?.usageLimit?.status, "reported");
    assert.deepEqual(record?.usageLimit?.scope, {
      name: "unconfirmed",
      models: ["claude-opus-4-5"],
      exact: true,
    });
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-opus-4-5"), false);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-sonnet-4-5"), true);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true);
  } finally {
    manager.dispose();
    installed.remove();
  }
});
test("a policy-only exact closure refuses the model, not the provider, so workflows skip only it", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  const policy = createUsageLimitPolicy({
    owner: env.owner,
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    usageSnapshot: async () => undefined,
  });
  // The root wrote the closure (no usage data); the manager holds no copy.
  policy.closeProvider("anthropic", "default", Date.now() + DAY, {
    name: "unconfirmed",
    models: ["claude-fable-5-2"],
    exact: true,
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-fable-5-2"), false);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-opus-4-5"), true);
    const message = manager.providerUnavailableMessage("anthropic", env.owner, "claude-fable-5-2");
    assert.match(message, /^Model anthropic\/claude-fable-5-2 unavailable /);
    assert.equal(providerKeyFromUnavailableMessage(message), "anthropic/claude-fable-5-2");
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("a closure a success removed during the re-check is not recreated by its result", async (t) => {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  let release: (answer: { open: boolean; until?: number }) => void = () => undefined;
  const until = Date.now() + DAY;
  const policy: UsageLimitPolicy = {
    owner: env.owner,
    generation: 1,
    preference: async () => "none",
    classify: () => undefined,
    corroborate: async (classification) => ({ ready: false, classification }),
    pickFallback: () => undefined,
    closeProvider: () => undefined,
    isClosed: () => false,
    recheck: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    const key = {
      owner: env.owner,
      providerKey: "anthropic",
      accountId: "default",
      scope: FABLE_SCOPE,
    };
    closeUntil(key, until);
    const pending = manager.refreshProviderBlock("anthropic", env.owner, "claude-fable-5-2");
    clearUsageLimitClosure(key); // a Fable request succeeded meanwhile
    release({ open: false, until });
    await pending;
    assert.equal(manager.isProviderAvailable("anthropic", env.owner, "claude-fable-5-2"), true);
  } finally {
    manager.dispose();
    installed.remove();
  }
});
