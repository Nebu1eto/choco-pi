import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { decodeNativeDiff } from "../.pi/packages/choco-pi-acp/src/acp/native-diff.ts";
import { createSystemClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import type {
  DiffSnapshot,
  DiffStoreState,
  FileSummary,
} from "../.pi/extensions/lib/changes/git/model.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import {
  NATIVE_DIFF_ENV,
  NATIVE_DIFF_NOTIFY_PREFIX,
  type NativeDiffReaders,
  presentNativeDiff,
  type SideRead,
  selectNativeDiff,
  uncommittedHint,
} from "../.pi/extensions/diff/native-diff.ts";

const SECRET = "TOP-SECRET-CONTENT-7f3a";
const TEMP_ROOT = tmpdir();

function summary(path: string, overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

function snapshot(files: FileSummary[], overrides: Partial<DiffSnapshot> = {}): DiffSnapshot {
  return {
    revision: 1,
    source: { kind: "uncommitted" },
    repoRoot: "/repo",
    head: "abc123",
    branch: "main",
    base: "abc123",
    capturedAt: 0,
    files,
    totals: { files: files.length, additions: files.length, deletions: files.length },
    omittedFiles: 0,
    ...overrides,
  };
}

type Spy = NativeDiffReaders & { oldPaths: string[]; newPaths: string[] };

/** Every read returns text that names the path, or SECRET for any sensitive-looking name. */
function spyReaders(content: (path: string, side: "old" | "new") => SideRead): Spy {
  const oldPaths: string[] = [];
  const newPaths: string[] = [];
  return {
    oldPaths,
    newPaths,
    async readOld(path) {
      oldPaths.push(path);
      return content(path, "old");
    },
    async readNew(path) {
      newPaths.push(path);
      return content(path, "new");
    },
  };
}

const textOf =
  (size = 10) =>
  (path: string, side: "old" | "new"): SideRead => ({
    kind: "text",
    text: `${side}:${path}:`.padEnd(size, "x").slice(0, Math.max(size, 0)),
  });

test("at most 30 files are shown; the rest are listed by name with the reason", async () => {
  const files = Array.from({ length: 35 }, (_, index) =>
    summary(`src/file-${String(index).padStart(2, "0")}.ts`),
  );
  const readers = spyReaders(textOf());
  const payload = await selectNativeDiff(snapshot(files), readers);
  assert.equal(payload.files.length, 30);
  assert.deepEqual(
    payload.skipped.map((entry) => [entry.path, entry.reason]),
    files.slice(30).map((file) => [file.path, "over the 30-file limit"]),
  );
  assert.equal(readers.newPaths.length, 30, "files over the cap are never read");
  assert.equal(payload.files[0]?.path, "/repo/src/file-00.ts", "paths are absolute");
  assert.equal(payload.files[0]?.displayPath, "src/file-00.ts");
});

test("the total text budget skips a file that would overflow it and keeps later small ones", async () => {
  const sizes = new Map([
    ["a.txt", 30],
    ["b.txt", 30],
    ["c.txt", 10],
  ]);
  const readers = spyReaders((path, side) => textOf(sizes.get(path) ?? 0)(path, side));
  const payload = await selectNativeDiff(
    snapshot([summary("a.txt"), summary("b.txt"), summary("c.txt")]),
    readers,
    { maxFiles: 30, maxTextBytes: 100, maxSkipped: 200 },
  );
  assert.deepEqual(
    payload.files.map((file) => file.displayPath),
    ["a.txt", "c.txt"],
  );
  assert.equal(payload.skipped.length, 1);
  assert.equal(payload.skipped[0]?.path, "b.txt");
  assert.match(payload.skipped[0]?.reason ?? "", /too large for the remaining text budget/u);
  const total = payload.files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.oldText ?? "") + Buffer.byteLength(file.newText),
    0,
  );
  assert.ok(total <= 100);
});

