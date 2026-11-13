/**
 * A stored usage-limit closure is re-checked against live evidence before a
 * spawn, resume or workflow step is refused: the owner policy's reading, a
 * later success, or the absence of any reading decides, not the stored time.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createUsageLimitPolicy } from "../../../extensions/lib/usage-limit.ts";
import type { ProviderUsageSnapshot } from "../../../extensions/provider-usage.ts";
import { ProviderUnavailableError } from "../src/provider-health.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  flush,
  harness,
  installPolicyObject,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const background = { description: "recheck", isBackground: true, isolated: true };

async function setup(t: TestContext): Promise<UsageLimitEnv> {
  const env = await createUsageLimitEnv();
  t.after(() => {
    env.dispose();
    cleanupProviders();
  });
  return env;
}

/** The real root policy for `owner`, reading usage through `read`. */
function realPolicy(owner: string, read: () => Promise<ProviderUsageSnapshot | undefined>) {
  let reads = 0;
  const policy = createUsageLimitPolicy({
    owner,
    generation: 1,
    readPreference: async () => "none",
    fallbacks: { tiers: {}, lastResort: [] },
    usageSnapshot: async () => {
      reads += 1;
      return read();
    },
  });
  return { policy, reads: () => reads };
}

function capacity(): ProviderUsageSnapshot {
  return { observedAt: Date.now(), windows: [{ label: "5h", percent: 30, qualifier: "used" }] };
}

test("a root closure the live reading disproves no longer refuses a spawn (incident)", async (t) => {
  const env = await setup(t);
  const { policy, reads } = realPolicy(env.owner, async () => capacity());
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs } = harness();
  try {
    // The root controller closed Anthropic for 24 h on a 429 that later reset.
    policy.closeProvider("anthropic", "default", Date.now() + 24 * HOUR);
    assert.throws(
      () => manager.spawn(env.pi, env.context(), "implementer", "refused", background),
      ProviderUnavailableError,
    );
    await Promise.all([
      manager.refreshProviderBlock("anthropic", env.owner),
      manager.refreshProviderBlock("anthropic", env.owner),
    ]);
    assert.equal(reads(), 1, "concurrent callers share one reading");
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true);
    assert.equal(policy.isClosed("anthropic", "default"), false);
    manager.spawn(env.pi, env.context(), "implementer", "runs", background);
    assert.equal(runs.length, 1);
    // Nothing is closed any more, so a later check does not read again.
    await manager.refreshProviderBlock("anthropic", env.owner);
    assert.equal(reads(), 1);
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("a closure the reading confirms keeps refusing with the reading's reset and reason", async (t) => {
  const env = await setup(t);
  const resetAt = Date.now() + 2 * HOUR;
  const { policy } = realPolicy(env.owner, async () => ({
    observedAt: Date.now(),
    windows: [{ label: "Opus 7d", percent: 100, qualifier: "used", eventAt: new Date(resetAt) }],
  }));
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    policy.closeProvider("anthropic", "default", Date.now() + 24 * HOUR);
    await manager.refreshProviderBlock("anthropic", env.owner);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
    assert.equal(
      manager.providerUnavailableMessage("anthropic", env.owner),
      `Provider anthropic unavailable (temporarily rate limited). Usage limit until ${new Date(resetAt).toISOString()}; live usage shows Opus 7d exhausted.`,
    );
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("a policy replaced during the reading changes nothing", async (t) => {
  const env = await setup(t);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { policy } = realPolicy(env.owner, async () => {
    await gate;
    return capacity();
  });
  const installed = installPolicyObject(policy, env.owner);
  const { manager } = harness();
  try {
    policy.closeProvider("anthropic", "default", Date.now() + HOUR);
    const pending = manager.refreshProviderBlock("anthropic", env.owner);
    const replacement = realPolicy(env.owner, async () => undefined).policy;
    replacement.closeProvider("anthropic", "default", Date.now() + HOUR);
    installPolicyObject(replacement, env.owner);
    release();
    await pending;
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
  } finally {
    manager.dispose();
    installed.remove();
    installPolicyObject(policy, env.owner).remove();
  }
});

test("resume re-checks the closure before its synchronous gate", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  const { policy } = realPolicy(env.owner, async () => capacity());
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs, resumes, resumePrompts } = harness();
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const first = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "done", session, aborted: false, steered: false });
    await first;
    policy.closeProvider("anthropic", "default", Date.now() + 24 * HOUR);
    const resumed = manager.resume(id, "again");
    await flush();
    assert.deepEqual(resumePrompts, ["again"]);
    resumes[0].resolve({ text: "done again" });
    assert.equal((await resumed)?.status, "completed");
  } finally {
    manager.dispose();
    installed.remove();
  }
});

function assistantAt(timestamp: number): AgentSession["messages"][number] {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "claude-opus-4-5",
    api: "anthropic-messages",
    stopReason: "stop",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  };
}

test("a child whose last request started after the closure reopens it; an older one does not", async (t) => {
  const env = await setup(t);
  const session = await env.childSession();
  const { policy, reads } = realPolicy(env.owner, async () => ({
    observedAt: Date.now(),
    windows: [
      { label: "5h", percent: 100, qualifier: "used", eventAt: new Date(Date.now() + HOUR) },
    ],
  }));
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs } = harness();
  try {
    const ids = [0, 1].map(() =>
      manager.spawn(env.pi, env.context(), "implementer", "task", background),
    );
    policy.closeProvider("anthropic", "default", Date.now() + 24 * HOUR);
    const finish = async (index: number, requestStart: number): Promise<void> => {
      const promise = manager.getRecord(ids[index] ?? "")?.promise;
      session.agent.state.messages = [assistantAt(requestStart)];
      runs[index]?.resolve({ responseText: "ok", session, aborted: false, steered: false });
      await promise;
    };
    await finish(0, Date.now() - 60_000);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), false);
    await finish(1, Date.now() + 1);
    assert.equal(manager.isProviderAvailable("anthropic", env.owner), true);
    assert.equal(reads(), 0);
  } finally {
    manager.dispose();
    installed.remove();
  }
});

test("a nested spawn re-checks the closure under its parent's root owner", async (t) => {
  const env = await setup(t);
  const { policy } = realPolicy(env.owner, async () => capacity());
  const installed = installPolicyObject(policy, env.owner);
  const { manager, runs } = harness();
  try {
    const parent = manager.spawn(env.pi, env.context(), "implementer", "parent", background);
    policy.closeProvider("anthropic", "default", Date.now() + 24 * HOUR);
    // The grandchild's context belongs to the child session, not the root.
    const childContext = env.context({ sessionManager: env.freshSessionManager() });
    const nested = { ...background, parentAgentId: parent };
    assert.throws(
      () => manager.spawn(env.pi, childContext, "implementer", "nested", nested),
      ProviderUnavailableError,
    );
    await manager.refreshSpawnProvider(childContext, nested);
    manager.spawn(env.pi, childContext, "implementer", "nested", nested);
    assert.equal(runs.length, 2);
  } finally {
    manager.dispose();
    installed.remove();
  }
});
