import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentManager } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import {
  setRequireExplicitModel,
  tierRefusal,
  withOverrideReason,
} from "../src/invocation-config.ts";
import { loadFlagshipModels } from "../src/model-tiers.ts";
import type { AgentConfig } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

function role(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "worker",
    description: "worker",
    extensions: false,
    skills: false,
    systemPrompt: "work",
    promptMode: "replace",
    ...overrides,
  };
}

const flagship = await loadFlagshipModels();
const FABLE = "anthropic/claude-fable-5-1";

test("repository fallbacks file yields the Flagship tier", () => {
  assert.ok(flagship.has(FABLE));
  assert.ok(flagship.has("openai-codex/gpt-6-astra"));
  assert.ok(!flagship.has("anthropic/claude-opus-5-5"));
});

test("implementer on a Flagship model needs a reason", () => {
  const implementer = role({ model: "anthropic/claude-opus-5-5" });
  const refusal = tierRefusal("implementer", implementer, { model: FABLE }, flagship);
  assert.equal(
    refusal,
    'Spawn refused: "anthropic/claude-fable-5-1" is a Flagship-tier model and role "implementer" declares anthropic/claude-opus-5-5; pass model_override_reason with the .pi/model-guidance.md reason, or choose a Workhorse/Utility model.',
  );
  assert.equal(
    tierRefusal(
      "implementer",
      implementer,
      { model: FABLE, model_override_reason: "  needs deep audit " },
      flagship,
    ),
    undefined,
  );
  assert.equal(
    tierRefusal(
      "implementer",
      implementer,
      { model: FABLE, model_override_reason: "  " },
      flagship,
    )?.startsWith("Spawn refused"),
    true,
  );
  assert.equal(
    withOverrideReason("Model: a/b (source: caller)", " needs deep audit "),
    "Model: a/b (source: caller) · override reason: needs deep audit",
  );
  assert.equal(withOverrideReason("Model: a/b", undefined), "Model: a/b");
});

test("roles declaring Flagship and non-Flagship models pass", () => {
  const reviewer = role({ model: "openai-codex/gpt-6-astra" });
  const planner = role({ model: FABLE });
  assert.equal(
    tierRefusal("reviewer", reviewer, { model: "openai-codex/gpt-6-astra" }, flagship),
    undefined,
  );
  assert.equal(tierRefusal("planner", planner, { model: FABLE }, flagship), undefined);
  assert.equal(tierRefusal("implementer", role({}), { model: "anthropic/x" }, flagship), undefined);
  assert.equal(tierRefusal("implementer", role({}), {}, flagship), undefined);
});

test("openai/<id> aliases the openai-codex tier", () => {
  const explore = role({ model: "openai-codex/gpt-6.1-sol" });
  assert.match(
    tierRefusal("explore", explore, { model: "openai/gpt-6-astra" }, flagship) ?? "",
    /Spawn refused: "openai\/gpt-6-astra" is a Flagship-tier model and role "explore"/,
  );
});

test("missing or invalid fallbacks file fails open", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tier-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = join(dir, "bad.json");
  await writeFile(bad, '{"tiers":');
  const wrong = join(dir, "wrong.json");
  await writeFile(wrong, '{"tiers":{"flagship":{"primary":[1]}}}');
  for (const path of [join(dir, "missing.json"), bad, wrong]) {
    const tiers = await loadFlagshipModels(path);
    assert.equal(tiers.size, 0);
    assert.equal(tierRefusal("implementer", role({}), { model: FABLE }, tiers), undefined);
  }
});

test("root Agent tool refuses a Flagship fresh spawn without a reason before spawning", async (t) => {
  const parent = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => parent.session.dispose());
  let spawns = 0;
  t.mock.method(AgentManager.prototype, "spawn", () => {
    spawns += 1;
    return "never";
  });
  const agentTool = parent.session.extensionRunner.getToolDefinition("Agent");
  assert.ok(agentTool);
  setRequireExplicitModel(true);
  const signal = new AbortController().signal;
  const result = await agentTool.execute(
    "call",
    {
      prompt: "task",
      description: "task",
      subagent_type: "general-purpose",
      model: FABLE,
      thinking: "low",
      run_in_background: true,
    },
    signal,
    () => undefined,
    parent.session.extensionRunner.createToolContext("call", signal),
  );
  const first = result.content[0];
  const textOut = first?.type === "text" ? first.text : "";
  assert.match(textOut, /Spawn refused: "anthropic\/claude-fable-5-1" is a Flagship-tier model/);
  assert.equal(spawns, 0);
});
