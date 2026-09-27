// Must stay the first import: isolates HOME before provider-usage.ts is evaluated.
import { E2E_HOME } from "./helpers/usage-limit-e2e-home.ts";

import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import usageLimitPolicy, {
  USAGE_LIMIT_MESSAGE_TYPE,
} from "../.pi/extensions/usage-limit-policy.ts";
import { readAgentPreferencesAsync } from "../.pi/extensions/lib/agent-preferences.ts";
import { createUsageLimitPolicy } from "../.pi/extensions/lib/usage-limit.ts";
import {
  getUsageLimitPolicy,
  registerUsageLimitPolicy,
} from "../.pi/extensions/lib/usage-limit-contract.ts";
import subagentsExtension from "../.pi/packages/choco-pi-subagents/src/index.ts";
import { USAGE_LIMIT_RESUME_PROMPT } from "../.pi/packages/choco-pi-subagents/src/agent-manager.ts";
import { resetProviderHealth } from "../.pi/packages/choco-pi-subagents/src/provider-health.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  ANTHROPIC_LIMIT_TEXT,
  CLAUDE_MODEL,
  CODEX_LIMIT_TEXT,
  CODEX_MODEL,
  createUsageLimitE2e,
  customEntries,
  delay,
  E2E_AGENT_TYPE,
  managerRegistry,
  resultText,
  runTool,
  usageLimitPolicyOwners,
  waitFor,
  type UsageLimitE2e,
} from "./helpers/usage-limit-e2e-fixture.ts";

const CONTROLLER_PATH = fileURLToPath(
  new URL("../.pi/extensions/usage-limit-policy.ts", import.meta.url),
);
/** Loads the real root controller inside child sessions through project extension discovery. */
const CHILD_CONTROLLER_SHIM = `export { default } from ${JSON.stringify(CONTROLLER_PATH)};\n`;

const subagents: ExtensionFactory = (pi) => subagentsExtension(pi);
const rootController: ExtensionFactory = (pi) => usageLimitPolicy(pi);

const UsageLimitEventSchema = Type.Object({
  agentId: Type.String(),
  provider: Type.String(),
  resetAt: Type.Optional(Type.Number()),
  status: Type.String(),
});

function usageEvents(events: readonly RuntimeValue[]) {
  return events.map((event) => {
    assert.ok(Value.Check(UsageLimitEventSchema, event), "malformed subagents:usage_limit event");
    return Value.Parse(UsageLimitEventSchema, event);
  });
}

function resetHealth(): void {
  for (const provider of ["openai-codex", "anthropic", "e2e-outside"])
    resetProviderHealth(provider);
}

beforeEach(resetHealth);
after(async () => {
  resetHealth();
  // provider-usage.ts queues its cache writes; remove until no late write recreates the dir.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await rm(E2E_HOME, { recursive: true, force: true });
    await delay(100);
    if (!(await exists(E2E_HOME))) return;
  }
  assert.fail(`${E2E_HOME} kept being recreated`);
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The quota cache provider-usage.ts derives from HOME (redirected by usage-limit-e2e-home.ts). */
const ISOLATED_USAGE_CACHE = join(E2E_HOME, ".pi", "agent", "choco-pi", "usage-cache.json");

async function waitForCacheKey(key: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const text = await readFile(ISOLATED_USAGE_CACHE, "utf8").catch(() => "");
    if (text.includes(JSON.stringify(key))) return;
    if (Date.now() >= deadline) throw new Error(`usage cache never recorded ${key}`);
    await delay(10);
  }
}

