import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REVIEW_INFO,
  VERDICT_INFO,
  parseStructuredBlock,
} from "../.pi/extensions/lib/verdict-blocks.ts";

function frontmatter(path: string): string {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.ok(source.startsWith("---\n"), `${path}: expected YAML frontmatter`);
  const end = source.indexOf("\n---\n", 4);
  assert.ok(end >= 0, `${path}: expected closing YAML frontmatter delimiter`);
  return source.slice(4, end);
}

test("internal workflow skills are hidden from model invocation; entry skills are not", () => {
  for (const path of [".pi/skills/task-core/SKILL.md", ".pi/skills/task-dynamic/SKILL.md"]) {
    assert.match(frontmatter(path), /^disable-model-invocation: true$/m, path);
  }
  for (const path of [
    ".pi/skills/task/SKILL.md",
    ".pi/skills/task-inline/SKILL.md",
    ".pi/skills/task-hotfix/SKILL.md",
    ".pi/skills/review/SKILL.md",
    ".pi/skills/verify/SKILL.md",
  ]) {
    assert.doesNotMatch(frontmatter(path), /disable-model-invocation/, path);
  }
});

/** Every fenced block with `info` in `path`, each wrapped as a one-block message for the parser. */
async function exampleBlocks(path: string, info: string): Promise<string[]> {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const pattern = new RegExp("^```" + info + "\\n[\\s\\S]*?^```$", "gmu");
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

test("the documented review and verdict block examples parse as valid blocks", async () => {
  const review = await exampleBlocks(".pi/review-policy.md", REVIEW_INFO);
  assert.equal(review.length, 1, "the review policy shows one choco-pi-review example");
  for (const block of review) {
    assert.deepEqual(parseStructuredBlock(block, REVIEW_INFO).status, "parsed", block);
  }
  const verdict = await exampleBlocks(".pi/skills/verify/SKILL.md", VERDICT_INFO);
  assert.equal(verdict.length, 1, "the verify skill shows one choco-pi-verdict example");
  for (const block of verdict) {
    assert.deepEqual(parseStructuredBlock(block, VERDICT_INFO).status, "parsed", block);
  }
});

test("a fully traced rule violation is a finding without execution; a candidate names its missing link", async () => {
  const read = (path: string): Promise<string> =>
    readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [policy, role, taskCore] = await Promise.all([
    read(".pi/review-policy.md"),
    read(".pi/agents/reviewer.md"),
    read(".pi/skills/task-core/SKILL.md"),
  ]);
  assert.match(policy, /A finding needs no execution\./);
  assert.match(policy, /`evidence` names the missing or assumed link\./);
  assert.match(role, /is a finding even if you ran nothing/);
  assert.match(role, /missing or assumed link is a candidate/);
  assert.match(taskCore, /Settle every candidate like a finding; never skip one for its class\./);
});
