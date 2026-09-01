import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeWritingPolicyPrompt,
  WRITING_POLICY_MARKER,
} from "../.pi/extensions/runtime-writing-prompt.ts";

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
  assert.match(systemPrompt, /Answer, explain, review, plan, or report: inspect and respond/);
  assert.match(
    systemPrompt,
    /Require explicit approval for destructive or hard-to-recover actions/,
  );
  assert.match(systemPrompt, /Current evidence outranks memory, comments, plans/);
  assert.match(systemPrompt, /Load `effective-writing` only/);

  assert.equal(assembled.split(WRITING_POLICY_MARKER).length - 1, 1);
  assert.match(assembled, /<choco_pi_writing_policy>/);
  assert.match(systemPrompt, /final response stands alone and leads with the outcome/);
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
  ] = await Promise.all([
    readRepoFile(".pi/SYSTEM.md"),
    readRepoFile(".pi/skills/task-core/SKILL.md"),
    readRepoFile(".pi/writing-policy.md"),
    readRepoFile(".pi/skills/task-inline/SKILL.md"),
    readRepoFile(".pi/skills/task/SKILL.md"),
    readRepoFile(".pi/skills/task-hotfix/SKILL.md"),
    readRepoFile(".pi/skills/task-dynamic/SKILL.md"),
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

  // Goal authority and post-compaction continuity stay owned by SYSTEM.md.
  assert.match(systemPrompt, /goal-mode request /);
  assert.match(systemPrompt, /make a goal for X/);
  assert.match(systemPrompt, /After compaction continue from the summary/);

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

test("assembled prompt stays within the context budget", async () => {
  const { systemPrompt, policy, assembled } = await assembledPrompt();

  assert.ok(estimatePromptTokens(systemPrompt) <= 1350, "SYSTEM.md exceeds 1,350 tokens");
  assert.ok(estimatePromptTokens(policy) <= 175, "default writing policy exceeds 175 tokens");
  assert.ok(estimatePromptTokens(assembled) <= 1550, "assembled base prompt exceeds 1,550 tokens");
});

test("compact descriptions and global session audit remain configured", async () => {
  const [settingsText, projectPolicy, modelGuidance, agentToolSource] = await Promise.all([
    readRepoFile(".pi/subagents.json"),
    readRepoFile("AGENTS.md"),
    readRepoFile(".pi/model-guidance.md"),
    readRepoFile(".pi/packages/choco-pi-subagents/src/index.ts"),
  ]);
  const compactStart = agentToolSource.indexOf("const compactAgentToolDescription");
  const fullStart = agentToolSource.indexOf("const fullAgentToolDescription", compactStart);

  assert.match(settingsText, /"toolDescriptionMode": "compact"/);
  assert.notEqual(compactStart, -1);
  assert.notEqual(fullStart, -1);
  const compactDescription = agentToolSource.slice(compactStart, fullStart);
  assert.doesNotMatch(compactDescription, /\b(?:Anthropic|OpenAI|Claude|GPT|Kimi|Apex)\b/i);
  assert.ok(
    estimatePromptTokens(compactDescription) <= 320,
    "compact Agent description source exceeds 320 tokens",
  );
  assert.match(projectPolicy, /## Post-task session audit/);
  assert.match(projectPolicy, /Once per user task, the root orchestrator audits/);
  assert.match(modelGuidance, /`splitDeferredTools` is implemented only/);
  assert.match(modelGuidance, /deferred tool loading remains an OpenAI-only optimization/);
});
