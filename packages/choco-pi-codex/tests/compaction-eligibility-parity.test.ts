import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type CodexConversionConfig,
  DEFAULT_CODEX_CONVERSION_CONFIG,
} from "../src/adapter/activation/config.ts";
import {
  resolveCodexRuntimePlan,
  resolveCodexRuntimePlanForState,
  resolveNativeCompactionEligibility,
  resolveNativeCompactionEligibilityForState,
} from "../src/adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexCompactionEligibility } from "../src/extension/compaction-eligibility.ts";
import { readCodexEligibility, resolveOwner } from "../../choco-pi-compaction/src/ownership.ts";

function modelOf(provider: string, api: Api, id: string, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 2048,
  };
}

const MODELS = {
  codex: modelOf(
    "openai-codex",
    "openai-codex-responses",
    "gpt-6-luna",
    "https://chatgpt.com/backend-api",
  ),
  alias: modelOf(
    "team-codex",
    "openai-codex-responses",
    "gpt-6-luna",
    "https://chatgpt.com/backend-api",
  ),
  openai: modelOf("openai", "openai-responses", "gpt-6-luna", "https://api.openai.com/v1"),
  corp: modelOf("corp", "openai-responses", "corp-large", "https://corp.example/v1"),
  anthropic: modelOf(
    "anthropic",
    "anthropic-messages",
    "claude-fable",
    "https://api.anthropic.com",
  ),
} as const;

type ConfigEdit = (config: CodexConversionConfig) => void;
const CONFIGS = {
  "compaction off": (config) => {
    config.compaction.responsesCompaction = false;
  },
  "on, all providers": () => {},
  "allProviders=off": (config) => {
    config.scope.allProviders = "off";
  },
  "allProviders=off + configured provider": (config) => {
    config.scope.allProviders = "off";
    config.scope.additionalProviders = ["corp"];
  },
  "extras scope": (config) => {
    config.scope.allProviders = "extras";
    config.tools.applyPatchOnly = true;
  },
  "extras via tool-only, allProviders=off": (config) => {
    config.scope.allProviders = "off";
    config.tools.viewImageOnly = true;
  },
  "voice-only": (config) => {
    config.voiceFeaturesOnly = true;
  },
  "voice-only with extras": (config) => {
    config.voiceFeaturesOnly = true;
    config.tools.webRunOnly = true;
  },
} satisfies Record<string, ConfigEdit>;

function configFor(edit: ConfigEdit): CodexConversionConfig {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.compaction.responsesCompaction = true;
  edit(config);
  return config;
}

test("eligibility equals resolveCodexRuntimePlan(...).nativeCompaction across exits (table)", () => {
  let natives = 0;
  let rows = 0;
  for (const [name, edit] of Object.entries(CONFIGS)) {
    const config = configFor(edit);
    for (const [modelName, model] of Object.entries(MODELS)) {
      for (const trusted of [undefined, true, false]) {
        const options = { canonicalAliasEndpointTrusted: trusted };
        const plan = resolveCodexRuntimePlan({ model }, config, config.executionMode, options);
        const eligible = resolveNativeCompactionEligibility(model, config, options);
        assert.equal(
          eligible,
          plan.nativeCompaction,
          `${name} / ${modelName} / trusted=${trusted}`,
        );
        rows++;
        if (eligible) natives++;
      }
    }
  }
  // The table exercises both outcomes, not only one exit.
  assert.ok(natives > 0 && natives < rows, `${natives}/${rows}`);
  // Pinned exits.
  const on = configFor(() => {});
  assert.equal(
    resolveNativeCompactionEligibility(MODELS.alias, on, { canonicalAliasEndpointTrusted: false }),
    false,
  );
  assert.equal(
    resolveNativeCompactionEligibility(MODELS.alias, on, { canonicalAliasEndpointTrusted: true }),
    true,
  );
  assert.equal(
    resolveNativeCompactionEligibility(MODELS.codex, configFor(CONFIGS["voice-only"])),
    false,
  );
  assert.equal(
    resolveNativeCompactionEligibility(MODELS.codex, configFor(CONFIGS["extras scope"])),
    false,
  );
  assert.equal(resolveNativeCompactionEligibility(MODELS.anthropic, on), false);
});

