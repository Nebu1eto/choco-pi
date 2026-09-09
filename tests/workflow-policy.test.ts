import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function frontmatter(source: string): string {
  assert.ok(source.startsWith("---\n"), "expected YAML frontmatter");
  const end = source.indexOf("\n---\n", 4);
  assert.ok(end >= 0, "expected closing YAML frontmatter delimiter");
  return source.slice(4, end);
}

function locateConfiguredSkill(name: string, directories: string[]): string | undefined {
  return directories.map((directory) => resolve(directory, name, "SKILL.md")).find(existsSync);
}

test("every review-capable workflow uses the shared immutable bundle policy", () => {
  const workflowPaths = [
    ".pi/skills/task/SKILL.md",
    ".pi/skills/task-inline/SKILL.md",
    ".pi/skills/task-hotfix/SKILL.md",
    ".pi/skills/task-dynamic/SKILL.md",
    ".pi/skills/task-core/SKILL.md",
    ".pi/skills/review/SKILL.md",
  ];

  for (const path of workflowPaths) {
    assert.match(
      readRepoFile(path),
      /review-bundle\.md/,
      `${path} must load the shared bundle policy`,
    );
  }

  const bundle = readRepoFile(".pi/skills/review/references/review-bundle.md");
  assert.match(bundle, /agent creating a review handoff owns bundle preparation/);
  assert.match(bundle, /target\.diff/);
  assert.match(bundle, /SHA-256 manifest/);
  assert.match(
    bundle,
    /complete snapshots? of every applicable `AGENTS\.md` and review-policy file/,
  );
  assert.match(bundle, /completion status.*repository revision or working-tree state/s);
  assert.match(bundle, /outputs? `INCOMPLETE`.*stops/s);

  const reviewer = readRepoFile(".pi/agents/reviewer.md");
  assert.match(reviewer, /review-bundle\.md/);
  assert.match(reviewer, /manifest digest/);
  assert.match(reviewer, /every listed checksum/);
  assert.match(reviewer, /output `INCOMPLETE`.*stop/s);
});

test("live review harness probes are maintainer opt-in", () => {
  const review = readRepoFile(".pi/skills/review/SKILL.md");
  const maintainer = readRepoFile(".pi/skills/review/references/maintainer-e2e.md");

  assert.doesNotMatch(review, /pi -p/);
  assert.match(review, /explicitly requests live fresh-Pi evidence/);
  assert.match(maintainer, /explicit opt-in harness-maintainer check/);
  assert.match(maintainer, /pi -p/);
});

