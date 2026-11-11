import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { DiffStore, FileBody, FileSummary } from "../.pi/extensions/lib/changes/git/model.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import { defaultExecRunner } from "../.pi/extensions/review/core/git.ts";
import type { DiffFile } from "../.pi/extensions/review/core/types.ts";

const execFileAsync = promisify(execFile);
const TEMP_ROOT = tmpdir();

/** Fixture git never reads the owner's global or system configuration. */
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function assertTemporary(path: string): void {
  assert.ok(
    path.startsWith(TEMP_ROOT + sep) || path.startsWith(`/private${TEMP_ROOT}${sep}`),
    `fixture path ${path} must be inside ${TEMP_ROOT}`,
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  assertTemporary(cwd);
  const result = await execFileAsync("git", args, {
    cwd,
    env: FIXTURE_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const target = join(root, path);
  assertTemporary(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

let touchSeconds = 0;

/**
 * Give a file a new mtime without changing its content. Git may compare whole
 * seconds only, so each touch moves the mtime a further 10 s ahead.
 */
async function touch(root: string, path: string): Promise<void> {
  const target = join(root, path);
  assertTemporary(target);
  touchSeconds += 10;
  const when = new Date(Date.now() + touchSeconds * 1000);
  await utimes(target, when, when);
}

async function tempDirectory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await realpath(await mkdtemp(join(TEMP_ROOT, "diff-core-git-")));
  assertTemporary(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function initRepository(path: string): Promise<string> {
  assertTemporary(path);
  await mkdir(path, { recursive: true });
  await git(path, "init", "-q", "-b", "main");
  await git(path, "config", "user.name", "Diff Test");
  await git(path, "config", "user.email", "diff@example.test");
  await git(path, "config", "commit.gpgsign", "false");
  await git(path, "config", "tag.gpgsign", "false");
  return path;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return (await git(root, "rev-parse", "HEAD")).trim();
}

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";
}

async function snapshotOf(store: DiffStore) {
  await store.refreshNow();
  const state = store.getState();
  assert.equal(state.kind, "ready", `expected ready, got ${JSON.stringify(state)}`);
  if (state.kind !== "ready") throw new Error("unreachable");
  return state.snapshot;
}

function byPath(files: readonly FileSummary[]): Map<string, FileSummary> {
  return new Map(files.map((file) => [file.path, file]));
}

function textOf(body: FileBody): DiffFile {
  assert.equal(body.kind, "text", `expected text, got ${JSON.stringify(body)}`);
  if (body.kind !== "text") throw new Error("unreachable");
  return body.file;
}

function pick(files: Map<string, FileSummary>, path: string): FileSummary {
  const file = files.get(path);
  assert.ok(file, `${JSON.stringify(path)} is listed`);
  return file;
}

const NEWLINE_NAME = "line\nbreak.txt";
const QUOTE_NAME = 'say "hi".txt';
const SPACE_NAME = "sp ace ü日本.txt";
const TWO_MB = 2 * 1024 * 1024;

test("uncommitted snapshot lists every change kind with counts, flags, and exact names", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "modified.txt", lines(30));
  await put(root, "deleted.txt", "remove me\n");
  await put(root, "rename-old.txt", lines(5, "rename"));
  await put(root, "copy-source.txt", lines(5, "copy"));
  await put(root, "type.txt", "regular file\n");
  await put(root, "binary.bin", new Uint8Array([0, 1, 2, 3]));
  await put(root, SPACE_NAME, "before\n");
  await put(root, QUOTE_NAME, "before\n");
  await put(root, NEWLINE_NAME, "before\n");
  await put(root, "big.txt", "small\n");
  await commitAll(root, "base");

  const modified = lines(30).split("\n");
  modified[3] = "line four changed";
  await put(root, "modified.txt", modified.join("\n"));
  await unlink(join(root, "deleted.txt"));
  await git(root, "mv", "rename-old.txt", "rename-new.txt");
  await put(root, "copy-dest.txt", lines(5, "copy"));
  await put(root, "copy-source.txt", lines(5, "copy") + "source changed\n");
  await git(root, "add", "copy-dest.txt", "copy-source.txt");
  await unlink(join(root, "type.txt"));
  await symlink("modified.txt", join(root, "type.txt"));
  await put(root, "binary.bin", new Uint8Array([0, 9, 8, 7, 6]));
  await put(root, SPACE_NAME, "after\n");
  await put(root, QUOTE_NAME, "after\n");
  await put(root, NEWLINE_NAME, "after\n");
  await put(root, "big.txt", `${"z".repeat(63)}\n`.repeat(TWO_MB / 64 + 100));
  await put(root, "staged-added.txt", "one\n");
  await git(root, "add", "staged-added.txt");
  await put(root, "staged-added.txt", "one\ntwo\n");
  await put(root, "intent.txt", "intent\n");
  await git(root, "add", "-N", "intent.txt");
  await put(root, "untracked/deep/new.txt", "a\nb\nc\n");
  await put(root, "untracked-binary.bin", new Uint8Array([65, 0, 66]));
  await put(root, "untracked-big.txt", "y".repeat(TWO_MB));

  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  const snapshot = await snapshotOf(store);
  const files = byPath(snapshot.files);

  assert.equal(snapshot.repoRoot, root);
  assert.equal(snapshot.branch, "main");
  assert.match(snapshot.head ?? "", /^[0-9a-f]{40,64}$/);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    snapshot.files.map((file) => file.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.equal(snapshot.omittedFiles, 0);
  assert.equal(snapshot.totals.files, snapshot.files.length);

  assert.deepEqual(pick(files, "modified.txt"), {
    path: "modified.txt",
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    staged: false,
    unstaged: true,
  });
  assert.equal(pick(files, "deleted.txt").status, "deleted");
  assert.equal(pick(files, "deleted.txt").deletions, 1);
  const renamed = pick(files, "rename-new.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "rename-old.txt");
  assert.equal(renamed.staged, true);
  assert.equal(files.has("rename-old.txt"), false);
  const copied = pick(files, "copy-dest.txt");
  assert.equal(copied.status, "copied");
  assert.equal(copied.oldPath, "copy-source.txt");
  assert.equal(pick(files, "type.txt").status, "type-changed");
  const binary = pick(files, "binary.bin");
  assert.equal(binary.binary, true);
  assert.equal(binary.additions, null);
  for (const name of [SPACE_NAME, QUOTE_NAME, NEWLINE_NAME]) {
    const file = pick(files, name);
    assert.equal(file.status, "modified");
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
  }
  const stagedAdded = pick(files, "staged-added.txt");
  assert.equal(stagedAdded.status, "added");
  assert.equal(stagedAdded.additions, 2);
  assert.equal(stagedAdded.staged, true);
  assert.equal(stagedAdded.unstaged, true);
  const intent = pick(files, "intent.txt");
  assert.equal(intent.status, "added");
  assert.equal(intent.staged, false);
  assert.equal(intent.unstaged, true);
  assert.deepEqual(pick(files, "untracked/deep/new.txt"), {
    path: "untracked/deep/new.txt",
    status: "untracked",
    additions: 3,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
  });
  assert.equal(pick(files, "untracked-binary.bin").binary, true);
  assert.equal(pick(files, "untracked-binary.bin").additions, null);
  assert.equal(pick(files, "untracked-big.txt").additions, null, "too large to count");

  // Bodies.
  // /review's parser rejects the quoted newline name, so compare ids file by file
  // using the same git invocations /review makes.
  const reviewFile = async (path: string) => {
    const tracked = await git(
      root,
      "diff",
      "--patch",
      "-M",
      "-C",
      "--no-color",
      "HEAD",
      "--",
      path,
    );
    const raw =
      tracked ||
      (await execFileAsync(
        "git",
        ["diff", "--patch", "--no-color", "--no-index", "--", "/dev/null", path],
        {
          cwd: root,
          env: FIXTURE_ENV,
          encoding: "utf8",
        },
      ).then(
        (result) => result.stdout,
        (error: { stdout: string }) => error.stdout,
      ));
    return parseGitDiff(raw, "", "").files[0];
  };

  const modifiedBody = await store.loadFile("modified.txt");
  assert.equal(modifiedBody.revision, snapshot.revision);
  const modifiedFile = textOf(modifiedBody.body);
  assert.equal(modifiedFile.kind, "modified");
  assert.equal(modifiedFile.additions, 1);
  assert.deepEqual(
    modifiedFile.hunks.map((hunk) => hunk.id),
    (await reviewFile("modified.txt"))?.hunks.map((hunk) => hunk.id),
    "hunk ids match /review's parser",
  );
  const untrackedFile = textOf((await store.loadFile("untracked/deep/new.txt")).body);
  assert.equal(untrackedFile.kind, "added");
  assert.deepEqual(
    untrackedFile.hunks.map((hunk) => [hunk.id, hunk.lines]),
    (await reviewFile("untracked/deep/new.txt"))?.hunks.map((hunk) => [hunk.id, hunk.lines]),
  );

  const newlineFile = textOf((await store.loadFile(NEWLINE_NAME)).body);
  assert.equal(newlineFile.path, NEWLINE_NAME);
  assert.deepEqual(
    newlineFile.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`)),
    ["del:before", "add:after"],
  );
  const quoteFile = textOf((await store.loadFile(QUOTE_NAME)).body);
  assert.equal(quoteFile.path, QUOTE_NAME);
  assert.equal(quoteFile.additions, 1);
  assert.equal(textOf((await store.loadFile(SPACE_NAME)).body).additions, 1);

  const renamedFile = textOf((await store.loadFile("rename-new.txt")).body);
  assert.equal(renamedFile.kind, "renamed");
  assert.equal(renamedFile.oldPath, "rename-old.txt");
  const deletedFile = textOf((await store.loadFile("deleted.txt")).body);
  assert.equal(deletedFile.kind, "deleted");
  assert.equal(deletedFile.deletions, 1);
  const typeFile = textOf((await store.loadFile("type.txt")).body);
  assert.deepEqual(
    typeFile.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`)),
    ["del:regular file", "add:modified.txt"],
  );
  assert.equal(textOf((await store.loadFile("staged-added.txt")).body).additions, 2);

  assert.deepEqual((await store.loadFile("binary.bin")).body, { kind: "binary" });
  assert.deepEqual((await store.loadFile("untracked-binary.bin")).body, { kind: "binary" });
  const bigBody = (await store.loadFile("big.txt")).body;
  assert.equal(bigBody.kind, "too-large");
  assert.ok(
    bigBody.kind === "too-large" && bigBody.bytes > TWO_MB && bigBody.limit === 1024 * 1024,
  );
  assert.equal((await store.loadFile("untracked-big.txt")).body.kind, "too-large");

  assert.deepEqual((await store.loadFile("not-listed.txt")).body, { kind: "gone" });
  // Reverted after the snapshot: the file is no longer changed.
  await git(root, "checkout", "--", QUOTE_NAME);
  assert.deepEqual((await store.loadFile(QUOTE_NAME)).body.kind, "text", "cached before revert");
  await unlink(join(root, "untracked/deep/new.txt"));
  const afterRevert = await snapshotOf(store);
  assert.ok(afterRevert.revision > snapshot.revision);
  assert.equal(byPath(afterRevert.files).has(QUOTE_NAME), false);
  assert.deepEqual((await store.loadFile(QUOTE_NAME)).body, { kind: "gone" });
});

test("a body read for a file reverted since the snapshot reports gone", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "a.txt", "one\n");
  await commitAll(root, "base");
  await put(root, "a.txt", "two\n");
  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  await snapshotOf(store);
  await git(root, "checkout", "--", "a.txt");
  assert.deepEqual((await store.loadFile("a.txt")).body, { kind: "gone" });
});

test("conflicted files are listed as conflicted with a readable body", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "c.txt", "base\n");
  await commitAll(root, "base");
  await git(root, "checkout", "-qb", "other");
  await put(root, "c.txt", "other\n");
  await commitAll(root, "other");
  await git(root, "checkout", "-q", "main");
  await put(root, "c.txt", "mine\n");
  await commitAll(root, "mine");
  await assert.rejects(git(root, "merge", "-q", "other"));

  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  const files = byPath((await snapshotOf(store)).files);
  const conflicted = pick(files, "c.txt");
  assert.equal(conflicted.status, "conflicted");
  assert.equal(conflicted.unstaged, true);
  const body = textOf((await store.loadFile("c.txt")).body);
  assert.ok(body.hunks.some((hunk) => hunk.lines.some((line) => line.text.startsWith("<<<<<<<"))));
});

