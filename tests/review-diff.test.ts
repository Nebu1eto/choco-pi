import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";
import {
  defaultExecRunner,
  listBranches,
  readRawDiff,
  readRawDiffToWorkingTree,
  resolveBranchTarget,
  resolveRevision,
} from "../.pi/extensions/review/core/git.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function repository(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Review Test");
  await git(root, "config", "user.email", "review@example.test");
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

test("real git patches parse text, path, binary, and metadata edge cases", async (t) => {
  const root = await repository(t);
  await put(
    root,
    "modified.txt",
    Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
  );
  await put(root, "deleted.txt", "remove me\n");
  await put(root, "rename old.txt", "rename content\n");
  await put(root, "copy source.txt", "copy content\n");
  await put(root, "mode-only.sh", "#!/bin/sh\nexit 0\n");
  await put(root, "binary.bin", new Uint8Array([0, 1, 2, 3]));
  await put(root, "sp ace-日本語.txt", "before\n");
  await put(root, "crlf.txt", "first\r\nsecond\r\n");
  await put(root, "no-newline.txt", "old");
  const baseSha = await commitAll(root, "base");

  const modified = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  modified[3] = "line four changed";
  modified[24] = "line twenty-five changed";
  await put(root, "modified.txt", modified.join("\n") + "\n");
  await unlink(join(root, "deleted.txt"));
  await rename(join(root, "rename old.txt"), join(root, "renamed new.txt"));
  await copyFile(join(root, "copy source.txt"), join(root, "copied destination.txt"));
  await put(root, "copy source.txt", "copy content\nsource changed\n");
  await chmod(join(root, "mode-only.sh"), 0o755);
  await put(root, "binary.bin", new Uint8Array([0, 9, 8, 7]));
  await put(root, "sp ace-日本語.txt", "after\n");
  await put(root, "crlf.txt", "first\r\nchanged\r\n");
  await put(root, "no-newline.txt", "new");
  await put(root, "added file.txt", "added\n");
  const headSha = await commitAll(root, "changed");

  const raw = await readRawDiff(root, baseSha, headSha);
  const model = parseGitDiff(raw, baseSha, headSha);
  const byPath = new Map(model.files.map((file) => [file.path, file]));

  assert.equal(
    byPath.get("added file.txt")?.kind,
    "added",
    `parsed paths: ${JSON.stringify([...byPath.keys()])}`,
  );
  assert.equal(byPath.get("deleted.txt")?.kind, "deleted");
  assert.deepEqual(
    { kind: byPath.get("renamed new.txt")?.kind, oldPath: byPath.get("renamed new.txt")?.oldPath },
    { kind: "renamed", oldPath: "rename old.txt" },
  );
  assert.equal(byPath.get("binary.bin")?.kind, "binary");
  assert.deepEqual(byPath.get("binary.bin")?.hunks, []);
  assert.equal(byPath.get("mode-only.sh")?.kind, "modified");
  assert.deepEqual(byPath.get("mode-only.sh")?.hunks, []);
  assert.equal(
    byPath.get("sp ace-日本語.txt")?.kind,
    "modified",
    JSON.stringify(byPath.get("sp ace-日本語.txt")),
  );
  assert.equal(byPath.get("modified.txt")?.hunks.length, 2);
  assert.deepEqual(
    {
      additions: byPath.get("modified.txt")?.additions,
      deletions: byPath.get("modified.txt")?.deletions,
    },
    { additions: 2, deletions: 2 },
  );
  assert.ok(
    byPath
      .get("crlf.txt")
      ?.hunks.flatMap((hunk) => hunk.lines)
      .every((line) => !line.text.endsWith("\r")),
  );
  assert.deepEqual(
    byPath
      .get("no-newline.txt")
      ?.hunks.flatMap((hunk) => hunk.lines)
      .map((line) => line.text),
    ["old", "new"],
  );

  const copied = byPath.get("copied destination.txt");
  if (copied?.kind === "copied") {
    assert.equal(copied.oldPath, "copy source.txt");
  } else {
    // Some Git builds do not consider modified copy sources without --find-copies-harder.
    const fixture = [
      "diff --git a/copy source.txt b/copied destination.txt",
      "similarity index 100%",
      "copy from copy source.txt",
      "copy to copied destination.txt",
      "",
    ].join("\n");
    assert.deepEqual(parseGitDiff(fixture, "base", "head").files[0], {
      path: "copied destination.txt",
      oldPath: "copy source.txt",
      kind: "copied",
      hunks: [],
      additions: 0,
      deletions: 0,
    });
  }
});

