import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  ]) {
    assert.doesNotMatch(frontmatter(path), /disable-model-invocation/, path);
  }
});