test("binary files are listed by name and their contents are not sent", async () => {
  const readers = spyReaders((path, side) =>
    path === "image.bin" && side === "new" ? { kind: "binary" } : textOf()(path, side),
  );
  const payload = await selectNativeDiff(
    snapshot([summary("logo.png", { binary: true }), summary("image.bin"), summary("ok.txt")]),
    readers,
  );
  assert.deepEqual(
    payload.files.map((file) => file.displayPath),
    ["ok.txt"],
  );
  assert.deepEqual(payload.skipped, [
    { path: "logo.png", reason: "binary file" },
    { path: "image.bin", reason: "binary file" },
  ]);
  assert.ok(!readers.newPaths.includes("logo.png"), "a file git marks binary is never read");
});

test("sensitive files are never read and only their names are sent", async () => {
  const sensitive = [
    ".env",
    "config/.env.local",
    "certs/server.pem",
    "certs/server.key",
    "certs/client.p12",
    "certs/client.pfx",
    "home/.ssh/id_rsa",
    "home/.ssh/id_ed25519.pub",
    "android/release.keystore",
    "agent/auth.json",
    ".npmrc",
    ".netrc",
    "docs/Client-Secret-notes.md",
    "credentials/aws.txt",
  ];
  const files = [
    ...sensitive.map((path) => summary(path)),
    summary("renamed.txt", { status: "renamed", oldPath: ".env.production" }),
    summary("public.txt"),
  ];
  const readers = spyReaders((path) => ({ kind: "text", text: `${SECRET} ${path}` }));
  const payload = await selectNativeDiff(snapshot(files), readers);
  assert.deepEqual(
    payload.files.map((file) => file.displayPath),
    ["public.txt"],
  );
  assert.deepEqual(
    payload.skipped.map((entry) => entry.path),
    [...sensitive, ".env.production -> renamed.txt"],
  );
  assert.ok(payload.skipped.every((entry) => entry.reason === "sensitive file; contents not sent"));
  assert.deepEqual(readers.oldPaths, ["public.txt"]);
  assert.deepEqual(readers.newPaths, ["public.txt"]);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.split(SECRET).length - 1, 2, "only public.txt's two sides are sent");
});

test("a rename or copy carries its previous absolute path, and the adapter decodes both sides", async () => {
  const readers = spyReaders(textOf());
  const payload = await selectNativeDiff(
    snapshot([
      summary("src/new.ts", { status: "renamed", oldPath: "src/old.ts" }),
      summary("src/copy.ts", { status: "copied", oldPath: "src/orig.ts" }),
      summary("src/plain.ts"),
    ]),
    readers,
  );
  assert.deepEqual(
    payload.files.map((file) => [file.displayPath, file.oldPath]),
    [
      ["src/new.ts", "/repo/src/old.ts"],
      ["src/copy.ts", "/repo/src/orig.ts"],
      ["src/plain.ts", undefined],
    ],
  );
  assert.deepEqual(readers.oldPaths, ["src/old.ts", "src/orig.ts", "src/plain.ts"]);
  const decoded = decodeNativeDiff(`${NATIVE_DIFF_NOTIFY_PREFIX}${JSON.stringify(payload)}`);
  assert.ok(decoded);
  assert.deepEqual(
    decoded.files.map((file) => [file.oldDisplayPath, file.displayPath]),
    [
      ["src/old.ts", "src/new.ts"],
      ["src/orig.ts", "src/copy.ts"],
      [undefined, "src/plain.ts"],
    ],
  );
});

test("added and untracked files have no old text; deleted files have empty new text", async () => {
  const readers = spyReaders(textOf());
  const payload = await selectNativeDiff(
    snapshot([
      summary("added.txt", { status: "added" }),
      summary("deleted.txt", { status: "deleted" }),
      summary("untracked.txt", { status: "untracked" }),
    ]),
    readers,
  );
  const byPath = new Map(payload.files.map((file) => [file.displayPath, file]));
  assert.equal(byPath.get("added.txt")?.oldText, null);
  assert.equal(byPath.get("untracked.txt")?.oldText, null);
  assert.equal(byPath.get("deleted.txt")?.newText, "");
  assert.equal(byPath.get("deleted.txt")?.oldText, "old:deleted.txt:".slice(0, 10));
  assert.deepEqual(readers.oldPaths, ["deleted.txt"]);
  assert.deepEqual(readers.newPaths, ["added.txt", "untracked.txt"]);
});