test("hunk ids survive an unrelated edit earlier in the file", async (t) => {
  const root = await repository(t);
  const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  await put(root, "stable.txt", original.join("\n") + "\n");
  const baseSha = await commitAll(root, "base");

  const laterOnly = [...original];
  laterOnly[29] = "later change";
  await put(root, "stable.txt", laterOnly.join("\n") + "\n");
  const firstModel = parseGitDiff(await readRawDiffToWorkingTree(root, baseSha), baseSha, baseSha);
  const firstId = firstModel.files[0]?.hunks[0]?.id;

  const shifted = ["unrelated insertion", ...laterOnly];
  await put(root, "stable.txt", shifted.join("\n") + "\n");
  const secondModel = parseGitDiff(await readRawDiffToWorkingTree(root, baseSha), baseSha, baseSha);
  const laterHunk = secondModel.files[0]?.hunks.find((hunk) =>
    hunk.lines.some((line) => line.text === "later change"),
  );

  assert.ok(firstId);
  assert.equal(laterHunk?.id, firstId);
  assert.notEqual(laterHunk?.header, firstModel.files[0]?.hunks[0]?.header);
});

test("empty patches produce an empty model and tree-to-tree reads remain parseable", async (t) => {
  const root = await repository(t);
  await put(root, "file.txt", "one\n");
  const baseSha = await commitAll(root, "base");
  assert.deepEqual(parseGitDiff("", baseSha, baseSha), { baseSha, headSha: baseSha, files: [] });

  await put(root, "file.txt", "two\n");
  const headSha = await commitAll(root, "head");
  const model = parseGitDiff(await readRawDiff(root, baseSha, headSha), baseSha, headSha);
  assert.equal(model.files[0]?.path, "file.txt");
  assert.equal(model.files[0]?.additions, 1);
  assert.equal(model.files[0]?.deletions, 1);
});

test("branch helpers resolve merge bases, include working changes, and list names", async (t) => {
  const root = await repository(t);
  await put(root, "file.txt", "base\n");
  const baseSha = await commitAll(root, "base");
  await git(root, "branch", "review-base");
  await put(root, "file.txt", "committed\n");
  const headSha = await commitAll(root, "head");
  await put(root, "file.txt", "working\n");
  await put(root, "untracked addition.txt", "new\n");

  assert.equal(await resolveRevision(root, "HEAD"), headSha);
  assert.deepEqual(await resolveBranchTarget(root, { kind: "branch", base: "review-base" }), {
    baseSha,
    headSha,
    includesWorkingTree: true,
  });
  assert.ok((await listBranches(root)).includes("review-base"));
  const workingPatch = await readRawDiffToWorkingTree(root, baseSha);
  assert.match(workingPatch, /\+working/);
  assert.equal(
    parseGitDiff(workingPatch, baseSha, headSha).files.find(
      (file) => file.path === "untracked addition.txt",
    )?.kind,
    "added",
  );
});

test("the default exec runner resolves non-zero exits and rejects spawn failures", async () => {
  const exited = await defaultExecRunner(process.execPath, [
    "-e",
    "process.stderr.write('no'); process.exit(7)",
  ]);
  assert.deepEqual(exited, { stdout: "", stderr: "no", code: 7 });
  const signaled = await defaultExecRunner(process.execPath, [
    "-e",
    "process.kill(process.pid, 'SIGTERM')",
  ]);
  assert.notEqual(signaled.code, 0);
  await assert.rejects(
    defaultExecRunner("definitely-not-a-review-test-command", []),
    (error: NodeJS.ErrnoException) => typeof error.code === "string",
  );
});

// `gh api --input -` reads stdin to end-of-file before it sends the request, so
// a runner that never writes and never closes stdin hangs instead of failing.
// A review submission blocked this way once left a `gh` process waiting
// indefinitely with the review kept only in the local store.
//
// The child reports what it received at end-of-file, and its guard timer reports
// the opposite. Without that guard a regression would stall the whole test run
// rather than fail this test, because the orphaned child keeps the runner alive.
const READ_STDIN_TO_END = [
  "let text = '';",
  "const done = (out) => process.stdout.write(out, () => process.exit(0));",
  "const guard = setTimeout(() => done('stdin-never-closed'), 5000);",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { text += chunk; });",
  "process.stdin.on('end', () => { clearTimeout(guard); done(text.length + ':' + text); });",
].join(" ");

test(
  "the default exec runner delivers input on stdin and closes it",
  { timeout: 30_000 },
  async () => {
    const payload = JSON.stringify({ body: "review body", comments: [] });

    const delivered = await defaultExecRunner(process.execPath, ["-e", READ_STDIN_TO_END], {
      input: payload,
    });
    assert.equal(delivered.code, 0);
    assert.equal(delivered.stdout, `${payload.length}:${payload}`);

    // Without input stdin must still be closed, or the child never exits.
    const empty = await defaultExecRunner(process.execPath, ["-e", READ_STDIN_TO_END]);
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "0:");
  },
);
