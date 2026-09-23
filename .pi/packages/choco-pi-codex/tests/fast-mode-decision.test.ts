import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  codexServiceTierForDecision,
  initializeCodexFastModeDefault,
  type CodexFastModeDecision,
  isCurrentCodexFastModeDecision,
  snapshotCodexFastModeDecision,
} from "../src/providers/openai-codex/fast-mode-decision.ts";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";
import {
  prepareCodexRequestBody,
  prewarmOpenAICodexWebSocket,
} from "../src/providers/openai-codex-custom-provider.ts";
import { isProtocolObject } from "../src/providers/openai-codex/types.ts";
import { rewriteCodexProviderRequest } from "../src/adapter/provider-request.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import {
  getFastModeBridge,
  type FastModeDecision,
} from "../../../extensions/lib/fast-mode-state.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createSdkFixture } from "./sdk-fixture.ts";

const symbol = Symbol.for("choco-pi.fast-mode-state");
const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};

test("bridge decision is frozen, drives explicit tiers, and detects revision drift", () => {
  let revision = 4;
  const controller = {
    getState: () => ({
      sessionId: "session-a",
      requested: false,
      source: "explicit" as const,
      revision,
    }),
    decide: (_model: Model<Api> | undefined): CodexFastModeDecision => ({
      sessionId: "session-a",
      requested: false,
      source: "explicit",
      revision,
      supported: true,
      active: false,
      serviceTier: "standard",
    }),
    set: () => assert.fail("explicit decision must not be reset"),
  };
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: {
      version: 1,
      get: (sessionId: string) => (sessionId === "session-a" ? controller : undefined),
      register: () => undefined,
      createExtension: () => undefined,
    },
  });
  try {
    const decision = snapshotCodexFastModeDecision("session-a", model, true);
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(decision.serviceTier, "standard");
    const body = buildRequestBody(model, normalizeContext({ messages: [] }), {
      serviceTier: codexServiceTierForDecision(decision),
    });
    assert.equal(body.service_tier, "default");
    assert.equal(isCurrentCodexFastModeDecision(decision), true);
    revision++;
    assert.equal(isCurrentCodexFastModeDecision(decision), false);
  } finally {
    Reflect.deleteProperty(globalThis, symbol);
  }
});

test("frozen explicit off wins after the real provider payload hook", async () => {
  const fixture = await createSdkFixture(model);
  const bridge = getFastModeBridge();
  const controller = bridge.register({
    sessionId: fixture.ctx.sessionManager.getSessionId(),
    owner: {},
    generation: 1,
    initial: { requested: false, source: "explicit" },
  });
  const decision: FastModeDecision = controller.decide(model);
  const config = {
    ...DEFAULT_CODEX_CONVERSION_CONFIG,
    openai: { ...DEFAULT_CODEX_CONVERSION_CONFIG.openai, fast: true },
    compaction: {
      ...DEFAULT_CODEX_CONVERSION_CONFIG.compaction,
      responsesCompaction: false,
    },
  };
  const state: AdapterState = {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config,
    executionMode: "normal",
    codexTurnState: createCodexTurnState(),
    pendingActiveProviderPromptCapture: false,
  };
  try {
    const body = await prepareCodexRequestBody(
      model,
      normalizeContext({ messages: [] }),
      {
        sessionId: decision.sessionId,
        fastModeDecision: decision,
        serviceTier: "default",
        onPayload: (payload) =>
          isProtocolObject(payload)
            ? rewriteCodexProviderRequest(payload, fixture.ctx, state)
            : payload,
      },
      false,
    );
    assert.equal(body.service_tier, "default");
    let prewarmTier: string | null | undefined;
    const tokenPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
    ).toString("base64url");
    await prewarmOpenAICodexWebSocket(
      model,
      normalizeContext({ messages: [] }),
      {
        apiKey: `e30.${tokenPayload}.signature`,
        sessionId: decision.sessionId,
        transport: "websocket",
      },
      {
        preparedBody: { ...body, service_tier: "priority" },
        useResponsesLite: () => false,
        prewarmTransport: async (_url, prepared) => {
          prewarmTier = prepared.service_tier;
          return { socketReused: false };
        },
      },
    );
    assert.equal(prewarmTier, "default");
  } finally {
    controller.dispose();
    fixture.session.dispose();
  }
});

test("legacy fallback remains explicit standard off and priority on", () => {
  const off = snapshotCodexFastModeDecision("legacy-off", model, false);
  const on = snapshotCodexFastModeDecision("legacy-on", model, true);
  assert.equal(off.serviceTier, "standard");
  assert.equal(off.active, false);
  assert.equal(on.serviceTier, "priority");
  assert.equal(on.active, true);
  assert.equal(isCurrentCodexFastModeDecision(off), true);
});

test("config defaults initialize only the owning default session", () => {
  const bridge = getFastModeBridge();
  const first = bridge.register({
    sessionId: "root-default-a",
    owner: {},
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  const second = bridge.register({
    sessionId: "root-default-b",
    owner: {},
    generation: 1,
    initial: { requested: false, source: "explicit" },
  });
  try {
    initializeCodexFastModeDefault("root-default-a", true);
    initializeCodexFastModeDefault("root-default-b", true);
    assert.equal(first.getState().requested, true);
    assert.equal(first.getState().source, "default");
    assert.equal(second.getState().requested, false);
    assert.equal(second.getState().source, "explicit");
  } finally {
    first.dispose();
    second.dispose();
  }
});