type Notified = { message: string; type: string | undefined };

type RecordingTarget = {
  mode: string;
  ui: { notify: (m: string, t?: "info" | "warning" | "error") => void };
  sent: Notified[];
};

function notifyTarget(mode: string): RecordingTarget {
  const sent: Notified[] = [];
  return { mode, sent, ui: { notify: (message, type) => sent.push({ message, type }) } };
}

const READY: DiffStoreState = {
  kind: "ready",
  refreshing: false,
  snapshot: snapshot([summary("a.txt")]),
};

const noDispose = (readers: NativeDiffReaders) => () => ({ ...readers, dispose: () => {} });

test("without the ACP marker, in the TUI, or for another source, /diff keeps its inline list", async () => {
  const clock = createSystemClock();
  const readers = noDispose(spyReaders(textOf()));
  const cases: Array<[string, DiffStoreState, Record<string, string>]> = [
    ["rpc", READY, {}],
    ["rpc", READY, { [NATIVE_DIFF_ENV]: "0" }],
    ["tui", READY, { [NATIVE_DIFF_ENV]: "1" }],
    [
      "rpc",
      { ...READY, snapshot: { ...READY.snapshot, source: { kind: "branch-base", base: "main" } } },
      { [NATIVE_DIFF_ENV]: "1" },
    ],
    ["rpc", { kind: "not-a-repository", cwd: "/x" }, {}],
    ["rpc", { kind: "error", message: "boom" }, {}],
  ];
  for (const [mode, state, env] of cases) {
    const target = notifyTarget(mode);
    const shown = await presentNativeDiff(target, state, {
      env,
      clock,
      alive: () => true,
      readers,
    });
    assert.equal(shown, false);
    assert.deepEqual(target.sent, []);
  }
});

test("under the ACP marker, /diff sends one versioned notification the adapter decodes", async () => {
  const target = notifyTarget("rpc");
  const shown = await presentNativeDiff(target, READY, {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock: createSystemClock(),
    alive: () => true,
    readers: noDispose(spyReaders(textOf())),
  });
  assert.equal(shown, true);
  assert.equal(target.sent.length, 1);
  const message = target.sent[0]?.message ?? "";
  assert.ok(message.startsWith(NATIVE_DIFF_NOTIFY_PREFIX));
  const decoded = decodeNativeDiff(message);
  assert.ok(decoded, "the adapter accepts the extension's payload");
  assert.equal(decoded.files.length, 1);
  assert.equal(decoded.files[0]?.path, "/repo/a.txt");
});

test("in the editor, git's error and the cwd are shown so that they cannot form Markdown", async () => {
  const hostile = "fatal: \u001b[31m# not\n[a](http://b) ```\u202e";
  const options = {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock: createSystemClock(),
    alive: () => true,
  };
  const failed = notifyTarget("rpc");
  assert.equal(await presentNativeDiff(failed, { kind: "error", message: hostile }, options), true);
  assert.equal(
    failed.sent[0]?.message,
    [
      "Diff failed:",
      "",
      "````text",
      "fatal: \u241b[31m# not",
      "[a](http://b) ```\uFFFD",
      "````",
    ].join("\n"),
  );
  const outside = notifyTarget("rpc");
  const cwd = "/tmp/# x [a](http://b) `q`";
  assert.equal(await presentNativeDiff(outside, { kind: "not-a-repository", cwd }, options), true);
  assert.equal(
    outside.sent[0]?.message,
    "Diff: `` /tmp/# x [a](http://b) `q` `` is not inside a git repository.",
  );
});