test("a repository with no commits lists staged and untracked files against the empty tree", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "staged.txt", "a\nb\n");
  await git(root, "add", "staged.txt");
  await put(root, "loose.txt", "c\n");

  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  const snapshot = await snapshotOf(store);
  assert.equal(snapshot.head, null);
  assert.equal(snapshot.branch, "main");
  const files = byPath(snapshot.files);
  assert.equal(pick(files, "staged.txt").status, "added");
  assert.equal(pick(files, "staged.txt").additions, 2);
  assert.equal(pick(files, "loose.txt").status, "untracked");
  assert.equal(textOf((await store.loadFile("staged.txt")).body).additions, 2);
});

test("detached HEAD, a subdirectory cwd, and a linked worktree keep repository-relative paths", async (t) => {
  const base = await tempDirectory(t);
  const root = await initRepository(join(base, "repo"));
  await put(root, "top.txt", "top\n");
  await put(root, "sub/inner.txt", "inner\n");
  await commitAll(root, "base");
  await git(root, "checkout", "-q", "--detach");
  await put(root, "top.txt", "top changed\n");
  await put(root, "sub/inner.txt", "inner changed\n");

  const store = createDiffStore({ cwd: join(root, "sub") });
  t.after(() => store.dispose());
  const snapshot = await snapshotOf(store);
  assert.equal(snapshot.branch, null);
  assert.equal(snapshot.repoRoot, root);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["sub/inner.txt", "top.txt"],
  );
  assert.equal(textOf((await store.loadFile("top.txt")).body).additions, 1);

  const worktree = join(base, "linked");
  await git(root, "worktree", "add", "-q", "-b", "linked-branch", worktree);
  await put(worktree, "sub/inner.txt", "from worktree\n");
  await put(worktree, "wt-new.txt", "new\n");
  const linked = createDiffStore({ cwd: worktree });
  t.after(() => linked.dispose());
  const linkedSnapshot = await snapshotOf(linked);
  assert.equal(linkedSnapshot.repoRoot, worktree);
  assert.equal(linkedSnapshot.branch, "linked-branch");
  assert.deepEqual(
    linkedSnapshot.files.map((file) => [file.path, file.status]),
    [
      ["sub/inner.txt", "modified"],
      ["wt-new.txt", "untracked"],
    ],
  );
  assert.equal(textOf((await linked.loadFile("sub/inner.txt")).body).additions, 1);
});

