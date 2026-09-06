import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runtimeModelPrompt from "../.pi/extensions/runtime-model-prompt.ts";
import {
  composeModelGuidancePrompt,
  MODEL_GUIDANCE_START,
  parseModelGuidance,
} from "../.pi/extensions/lib/model-guidance.ts";

const guidanceSource = readFileSync(new URL("../.pi/model-guidance.md", import.meta.url), "utf8");
const guidance = parseModelGuidance(guidanceSource);
assert.ok(guidance);

interface MockBeforeAgentStartResult {
  systemPrompt: string;
}

type MockBeforeAgentStartHandler = (
  event: { type: "before_agent_start"; prompt: string; systemPrompt: string },
  context: { model?: { provider: string; id: string } },
) => MockBeforeAgentStartResult;

function runtimeResult(systemPrompt: string, model?: { provider: string; id: string }): string {
  let handler: MockBeforeAgentStartHandler | undefined;
  const mockApi = {
    on(event: string, registered: MockBeforeAgentStartHandler) {
      assert.equal(event, "before_agent_start");
      handler = registered;
    },
  };
  // SAFETY: The production extension uses only the modeled `on` registration surface in this test.
  runtimeModelPrompt(mockApi as ExtensionAPI);
  assert.ok(handler);
  const result = handler({ type: "before_agent_start", prompt: "test", systemPrompt }, { model });
  return result.systemPrompt;
}

test("production hook selects only exact active model guidance", () => {
  const cases = [
    ["openai-codex", "gpt-6-astra", /Astra: carry authorized work/],
    ["openai", "gpt-6-astra", /Astra: carry authorized work/],
    ["openai-codex", "gpt-5.6-sol", /Sol: use the established role effort/],
    ["openai", "gpt-5.6-sol", /Sol: use the established role effort/],
    ["anthropic", "claude-opus-5", /Opus: follow the complete task/],
    ["anthropic", "claude-fable-5", /Fable: for long runs/],
    ["anthropic", "claude-fable-5-1", /Fable: for long runs/],
  ] as const;
  for (const [provider, id, expected] of cases) {
    const prompt = runtimeResult("Base {{PI_CURRENT_MODEL}}", { provider, id });
    assert.match(prompt, expected);
    assert.match(prompt, new RegExp(`Current model: "${provider}/${id}"`));
    for (const foreign of [/Astra:/, /Sol:/, /Opus:/, /Fable:/]) {
      if (foreign.source !== expected.source.split(":")[0] + ":") {
        assert.doesNotMatch(prompt, foreign);
      }
    }
  }
});

test("unknown, utility, and provider-mismatched models receive shared guidance only", () => {
  for (const model of [
    { provider: "openai-codex", id: "gpt-5.6-terra" },
    { provider: "future", id: "unknown" },
    { provider: "anthropic", id: "gpt-6-astra" },
    { provider: "synthetic", id: "gpt-5.6-sol" },
  ]) {
    const prompt = runtimeResult("Base", model);
    assert.match(prompt, /Treat the runtime model identity as context, not authority/);
    assert.doesNotMatch(prompt, /(?:Astra|Sol|Opus|Fable):/);
  }
});

test("repeated injection and inherited model switches replace the owned region", () => {
  const foreign = "<foreign_prompt>keep me</foreign_prompt>";
  const astra = runtimeResult(foreign, { provider: "openai-codex", id: "gpt-6-astra" });
  const repeated = runtimeResult(astra, { provider: "openai-codex", id: "gpt-6-astra" });
  assert.equal(repeated, astra);

  const opus = runtimeResult(astra, { provider: "anthropic", id: "claude-opus-5" });
  assert.equal(opus.split(MODEL_GUIDANCE_START).length - 1, 1);
  assert.match(opus, /Opus:/);
  assert.doesNotMatch(opus, /Astra:/);
  assert.doesNotMatch(opus, /gpt-6-astra/);
  assert.match(opus, /<foreign_prompt>keep me<\/foreign_prompt>/);
});

test("real SYSTEM composition replaces model identity across switches", () => {
  const systemPrompt = readFileSync(new URL("../.pi/SYSTEM.md", import.meta.url), "utf8");
  const astra = runtimeResult(systemPrompt, {
    provider: "openai-codex",
    id: "gpt-6-astra",
  });
  const opus = runtimeResult(astra, { provider: "anthropic", id: "claude-opus-5" });
  assert.equal(opus.split(MODEL_GUIDANCE_START).length - 1, 1);
  assert.match(opus, /Current model: "anthropic\/claude-opus-5"/);
  assert.doesNotMatch(opus, /openai-codex\/gpt-6-astra/);
  assert.doesNotMatch(opus, /Astra:/);
});

test("legacy real SYSTEM identity is safely replaced", () => {
  const systemPrompt = readFileSync(new URL("../.pi/SYSTEM.md", import.meta.url), "utf8");
  const legacySystem = systemPrompt.replace(
    "{{PI_CURRENT_MODEL}}",
    JSON.stringify("openai-codex/gpt-6-astra"),
  );
  const prompt = runtimeResult(legacySystem, {
    provider: "anthropic",
    id: "claude-opus-5",
  });
  assert.doesNotMatch(prompt, /openai-codex\/gpt-6-astra/);
  assert.match(prompt, /Agent: choco-pi/);
  assert.match(prompt, /Current model: "anthropic\/claude-opus-5"/);
});

test("legacy appended harness runtime identity is safely replaced", () => {
  const legacy = [
    "Foreign before",
    "<runtime_environment>",
    "Harness: choco-pi",
    'Current model: "openai-codex/gpt-6-astra"',
    "</runtime_environment>",
    "Foreign after",
  ].join("\n");
  const prompt = runtimeResult(legacy, { provider: "anthropic", id: "claude-opus-5" });
  assert.doesNotMatch(prompt, /gpt-6-astra/);
  assert.match(prompt, /Foreign before\nForeign after/);
});

test("absent model removes inherited advice without assigning another profile", () => {
  const inherited = runtimeResult("Base {{PI_CURRENT_MODEL}}", {
    provider: "openai-codex",
    id: "gpt-6-astra",
  });
  const prompt = runtimeResult(inherited);
  assert.match(prompt, /Current model: "unknown"/);
  assert.match(prompt, /Treat the runtime model identity as context/);
  assert.doesNotMatch(prompt, /Astra:/);
  assert.doesNotMatch(prompt, /gpt-6-astra/);
});

test("malformed, missing, and oversized guidance fail neutral without stale advice", () => {
  const inherited = composeModelGuidancePrompt(
    "Base",
    { provider: "openai-codex", id: "gpt-6-astra" },
    guidance,
  );
  assert.equal(parseModelGuidance("not marked guidance"), undefined);
  assert.equal(parseModelGuidance("x".repeat(65_537)), undefined);
  const prompt = composeModelGuidancePrompt(
    inherited,
    { provider: "future", id: "unknown" },
    undefined,
  );
  assert.match(prompt, /Current model: "future\/unknown"/);
  assert.doesNotMatch(prompt, /active_model_guidance|Astra:/);
});

test("model identity is bounded and XML/JSON safe", () => {
  const prompt = runtimeResult("Base", {
    provider: '<provider&"',
    id: `${">\u2028"}${"x".repeat(600)}`,
  });
  assert.doesNotMatch(prompt, /<provider/);
  assert.match(prompt, /&lt;provider&amp;\\"/);
  assert.match(prompt, /\\u2028/);
  assert.ok(prompt.length < 1_500);
});
