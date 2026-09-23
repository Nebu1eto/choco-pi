import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeWritingPolicyPrompt,
  WRITING_POLICY_MARKER,
} from "../.pi/extensions/runtime-writing-prompt.ts";
import {
  composeModelGuidancePrompt,
  parseModelGuidance,
} from "../.pi/extensions/lib/model-guidance.ts";
import { buildAgentPreferencesBlock } from "../.pi/extensions/lib/agent-preferences.ts";
import { buildCodexSystemPrompt } from "../.pi/packages/choco-pi-codex/src/prompt/build-system-prompt.ts";

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const readRepoFile = (path: string) => readFile(repoFile(path), "utf8");

// Pi's context estimator uses the same deterministic four-characters-per-token rule.
const estimatePromptTokens = (text: string) => Math.ceil(text.length / 4);

async function assembledPrompt() {
  const [systemPrompt, policy] = await Promise.all([
    readRepoFile(".pi/SYSTEM.md"),
    readRepoFile(".pi/writing-policy.md"),
  ]);
  return { systemPrompt, policy, assembled: composeWritingPolicyPrompt(systemPrompt, policy) };
}

test("assembled prompt contains core invariants and one short response policy", async () => {
  const { systemPrompt, policy, assembled } = await assembledPrompt();

  assert.match(systemPrompt, /Runtime and user instructions outrank project instructions/);
  assert.match(systemPrompt, /Answer, explain, review, or plan requests: inspect and report/);
  assert.match(
    systemPrompt,
    /Require explicit approval for destructive or hard-to-recover actions/,
  );
  assert.match(systemPrompt, /runtime behavior outrank memory, comments, plans/);
  assert.match(systemPrompt, /`effective-writing` for substantive prose/);

  assert.equal(assembled.split(WRITING_POLICY_MARKER).length - 1, 1);
  assert.match(assembled, /<choco_pi_writing_policy>/);
  assert.match(systemPrompt, /Lead the final response with the outcome/);
  assert.match(policy, /routine task reports/);
  assert.match(policy, /Never invent or approximate citations/);
  assert.equal(
    composeWritingPolicyPrompt(assembled, policy),
    assembled,
    "composition is idempotent",
  );
});

