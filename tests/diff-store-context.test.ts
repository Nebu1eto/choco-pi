import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MAX_EXCERPT_LINES, type DiffStore } from "../.pi/extensions/lib/changes/git/model.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";

const execFileAsync = promisify(execFile);
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  assert.ok(cwd.startsWith(tmpdir() + sep) || cwd.startsWith(`/private${tmpdir()}${sep}`), cwd);
  return (await execFileAsync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" })).stdout;
}

const numbered = (count: number, prefix: string) =>
  Array.from({ length: count }, (_unused, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

async function repository(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diff-store-context-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await writeFile(join(root, "a.txt"), numbered(60, "old"));
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "one");
  await writeFile(join(root, "a.txt"), numbered(60, "new"));
  await git(root, "commit", "-q", "-am", "two");
  return root;
}

async function ready(store: DiffStore): Promise<number> {
  await store.refreshNow();
  const state = store.getState();
  assert.equal(state.kind, "ready", JSON.stringify(state));
  return state.kind === "ready" ? state.snapshot.revision : -1;
}

test("loadContext quotes the working tree for working-tree sources, capped and cached per revision", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), numbered(60, "work"));
  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  const revision = await ready(store);
  const first = await store.loadContext("a.txt", 3, 5);
  assert.deepEqual(first, {
    revision,
    excerpt: { kind: "lines", from: 3, lines: ["work 3", "work 4", "work 5"] },
  });
  const capped = await store.loadContext("a.txt", 1, 500);
  assert.equal(
    capped.excerpt.kind === "lines" ? capped.excerpt.lines.length : -1,
    MAX_EXCERPT_LINES,
  );
  const past = await store.loadContext("a.txt", 59, 70);
  assert.deepEqual(past.excerpt, { kind: "lines", from: 59, lines: ["work 59", "work 60"] });

  // Cached for the revision: an edit the store has not refreshed for is not seen.
  await writeFile(join(root, "a.txt"), numbered(60, "edited"));
  assert.deepEqual((await store.loadContext("a.txt", 3, 5)).excerpt, first.excerpt);
  const next = await ready(store);
  assert.notEqual(next, revision);
  assert.deepEqual((await store.loadContext("a.txt", 3, 3)).excerpt, {
    kind: "lines",
    from: 3,
    lines: ["edited 3"],
  });
});

test("loadContext reads the head tree for a range source, and refuses files that are not listed", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), numbered(60, "uncommitted"));
  await writeFile(join(root, "secret.txt"), "not listed\n");
  const store = createDiffStore({
    cwd: root,
    source: { kind: "range", base: "HEAD~1", head: "HEAD", label: "last commit" },
  });
  t.after(() => store.dispose());
  await ready(store);
  assert.deepEqual((await store.loadContext("a.txt", 10, 11)).excerpt, {
    kind: "lines",
    from: 10,
    lines: ["new 10", "new 11"],
  });
  assert.deepEqual((await store.loadContext("secret.txt", 1, 1)).excerpt, {
    kind: "unavailable",
    reason: "Not in this diff.",
  });
  assert.equal((await store.loadContext("../outside", 1, 1)).excerpt.kind, "unavailable");
});

test("loadContext does not read a file over the body size limit", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), numbered(2000, "big"));
  const store = createDiffStore({ cwd: root, limits: { maxFileBytes: 1024 } });
  t.after(() => store.dispose());
  await ready(store);
  assert.deepEqual((await store.loadContext("a.txt", 1, 2)).excerpt, {
    kind: "unavailable",
    reason: "The file is too large to quote.",
  });
});
