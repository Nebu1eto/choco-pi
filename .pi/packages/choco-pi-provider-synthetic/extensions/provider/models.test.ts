import { describe, expect, it } from "vitest";
import type { SyntheticApiModel } from "../../src/client/types";
import {
  buildSyntheticProviderModels,
  buildSyntheticProviderModelsFromApi,
  parseApiPrice,
  SYNTHETIC_MODELS,
} from "./models";

interface Discrepancy {
  model: string;
  field: string;
  hardcoded: unknown;
  api: unknown;
}

async function fetchApiModels(): Promise<SyntheticApiModel[]> {
  const response = await fetch("https://api.synthetic.new/openai/v1/models", {
    headers: {
      Referer: "https://github.com/aliou/pi-synthetic",
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data: { data?: SyntheticApiModel[] } = await response.json();
  return data.data ?? [];
}

function compareModels(
  apiModels: SyntheticApiModel[],
  hardcodedModels: typeof SYNTHETIC_MODELS,
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  for (const hardcoded of hardcodedModels) {
    const apiModel = apiModels.find((m) => m.id === hardcoded.id);

    if (!apiModel) {
      discrepancies.push({
        model: hardcoded.id,
        field: "exists",
        hardcoded: true,
        api: false,
      });
      continue;
    }

    const apiInputs = [...apiModel.input_modalities].sort();
    const hardcodedInputs = [...hardcoded.input].sort();
    if (JSON.stringify(apiInputs) !== JSON.stringify(hardcodedInputs)) {
      discrepancies.push({
        model: hardcoded.id,
        field: "input",
        hardcoded: hardcodedInputs,
        api: apiInputs,
      });
    }

    if (apiModel.context_length !== hardcoded.contextWindow) {
      discrepancies.push({
        model: hardcoded.id,
        field: "contextWindow",
        hardcoded: hardcoded.contextWindow,
        api: apiModel.context_length,
      });
    }

    if (apiModel.max_output_length !== hardcoded.maxTokens) {
      discrepancies.push({
        model: hardcoded.id,
        field: "maxTokens",
        hardcoded: hardcoded.maxTokens,
        api: apiModel.max_output_length,
      });
    }

    const apiInputCost = parseApiPrice(apiModel.pricing.prompt);
    const epsilon = 0.001;
    if (Math.abs(apiInputCost - hardcoded.cost.input) > epsilon) {
      discrepancies.push({
        model: hardcoded.id,
        field: "cost.input",
        hardcoded: hardcoded.cost.input,
        api: apiInputCost,
      });
    }

    const apiOutputCost = parseApiPrice(apiModel.pricing.completion);
    if (Math.abs(apiOutputCost - hardcoded.cost.output) > epsilon) {
      discrepancies.push({
        model: hardcoded.id,
        field: "cost.output",
        hardcoded: hardcoded.cost.output,
        api: apiOutputCost,
      });
    }

    const apiCacheReadCost = parseApiPrice(apiModel.pricing.input_cache_reads);
    if (Math.abs(apiCacheReadCost - hardcoded.cost.cacheRead) > epsilon) {
      discrepancies.push({
        model: hardcoded.id,
        field: "cost.cacheRead",
        hardcoded: hardcoded.cost.cacheRead,
        api: apiCacheReadCost,
      });
    }

    if (apiModel.supported_features !== undefined) {
      const apiSupportsReasoning = apiModel.supported_features.includes("reasoning");
      if (apiSupportsReasoning !== hardcoded.reasoning) {
        discrepancies.push({
          model: hardcoded.id,
          field: "reasoning",
          hardcoded: hardcoded.reasoning,
          api: apiSupportsReasoning,
        });
      }
    }
  }

  for (const apiModel of apiModels) {
    const hardcoded = hardcodedModels.find((m) => m.id === apiModel.id);
    if (!hardcoded) {
      discrepancies.push({
        model: apiModel.id,
        field: "exists",
        hardcoded: false,
        api: true,
      });
    }
  }

  return discrepancies;
}

describe("Synthetic models", () => {
  it("should match API model definitions", { timeout: 30000 }, async () => {
    const apiModels = await fetchApiModels();
    const discrepancies = compareModels(apiModels, SYNTHETIC_MODELS);

    if (discrepancies.length > 0) {
      console.error("\nModel discrepancies found:");
      console.error("==========================");
      for (const d of discrepancies) {
        if (d.field === "exists") {
          if (d.hardcoded) {
            console.error(`  ${d.model}: Missing from API`);
          } else {
            console.error(`  ${d.model}: Missing from hardcoded models (NEW)`);
          }
        } else {
          console.error(`  ${d.model}.${d.field}:`);
          console.error(`    hardcoded: ${JSON.stringify(d.hardcoded)}`);
          console.error(`    api:       ${JSON.stringify(d.api)}`);
        }
      }
      console.error("==========================\n");
    }

    expect(discrepancies).toHaveLength(0);
  });

  it("buildSyntheticProviderModels returns the static catalog with defaults", () => {
    const models = buildSyntheticProviderModels();
    expect(models.length).toBe(SYNTHETIC_MODELS.length);
    for (const model of models) {
      const compat = model.compat as Record<string, unknown> | undefined;
      expect(compat?.supportsDeveloperRole).toBe(false);
      expect(compat?.maxTokensField).toBe("max_tokens");
      if (model.reasoning) {
        expect(compat?.supportsReasoningEffort).toBe(true);
      }
    }
  });

  it("buildSyntheticProviderModelsFromApi merges API data with static overrides", () => {
    const apiModels: SyntheticApiModel[] = [
      {
        id: "hf:moonshotai/Kimi-K3",
        name: "moonshotai/Kimi-K3",
        provider: "synthetic",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        context_length: 524288,
        max_output_length: 65536,
        pricing: {
          prompt: "$0.000003",
          completion: "$0.000015",
          input_cache_reads: "$0.00000045",
          input_cache_writes: "0",
        },
        supported_features: ["reasoning"],
        reasoning_parameters: { efforts: ["low", "high", "max"] },
      },
    ];

    const models = buildSyntheticProviderModelsFromApi(apiModels);
    expect(models).toHaveLength(1);

    const model = models[0];
    expect(model.id).toBe("hf:moonshotai/Kimi-K3");
    expect(model.cost.input).toBe(3);
    expect(model.cost.cacheRead).toBeCloseTo(0.45);
    expect(model.thinkingLevelMap?.low).toBe("low");
    expect(model.thinkingLevelMap?.high).toBe("high");
    expect(model.thinkingLevelMap?.max).toBe("max");
    // Kimi-K3 rejects "none" upstream — reasoning cannot be disabled.
    expect(model.thinkingLevelMap?.off).toBeNull();
    expect(model.thinkingLevelMap?.minimal).toBeNull();
    expect(model.thinkingLevelMap?.medium).toBeNull();
    expect(model.thinkingLevelMap?.xhigh).toBeNull();
    const compat = model.compat as Record<string, unknown> | undefined;
    expect(compat?.supportsReasoningEffort).toBe(true);
  });

  it("buildSyntheticProviderModelsFromApi maps 'none' to off and hides unlisted levels", () => {
    const apiModels: SyntheticApiModel[] = [
      {
        id: "hf:zai-org/GLM-4.7-Flash",
        name: "zai-org/GLM-4.7-Flash",
        provider: "synthetic",
        input_modalities: ["text"],
        output_modalities: ["text"],
        context_length: 196608,
        max_output_length: 65536,
        pricing: {
          prompt: "$0.0000001",
          completion: "$0.0000005",
          input_cache_reads: "$0.00000002",
          input_cache_writes: "0",
        },
        supported_features: ["reasoning"],
        reasoning_parameters: { efforts: ["none", "low", "medium", "high"] },
      },
    ];

    const models = buildSyntheticProviderModelsFromApi(apiModels);
    expect(models[0]?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("buildSyntheticProviderModelsFromApi falls back to the static map without reasoning_parameters", () => {
    const apiModels: SyntheticApiModel[] = [
      {
        id: "hf:moonshotai/Kimi-K3",
        name: "moonshotai/Kimi-K3",
        provider: "synthetic",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        context_length: 524288,
        max_output_length: 65536,
        pricing: {
          prompt: "$0.000003",
          completion: "$0.000015",
          input_cache_reads: "$0.00000045",
          input_cache_writes: "0",
        },
        supported_features: ["reasoning"],
      },
    ];

    const models = buildSyntheticProviderModelsFromApi(apiModels);
    expect(models[0]?.thinkingLevelMap).toEqual(
      SYNTHETIC_MODELS.find((m) => m.id === "hf:moonshotai/Kimi-K3")?.thinkingLevelMap,
    );
  });

  it("static catalog thinkingLevelMaps match the API's declared efforts", async () => {
    const apiModels = await fetchApiModels();
    const levelKeys = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    for (const apiModel of apiModels) {
      const hardcoded = SYNTHETIC_MODELS.find((m) => m.id === apiModel.id);
      if (!hardcoded?.reasoning || !apiModel.reasoning_parameters) continue;
      const efforts = apiModel.reasoning_parameters.efforts;
      // Kimi-K3 rejects "none" upstream and cannot disable reasoning, so its
      // static map hides off; everything else maps "none" to off verbatim.
      const expected: Record<string, string | null> = {
        off: efforts.includes("none")
          ? "none"
          : (apiModel.hugging_face_id ?? apiModel.id).includes("Kimi")
            ? null
            : "none",
      };
      for (const level of levelKeys) {
        expected[level] = efforts.includes(level) ? level : null;
      }
      expect(hardcoded.thinkingLevelMap, apiModel.id).toEqual(expected);
    }
  });

  it("buildSyntheticProviderModelsFromApi preserves unknown API models", () => {
    const apiModels: SyntheticApiModel[] = [
      {
        id: "hf:new/model",
        name: "new/model",
        provider: "synthetic",
        input_modalities: ["text"],
        output_modalities: ["text"],
        context_length: 128000,
        max_output_length: 32768,
        pricing: {
          prompt: "$0.000001",
          completion: "$0.000002",
          input_cache_reads: "$0.000001",
          input_cache_writes: "0",
        },
        supported_features: ["reasoning"],
      },
    ];

    const models = buildSyntheticProviderModelsFromApi(apiModels);
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("hf:new/model");
    const compat = models[0]?.compat as Record<string, unknown> | undefined;
    expect(compat?.supportsReasoningEffort).toBe(true);
  });
});