test("a session that ends while reading sends nothing", async () => {
  const target = notifyTarget("rpc");
  let alive = true;
  const readers = spyReaders((path, side) => {
    alive = false;
    return textOf()(path, side);
  });
  const shown = await presentNativeDiff(target, READY, {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock: createSystemClock(),
    alive: () => alive,
    readers: noDispose(readers),
  });
  assert.equal(shown, true);
  assert.deepEqual(target.sent, []);
});

test("each file carries its status and line counts, and the adapter keeps them", async () => {
  const target = notifyTarget("rpc");
  const state: DiffStoreState = {
    ...READY,
    snapshot: snapshot([
      summary("a.txt", { additions: 3, deletions: 2 }),
      summary("n.txt", { status: "untracked", additions: null, deletions: null }),
    ]),
  };
  await presentNativeDiff(target, state, {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock: createSystemClock(),
    alive: () => true,
    readers: noDispose(spyReaders(textOf())),
  });
  const decoded = decodeNativeDiff(target.sent[0]?.message ?? "");
  assert.ok(decoded);
  assert.deepEqual(
    decoded.files.map((file) => [file.displayPath, file.status, file.additions, file.deletions]),
    [
      ["a.txt", "modified", 3, 2],
      ["n.txt", "untracked", null, null],
    ],
  );
});

const EMPTY_SESSION: DiffStoreState = {
  kind: "ready",
  refreshing: false,
  snapshot: snapshot([], {
    source: { kind: "session" },
    baseline: { kind: "none", reason: "No file checkpoint yet." },
  }),
};

test("an empty session source with uncommitted changes names the command that shows them", async () => {
  for (const [count, hinted] of [
    [4, true],
    [1, true],
    [0, false],
    [undefined, false],
  ] as const) {
    const target = notifyTarget("rpc");
    const readers = { ...spyReaders(textOf()), countUncommitted: async () => count };
    await presentNativeDiff(target, EMPTY_SESSION, {
      env: { [NATIVE_DIFF_ENV]: "1" },
      clock: createSystemClock(),
      alive: () => true,
      readers: noDispose(readers),
    });
    assert.ok(
      target.sent[0]?.message.startsWith(NATIVE_DIFF_NOTIFY_PREFIX),
      "the card comes first",
    );
    assert.equal(target.sent.length, hinted ? 2 : 1, `count ${String(count)}`);
    if (hinted) {
      const hint = target.sent[1]?.message ?? "";
      assert.equal(hint, uncommittedHint(count ?? 0));
      assert.match(hint, /`\/diff source uncommitted` shows/u);
      assert.equal(hint.includes("\n"), false, "one line");
    }
  }
  assert.match(uncommittedHint(4), /\b4\b/u);
  assert.match(uncommittedHint(1), /\b1\b/u);
});

test("the hint is not counted for another source, a non-empty session, or a closed session", async () => {
  let counted = 0;
  const counting = {
    ...spyReaders(textOf()),
    countUncommitted: async () => {
      counted += 1;
      return 5;
    },
  };
  const emptyUncommitted: DiffStoreState = {
    kind: "ready",
    refreshing: false,
    snapshot: snapshot([]),
  };
  const busySession: DiffStoreState = {
    ...READY,
    snapshot: { ...READY.snapshot, source: { kind: "session" } },
  };
  for (const state of [emptyUncommitted, busySession]) {
    const target = notifyTarget("rpc");
    await presentNativeDiff(target, state, {
      env: { [NATIVE_DIFF_ENV]: "1" },
      clock: createSystemClock(),
      alive: () => true,
      readers: noDispose(counting),
    });
    assert.equal(target.sent.length, 1);
  }
  assert.equal(counted, 0);

  let alive = true;
  const closing = {
    ...spyReaders(textOf()),
    countUncommitted: async () => {
      alive = false;
      return 3;
    },
  };
  const target = notifyTarget("rpc");
  await presentNativeDiff(target, EMPTY_SESSION, {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock: createSystemClock(),
    alive: () => alive,
    readers: noDispose(closing),
  });
  assert.equal(target.sent.length, 1, "nothing is sent after the session closed");
});