test("a cwd outside any repository reports not-a-repository without throwing", async (t) => {
  const plain = join(await tempDirectory(t), "plain");
  await mkdir(plain);
  // Guard against a temp directory that happens to sit inside a repository.
  const probe = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: plain }).then(
    () => true,
    () => false,
  );
  if (probe) return t.skip("temporary directory is inside a git repository");
  const store = createDiffStore({ cwd: plain });
  t.after(() => store.dispose());
  await store.refreshNow();
  assert.deepEqual(store.getState(), { kind: "not-a-repository", cwd: plain });
  assert.deepEqual((await store.loadFile("x")).body.kind, "unreadable");
});

test("submodule entries are listed and their body is unreadable with a reason", async (t) => {
  const base = await tempDirectory(t);
  const sub = await initRepository(join(base, "sub"));
  await put(sub, "s.txt", "s\n");
  await commitAll(sub, "s");
  const root = await initRepository(join(base, "main"));
  await put(root, "m.txt", "m\n");
  await commitAll(root, "m");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sm");
  await commitAll(root, "add submodule");
  const inner = join(root, "sm");
  await git(inner, "config", "user.name", "Diff Test");
  await git(inner, "config", "user.email", "diff@example.test");
  await git(inner, "config", "commit.gpgsign", "false");
  await put(inner, "s.txt", "s2\n");
  await git(inner, "commit", "-qam", "s2");

  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  const files = byPath((await snapshotOf(store)).files);
  assert.equal(pick(files, "sm").status, "modified");
  const body = (await store.loadFile("sm")).body;
  assert.equal(body.kind, "unreadable");
  assert.match(body.kind === "unreadable" ? body.reason : "", /Submodule/);
});