test("preference none: child limit is reported, provider closed, model untouched", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "none",
    parentModel: CLAUDE_MODEL,
    factories: [rootController, subagents],
    projectExtensions: { "usage-limit-policy.ts": CHILD_CONTROLLER_SHIM },
  });
  try {
    const parentId = e2e.session.sessionId;
    assert.deepEqual(usageLimitPolicyOwners(), [parentId]);
    e2e.providers.script(CODEX_MODEL, { kind: "error", message: CODEX_LIMIT_TEXT });

    const before = Date.now();
    const result = await runTool(e2e.session, "Agent", {
      prompt: "Summarise the repository.",
      description: "limited child",
      subagent_type: E2E_AGENT_TYPE,
      run_in_background: false,
    });
    const after = Date.now();
    const text = resultText(result);
    assert.match(text, /Agent failed: Codex usage limit reached \(plus plan\)\. Resets in ~5m\./);
    assert.match(
      text,
      /Usage limit: openai-codex usage limit \(quota\); resets ~\S+; suggested model: anthropic\/e2e-claude; status: reported/,
    );

    const events = usageEvents(e2e.usageEvents);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event);
    assert.equal(event.status, "reported");
    assert.equal(event.provider, "openai-codex");

    const record = managerRegistry().getRecord(event.agentId);
    assert.ok(record);
    assert.equal(record.status, "error");
    assert.equal(record.usageLimit?.status, "reported");
    assert.equal(record.usageLimit?.provider, "openai-codex");
    assert.equal(record.usageLimit?.kind, "quota");
    assert.equal(record.usageLimit?.suggestedModel, "anthropic/e2e-claude");
    const resetAt = record.usageLimit?.resetAt;
    assert.ok(resetAt !== undefined);
    assert.ok(resetAt >= before + 5 * 60_000 && resetAt <= after + 5 * 60_000);
    assert.equal(event.resetAt, resetAt);

    const child = record.session;
    assert.ok(child);
    assert.equal(child.model?.provider, "openai-codex");
    assert.equal(child.model?.id, "e2e-codex");
    assert.equal(e2e.providers.requestsFor(CODEX_MODEL).length, 1);
    assert.equal(e2e.providers.requestsFor(CLAUDE_MODEL).length, 0);

    // The real controller loaded in the child, stayed inert, and published no policy there.
    assert.ok(
      child.resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path.endsWith("usage-limit-policy.ts")),
      "controller shim was not loaded in the child session",
    );
    assert.deepEqual(usageLimitPolicyOwners(), [parentId]);
    assert.notEqual(child.sessionId, parentId);

    await assert.rejects(
      runTool(e2e.session, "Agent", {
        prompt: "Try again.",
        description: "second spawn",
        subagent_type: E2E_AGENT_TYPE,
      }),
      (error: Error) => {
        assert.match(error.message, /Provider openai-codex unavailable/);
        assert.match(error.message, /Usage limit until \d{4}-\d{2}-\d{2}T/);
        assert.match(error.message, /suggested: anthropic\/e2e-claude/);
        return true;
      },
    );
    assert.equal(e2e.providers.requestsFor(CODEX_MODEL).length, 1);
    assert.deepEqual(e2e.fetchCalls, []);
  } finally {
    await e2e.close();
  }
  assert.equal(usageLimitPolicyOwners()?.length ?? 0, 0);
});

/** Private `USAGE_LIMIT_RESET_MARGIN_MS` in agent-manager.ts: the wake fires at resetAt + margin. */
const MANAGER_RESET_MARGIN_MS = 30_000;
/** Distance from park to wake-up in the auto-resume scenarios. */
const WAKE_AFTER_MS = 600;

/**
 * Real policy factory (real classifier, corroboration and preference reader)
 * with the `usageSnapshot` seam injected: the first reading reports an
 * exhausted window whose reset lands WAKE_AFTER_MS after the manager's 30 s
 * margin, every later reading reports capacity. Registered for `owner`.
 */
function registerParkingPolicy(e2e: UsageLimitE2e) {
  let readings = 0;
  const policy = createUsageLimitPolicy({
    owner: e2e.session.sessionId,
    generation: 1,
    readPreference: async () => (await readAgentPreferencesAsync(e2e.agentDir)).onUsageLimit,
    fallbacks: {
      tiers: { e2e: { primary: ["anthropic/e2e-claude", "openai-codex/e2e-codex"] } },
      lastResort: [],
    },
    usageSnapshot: async (provider) => {
      assert.equal(provider, "openai-codex");
      readings += 1;
      const observedAt = Date.now();
      if (readings > 1) return { observedAt, windows: [] };
      const eventAt = new Date(observedAt - MANAGER_RESET_MARGIN_MS + WAKE_AFTER_MS);
      return { observedAt, windows: [{ label: "5h", percent: 100, qualifier: "used", eventAt }] };
    },
  });
  const unregister = registerUsageLimitPolicy(policy);
  return { unregister, readings: () => readings };
}

async function spawnParkedChild(e2e: UsageLimitE2e) {
  e2e.providers.script(
    CODEX_MODEL,
    { kind: "error", message: CODEX_LIMIT_TEXT },
    { kind: "text", text: "resumed-ok" },
  );
  const started = Date.now();
  const result = await runTool(e2e.session, "Agent", {
    prompt: "Summarise the repository.",
    description: "parked child",
    subagent_type: E2E_AGENT_TYPE,
    run_in_background: false,
  });
  const elapsed = Date.now() - started;
  const [event] = usageEvents(e2e.usageEvents);
  assert.ok(event);
  const record = managerRegistry().getRecord(event.agentId);
  assert.ok(record);
  return { text: resultText(result), elapsed, record, id: event.agentId };
}

