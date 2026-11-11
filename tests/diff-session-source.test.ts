// The session source against real git and real session files: what it lists, and where its baseline comes from.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_ENTRY } from "../.pi/extensions/checkpoints/turns.ts";
import {
  createTurnCheckpointProvider,
  SESSION_WITHOUT_CHECKPOINTS,
  sessionBaselineOf,
} from "../.pi/extensions/diff/core/checkpoints.ts";
import { emptyMessage, inlineList } from "../.pi/extensions/diff/ui/format.ts";
import type { DiffSnapshot, DiffStoreState } from "../.pi/extensions/lib/changes/git/model.ts";
import { NO_SESSION_CHECKPOINT } from "../.pi/extensions/lib/changes/git/snapshot.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import type {
  SessionBaselineChoice,
  TurnTreeProvider,
} from "../.pi/extensions/lib/changes/types.ts";

const execFileAsync = promisify(execFile);
const TEMP = tmpdir();
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function inTemp(path: string): void {
  assert.ok(path.startsWith(TEMP + sep) || path.startsWith(`/private${TEMP}${sep}`), path);
}

async function git(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  inTemp(cwd);
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...env },
    encoding: "utf8",
  });
  return result.stdout;
}

async function tempDir(
  t: { after(fn: () => Promise<void>): void },
  prefix: string,
): Promise<string> {
  const path = await realpath(await mkdtemp(join(TEMP, prefix)));
  inTemp(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function repository(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await tempDir(t, "diff-session-");
  await git(root, {}, "init", "-q", "-b", "main");
  await git(root, {}, "config", "user.name", "Diff Test");
  await git(root, {}, "config", "user.email", "diff@example.test");
  await git(root, {}, "config", "commit.gpgsign", "false");
  return root;
}

/** The tree of every non-ignored working file, as file-checkpoints captures it before a prompt. */
async function checkpointTree(root: string): Promise<string> {
  const index = join(root, ".git", "checkpoint-index-" + String(Math.random()).slice(2));
  await git(root, { GIT_INDEX_FILE: index }, "add", "-A");
  return (await git(root, { GIT_INDEX_FILE: index }, "write-tree")).trim();
}

function provider(choice: SessionBaselineChoice): TurnTreeProvider {
  return createTurnCheckpointProvider(
    () => [],
    () => choice,
  );
}

async function read(
  root: string,
  checkpoints: TurnTreeProvider | undefined,
  source: "session" | "uncommitted" = "session",
): Promise<DiffSnapshot> {
  const store = createDiffStore({ cwd: root, checkpoints, source: { kind: source } });
  try {
    await store.refreshNow();
    const state: DiffStoreState = store.getState();
    assert.equal(state.kind, "ready", state.kind === "error" ? state.message : state.kind);
    if (state.kind !== "ready") throw new Error("not ready");
    return state.snapshot;
  } finally {
    store.dispose();
  }
}

function listed(snapshot: DiffSnapshot): string[] {
  return snapshot.files.map((file) => `${file.path} +${file.additions} -${file.deletions}`);
}

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

function checkpointData(tree: string, label: string) {
  return {
    version: 2,
    worktreeTree: tree,
    timestamp: new Date().toISOString(),
    // Pi's turn_start index restarts at 0 for every prompt, so every checkpoint records 0.
    turnIndex: 0,
    label,
  };
}

/* ------------------------------------------------------------- listing */

test("the session source lists only this session's changes: earlier edits stay out, a re-edited file shows the session's part", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "pre.txt"), "one\n");
  await writeFile(join(root, "both.txt"), "one\n");
  await writeFile(join(root, "b.txt"), "one\n");
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "base");
  // Before the session: two dirty files and an untracked one.
  await writeFile(join(root, "pre.txt"), "one\npre\n");
  await writeFile(join(root, "both.txt"), "one\npre\n");
  await writeFile(join(root, "pre-untracked.txt"), "x\n");
  const tree = await checkpointTree(root);
  // During the session: an edit, a second edit of a dirty file, a new file (as a shell command would make).
  await writeFile(join(root, "b.txt"), "one\nsession\n");
  await writeFile(join(root, "both.txt"), "one\npre\nsession\n");
  await writeFile(join(root, "made-by-shell.txt"), "a\nb\n");

  const session = await read(root, provider({ kind: "checkpoint", tree, label: "turn 1 (edit)" }));
  assert.deepEqual(listed(session), ["b.txt +1 -0", "both.txt +1 -0", "made-by-shell.txt +2 -0"]);
  assert.deepEqual(session.baseline, { kind: "checkpoint", label: "turn 1 (edit)" });
  assert.equal(session.base, tree);

  const uncommitted = await read(root, undefined, "uncommitted");
  assert.deepEqual(
    uncommitted.files.map((file) => file.path),
    ["b.txt", "both.txt", "made-by-shell.txt", "pre-untracked.txt", "pre.txt"],
    "the uncommitted source still lists everything",
  );
  assert.equal(uncommitted.baseline, undefined);
});

