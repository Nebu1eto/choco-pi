// /review-assist with no argument outside the terminal UI: the same target choices as the TUI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExecRunner, ResolvedReviewConfig } from "../.pi/extensions/review/core/types.ts";
import { presentHeadlessReview } from "../.pi/extensions/review/headless.ts";

const execFileAsync = promisify(execFile);
const TEMP = tmpdir();
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function inTemp(path: string): void {
  assert.ok(path.startsWith(TEMP + sep) || path.startsWith(`/private${TEMP}${sep}`), path);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  inTemp(cwd);
  await execFileAsync("git", args, { cwd, env: FIXTURE_ENV });
}

/**
 * Real git inside the fixture; gh is never run (no network), it just fails.
 * Callers only tell success from failure, so a failure is reported as status 1.
 */
const runner: ExecRunner = (command, args, options) => {
  if (command !== "git") {
    return Promise.resolve({ stdout: "", stderr: "gh is not available in this test", code: 1 });
  }
  inTemp(options?.cwd ?? "");
  return new Promise((resolve) => {
    execFile("git", args, { cwd: options?.cwd, env: FIXTURE_ENV }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error === null ? 0 : 1 });
    });
  });
};

const config = {
  editor: { command: ["zed"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 1, maxDiffLines: 1 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
} satisfies ResolvedReviewConfig;

test("on branch feature, the headless picker offers a base other than feature and never feature", async (t) => {
  const root = await realpath(await mkdtemp(join(TEMP, "review-headless-picker-")));
  inTemp(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  await git(root, "branch", "other");
  await git(root, "checkout", "-q", "-b", "feature");

  const offered: string[] = [];
  const sent: string[] = [];
  await presentHeadlessReview({
    request: { action: "pick" },
    cwd: root,
    sessionId: "session",
    ui: {
      notify: (message) => sent.push(message),
      select: async (_title, options) => {
        offered.push(...options);
        return undefined;
      },
    },
    dependencies: {
      store: { load: async () => undefined, save: async () => {}, list: async () => [] },
      runner,
      loadConfig: async () => config,
      checkpointProvider: { listTurns: async () => [] },
      readTargetDiff: async () => assert.fail("nothing was picked"),
      isCurrent: () => true,
      env: {},
    },
  });

  const bases = offered.filter((label) => label.startsWith("Branch base: "));
  assert.deepEqual(bases, ["Branch base: main", "Branch base: other"], "default base first");
  assert.equal(bases.includes("Branch base: feature"), false);
  assert.ok(offered.includes("Uncommitted changes"));
  assert.ok(sent.some((message) => message.startsWith("Pull request targets are unavailable: ")));
  assert.ok(sent.includes("Review target selection was cancelled."));
});
