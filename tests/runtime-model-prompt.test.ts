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
const parsedGuidance = parseModelGuidance(guidanceSource);
if (!parsedGuidance) throw new Error(".pi/model-guidance.md must parse");
const guidance = parsedGuidance;
const modelBodies = [...new Set(guidance.models.values())];

// Two configured models with different sections, taken from the guidance file
// itself so the tests follow its routing instead of restating its wording.
const [first, second] = [...guidance.models.entries()]
  .filter(([, body], index, entries) => entries.findIndex(([, other]) => other === body) === index)
  .map(([key]) => {
    const separator = key.indexOf("/");
    return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
  });
assert.ok(first && second, "the guidance file configures at least two distinct sections");
const keyOf = (model: { provider: string; id: string }) => model.provider + "/" + model.id;

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

function assertOnlySection(prompt: string, expected: string | undefined): void {
  assert.ok(prompt.includes(guidance.shared), "shared guidance is always present");
  for (const body of modelBodies) {
    assert.equal(prompt.includes(body), body === expected);
  }
}

test("production hook injects exactly the configured section for every routed model", () => {
  for (const [key, body] of guidance.models) {
    const separator = key.indexOf("/");
    const model = { provider: key.slice(0, separator), id: key.slice(separator + 1) };
    const prompt = runtimeResult("Base {{PI_CURRENT_MODEL}}", model);
    assertOnlySection(prompt, body);
    assert.ok(prompt.includes("Current model: " + JSON.stringify(key)), key);
  }
});

test("unrouted and provider-mismatched models receive shared guidance only", () => {
  for (const model of [
    { provider: "future", id: "unknown" },
    { provider: "future", id: first.id },
  ]) {
    assertOnlySection(runtimeResult("Base", model), undefined);
  }
});

test("repeated injection and model switches replace the owned region", () => {
  const foreign = "<foreign_prompt>keep me</foreign_prompt>";
  const initial = runtimeResult(foreign, first);
  assert.equal(runtimeResult(initial, first), initial);

  const switched = runtimeResult(initial, second);
  assert.equal(switched.split(MODEL_GUIDANCE_START).length - 1, 1);
  assertOnlySection(switched, guidance.models.get(keyOf(second)));
  assert.ok(!switched.includes(JSON.stringify(keyOf(first))));
  assert.ok(switched.includes(foreign));
});

test("real SYSTEM composition replaces model identity across switches", () => {
  const systemPrompt = readFileSync(new URL("../.pi/SYSTEM.md", import.meta.url), "utf8");
  const switched = runtimeResult(runtimeResult(systemPrompt, first), second);
  assert.equal(switched.split(MODEL_GUIDANCE_START).length - 1, 1);
  assert.ok(switched.includes("Current model: " + JSON.stringify(keyOf(second))));
  assert.ok(!switched.includes(JSON.stringify(keyOf(first))));
});

test("legacy real SYSTEM identity is safely replaced", () => {
  const systemPrompt = readFileSync(new URL("../.pi/SYSTEM.md", import.meta.url), "utf8");
  const legacySystem = systemPrompt.replace("{{PI_CURRENT_MODEL}}", JSON.stringify(keyOf(first)));
  const prompt = runtimeResult(legacySystem, second);
  assert.ok(!prompt.includes(JSON.stringify(keyOf(first))));
  assert.ok(prompt.includes("Current model: " + JSON.stringify(keyOf(second))));
});

test("legacy appended harness runtime identity is safely replaced", () => {
  const legacy = [
    "Foreign before",
    "<runtime_environment>",
    "Harness: choco-pi",
    "Current model: " + JSON.stringify(keyOf(first)),
    "</runtime_environment>",
    "Foreign after",
  ].join("\n");
  const prompt = runtimeResult(legacy, second);
  assert.ok(!prompt.includes(JSON.stringify(keyOf(first))));
  assert.ok(prompt.includes("Foreign before\nForeign after"));
});

test("absent model removes inherited advice without assigning another section", () => {
  const prompt = runtimeResult(runtimeResult("Base {{PI_CURRENT_MODEL}}", first));
  assert.ok(prompt.includes('Current model: "unknown"'));
  assertOnlySection(prompt, undefined);
  assert.ok(!prompt.includes(JSON.stringify(keyOf(first))));
});

test("malformed, missing, and oversized guidance fail neutral without stale advice", () => {
  const inherited = composeModelGuidancePrompt("Base", first, guidance);
  assert.equal(parseModelGuidance("not marked guidance"), undefined);
  assert.equal(parseModelGuidance("x".repeat(65_537)), undefined);
  const prompt = composeModelGuidancePrompt(
    inherited,
    { provider: "future", id: "unknown" },
    undefined,
  );
  assert.ok(prompt.includes('Current model: "future/unknown"'));
  assert.ok(!prompt.includes("<active_model_guidance>"));
  for (const body of modelBodies) assert.ok(!prompt.includes(body));
});

test("model identity is bounded and XML/JSON safe", () => {
  const prompt = runtimeResult("Base", {
    provider: '<provider&"',
    id: ">\u2028" + "x".repeat(600),
  });
  assert.doesNotMatch(prompt, /<provider/);
  assert.match(prompt, /&lt;provider&amp;\\"/);
  assert.match(prompt, /\\u2028/);
  assert.ok(prompt.length < 1_500);
});