test("internal workflows are hidden while configured skill directories keep the alias portable", () => {
  for (const path of [".pi/skills/task-core/SKILL.md", ".pi/skills/task-dynamic/SKILL.md"]) {
    assert.match(frontmatter(readRepoFile(path)), /^disable-model-invocation: true$/m);
  }

  for (const path of [
    ".pi/skills/task/SKILL.md",
    ".pi/skills/task-inline/SKILL.md",
    ".pi/skills/task-hotfix/SKILL.md",
    ".pi/skills/review/SKILL.md",
  ]) {
    assert.doesNotMatch(frontmatter(readRepoFile(path)), /disable-model-invocation/);
  }

  const alias = readRepoFile(".pi/prompts/task-dynamic.md");
  const reviewer = readRepoFile(".pi/agents/reviewer.md");
  const dynamic = readRepoFile(".pi/skills/task-dynamic/SKILL.md");
  const configuredSkills = fileURLToPath(new URL("../.pi/skills", import.meta.url));
  const resolvedDynamic = locateConfiguredSkill("task-dynamic", [
    resolve(configuredSkills, "missing"),
    configuredSkills,
  ]);

  assert.equal(resolvedDynamic, resolve(configuredSkills, "task-dynamic", "SKILL.md"));
  assert.match(alias, /available skill metadata/);
  assert.match(alias, /only Pi's `skills` configuration field/);
  assert.match(alias, /configured skill directories for `task-dynamic\/SKILL\.md`/);
  assert.match(alias, /resolve its relative references from its actual directory/);
  assert.match(reviewer, /available skill metadata/);
  assert.match(reviewer, /configured skill directories/);
  assert.match(reviewer, /`references\/review-bundle\.md` relative to the located `SKILL\.md`/);
  assert.match(dynamic, /`references\/review-bundle\.md` relative to that file/);

  for (const policy of [alias, reviewer, dynamic]) {
    assert.doesNotMatch(policy, /~\/\.pi\/agent\/skills\//);
  }
});

test("validation policy is acceptance-selected and provenance-bound", () => {
  const core = readRepoFile(".pi/skills/task-core/SKILL.md");
  const agents = readRepoFile("AGENTS.md");

  assert.match(core, /`check` skill owns environment readiness/);
  assert.match(core, /status, scope, repository revision or exact working-tree state/);
  assert.match(core, /pending, cancelled, stale, unavailable, or failed result is never a pass/);
  assert.match(core, /When changed files use a supported language and diagnostics are relevant/);
  assert.match(core, /Do not block an unrelated prose-only change/);
  assert.match(
    core,
    /Active-model guidance may also select review for a qualifying long-running task/,
  );
  assert.match(core, /Do not require or forbid a reviewer from the provider or model name alone/);

  for (const command of ["pnpm lint", "pnpm fmt:check", "pnpm typecheck", "pnpm test"]) {
    assert.ok(agents.includes(`\`${command}\``), `missing root completion gate: ${command}`);
  }

  for (const path of [
    ".pi/skills/task/SKILL.md",
    ".pi/skills/task-inline/SKILL.md",
    ".pi/skills/task-hotfix/SKILL.md",
  ]) {
    assert.doesNotMatch(readRepoFile(path), /run `check`[^\n]*repository gates/i);
  }
});

test("repository policy prohibits diagnostic bypasses and blocking executable code", async () => {
  const policyUrl = new URL("../AGENTS.md", import.meta.url);
  const agents = await readFile(policyUrl, "utf8");
  assert.match(agents, /Never bypass lint findings/);
  assert.match(agents, /Do not add suppression directives, disable or weaken rules, exclude files/);
  assert.match(agents, /Never ignore type errors/);
  assert.match(agents, /@ts-ignore.*@ts-nocheck.*@ts-expect-error.*unchecked casts.*`any`/s);
  assert.match(
    agents,
    /New or rewritten first-party executable code must be Node-erasable TypeScript/,
  );
  assert.match(agents, /Use non-blocking Node\.js APIs whenever an asynchronous equivalent exists/);
  assert.match(agents, /`\*Sync` variants, are prohibited in new or rewritten code/);
  assert.match(agents, /Required lint and typecheck gates must finish with zero errors/);
  assert.match(agents, /Pre-existing failures are not an exemption/);
  assert.match(
    agents,
    /report the blocker and request that scope rather than suppressing the failure/,
  );
});

test("review recovery preserves runner and evidence state", () => {
  const core = readRepoFile(".pi/skills/task-core/SKILL.md");
  const review = readRepoFile(".pi/skills/review/SKILL.md");

  assert.match(core, /observation wait ending without a result.*not evidence.*execution failed/s);
  assert.match(core, /execution failure or execution timeout.*only when the runner reports/s);
  assert.match(core, /cancellation request is `cancellation pending`.*terminal settlement/s);
  assert.match(core, /completed `INCOMPLETE` review.*not a pass/s);
  assert.match(core, /first reviewer the complete immutable packet/);
  assert.match(core, /instead of repeating the same wait, poll, or steer loop/);
  assert.match(
    core,
    /partial output may be independently validated.*do not make the review complete or clean/s,
  );
  assert.match(core, /never loop on an identical defective packet/);
  assert.match(core, /transient provider or capacity failure.*bounded retry and fallback policy/s);
  assert.match(core, /Do not ask an incomplete reviewer.*`NO_FINDINGS`/);
  assert.match(core, /task is blocked or partially complete/);
  assert.match(core, /do not declare completion.*partial `NO_FINDINGS`.*pass/s);

  assert.match(review, /follow `task-core`'s \*\*Observe and recover a review run\*\*/);
  assert.match(review, /observation timeout is not an execution failure/);
  assert.match(review, /completed `INCOMPLETE` result must remain incomplete/);
});

test("shared authority permits local implementation without weakening approval boundaries", () => {
  const system = readRepoFile(".pi/SYSTEM.md");
  const agents = readRepoFile("AGENTS.md");
  assert.match(system, /in-scope local edits and non-destructive local validation/);
  assert.match(system, /Require explicit approval for destructive or hard-to-recover actions/);
  assert.match(system, /Never reveal secrets, credentials, tokens, or keys/);
  assert.match(agents, /Before the first `await` or dynamic import, snapshot scalars/);
  assert.match(agents, /Settle lifecycle callbacks exactly once/);
  assert.match(agents, /rethrow unrelated failures/);
});

test("implementation workflows retain ownership and checkpoint boundaries", () => {
  const task = readRepoFile(".pi/skills/task/SKILL.md");
  const dynamic = readRepoFile(".pi/skills/task-dynamic/SKILL.md");
  assert.match(task, /exclusive direct and indirect write scope/);
  assert.match(dynamic, /scopes narrow down the tree/);

  for (const path of [
    ".pi/skills/task/SKILL.md",
    ".pi/skills/task-inline/SKILL.md",
    ".pi/skills/task-hotfix/SKILL.md",
  ]) {
    assert.match(readRepoFile(path), /Unless the user explicitly excluded a commit/);
  }
});
