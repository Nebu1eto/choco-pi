import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  codexServiceTierForDecision,
  type CodexFastModeDecision,
  isCurrentCodexFastModeDecision,
  snapshotCodexFastModeDecision,
} from "../src/providers/openai-codex/fast-mode-decision.ts";
import {
  beginCodexDaybreakRequest,
  resolveCodexDaybreakTicket,
  snapshotCodexDaybreakDecision,
} from "../src/providers/openai-codex/daybreak-decision.ts";
import { daybreakAccount } from "../src/providers/openai-codex/daybreak-entitlement.ts";
import { configureCodexDaybreakEntitlementForTest } from "../src/providers/openai-codex/daybreak-entitlement.ts";
import { configureCodexDaybreakModelSupportForTest } from "../src/providers/openai-codex/daybreak-model-support.ts";
import { createCodexDaybreakProbe } from "../src/extension/daybreak-probe.ts";
import {
  formatDaybreakStatus,
  formatFastModeUnavailableStatus,
  renderCodexStatus,
} from "../src/ui/status.ts";
import {
  OPENAI_STEERING_UNAVAILABLE_REASON,
  SteeringStatusWidget,
} from "../src/ui/steering-status.ts";
import {
  OPENAI_SIGN_IN_DAYBREAK_REASON,
  OPENAI_SIGN_IN_FAST_REASON,
} from "../src/adapter/openai-sign-in.ts";
import { getDaybreakBridge } from "../../../extensions/lib/daybreak-state.ts";
import { getFastModeBridge } from "../../../extensions/lib/fast-mode-state.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import type { NormalRuntimePlan } from "../src/adapter/activation/runtime-plan.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const symbol = Symbol.for("choco-pi.fast-mode-state");
const openai: Model<Api> = {
  id: "gpt-6.1-sol",
  name: "GPT",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};
const codex: Model<Api> = {
  ...openai,
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};
const oauth = { isUsingOAuth: () => true };
const apiKeyRegistry = { isUsingOAuth: () => false };
// ChatGPT sign-in token shape without chatgpt_account_id.
const signInToken = `e30.${Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url")}.sig`;

function installClaimingBridge(sessionId: string, revision: { value: number }): () => void {
  const controller = {
    getState: () => ({
      sessionId,
      requested: true,
      source: "explicit" as const,
      revision: revision.value,
    }),
    decide: (): CodexFastModeDecision => ({
      sessionId,
      requested: true,
      source: "explicit",
      revision: revision.value,
      supported: true,
      active: true,
      serviceTier: "priority",
    }),
    set: () => assert.fail("must not reset"),
  };
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: {
      version: 1,
      get: (id: string) => (id === sessionId ? controller : undefined),
      register: () => undefined,
      createExtension: () => undefined,
    },
  });
  return () => Reflect.deleteProperty(globalThis, symbol);
}

function assertDisabled(decision: CodexFastModeDecision, requested: boolean): void {
  assert.equal(decision.supported, false);
  assert.equal(decision.active, false);
  assert.equal(decision.serviceTier, undefined);
  assert.equal(decision.requested, requested);
  assert.equal(decision.reason, OPENAI_SIGN_IN_FAST_REASON);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(codexServiceTierForDecision(decision), undefined);
}

test("openai sign-in fallback Fast is visible but disabled with a reason", () => {
  assertDisabled(snapshotCodexFastModeDecision("s", openai, true, oauth), true);
  assertDisabled(snapshotCodexFastModeDecision("s", openai, false, true), false);
});

test("openai sign-in neutralizes a bridge decision that claims priority and keeps drift checks", () => {
  const revision = { value: 3 };
  const restore = installClaimingBridge("claim", revision);
  try {
    const decision = snapshotCodexFastModeDecision("claim", openai, false, oauth);
    assertDisabled(decision, true);
    assert.equal(decision.source, "explicit");
    assert.equal(decision.revision, 3);
    assert.equal(isCurrentCodexFastModeDecision(decision), true);
    revision.value++;
    assert.equal(isCurrentCodexFastModeDecision(decision), false);
  } finally {
    restore();
  }
});

test("sk- openai, omitted sign-in, and openai-codex keep the paid priority tier", () => {
  const revision = { value: 1 };
  const restore = installClaimingBridge("paid", revision);
  try {
    for (const [model, signIn] of [
      [openai, apiKeyRegistry],
      [openai, undefined],
      [codex, oauth],
      [codex, true],
    ] as const) {
      const decision = snapshotCodexFastModeDecision("paid", model, false, signIn);
      assert.equal(decision.serviceTier, "priority");
      assert.equal(decision.supported, true);
      assert.equal(decision.reason, undefined);
      assert.equal(Object.hasOwn(decision, "reason"), false);
    }
  } finally {
    restore();
  }
  const fallback = snapshotCodexFastModeDecision("x", openai, true, apiKeyRegistry);
  assert.equal(codexServiceTierForDecision(fallback), "priority");
  assert.deepEqual(snapshotCodexFastModeDecision("x", codex, false), {
    sessionId: "x",
    requested: false,
    source: "default",
    revision: 0,
    supported: true,
    active: false,
    serviceTier: "standard",
  });
});

