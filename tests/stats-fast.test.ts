import assert from "node:assert/strict";
import test from "node:test";
import {
  baseModelId,
  fastFromPrice,
  fastStateOf,
  listOutputRate,
  type ModelPrices,
} from "../.pi/extensions/lib/stats/fast.ts";
import type { CallRecord } from "../.pi/extensions/lib/stats/records.ts";

const ASTRA: ModelPrices = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
};
const GROK: ModelPrices = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
};
const lookup = (provider: string, model: string): ModelPrices | undefined =>
  provider === "openai-codex" && model === "gpt-6-astra"
    ? ASTRA
    : provider === "xai" && model === "grok-4.7"
      ? GROK
      : undefined;

function call(overrides: Partial<CallRecord>, outputRatePerMtok: number): CallRecord {
  const output = 1000;
  return {
    key: "k",
    sessionId: "s",
    file: "/s.jsonl",
    cwd: "/w",
    at: 0,
    kind: "assistant",
    provider: "openai-codex",
    model: "gpt-6-astra",
    tokens: { input: 100, output, cacheRead: 0, cacheWrite: 0 },
    cost: {
      input: 0,
      output: (output * outputRatePerMtok) / 1e6,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1,
    },
    durationMs: 1000,
    ttftMs: undefined,
    stopReason: "stop",
    responseModel: undefined,
    fastRequested: undefined,
    feature: "conversation",
    nestedCalls: [],
    isSubagent: false,
    failed: false,
    ...overrides,
  };
}

test("the recorded output rate against the list rate tells Fast from standard, tier-aware", () => {
  assert.equal(fastFromPrice(call({}, 100), ASTRA), "on", "twice the list rate is Fast");
  assert.equal(fastFromPrice(call({}, 50), ASTRA), "off", "the list rate is standard");
  const longContext = { input: 300_000, output: 1000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(
    listOutputRate(ASTRA, call({ tokens: longContext }, 0)),
    75,
    "above the tier threshold the tier rate applies",
  );
  assert.equal(
    fastFromPrice(call({ tokens: longContext }, 75), ASTRA),
    "off",
    "tier pricing alone is not Fast",
  );
  assert.equal(
    fastFromPrice(call({ tokens: longContext }, 150), ASTRA),
    "on",
    "tier pricing doubled is Fast",
  );
  assert.equal(
    fastFromPrice(call({}, 125), ASTRA),
    "on",
    "a 2.5x multiple (gpt-5.5 priority) is Fast",
  );
  assert.equal(
    fastFromPrice(call({}, 85), ASTRA),
    undefined,
    "a rate between the bands is no evidence",
  );
  assert.equal(
    fastFromPrice(
      call({ tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, 100),
      ASTRA,
    ),
    undefined,
    "no output tokens, no evidence",
  );
  assert.equal(
    fastFromPrice(call({}, 100), undefined),
    undefined,
    "an unpriced model gives no evidence",
  );
});

test("fastStateOf: price evidence first, then the xAI variant id, then the requested state", () => {
  assert.equal(
    fastStateOf(call({ fastRequested: false }, 100), lookup),
    "on",
    "price beats a stale requested state",
  );
  assert.equal(
    fastStateOf(call({ fastRequested: true }, 50), lookup),
    "off",
    "requested but priced at list was not applied",
  );
  assert.equal(
    fastStateOf(call({ model: "gpt-daybreak-blue-latest", fastRequested: true }, 0), lookup),
    "unknown",
    "requested without price evidence stays unknown",
  );
  assert.equal(
    fastStateOf(call({ model: "gpt-daybreak-blue-latest", fastRequested: false }, 0), lookup),
    "off",
    "not requested cannot have been applied",
  );
  assert.equal(
    fastStateOf(call({ model: "gpt-daybreak-blue-latest" }, 0), lookup),
    "unknown",
    "no entry in the log stays unknown",
  );
  assert.equal(
    fastStateOf(call({ provider: "xai", model: "grok-4.7-build-fast" }, 12), lookup),
    "on",
  );
  assert.equal(
    fastStateOf(
      call({ provider: "xai", model: "grok-4.7", responseModel: "grok-4.7-build-fast" }, 12),
      lookup,
    ),
    "on",
  );
  const tierGrok = { input: 250_000, output: 1000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(
    fastStateOf(call({ provider: "xai", model: "grok-4.7", tokens: tierGrok }, 12), lookup),
    "off",
    "a long-context grok call at the tier rate is standard",
  );
  assert.equal(
    fastStateOf(call({ provider: "xai", model: "grok-4.7", tokens: tierGrok }, 24), lookup),
    "on",
  );
  assert.equal(
    fastStateOf(
      call({ provider: "anthropic", model: "claude-opus-5-5", fastRequested: true }, 100),
      lookup,
    ),
    undefined,
    "Anthropic never splits",
  );
  assert.equal(baseModelId("grok-4.7-build-fast"), "grok-4.7");
  assert.equal(baseModelId("gpt-6-astra"), "gpt-6-astra");
});