test("branch-base and since-checkpoint sources compare the working tree with their base", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "shared.txt", "shared\n");
  await put(root, "untouched.txt", "same\n");
  await put(root, "untouched.bin", new Uint8Array([0, 1, 2]));
  await commitAll(root, "base");
  const baseTree = (await git(root, "rev-parse", "HEAD^{tree}")).trim();
  await git(root, "checkout", "-qb", "feature");
  await put(root, "feature.txt", "feature\n");
  await commitAll(root, "feature");
  await put(root, "shared.txt", "shared\nedited\n");
  // Rewritten with identical content: stat-dirty, but not a change.
  await touch(root, "untouched.txt");
  await touch(root, "untouched.bin");

  const store = createDiffStore({
    cwd: root,
    checkpoints: { listTurns: async () => [{ turnIndex: 0, tree: baseTree, label: "Turn 1" }] },
  });
  t.after(() => store.dispose());
  assert.deepEqual(
    (await snapshotOf(store)).files.map((file) => file.path),
    ["shared.txt"],
  );
  store.setSource({ kind: "branch-base", base: "main" });
  const branchSnapshot = await snapshotOf(store);
  assert.equal(branchSnapshot.source.kind, "branch-base");
  assert.deepEqual(
    branchSnapshot.files.map((file) => [file.path, file.status, file.staged, file.unstaged]),
    [
      ["feature.txt", "added", false, false],
      ["shared.txt", "modified", false, true],
    ],
  );
  assert.equal(textOf((await store.loadFile("feature.txt")).body).additions, 1);

  store.setSource({ kind: "since-checkpoint", checkpointId: "0", label: "Turn 1" });
  const checkpointSnapshot = await snapshotOf(store);
  assert.deepEqual(
    checkpointSnapshot.files.map((file) => file.path),
    ["feature.txt", "shared.txt"],
  );

  store.setSource({ kind: "branch-base", base: "no-such-branch" });
  await store.refreshNow();
  const failed = store.getState();
  assert.equal(failed.kind, "error");
  if (failed.kind !== "error") throw new Error("unreachable");
  // The wording `resolveBase` has always produced: git's own first stderr line.
  assert.match(failed.message, /^No merge base with no-such-branch: fatal: .*no-such-branch/);
});