test("openai sign-in Daybreak is unavailable with a reason and performs zero fetches", async (t) => {
  let fetches = 0;
  const counted: typeof fetch = async () => {
    fetches++;
    return Response.json({});
  };
  t.mock.method(globalThis, "fetch", counted);
  configureCodexDaybreakEntitlementForTest({ fetch: counted });
  configureCodexDaybreakModelSupportForTest({ fetch: counted });
  const sessionId = "daybreak-sign-in";
  const controller = getDaybreakBridge().register({
    sessionId,
    owner: {},
    generation: 0,
    initial: { requested: true, source: "explicit" },
  });
  const probe = createCodexDaybreakProbe();
  let credentialReads = 0;
  try {
    assert.equal(daybreakAccount(signInToken, openai.baseUrl), undefined);
    const snapshot = snapshotCodexDaybreakDecision(sessionId, openai, true);
    assert.equal(snapshot.outcome, "auth-not-eligible");
    assert.equal(snapshot.cyber, undefined);
    assert.equal(snapshot.reason, OPENAI_SIGN_IN_DAYBREAK_REASON);
    assert.equal(
      formatDaybreakStatus(snapshot),
      `Daybreak unavailable (${OPENAI_SIGN_IN_DAYBREAK_REASON})`,
    );
    // Without sign-in evidence the legacy snapshot is unchanged.
    assert.equal(snapshotCodexDaybreakDecision(sessionId, openai).reason, undefined);
    const ticket = beginCodexDaybreakRequest({
      sessionId,
      model: openai,
      credentials: { apiKey: signInToken },
    });
    const resolved = await resolveCodexDaybreakTicket(ticket);
    assert.equal(resolved?.outcome, "auth-not-eligible");
    assert.equal(resolved?.cyber, undefined);
    await probe.bind({
      model: openai,
      sessionManager: { getSessionId: () => sessionId },
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          credentialReads++;
          return { ok: true, apiKey: signInToken, headers: {} };
        },
      },
    });
    await probe.settled();
    assert.equal(controller.getState().outcome, "auth-not-eligible");
    assert.equal(credentialReads, 0);
    assert.equal(fetches, 0);
  } finally {
    probe.dispose();
    controller.dispose();
    configureCodexDaybreakEntitlementForTest(undefined);
    configureCodexDaybreakModelSupportForTest(undefined);
  }
});

test("status line shows disabled Fast and Daybreak reasons for openai sign-in", async (t) => {
  initTheme("dark", false);
  const fixture = await createSdkFixture(openai);
  const sessionId = fixture.ctx.sessionManager.getSessionId();
  const fast = getFastModeBridge().register({
    sessionId,
    owner: {},
    generation: 1,
    initial: { requested: true, source: "explicit" },
  });
  const daybreak = getDaybreakBridge().register({
    sessionId,
    owner: {},
    generation: 1,
    initial: { requested: true, source: "explicit" },
  });
  const statuses: string[] = [];
  const context = {
    ...fixture.ctx,
    hasUI: true,
    ui: {
      ...fixture.ctx.ui,
      setStatus: (_key: string, value: string | undefined): void => {
        if (value !== undefined) statuses.push(value);
      },
    },
  };
  const state: AdapterState = {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config: {
      ...DEFAULT_CODEX_CONVERSION_CONFIG,
      ui: { ...DEFAULT_CODEX_CONVERSION_CONFIG.ui, statusLine: true },
    },
    executionMode: "normal",
    codexTurnState: createCodexTurnState(),
  };
  const plan: NormalRuntimePlan = {
    kind: "normal",
    prompt: "normal",
    transport: "responses",
    toolNames: [],
    ownedToolNames: [],
    configuredProvider: false,
    codexTransport: false,
    effectiveOpenAICodex: false,
    nativeCompaction: false,
  };
  try {
    renderCodexStatus(context, state, plan);
    const apiKeyStatus = statuses.at(-1) ?? "";
    assert.match(apiKeyStatus, /• fast/);
    assert.doesNotMatch(apiKeyStatus, /unavailable|Daybreak/);
    t.mock.method(fixture.ctx.modelRegistry, "isUsingOAuth", () => true);
    renderCodexStatus(context, state, plan);
    const signInStatus = statuses.at(-1) ?? "";
    assert.ok(signInStatus.includes(`Fast unavailable (${OPENAI_SIGN_IN_FAST_REASON})`));
    assert.ok(signInStatus.includes(`Daybreak unavailable (${OPENAI_SIGN_IN_DAYBREAK_REASON})`));
    assert.doesNotMatch(signInStatus, /• fast/);
    fast.set(false, "explicit");
    daybreak.set(false, "explicit");
    renderCodexStatus(context, state, plan);
    assert.doesNotMatch(statuses.at(-1) ?? "", /unavailable|Daybreak|fast/i);
  } finally {
    fast.dispose();
    daybreak.dispose();
    fixture.session.dispose();
  }
});

test("Fast unavailable note requires a requested, inactive, reasoned decision", () => {
  const base = { requested: true, active: false, reason: "r" };
  assert.equal(formatFastModeUnavailableStatus(base), "Fast unavailable (r)");
  assert.equal(formatFastModeUnavailableStatus({ ...base, requested: false }), "");
  assert.equal(formatFastModeUnavailableStatus({ ...base, active: true }), "");
  assert.equal(formatFastModeUnavailableStatus({ requested: true, active: false }), "");
});

test("steering receipts on openai state native steering is unavailable", async () => {
  const frames: (string[] | undefined)[] = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai" },
    sessionManager: { getSessionId: () => "owner" },
    ui: { setWidget: (_key: string, lines: string[] | undefined) => frames.push(lines) },
  };
  const widget = new SteeringStatusWidget();
  const observe = widget.add("hello", ctx);
  assert.ok(frames.at(-1)?.[0]?.includes(OPENAI_STEERING_UNAVAILABLE_REASON));
  observe("sent");
  await Promise.resolve();
  assert.ok(frames.at(-1)?.[0]?.includes(OPENAI_STEERING_UNAVAILABLE_REASON));
  widget.add("codex", { ...ctx, model: { provider: "openai-codex" } });
  assert.match(frames.at(-1)?.[1] ?? "", /#2 · Queued \(Pi path\) · codex$/);
});