// ---------------------------------------------------------------------------
// Real git: the store's file list plus git and filesystem reads.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function assertTemporary(path: string): void {
  assert.ok(
    path.startsWith(TEMP_ROOT + sep) || path.startsWith(`/private${TEMP_ROOT}${sep}`),
    `fixture path ${path} must be inside ${TEMP_ROOT}`,
  );
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  assertTemporary(cwd);
  await execFileAsync("git", args, { cwd, env: FIXTURE_ENV });
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const target = join(root, path);
  assertTemporary(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("real repository: /diff sends HEAD and working-tree text, never a secret", async (t) => {
  const root = await realpath(await mkdtemp(join(TEMP_ROOT, "diff-native-acp-")));
  assertTemporary(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await put(root, "a.txt", "one\ntwo\n");
  await put(root, "gone.txt", "bye\n");
  await put(root, ".env", "TOKEN=old\n");
  await put(root, "bin.dat", Buffer.from([0, 1, 2, 3]));
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");

  await put(root, "a.txt", "one\nTWO\n");
  await unlink(join(root, "gone.txt"));
  await put(root, "new.txt", "fresh\n");
  await put(root, ".env", `TOKEN=${SECRET}\n`);
  await put(root, "bin.dat", Buffer.from([0, 9, 9, 9]));

  const clock = createSystemClock();
  const store = createDiffStore({ cwd: root, clock });
  t.after(() => store.dispose());
  await store.refreshNow();
  const target = notifyTarget("rpc");
  const shown = await presentNativeDiff(target, store.getState(), {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock,
    alive: () => true,
  });
  assert.equal(shown, true);
  const message = target.sent[0]?.message ?? "";
  assert.ok(!message.includes(SECRET), "the .env contents never leave Pi");
  const payload = decodeNativeDiff(message);
  assert.ok(payload, "the adapter accepts the real payload");
  const byPath = new Map(payload.files.map((file) => [file.displayPath, file]));
  assert.deepEqual([...byPath.keys()].sort(), ["a.txt", "gone.txt", "new.txt"]);
  assert.deepEqual(
    { oldText: byPath.get("a.txt")?.oldText, newText: byPath.get("a.txt")?.newText },
    { oldText: "one\ntwo\n", newText: "one\nTWO\n" },
  );
  assert.equal(byPath.get("a.txt")?.path, join(root, "a.txt"));
  assert.deepEqual(
    { oldText: byPath.get("gone.txt")?.oldText, newText: byPath.get("gone.txt")?.newText },
    { oldText: "bye\n", newText: "" },
  );
  assert.deepEqual(
    { oldText: byPath.get("new.txt")?.oldText, newText: byPath.get("new.txt")?.newText },
    { oldText: null, newText: "fresh\n" },
  );
  assert.deepEqual(payload.skipped, [
    { path: ".env", reason: "sensitive file; contents not sent" },
    { path: "bin.dat", reason: "binary file" },
  ]);
});

test("real repository: a fresh session's empty /diff counts the uncommitted changes", async (t) => {
  const root = await realpath(await mkdtemp(join(TEMP_ROOT, "diff-native-acp-hint-")));
  assertTemporary(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await put(root, "a.txt", "one\n");
  await put(root, "b.txt", "two\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  await put(root, "a.txt", "ONE\n");
  await unlink(join(root, "b.txt"));
  await put(root, "dir/new.txt", "fresh\n");

  const clock = createSystemClock();
  const store = createDiffStore({ cwd: root, clock, source: { kind: "session" } });
  t.after(() => store.dispose());
  await store.refreshNow();
  const state = store.getState();
  assert.equal(
    state.kind === "ready" && state.snapshot.files.length,
    0,
    "the session lists nothing",
  );
  const target = notifyTarget("rpc");
  await presentNativeDiff(target, state, {
    env: { [NATIVE_DIFF_ENV]: "1" },
    clock,
    alive: () => true,
  });
  assert.equal(target.sent.length, 2);
  assert.equal(target.sent[1]?.message, uncommittedHint(3));
});