test("auto-resume: foreground child parks, wakes, resumes the same session and model once", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "auto-resume",
    parentModel: CLAUDE_MODEL,
    factories: [subagents],
  });
  const parking = registerParkingPolicy(e2e);
  try {
    const { text, elapsed, record } = await spawnParkedChild(e2e);
    assert.match(text, /Agent paused until \d{4}-\d{2}-\d{2}T[^;]+; result will arrive/);
    assert.match(text, /status: waiting_for_reset/);
    assert.ok(elapsed < 2_000, `foreground call took ${elapsed} ms`);
    // Returned before the wake-up: only the settle-time corroboration ran.
    assert.equal(parking.readings(), 1);
    assert.equal(record.status, "waiting_for_reset");
    assert.equal(record.usageLimit?.status, "waiting_for_reset");
    const child = record.session;
    assert.ok(child);
    const childId = child.sessionId;

    await waitFor(() => record.status === "completed", 5_000, "resumed child completion");
    assert.equal(parking.readings(), 2);
    assert.equal(record.session, child);
    assert.equal(record.session?.sessionId, childId);
    assert.equal(record.session?.model?.provider, "openai-codex");
    assert.equal(record.session?.model?.id, "e2e-codex");
    assert.equal(record.usageLimit?.status, "resumed");
    assert.match(record.result ?? "", /resumed-ok/);
    const codexRequests = e2e.providers.requestsFor(CODEX_MODEL);
    assert.equal(codexRequests.length, 2);
    assert.equal(codexRequests[1]?.lastText, USAGE_LIMIT_RESUME_PROMPT);
    assert.deepEqual(
      usageEvents(e2e.usageEvents).map((event) => event.status),
      ["waiting_for_reset", "resumed"],
    );

    await waitFor(
      () => customEntries(e2e.session, "subagent-notification").length > 0,
      3_000,
      "completion notification",
    );
    await delay(500);
    await e2e.session.waitForIdle();
    assert.equal(customEntries(e2e.session, "subagent-notification").length, 1);
    assert.equal(customEntries(e2e.session, "subagent-usage-limit").length, 1);
    assert.deepEqual(e2e.fetchCalls, []);
  } finally {
    parking.unregister();
    await e2e.close();
  }
});

test("auto-resume: stop_subagent while parked settles stopped with no later resume", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "auto-resume",
    parentModel: CLAUDE_MODEL,
    factories: [subagents],
  });
  const parking = registerParkingPolicy(e2e);
  try {
    const { record, id } = await spawnParkedChild(e2e);
    assert.equal(record.status, "waiting_for_reset");
    const stop = await runTool(e2e.session, "stop_subagent", { agent_id: id });
    assert.doesNotMatch(resultText(stop), /not found|already settled|Failed to stop/);
    assert.equal(record.status, "stopped");
    assert.equal(record.error, "Stopped by user request.");

    // Past the armed wake-up: no corroboration, no resume request, still stopped.
    await delay(WAKE_AFTER_MS + 900);
    assert.equal(parking.readings(), 1);
    assert.equal(e2e.providers.requestsFor(CODEX_MODEL).length, 1);
    assert.equal(record.status, "stopped");
    await e2e.session.waitForIdle();
    const notifications = customEntries(e2e.session, "subagent-notification");
    assert.equal(notifications.length, 1);
    assert.match(JSON.stringify(notifications[0]), /<status>Stopped<\/status>/);
    // Not asserted: usageLimit.status after stop (observed "waiting_for_reset"; see report).
  } finally {
    parking.unregister();
    await e2e.close();
  }
});

