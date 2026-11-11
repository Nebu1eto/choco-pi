import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DiffLoadCancelledError,
  loadDiffModel,
  type LoadDiffModelOptions,
} from "../.pi/extensions/lib/changes/git/load-model.ts";
import { createGitExecRunner, DiffDisposedError } from "../.pi/extensions/lib/changes/git/exec.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import type { DiffModel, ExecRunner } from "../.pi/extensions/lib/changes/types.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { createReviewStore, unreviewedHunks } from "../.pi/extensions/review/core/store.ts";
import type { ReviewComment, ReviewRecord } from "../.pi/extensions/review/core/types.ts";

/**
 * /review-assist reads local targets through the shared change layer. Saved
 * reviews point at hunks by id, so the layer must produce the hunk ids the
 * old route produced: `git diff --patch -M -C` text through `parseGitDiff`.
 */

const execFileAsync = promisify(execFile);
// A user's global git configuration must not change what either route reads.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

async function gitAllowing(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, ...args);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1 && "stdout" in error) {
      return String(error.stdout);
    }
    throw error;
  }
}

/* ------------------------------------------------- the old route, verbatim */

const OLD_GIT_CONFIG = ["-c", "core.quotePath=false", "-c", "color.ui=false"];
const OLD_DIFF_ARGS = ["--patch", "-M", "-C", "--no-color"];

/** The committed `readRawDiff`: a patch between two revisions or trees. */
async function oldRange(root: string, base: string, head: string): Promise<DiffModel> {
  const patch = await git(root, ...OLD_GIT_CONFIG, "diff", ...OLD_DIFF_ARGS, base, head, "--");
  return parseGitDiff(patch, base, head);
}

/** The committed `readRawDiffToWorkingTree`: tracked patch, then each untracked file. */
async function oldWorking(root: string, base: string, headSha: string): Promise<DiffModel> {
  const tracked = await git(root, ...OLD_GIT_CONFIG, "diff", ...OLD_DIFF_ARGS, base, "--");
  const untracked = (
    await git(root, ...OLD_GIT_CONFIG, "ls-files", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean);
  const patches = await Promise.all(
    untracked.map((path) =>
      gitAllowing(root, [
        ...OLD_GIT_CONFIG,
        "diff",
        "--patch",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]),
    ),
  );
  const raw = [tracked, ...patches]
    .filter(Boolean)
    .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
    .join("");
  return parseGitDiff(raw, base, headSha);
}

/* ------------------------------------------------------------- fixtures */

type Cleanup = { after(fn: () => void | Promise<void>): void };

async function repository(t: Cleanup): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "changes-load-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Load Test");
  await git(root, "config", "user.email", "load@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  return root;
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return (await git(root, "rev-parse", "HEAD")).trim();
}

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

const ODD_NAMES = ["sp ace.txt", 'qu"ote.txt', "ta\tb.txt", "new\nline.txt", "日本語 ü.txt"];

type Fixture = {
  root: string;
  mainSha: string;
  featureSha: string;
  mainTree: string;
  featureTree: string;
};

/**
 * main: the base. feature: a rename with edits, a pure rename, a deletion,
 * a file without a trailing newline, CRLF lines, a mode-only change, a
 * binary change and edits to odd names. The working tree adds untracked
 * files, one more edit, and a type change.
 */
async function fixture(t: Cleanup): Promise<Fixture> {
  const root = await repository(t);
  await put(root, "keep.txt", "same\n");
  await put(root, "rename-edit old.txt", lines(12, "row"));
  await put(root, "pure-rename.txt", lines(6, "pure"));
  await put(root, "deleted.txt", lines(3, "gone"));
  await put(root, "noeol.txt", "a\nb");
  await put(root, "crlf.txt", "one\r\ntwo\r\nthree\r\n");
  await put(root, "mode.sh", "echo mode\n");
  await put(root, "image.bin", new Uint8Array([0, 1, 2, 3, 0, 5]));
  await put(root, "typechange.txt", "type\n");
  for (const name of ODD_NAMES) await put(root, name, `${JSON.stringify(name)} before\n`);
  const mainSha = await commitAll(root, "base");

  await git(root, "checkout", "-q", "-b", "feature");
  await git(root, "mv", "rename-edit old.txt", "rename-edit new.txt");
  await put(root, "rename-edit new.txt", lines(12, "row").replace("row 6\n", "row six\n"));
  await git(root, "mv", "pure-rename.txt", "pure-renamed.txt");
  await unlink(join(root, "deleted.txt"));
  await put(root, "noeol.txt", "a\nB");
  await put(root, "crlf.txt", "one\r\nTWO\r\nthree\r\n");
  await chmod(join(root, "mode.sh"), 0o755);
  await put(root, "image.bin", new Uint8Array([0, 9, 2, 3, 0, 5, 7]));
  for (const name of ODD_NAMES) await put(root, name, `${JSON.stringify(name)} after\n`);
  const featureSha = await commitAll(root, "feature");

  await put(root, "untracked new.txt", lines(3, "fresh"));
  await put(root, 'untracked "q".txt', "quoted fresh\n");
  await put(root, "sp ace.txt", `${JSON.stringify("sp ace.txt")} working\n`);
  await unlink(join(root, "typechange.txt"));
  await symlink("keep.txt", join(root, "typechange.txt"));

  return {
    root,
    mainSha,
    featureSha,
    mainTree: (await git(root, "rev-parse", "main^{tree}")).trim(),
    featureTree: (await git(root, "rev-parse", "feature^{tree}")).trim(),
  };
}

