import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import type { NormalRuntimePlan } from "../src/adapter/activation/runtime-plan.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { renderCodexStatus } from "../src/ui/status.ts";
import { getFastModeBridge } from "../../../extensions/lib/fast-mode-state.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const LEGACY_SYMBOL: unique symbol = Symbol.for("choco-pi.codex-fast-mode");
interface LegacyRegistry {
  [LEGACY_SYMBOL]?: { enabled: boolean };
}

const model: Model<Api> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};

test("Codex status reads session-owned explicit off without publishing a global default", async () => {
  const fixture = await createSdkFixture(model);
  const legacy = { enabled: true };
  const registry: typeof globalThis & LegacyRegistry = globalThis;
  Object.defineProperty(globalThis, LEGACY_SYMBOL, { configurable: true, value: legacy });
  const bridge = getFastModeBridge();
  const controller = bridge.register({
    sessionId: fixture.ctx.sessionManager.getSessionId(),
    owner: {},
    generation: 1,
    initial: { requested: false, source: "explicit" },
  });
  let status: string | undefined;
  const config = {
    ...DEFAULT_CODEX_CONVERSION_CONFIG,
    openai: { ...DEFAULT_CODEX_CONVERSION_CONFIG.openai, fast: true },
  };
  const state: AdapterState = {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config,
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
    effectiveOpenAICodex: true,
    nativeCompaction: false,
  };
  try {
    renderCodexStatus(fixture.ctx, state, plan);
    status = fixture.ctx.hasUI ? status : undefined;
    assert.doesNotMatch(status ?? "", /fast/i);
    assert.equal(registry[LEGACY_SYMBOL], legacy);
  } finally {
    controller.dispose();
    fixture.session.dispose();
    Reflect.deleteProperty(globalThis, LEGACY_SYMBOL);
  }
});