test("Agent resume with model: in-scope switches the errored child, others leave it unchanged", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "none",
    parentModel: CLAUDE_MODEL,
    factories: [rootController, subagents],
    subagentsSettings: { scopeModels: true },
    projectSettings: { enabledModels: ["openai-codex/e2e-codex", "anthropic/e2e-claude"] },
  });
  try {
    e2e.providers.script(CODEX_MODEL, { kind: "error", message: CODEX_LIMIT_TEXT });
    await runTool(e2e.session, "Agent", {
      prompt: "Summarise the repository.",
      description: "limited child",
      subagent_type: E2E_AGENT_TYPE,
      run_in_background: false,
    });
    const [event] = usageEvents(e2e.usageEvents);
    assert.ok(event);
    const record = managerRegistry().getRecord(event.agentId);
    assert.ok(record?.session);
    assert.equal(record.status, "error");
    const child = record.session;
    const resume = (model: string) =>
      runTool(e2e.session, "Agent", {
        prompt: "Continue.",
        description: "resume child",
        subagent_type: E2E_AGENT_TYPE,
        resume: event.agentId,
        model,
        run_in_background: false,
      });

    const outside = resultText(await resume("e2e-outside/e2e-outside"));
    assert.match(outside, /Model not in scope: "e2e-outside\/e2e-outside"/);
    assert.equal(child.model?.provider, "openai-codex");
    assert.equal(record.status, "error");

    const unknown = resultText(await resume("nope/missing"));
    assert.match(unknown, /^Model not found: "nope\/missing"/);
    assert.doesNotMatch(unknown, /Agent alias:/);
    assert.equal(child.model?.provider, "openai-codex");
    assert.equal(record.status, "error");
    assert.equal(e2e.providers.requestsFor(CODEX_MODEL).length, 1);

    const switched = resultText(await resume("anthropic/e2e-claude"));
    assert.match(switched, /Agent alias: @\S+\n\nok/);
    assert.equal(record.session, child);
    assert.equal(child.model?.provider, "anthropic");
    assert.equal(child.model?.id, "e2e-claude");
    assert.equal(record.status, "completed");
    const claudeRequests = e2e.providers.requestsFor(CLAUDE_MODEL);
    assert.equal(claudeRequests.length, 1);
    assert.equal(claudeRequests[0]?.lastText, "Continue.");
    assert.equal(e2e.providers.requestsFor(CODEX_MODEL).length, 1);
  } finally {
    await e2e.close();
  }
});

test("real root controller, fallback: Anthropic 429 switches the session to Codex and continues", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "fallback",
    parentModel: CLAUDE_MODEL,
    factories: [rootController],
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  try {
    const parentId = e2e.session.sessionId;
    assert.deepEqual(usageLimitPolicyOwners(), [parentId]);
    e2e.providers.script(
      CLAUDE_MODEL,
      { kind: "error", message: ANTHROPIC_LIMIT_TEXT },
      { kind: "error", message: ANTHROPIC_LIMIT_TEXT },
    );
    await e2e.session.prompt("Do the task.");
    await waitFor(
      () => e2e.providers.requestsFor(CODEX_MODEL).length > 0,
      5_000,
      "fallback provider request",
    );
    await e2e.session.waitForIdle();

    // One original attempt plus one host retry, then a single settle.
    assert.equal(e2e.providers.requestsFor(CLAUDE_MODEL).length, 2);
    assert.equal(e2e.session.model?.provider, "openai-codex");
    assert.equal(e2e.session.model?.id, "e2e-codex");
    const continuation = customEntries(e2e.session, USAGE_LIMIT_MESSAGE_TYPE);
    assert.equal(continuation.length, 1);
    const codexRequests = e2e.providers.requestsFor(CODEX_MODEL);
    assert.equal(codexRequests.length, 1);
    assert.match(
      codexRequests[0]?.lastText ?? "",
      /^anthropic usage limit reached \(resets .+\)\. Switched to openai-codex\/e2e-codex\. Continue the previous task/,
    );
    assert.deepEqual(usageLimitPolicyOwners(), [parentId]);
    // Corroboration had a (fake) Anthropic token, so it tried the OAuth usage endpoints.
    // The guard refused them, so corroboration read nothing and fallback proceeded uncorroborated.
    assert.ok(e2e.fetchCalls.includes("https://api.anthropic.com/api/oauth/usage"));
    assert.ok(e2e.fetchCalls.every((url) => url.startsWith("https://api.anthropic.com/")));
    // The refused request's backoff entry went to the isolated HOME, not the user's cache.
    await waitForCacheKey("anthropic:usage");
  } finally {
    await e2e.close();
  }
  assert.equal(usageLimitPolicyOwners()?.length ?? 0, 0);
});

test("real policy corroboration without provider auth resolves not-ready with no network I/O", async () => {
  const e2e = await createUsageLimitE2e({
    preference: "none",
    parentModel: CODEX_MODEL,
    factories: [rootController],
    omitProviders: ["anthropic"],
  });
  try {
    const ctx = e2e.session.extensionRunner.createContext();
    assert.equal(ctx.modelRegistry.getProviderAuthStatus("anthropic").configured, false);
    const policy = getUsageLimitPolicy(e2e.session.sessionId);
    assert.ok(policy);
    const anthropic = await policy.corroborate({
      kind: "quota",
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      confidence: "inferred",
    });
    assert.equal(anthropic.ready, false);
    // Codex is authenticated with a non-JWT key, so no account id can be derived.
    const codex = await policy.corroborate({
      kind: "quota",
      provider: "openai-codex",
      modelId: "e2e-codex",
      confidence: "parsed",
      resetAt: Date.now() + 60_000,
    });
    assert.equal(codex.ready, false);
    assert.deepEqual(e2e.fetchCalls, []);
  } finally {
    await e2e.close();
  }
});