async function load(options: Omit<LoadDiffModelOptions, "isCurrent">): Promise<DiffModel> {
  return (await loadDiffModel({ ...options, isCurrent: () => true })).model;
}

/** (path, kind, oldPath, hunk ids) per file, sorted by path: what saved reviews depend on. */
function identity(model: DiffModel, without: readonly string[] = []): string[] {
  return model.files
    .filter((file) => !without.includes(file.path))
    .map((file) =>
      JSON.stringify([
        file.path,
        file.kind,
        file.oldPath ?? null,
        file.hunks.map((hunk) => hunk.id),
      ]),
    )
    .sort();
}

const TYPE_CHANGE = "typechange.txt";

/* ---------------------------------------------------------------- tests */

test("every local target lists the files, kinds and hunk ids the old route produced", async (t) => {
  const f = await fixture(t);
  const turns = {
    listTurns: async () => [{ turnIndex: 1, tree: f.mainTree, label: "turn 1" }],
  };

  // branch <base>: the working tree against merge-base(HEAD, base).
  const branchOld = await oldWorking(f.root, f.mainSha, f.featureSha);
  const branchNew = await load({ cwd: f.root, source: { kind: "branch-base", base: "main" } });
  assert.deepEqual(identity(branchNew, [TYPE_CHANGE]), identity(branchOld, [TYPE_CHANGE]));
  assert.deepEqual([branchNew.baseSha, branchNew.headSha], [f.mainSha, f.featureSha]);

  // session: the working tree against the first turn's tree.
  const sessionOld = await oldWorking(f.root, f.mainTree, f.featureSha);
  const sessionNew = await load({
    cwd: f.root,
    source: { kind: "since-checkpoint", checkpointId: f.mainTree, label: "turn 1" },
    turns,
  });
  assert.deepEqual(identity(sessionNew, [TYPE_CHANGE]), identity(sessionOld, [TYPE_CHANGE]));
  assert.deepEqual([sessionNew.baseSha, sessionNew.headSha], [f.mainTree, f.featureSha]);

  // session turn <n> that has a later turn, and branch <base> <target>: tree against tree.
  for (const [base, head] of [
    [f.mainTree, f.featureTree],
    [f.mainSha, f.featureSha],
  ] as const) {
    const rangeOld = await oldRange(f.root, base, head);
    const rangeNew = await load({
      cwd: f.root,
      source: { kind: "range", base, head, label: "range" },
    });
    assert.deepEqual(identity(rangeNew), identity(rangeOld));
    assert.deepEqual([rangeNew.baseSha, rangeNew.headSha], [base, head]);
  }

  // The fixture covers what it claims to.
  const kinds = new Map(branchNew.files.map((file) => [file.path, file.kind]));
  assert.equal(kinds.get("rename-edit new.txt"), "renamed");
  assert.equal(kinds.get("pure-renamed.txt"), "renamed");
  assert.equal(kinds.get("deleted.txt"), "deleted");
  assert.equal(kinds.get("image.bin"), "binary");
  assert.equal(kinds.get("untracked new.txt"), "added");
  assert.equal(kinds.get("mode.sh"), "modified");
  for (const name of ODD_NAMES) assert.equal(kinds.get(name), "modified", JSON.stringify(name));
  assert.equal(
    branchNew.files
      .find((file) => file.path === "crlf.txt")
      ?.hunks[0]?.lines.some((line) => line.text === "TWO"),
    true,
  );
});

