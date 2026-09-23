import assert from "node:assert/strict";
import test from "node:test";
import {
  composeWritingPolicyPrompt,
  WRITING_POLICY_MARKER,
} from "../.pi/extensions/runtime-writing-prompt.ts";
import { buildCodexSystemPrompt } from "../.pi/packages/choco-pi-codex/src/prompt/build-system-prompt.ts";

test("writing policy composes once and recomposition is idempotent", () => {
  const assembled = composeWritingPolicyPrompt("BASE", "POLICY BODY");

  assert.equal(assembled.split(WRITING_POLICY_MARKER).length - 1, 1);
  assert.ok(assembled.startsWith("BASE"));
  assert.ok(assembled.includes("POLICY BODY"));
  assert.equal(composeWritingPolicyPrompt(assembled, "POLICY BODY"), assembled);
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