function stateFor(
  config: CodexConversionConfig,
): Pick<AdapterState, "config" | "canonicalAliasEndpoint"> {
  return { config, canonicalAliasEndpoint: undefined };
}

test("the published slot makes resolveOwner local exactly when eligibility is false", () => {
  const state = stateFor(configFor(() => {}));
  const eligibility = createCodexCompactionEligibility(() => state);
  eligibility.publish();
  try {
    const slot = readCodexEligibility();
    assert.ok(slot);
    for (const [name, edit] of Object.entries(CONFIGS)) {
      state.config = configFor(edit);
      for (const [modelName, model] of Object.entries(MODELS)) {
        const eligible = resolveNativeCompactionEligibilityForState(model, state);
        assert.equal(
          eligible,
          resolveCodexRuntimePlanForState(
            { model },
            { ...state, executionMode: state.config.executionMode, canonicalSearch: undefined },
          ).nativeCompaction,
        );
        assert.equal(slot.isNativeCompactionOwner(model), eligible, `${name} / ${modelName}`);
        // Compaction's own lanes are off here, so a non-Codex owner is local.
        const owner = resolveOwner({ model });
        assert.equal(owner === "local", !eligible, `${name} / ${modelName}: ${owner}`);
      }
    }
  } finally {
    eligibility.unpublish();
  }
});

test("the revision bumps on /codex ownership inputs only; alias trust counts once known", () => {
  const state = stateFor(configFor(() => {}));
  const eligibility = createCodexCompactionEligibility(() => state);
  eligibility.publish();
  const slot = readCodexEligibility();
  assert.ok(slot);
  const seen: number[] = [];
  const unsubscribe = slot.subscribe((revision) => seen.push(revision));
  const local: number[] = [];
  eligibility.onChange(() => local.push(1));
  try {
    const start = slot.revision;
    assert.equal(eligibility.refresh(), false);
    state.config = { ...state.config, openai: { ...state.config.openai, verbosity: "high" } };
    assert.equal(eligibility.refresh(), false, "unrelated settings do not bump");
    state.config = configFor(CONFIGS["compaction off"]);
    assert.equal(eligibility.refresh(), true);
    state.config = configFor(CONFIGS["voice-only"]);
    assert.equal(eligibility.refresh(), true);
    state.config = configFor(CONFIGS["allProviders=off + configured provider"]);
    assert.equal(eligibility.refresh(), true);
    state.config = configFor(CONFIGS["extras scope"]);
    assert.equal(eligibility.refresh(), true);
    state.canonicalAliasEndpoint = { modelKey: "k", trusted: true };
    assert.equal(eligibility.refresh(), true, "alias trust learned");
    state.canonicalAliasEndpoint = undefined;
    assert.equal(eligibility.refresh(), false, "clearing at model_select is not a change");
    state.canonicalAliasEndpoint = { modelKey: "k", trusted: true };
    assert.equal(eligibility.refresh(), false, "same trust restored");
    assert.equal(slot.revision, start + 5);
    assert.deepEqual(seen, [start + 1, start + 2, start + 3, start + 4, start + 5]);
    assert.equal(local.length, 5);
  } finally {
    unsubscribe();
    eligibility.unpublish();
  }
});

test("a second (child) registration neither answers nor bumps while the first is published", () => {
  const parentState = stateFor(configFor(() => {}));
  const childState = stateFor(configFor(CONFIGS["compaction off"]));
  const parent = createCodexCompactionEligibility(() => parentState);
  const child = createCodexCompactionEligibility(() => childState);
  parent.publish();
  const slot = readCodexEligibility();
  assert.ok(slot);
  const seen: number[] = [];
  const unsubscribe = slot.subscribe((revision) => seen.push(revision));
  try {
    child.publish();
    childState.config = configFor(CONFIGS["voice-only"]);
    child.refresh();
    assert.deepEqual(seen, []);
    assert.equal(slot.isNativeCompactionOwner(MODELS.codex), true, "the parent answers");
    child.unpublish();
    assert.deepEqual(seen, []);
    parent.unpublish();
    assert.equal(seen.length, 1, "the answering source left");
    assert.equal(slot.published, false);
    // With nothing published, ownership falls back to the snapshot heuristic.
    assert.equal(resolveOwner({ model: MODELS.codex }), "codex-native");
  } finally {
    unsubscribe();
    child.unpublish();
    parent.unpublish();
  }
});