test("documented differences: a type change is one entry and untracked files sort by path", async (t) => {
  const f = await fixture(t);
  const before = await oldWorking(f.root, f.mainSha, f.featureSha);
  const after = await load({ cwd: f.root, source: { kind: "branch-base", base: "main" } });
  assert.equal(before.files.filter((file) => file.path === TYPE_CHANGE).length, 2);
  const typeChange = after.files.filter((file) => file.path === TYPE_CHANGE);
  assert.equal(typeChange.length, 1);
  assert.deepEqual(
    typeChange[0]?.hunks.map((hunk) => hunk.id).sort(),
    before.files
      .filter((file) => file.path === TYPE_CHANGE)
      .flatMap((file) => file.hunks.map((hunk) => hunk.id))
      .sort(),
    "the two halves keep their hunk ids",
  );
  const paths = before.files.map((file) => file.path);
  assert.deepEqual(paths.slice(-2).sort(), ['untracked "q".txt', "untracked new.txt"].sort());
  const sorted = after.files.map((file) => file.path);
  assert.deepEqual(
    sorted,
    [...sorted].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
});

test("a review saved from the old route keeps its reviewed marks and comments", async (t) => {
  const f = await fixture(t);
  const old = await oldWorking(f.root, f.mainSha, f.featureSha);
  const comments: ReviewComment[] = [];
  for (const file of old.files) {
    const hunk = file.hunks[0];
    const line = hunk?.lines.find((candidate) => candidate.kind !== "context");
    if (!hunk || !line) continue;
    const side = line.kind === "del" ? "LEFT" : "RIGHT";
    const number = side === "LEFT" ? line.oldLine : line.newLine;
    if (number === undefined) continue;
    comments.push({
      id: `c${comments.length}`,
      path: file.path,
      side,
      line: number,
      body: "check this",
      anchor: buildCommentAnchor(hunk, side, number),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const record: ReviewRecord = {
    version: 1,
    repoKey: "fixture",
    target: { kind: "branch", base: "main" },
    baseSha: old.baseSha,
    headSha: old.headSha,
    cursor: {
      reviewedHunkIds: old.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
      lastHeadSha: old.headSha,
    },
    comments,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const directory = await mkdtemp(join(tmpdir(), "changes-load-model-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reviews = createReviewStore(directory);
  await reviews.save(record);
  const saved = (await reviews.list("fixture"))[0];
  assert.ok(saved);

  const current = await load({ cwd: f.root, source: { kind: "branch-base", base: "main" } });
  assert.deepEqual([current.baseSha, current.headSha], [saved.baseSha, saved.headSha]);
  assert.deepEqual(
    unreviewedHunks(saved, current).map((entry) => entry.path),
    [],
    "every reviewed mark still matches a hunk",
  );
  const commented = new Set(saved.comments.map((comment) => comment.path));
  for (const name of [...ODD_NAMES, "rename-edit new.txt", "deleted.txt", "noeol.txt"]) {
    assert.ok(commented.has(name), `the fixture comments on ${JSON.stringify(name)}`);
  }
  const unattached = saved.comments.filter((comment) => {
    const file = current.files.find((candidate) => candidate.path === comment.path);
    const hunk = file?.hunks.find((candidate) => candidate.id === comment.anchor.hunkHash);
    return !hunk?.lines.some((line) =>
      comment.side === "LEFT" ? line.oldLine === comment.line : line.newLine === comment.line,
    );
  });
  assert.deepEqual(
    unattached.map((comment) => comment.path),
    [],
    "every comment still sits on its hunk and line",
  );
  // Binary and renamed files keep their identity although a binary file has no hunks.
  const binary = current.files.find((file) => file.path === "image.bin");
  assert.deepEqual([binary?.kind, binary?.hunks.length], ["binary", 0]);
  const renamed = current.files.find((file) => file.path === "pure-renamed.txt");
  assert.deepEqual([renamed?.kind, renamed?.oldPath], ["renamed", "pure-rename.txt"]);
});

test("a file over the byte limit is a notice, and files over the file limit are counted", async (t) => {
  const root = await repository(t);
  await put(root, "a.txt", "a\n");
  await put(root, "big.txt", "small\n");
  await put(root, "c.txt", "c\n");
  await commitAll(root, "base");
  await put(root, "a.txt", "A\n");
  await put(root, "big.txt", "x".repeat(4096) + "\n");
  await put(root, "c.txt", "C\n");

  const limited = await loadDiffModel({
    cwd: root,
    source: { kind: "uncommitted" },
    limits: { maxFileBytes: 1024 },
    isCurrent: () => true,
  });
  const big = limited.model.files.find((file) => file.path === "big.txt");
  assert.deepEqual([big?.kind, big?.hunks.length, big?.additions], ["modified", 0, 1]);
  assert.deepEqual(
    limited.model.notices?.map((notice) => notice.path),
    ["big.txt"],
  );
  assert.match(limited.model.notices?.[0]?.message ?? "", /4 KiB.*1 KiB/u);
  assert.equal(limited.model.files.find((file) => file.path === "a.txt")?.hunks.length, 1);

  const capped = await loadDiffModel({
    cwd: root,
    source: { kind: "uncommitted" },
    limits: { maxFiles: 2 },
    isCurrent: () => true,
  });
  assert.deepEqual(
    capped.model.files.map((file) => file.path),
    ["a.txt", "big.txt"],
  );
  assert.equal(capped.model.omittedFiles, 1);
  assert.equal(capped.omittedFiles, 1);

  const unlimited = await load({ cwd: root, source: { kind: "uncommitted" } });
  assert.equal(unlimited.notices, undefined);
  assert.equal(unlimited.omittedFiles, undefined);
});

test("a checkpoint file that is untracked now is compared by content, not listed as deleted", async (t) => {
  const root = await repository(t);
  await put(root, "tracked.txt", "tracked\n");
  await commitAll(root, "base");
  await put(root, "same.txt", "unchanged scratch\n");
  await put(root, "edited.txt", "old line\nkept\n");
  // The checkpoint captured both untracked files, as file-checkpoints does.
  const index = join(root, ".git", "checkpoint-index");
  const env = { ...GIT_ENV, GIT_INDEX_FILE: index };
  await execFileAsync("git", ["add", "-A"], { cwd: root, env });
  const tree = (await execFileAsync("git", ["write-tree"], { cwd: root, env })).stdout.trim();
  await unlink(index);
  await put(root, "edited.txt", "new line\nkept\n");

  const old = await oldWorking(root, tree, "");
  assert.deepEqual(
    old.files.filter((file) => file.path === "edited.txt").map((file) => file.kind),
    ["deleted", "added"],
    "the old route listed it twice",
  );
  const current = await load({
    cwd: root,
    source: { kind: "since-checkpoint", checkpointId: tree, label: "turn 1" },
    turns: { listTurns: async () => [{ turnIndex: 1, tree, label: "turn 1" }] },
  });
  assert.deepEqual(
    current.files.map((file) => [
      file.path,
      file.kind,
      file.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`)),
    ]),
    [["edited.txt", "modified", ["del:old line", "add:new line", "context:kept"]]],
  );
});

test("loading never writes the index", async (t) => {
  const f = await fixture(t);
  const indexPath = join(f.root, ".git", "index");
  // Make the index stat data stale, which a porcelain diff would refresh and rewrite.
  await put(f.root, "keep.txt", "same\n");
  const before = await stat(indexPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await load({ cwd: f.root, source: { kind: "branch-base", base: "main" } });
  const after = await stat(indexPath);
  assert.deepEqual([after.mtimeMs, after.size], [before.mtimeMs, before.size]);
});

test("losing ownership stops the load: no git call starts after it", async (t) => {
  const f = await fixture(t);
  let current = true;
  let callsAfterLoss = 0;
  let calls = 0;
  const real = createGitExecRunner({ timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024 });
  const exec: ExecRunner = async (cmd, args, opts) => {
    calls += 1;
    if (!current) callsAfterLoss += 1;
    const result = await real(cmd, args, opts);
    // Ownership ends during the first body read.
    if (args.includes("--patch")) current = false;
    return result;
  };
  await assert.rejects(
    loadDiffModel({
      cwd: f.root,
      source: { kind: "branch-base", base: "main" },
      exec,
      isCurrent: () => current,
    }),
    DiffLoadCancelledError,
  );
  assert.ok(calls > 0);
  // Up to three other body reads may already have started; none begins later.
  const settled = calls;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls, settled);
  assert.ok(callsAfterLoss <= 3, String(callsAfterLoss));
});

test("aborting the default runner kills its process at once", async () => {
  const controller = new AbortController();
  const runner = createGitExecRunner(
    { timeoutMs: 30_000, maxOutputBytes: 1024 },
    controller.signal,
  );
  const started = Date.now();
  const pending = runner(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, DiffDisposedError);
  assert.ok(Date.now() - started < 5_000);
  await assert.rejects(runner("git", ["--version"]), DiffDisposedError);
});