test("changes committed during the session stay listed; the uncommitted source forgets them", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "base");
  const tree = await checkpointTree(root);
  await writeFile(join(root, "a.txt"), "one\ntwo\n");
  await writeFile(join(root, "new.txt"), "n\n");
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "agent commit");

  const checkpoints = provider({ kind: "checkpoint", tree, label: "turn 1 (commit it)" });
  const session = await read(root, checkpoints);
  assert.deepEqual(listed(session), ["a.txt +1 -0", "new.txt +1 -0"]);
  const uncommitted = await read(root, undefined, "uncommitted");
  assert.deepEqual(listed(uncommitted), []);
});

test("a commit during the session is picked up by the open pane's probe", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "base");
  const tree = await checkpointTree(root);
  await writeFile(join(root, "a.txt"), "one\ntwo\n");
  const store = createDiffStore({
    cwd: root,
    checkpoints: provider({ kind: "checkpoint", tree, label: "turn 1" }),
    source: { kind: "session" },
    limits: { debounceMs: 0, pollIntervalMs: 20 },
  });
  t.after(() => store.dispose());
  await store.refreshNow();
  const before = store.getState();
  assert.ok(before.kind === "ready" && before.snapshot.files[0]?.unstaged === true);
  const revision = before.snapshot.revision;
  await git(root, {}, "commit", "-qam", "agent commit");
  store.setVisible(true);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = store.getState();
    if (state.kind === "ready" && state.snapshot.revision > revision) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = store.getState();
  assert.ok(
    after.kind === "ready" && after.snapshot.revision > revision,
    "the probe saw the commit",
  );
  assert.deepEqual(listed(after.snapshot), ["a.txt +1 -0"], "still listed after the commit");
  assert.equal(after.snapshot.files[0]?.unstaged, false);
});

test("without a checkpoint the session source lists nothing, not the working tree, and says why", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "base");
  await writeFile(join(root, "a.txt"), "edited before the session\n");

  const fresh = SessionManager.inMemory(root);
  const none = await read(root, provider(sessionBaselineOf(fresh.getEntries())));
  assert.deepEqual(listed(none), []);
  assert.deepEqual(none.baseline, { kind: "none", reason: NO_SESSION_CHECKPOINT });
  // An empty session source names the way to the working tree's own changes.
  assert.equal(
    emptyMessage(none),
    `${NO_SESSION_CHECKPOINT} /diff source uncommitted shows every uncommitted change.`,
  );
  assert.match(
    inlineList({ kind: "ready", snapshot: none, refreshing: false }),
    /Baseline: none yet/u,
  );

  fresh.appendMessage(user("a prompt whose checkpoint failed"));
  const off = await read(root, provider(sessionBaselineOf(fresh.getEntries())));
  assert.deepEqual(listed(off), []);
  assert.deepEqual(off.baseline, { kind: "none", reason: SESSION_WITHOUT_CHECKPOINTS });
  // That reason already names the command; it is not repeated.
  assert.equal(emptyMessage(off), SESSION_WITHOUT_CHECKPOINTS);

  const noProvider = await read(root, undefined);
  assert.deepEqual(listed(noProvider), []);
  assert.equal(noProvider.baseline?.kind, "none");

  const turnsOnly: TurnTreeProvider = { listTurns: async () => [] };
  const fallback = await read(root, turnsOnly);
  assert.deepEqual(fallback.baseline, { kind: "none", reason: NO_SESSION_CHECKPOINT });
});