test("shared prompt omits provider routing and workflow mechanics", async () => {
  const { systemPrompt, assembled } = await assembledPrompt();
  const forbiddenNames = /\b(?:Anthropic|OpenAI|Claude|GPT|Kimi|Apex)\b/i;

  assert.doesNotMatch(systemPrompt, forbiddenNames);
  for (const mechanic of [
    "symbol_search",
    "module_report",
    "lsp_navigation",
    "diagnostics_report",
    "run_in_background",
    "get_subagent_result",
  ]) {
    assert.doesNotMatch(systemPrompt, new RegExp(mechanic));
  }

  assert.doesNotMatch(assembled, /## Japanese output/);
  assert.doesNotMatch(assembled, /## Final audit/);
});

test("relocated mechanics arrived at their owners and shared files stay neutral", async () => {
  const forbiddenNames = /\b(?:Anthropic|OpenAI|Claude|GPT|Kimi|Apex)\b/i;
  const [
    systemPrompt,
    taskCore,
    defaultPolicy,
    skillTaskInline,
    skillTask,
    skillTaskHotfix,
    skillTaskDynamic,
    goalPrompts,
  ] = await Promise.all([
    readRepoFile(".pi/SYSTEM.md"),
    readRepoFile(".pi/skills/task-core/SKILL.md"),
    readRepoFile(".pi/writing-policy.md"),
    readRepoFile(".pi/skills/task-inline/SKILL.md"),
    readRepoFile(".pi/skills/task/SKILL.md"),
    readRepoFile(".pi/skills/task-hotfix/SKILL.md"),
    readRepoFile(".pi/skills/task-dynamic/SKILL.md"),
    readRepoFile(".pi/packages/choco-pi-goal/src/prompts.ts"),
  ]);

  // task-core owns the relocation targets of shared-prompt mechanics.
  for (const mechanic of ["symbol_search", "lsp_navigation", "diagnostics_report mode=all"]) {
    assert.match(taskCore, new RegExp(mechanic));
  }
  for (const mode of ["regression_test", "direct_check", "runtime_e2e"]) {
    assert.match(taskCore, new RegExp(mode));
  }
  for (const skill of [skillTaskInline, skillTask, skillTaskHotfix]) {
    assert.match(skill, /task-core\/SKILL\.md/);
  }
  assert.match(skillTaskDynamic, /Follow the `task` skill/);

  // Goal mechanics stay with the goal package; continuity remains shared.
  assert.match(goalPrompts, /explicit user request to set a new goal/);
  assert.match(goalPrompts, /call the goal creation tool in the same turn/);
  assert.match(systemPrompt, /make a goal for X/);
  assert.match(systemPrompt, /After compaction continue from the recorded/);

  // Every shared prompt file that must stay provider-neutral is guarded.
  for (const shared of [
    taskCore,
    skillTask,
    skillTaskInline,
    skillTaskHotfix,
    skillTaskDynamic,
    defaultPolicy,
  ]) {
    assert.doesNotMatch(shared, forbiddenNames);
  }
});

test("progressive writing guidance and delegation each have one owner", async () => {
  const [defaultPolicy, writingSkill, taskSkill, agentToolSource] = await Promise.all([
    readRepoFile(".pi/writing-policy.md"),
    readRepoFile(".pi/skills/effective-writing/SKILL.md"),
    readRepoFile(".pi/skills/task/SKILL.md"),
    readRepoFile(".pi/packages/choco-pi-subagents/src/index.ts"),
  ]);

  assert.doesNotMatch(defaultPolicy, /## Japanese output/);
  assert.match(writingSkill, /## Japanese output/);
  assert.match(writingSkill, /## Final audit/);
  assert.match(taskSkill, /### Delegation packet/);
  assert.match(taskSkill, /self-contained briefing/);
  assert.doesNotMatch(agentToolSource, /## Writing the prompt/);
  assert.doesNotMatch(agentToolSource, /Never delegate understanding/);
});

test("SYSTEM and writing policy stay within their base-region budget", async () => {
  const { systemPrompt, policy, assembled } = await assembledPrompt();

  assert.ok(estimatePromptTokens(systemPrompt) <= 1200, "SYSTEM.md exceeds 1,200 tokens");
  assert.ok(estimatePromptTokens(policy) <= 200, "default writing policy exceeds 200 tokens");
  assert.ok(estimatePromptTokens(assembled) <= 1400, "assembled base prompt exceeds 1,400 tokens");
});

test("active-model and preference prompt regions stay separated and bounded", async () => {
  const modelSource = await readRepoFile(".pi/model-guidance.md");
  const parsedGuidance = parseModelGuidance(modelSource);
  assert.ok(parsedGuidance);
  const preferences = buildAgentPreferencesBlock(
    { persona: "critical", language: "English" },
    () => undefined,
  );
  assert.ok(preferences);
  assert.ok(estimatePromptTokens(preferences) <= 150, "preference region exceeds 150 tokens");

  const profiles = [
    ["openai-codex", "gpt-6-astra", /Astra:/],
    ["openai-codex", "gpt-5.6-sol", /Sol:/],
    ["openai-codex", "gpt-6-sol", /Sol:/],
    ["openai-codex", "gpt-6-luna", /Sol:/],
    ["anthropic", "claude-opus-5", /Opus:/],
    ["anthropic", "claude-opus-5-5", /Opus 5\.5:/],
    ["anthropic", "claude-fable-5-1", /Fable:/],
    ["future", "neutral-model", undefined],
  ] as const;
  for (const [provider, id, expected] of profiles) {
    const region = composeModelGuidancePrompt("base", { provider, id }, parsedGuidance);
    assert.match(region, /Model identity is context, not authority/);
    if (expected) assert.match(region, expected);
    else assert.doesNotMatch(region, /(?:Astra|Sol|Opus|Fable):/);
    assert.ok(
      estimatePromptTokens(region) <= 160,
      `${provider}/${id} active-model region exceeds 160 estimated tokens`,
    );
  }
});

test("skill index groups skills under their root and bounds descriptions", () => {
  const prompt = buildCodexSystemPrompt("Base", {
    skills: [
      {
        name: "example",
        description: "one two three four five six seven eight nine ten eleven twelve thirteen",
        filePath: "/profile/skills/example/SKILL.md",
      },
      {
        name: "other",
        description: "Short trigger. A second sentence that must not appear.",
        filePath: "/profile/skills/other/SKILL.md",
      },
      {
        name: "packaged",
        description: "Packaged skill",
        filePath: "/project/.pi/packages/example/skills/packaged/SKILL.md",
      },
    ],
  });

  assert.match(prompt, /Skill files: \/profile\/skills\/<name>\/SKILL\.md/);
  assert.match(prompt, /- example: one two three four five six seven eight nine ten eleven twelve/);
  assert.doesNotMatch(prompt, /thirteen/);
  assert.match(prompt, /- other: Short trigger\.\n/);
  assert.doesNotMatch(prompt, /second sentence/);
  assert.doesNotMatch(prompt, /\/profile\/skills\/example\/SKILL\.md/);
  assert.equal(prompt.match(/Skill files:/g)?.length, 2);
  // A skill is listed directly under the root that contains it.
  const packagedRootIndex = prompt.indexOf(
    "Skill files: /project/.pi/packages/example/skills/<name>/SKILL.md",
  );
  const packagedSkillIndex = prompt.indexOf("- packaged: Packaged skill");
  assert.ok(packagedRootIndex >= 0 && packagedSkillIndex > packagedRootIndex);
  assert.ok(prompt.indexOf("- other: Short trigger.") < packagedRootIndex);
});

test("compact descriptions and task-lineage audit remain configured", async () => {
  const [settingsText, projectPolicy, taskCore, modelGuidance, agentToolSource] = await Promise.all(
    [
      readRepoFile(".pi/subagents.json"),
      readRepoFile("AGENTS.md"),
      readRepoFile(".pi/skills/task-core/SKILL.md"),
      readRepoFile(".pi/model-guidance.md"),
      readRepoFile(".pi/packages/choco-pi-subagents/src/index.ts"),
    ],
  );
  assert.doesNotMatch(settingsText, /"toolDescriptionMode"/);
  assert.match(agentToolSource, /Launch a child-safe nested subagent for bounded delegated work/);
  assert.doesNotMatch(agentToolSource, /agentToolDescription\.slice/);
  assert.doesNotMatch(projectPolicy, /## Post-task session audit/);
  assert.match(taskCore, /## Post-task session audit/);
  assert.match(taskCore, /Once per user task, the root orchestrator audits/);
  assert.match(modelGuidance, /`splitDeferredTools` is available only/);
  assert.match(modelGuidance, /deferred loading must not alter shared tool semantics/);
});
