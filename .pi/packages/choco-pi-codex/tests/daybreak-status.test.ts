import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import type { NormalRuntimePlan } from "../src/adapter/activation/runtime-plan.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import type { DaybreakOutcome } from "../src/providers/openai-codex/daybreak-types.ts";
import { formatDaybreakStatus, renderCodexStatus } from "../src/ui/status.ts";
import { getDaybreakBridge } from "../../../extensions/lib/daybreak-state.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

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

const outcomes: readonly [DaybreakOutcome, string][] = [
  ["pending", "Daybreak pending (checking)"],
  ["blue", "Daybreak on"],
  ["red", "Daybreak on"],
  ["not-granted", "Daybreak requested (not granted)"],
  ["lookup-failed", "Daybreak requested (lookup failed)"],
  ["model-not-supported", "Daybreak unavailable (model unsupported)"],
  ["auth-not-eligible", "Daybreak requested (auth not eligible)"],
];

test("Daybreak status distinguishes every effective state and denial reason", () => {
  assert.equal(formatDaybreakStatus({ requested: false, outcome: "red" }), "Daybreak off");
  for (const [outcome, expected] of outcomes) {
    assert.equal(formatDaybreakStatus({ requested: true, outcome }), expected);
  }
});

test("Codex status line reads the session's effective Daybreak outcome", async () => {
  const owner = {};
  const generation = 1;
  initTheme("dark", false);
  const fixture = await createSdkFixture(model);
  const controller = getDaybreakBridge().register({
    sessionId: fixture.ctx.sessionManager.getSessionId(),
    owner,
    generation,
    initial: { requested: true, source: "inherited" },
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
    codexTransport: true,
    effectiveOpenAICodex: true,
    nativeCompaction: false,
  };
  try {
    for (const [outcome, expected] of outcomes) {
      controller.report(outcome, controller.getState().revision);
      renderCodexStatus(context, state, plan);
      assert.ok(statuses.at(-1)?.includes(expected), `missing ${expected}`);
    }
    controller.set(false, "explicit");
    renderCodexStatus(context, state, plan);
    assert.ok(statuses.at(-1)?.includes("Daybreak off"));
    assert.equal(controller.getState().source, "explicit");
    renderCodexStatus(
      {
        ...context,
        model: {
          ...model,
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        },
      },
      state,
      plan,
    );
    assert.doesNotMatch(statuses.at(-1) ?? "", /Daybreak/i);
  } finally {
    controller.dispose();
    fixture.session.dispose();
  }
});