test("refreshing never writes the index even when status would refresh stat data", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "a.txt", "a\n");
  await put(root, "b.txt", "b\n");
  await put(root, "c.bin", new Uint8Array([0, 1, 2]));
  await commitAll(root, "base");
  await put(root, "a.txt", "a changed\n");
  const index = join(root, ".git", "index");

  const touchFiles = async () => {
    // Same content, new mtime: a plain `git status` re-hashes b.txt and rewrites the index.
    await touch(root, "b.txt");
    await touch(root, "c.bin");
  };

  // The review runner adds no GIT_OPTIONAL_LOCKS environment, so only the
  // pinned --no-optional-locks option keeps the index untouched here.
  const store = createDiffStore({ cwd: root, exec: defaultExecRunner });
  t.after(() => store.dispose());
  await touchFiles();
  const before = await stat(index);
  const snapshot = await snapshotOf(store);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["a.txt"],
    "files touched without a content change are not listed",
  );
  await store.loadFile("a.txt");
  const after = await stat(index);
  assert.equal(after.mtimeMs, before.mtimeMs, "index not rewritten by the pane");
  assert.equal(after.ino, before.ino);

  // Control: the same situation with a plain status does rewrite the index,
  // so the assertion above can fail.
  await touchFiles();
  const controlBefore = await stat(index);
  await git(root, "status", "--porcelain");
  const controlAfter = await stat(index);
  assert.notEqual(controlAfter.mtimeMs, controlBefore.mtimeMs, "control: plain status writes");
});

test("the listed-file cap counts the rest in omittedFiles and totals", async (t) => {
  const root = await initRepository(join(await tempDirectory(t), "repo"));
  await put(root, "keep.txt", "k\n");
  await commitAll(root, "base");
  for (let index = 0; index < 5; index += 1) await put(root, `f${index}.txt`, "x\ny\n");
  const store = createDiffStore({ cwd: root, limits: { maxFiles: 3, maxUntrackedReads: 2 } });
  t.after(() => store.dispose());
  const snapshot = await snapshotOf(store);
  assert.deepEqual(
    snapshot.files.map((file) => [file.path, file.additions]),
    [
      ["f0.txt", 2],
      ["f1.txt", 2],
      ["f2.txt", null],
    ],
  );
  assert.equal(snapshot.omittedFiles, 2);
  assert.equal(snapshot.totals.files, 5);
});