test("outside a git repository the session source reports it and lists nothing", async (t) => {
  const plain = await tempDir(t, "diff-session-plain-");
  const store = createDiffStore({
    cwd: plain,
    checkpoints: provider({ kind: "none", reason: NO_SESSION_CHECKPOINT }),
    source: { kind: "session" },
  });
  t.after(() => store.dispose());
  await store.refreshNow();
  assert.equal(store.getState().kind, "not-a-repository");
});

/* ------------------------------------------------------------ baseline */

test("the baseline is the session's first checkpoint across resume, compaction, /tree navigation and fork", async (t) => {
  const cwd = await tempDir(t, "diff-session-cwd-");
  const sessions = await tempDir(t, "diff-session-files-");
  const manager = SessionManager.create(cwd, sessions);
  manager.appendCustomEntry(CHECKPOINT_ENTRY, checkpointData("a".repeat(40), "first prompt"));
  const firstPrompt = manager.appendMessage(user("first prompt"));
  manager.appendCustomEntry(CHECKPOINT_ENTRY, checkpointData("b".repeat(40), "second prompt"));
  const secondPrompt = manager.appendMessage(user("second prompt"));
  const expected = { kind: "checkpoint", tree: "a".repeat(40), label: "turn 1 (first prompt)" };
  assert.deepEqual(sessionBaselineOf(manager.getEntries()), expected);

  manager.appendCompaction("summary", secondPrompt, 1000);
  assert.deepEqual(sessionBaselineOf(manager.getEntries()), expected, "after /compact");

  // /tree: back to the first prompt and a new branch from there.
  manager.branch(firstPrompt);
  manager.appendCustomEntry(CHECKPOINT_ENTRY, checkpointData("c".repeat(40), "other branch"));
  manager.appendMessage(user("other branch"));
  assert.deepEqual(sessionBaselineOf(manager.getEntries()), expected, "after /tree navigation");

  const file = manager.getSessionFile();
  assert.ok(file);
  const resumed = SessionManager.open(file, sessions);
  assert.deepEqual(sessionBaselineOf(resumed.getEntries()), expected, "a resumed session");

  // Fork (as /fork and /clone do): a new session file with the path to the chosen entry.
  const parentId = resumed.getSessionId();
  const forkFile = resumed.createBranchedSession(secondPrompt);
  assert.ok(forkFile);
  const fork = SessionManager.open(forkFile, sessions);
  assert.notEqual(fork.getSessionId(), parentId);
  assert.deepEqual(
    sessionBaselineOf(fork.getEntries()),
    expected,
    "a fork keeps its parent's start",
  );

  // A fork before the first prompt copied no prompt: its own first checkpoint is the start.
  const early = SessionManager.inMemory(cwd);
  early.appendCustomEntry(CHECKPOINT_ENTRY, checkpointData("a".repeat(40), "first prompt"));
  assert.equal(sessionBaselineOf(early.getEntries()).kind, "none");
  early.appendCustomEntry(CHECKPOINT_ENTRY, checkpointData("d".repeat(40), "fork prompt"));
  early.appendMessage(user("fork prompt"));
  assert.deepEqual(sessionBaselineOf(early.getEntries()), {
    kind: "checkpoint",
    tree: "d".repeat(40),
    label: "turn 1 (fork prompt)",
  });
});
