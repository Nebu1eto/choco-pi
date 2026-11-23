import type { ModelCost } from "@earendil-works/pi-ai";
import type { AntigravityFamily } from "./group.ts";

const ZERO_COST: Readonly<ModelCost> = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const GEMINI_3_1_PRO_COST: Readonly<ModelCost> = {
  input: 2,
  output: 12,
  cacheRead: 0.2,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
};

const GEMINI_2_5_PRO_COST: Readonly<ModelCost> = {
  input: 1.25,
  output: 10,
  cacheRead: 0.125,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
};

const GEMINI_3_8_FLASH_COST: Readonly<ModelCost> = {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite: 0,
};

const GEMINI_3_1_FLASH_LITE_COST: Readonly<ModelCost> = {
  input: 0.25,
  output: 1.5,
  cacheRead: 0.025,
  cacheWrite: 0,
};

const GEMINI_4_STANDARD_COST: Readonly<ModelCost> = {
  input: 2,
  output: 10,
  cacheRead: 0.1,
  cacheWrite: 0,
};

const GOOGLE_COSTS: ReadonlyMap<string, Readonly<ModelCost>> = new Map([
  ["gemini-4-neon", { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 }],
  ["gemini-4-carbon", GEMINI_4_STANDARD_COST],
  ["gemini-4-argon", GEMINI_4_STANDARD_COST],
  ["gemini-4-hydrogen", { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 }],
  ["gemini-3.8-flash", GEMINI_3_8_FLASH_COST],
  ["gemini-3.7-flash", GEMINI_3_8_FLASH_COST],
  ["gemini-3.6-flash", GEMINI_3_8_FLASH_COST],
  ["gemini-3.5-flash", { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 }],
  ["gemini-3.5-flash-lite", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 }],
  ["gemini-3.1-pro-preview", GEMINI_3_1_PRO_COST],
  ["gemini-3.1-pro-preview-customtools", GEMINI_3_1_PRO_COST],
  ["gemini-3.1-flash-lite", GEMINI_3_1_FLASH_LITE_COST],
  ["gemini-3.1-flash-lite-preview", GEMINI_3_1_FLASH_LITE_COST],
  ["gemini-3-flash-preview", { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 }],
  ["gemini-2.5-pro", GEMINI_2_5_PRO_COST],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 }],
  ["gemini-2.5-flash-lite", { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 }],
  [
    "gemini-2.5-computer-use-preview-10-2025",
    { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
  ],
  ["gemini-flash-latest", { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 }],
  ["gemini-flash-lite-latest", GEMINI_3_1_FLASH_LITE_COST],
  ["gemini-pro-latest", GEMINI_3_1_PRO_COST],
  ["gemini-robotics-er-2-preview", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }],
]);

const CLAUDE_OPUS_LEGACY_COST: Readonly<ModelCost> = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

const CLAUDE_SONNET_4_COST: Readonly<ModelCost> = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

const ANTHROPIC_COSTS: ReadonlyMap<string, Readonly<ModelCost>> = new Map([
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  [
    "claude-haiku-5-5",
    {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      ],
    },
  ],
  ["claude-opus-5", CLAUDE_OPUS_LEGACY_COST],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ["claude-opus-4-8", CLAUDE_OPUS_LEGACY_COST],
  ["claude-opus-4-7", CLAUDE_OPUS_LEGACY_COST],
  ["claude-opus-4-6", CLAUDE_OPUS_LEGACY_COST],
  ["claude-sonnet-4-6", CLAUDE_SONNET_4_COST],
  ["claude-opus-4-5", CLAUDE_OPUS_LEGACY_COST],
  ["claude-sonnet-4-5", CLAUDE_SONNET_4_COST],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
]);

const VERTEX_PARTNER_COSTS: ReadonlyMap<string, Readonly<ModelCost>> = new Map([
  ["gpt-oss-120b", { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 }],
]);

const GOOGLE_VARIANT_SUFFIX = /-(?:thinking|tiered)$/u;

function cloneCost(cost: Readonly<ModelCost>): ModelCost {
  const copy: ModelCost = {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  };
  if (cost.tiers && cost.tiers.length > 0) {
    copy.tiers = cost.tiers.map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    }));
  }
  return copy;
}

function lookupGoogleCost(modelId: string): Readonly<ModelCost> | undefined {
  const normalized = modelId.replace(GOOGLE_VARIANT_SUFFIX, "");
  const exact = GOOGLE_COSTS.get(normalized);
  if (exact) return exact;
  const preview = GOOGLE_COSTS.get(`${normalized}-preview`);
  if (preview) return preview;
  if (normalized.endsWith("-preview")) {
    return GOOGLE_COSTS.get(normalized.slice(0, -"-preview".length));
  }
  return undefined;
}

function lookupAnthropicCost(modelId: string): Readonly<ModelCost> | undefined {
  const exact = ANTHROPIC_COSTS.get(modelId);
  if (exact) return exact;
  if (modelId.endsWith("-thinking")) {
    return ANTHROPIC_COSTS.get(modelId.slice(0, -"-thinking".length));
  }
  return undefined;
}

export function costForAntigravityModel(modelId: string, family: AntigravityFamily): ModelCost {
  let found: Readonly<ModelCost> | undefined;
  if (family === "gemini") {
    found = lookupGoogleCost(modelId);
  } else if (family === "claude") {
    found = lookupAnthropicCost(modelId);
  } else {
    found = VERTEX_PARTNER_COSTS.get(modelId);
  }
  return cloneCost(found ?? ZERO_COST);
}
