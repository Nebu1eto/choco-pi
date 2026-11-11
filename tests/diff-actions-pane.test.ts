import assert from "node:assert/strict";
import test from "node:test";
import type { TurnCheckpointInfo } from "../.pi/extensions/diff/core/checkpoints.ts";
import type { PrefsIo } from "../.pi/extensions/diff/ui/prefs.ts";
import { isSensitivePath } from "../.pi/extensions/lib/changes/sensitive.ts";
import { file, flush, harness, hunk, textBody } from "./diff-actions-fakes.ts";

const TREE_1 = "1111111111111111111111111111111111111111";
const TREE_2 = "2222222222222222222222222222222222222222";
const TURNS: TurnCheckpointInfo[] = [
  { turn: 1, tree: TREE_1, checkpointTurnIndex: 0, prompt: "first prompt" },
  { turn: 2, tree: TREE_2, checkpointTurnIndex: 0, prompt: "fix the parser please" },
];

async function openFocused(h: ReturnType<typeof harness>) {
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  assert.ok(h.tui.paneFocused(), "the pane has focus");
}

/* --------------------------------------------------------------- sources */

test("s cycles session, uncommitted, latest turn, branch base; the header names the comparison", async () => {
  const h = harness({ turns: TURNS });
  await openFocused(h);
  h.store().ready(1, [file("src/a.ts")]);
  assert.match(h.header(), /Session changes|Uncommitted changes/);
  h.tui.input("s");
  assert.deepEqual(h.store().sources.at(-1), { kind: "uncommitted" });
  assert.match(h.header(), /Uncommitted changes/);
  h.tui.input("s");
  const turn = h.store().sources.at(-1);
  assert.deepEqual(turn, {
    kind: "since-checkpoint",
    checkpointId: TREE_2,
    label: "turn 2 (fix the parser please)",
  });
  assert.match(h.header(), /Changes since turn 2 \(fix the parser please\)/);
  // The store lists a checkpoint file that is untracked now by content, so no caveat is shown.
  assert.equal(h.header().includes("Known limit"), false);
  // The store's checkpoint provider resolves the id by tree.
  const listed = await h.store().checkpoints?.listTurns();
  assert.ok(listed?.some((entry) => entry.tree === TREE_2));
  h.tui.input("s");
  await flush();
  assert.deepEqual(h.store().sources.at(-1), { kind: "branch-base", base: "main" });
  assert.match(h.header(), /Changes since main/);
  h.tui.input("s");
  assert.deepEqual(h.store().sources.at(-1), { kind: "session" });
  assert.match(h.header(), /Session changes/);
});

test("/diff source turn picks a turn or says no checkpoint exists and keeps the source", async () => {
  const h = harness({ turns: TURNS });
  await openFocused(h);
  await h.run("source turn 1");
  assert.equal(h.store().sources.at(-1)?.kind, "since-checkpoint");
  assert.match(h.header(), /Changes since turn 1 \(first prompt\)/);
  const before = h.store().sources.length;
  await h.run("source turn 7");
  assert.equal(h.store().sources.length, before, "unknown turn keeps the source");
  assert.match(h.header(), /Turn 7 has no checkpoint/);

  const empty = harness({ turns: [] });
  await openFocused(empty);
  await empty.run("source turn");
  assert.equal(empty.store().sources.length, 0, "no source change");
  assert.match(empty.header(), /No turn checkpoint exists in this session yet/);
  empty.tui.input("s");
  assert.deepEqual(empty.store().sources.at(-1), { kind: "uncommitted" });
  empty.tui.input("s");
  await flush();
  assert.deepEqual(empty.store().sources.at(-1), { kind: "branch-base", base: "main" });
  assert.match(empty.header(), /turn source was skipped/);
});

/* -------------------------------------------------------------------- ask */

test("a on a file inserts its @ mention, keeps typed text, returns focus, sends nothing", async () => {
  const h = harness({ editorText: "Why did this change?" });
  await openFocused(h);
  h.store().ready(1, [file("src/a.ts"), file("docs/my notes.md")]);
  h.tui.input("a");
  assert.equal(h.editor.text, "Why did this change? @src/a.ts ");
  assert.equal(h.tui.paneFocused(), false, "focus is back in the editor");
  await h.run("focus");
  h.tui.input("j");
  h.tui.input("a");
  assert.equal(h.editor.text, 'Why did this change? @src/a.ts @"docs/my notes.md" ');
});

test("a on a short hunk inserts the range and a fenced diff; a long hunk only the range", async () => {
  const h = harness({ editorText: "" });
  await openFocused(h);
  const short = hunk("h-short", 3, [" keep", "-old", "+new", " tail"]);
  const longBody = Array.from({ length: 61 }, (_, index) => `+line ${index}`);
  const long = hunk("h-long", 40, longBody);
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [short, long]));
  h.store().ready(1, [file("src/a.ts")]);
  h.tui.input("n");
  await flush();
  assert.deepEqual(h.view().selectedHunk, { path: "src/a.ts", hunkId: "h-short" });
  h.tui.input("a");
  assert.equal(
    h.editor.text,
    "@src/a.ts lines 3-5\n```diff\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail\n```\n",
  );
  await h.run("focus");
  h.tui.input("n");
  assert.deepEqual(h.view().selectedHunk, { path: "src/a.ts", hunkId: "h-long" });
  h.tui.input("a");
  const added = h.editor.text.split("```\n").at(-1) ?? "";
  assert.match(added, /^@src\/a\.ts lines 40-100 \(the hunk has 61 lines, more than 60/);
  assert.equal(added.includes("+line 0"), false, "long hunk text is not inserted");
  assert.match(h.header(), /longer than 60 lines/);
});

test("a on selected lines inserts their range and only those lines", async () => {
  const h = harness({ editorText: "" });
  await openFocused(h);
  const short = hunk("h-short", 3, [" keep", "-old", "+new", " tail"]);
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [short]));
  h.store().ready(1, [file("src/a.ts")]);
  h.tui.input("n");
  await flush();
  const DOWN = "\u001b[B";
  h.tui.input(DOWN);
  h.tui.input(DOWN);
  h.tui.input("a");
  assert.equal(
    h.editor.text,
    "@src/a.ts removed line 4 (numbered as before the change)\n```diff\n-old\n```\n",
    "a removed line has only its old number",
  );
  assert.equal(h.tui.paneFocused(), false, "focus is back in the editor");
  h.editor.text = "";
  await h.run("focus");
  h.tui.input("\u001b[1;2B");
  h.tui.input("a");
  assert.equal(h.editor.text, "@src/a.ts line 4\n```diff\n-old\n+new\n```\n");
  assert.match(h.header(), /Selected lines added to the editor/);
});

const SENSITIVE = [
  ".env",
  ".env.production",
  "certs/server.pem",
  "tls/server.key",
  "store/client.p12",
  "store/client.pfx",
  "home/.ssh/id_rsa",
  "home/.ssh/id_ed25519.pub",
  "android/release.keystore",
  "config/my-Secret-values.yaml",
  "config/AWS_Credentials.ini",
  "agent/auth.json",
  ".npmrc",
  "home/.netrc",
];

test("sensitive files: every pattern matches and ordinary names do not", () => {
  for (const path of SENSITIVE) assert.equal(isSensitivePath(path), true, path);
  for (const path of ["src/a.ts", "environment.ts", "keys.ts", "docs/pem-guide.md", "authz.json"]) {
    assert.equal(isSensitivePath(path), false, path);
  }
});

test("sensitive files: ask inserts only the path and the body stays hidden until v", async () => {
  // Representative names: the classifier test above covers every category.
  for (const path of [".env", "home/.ssh/id_rsa", "config/AWS_Credentials.ini"]) {
    const h = harness();
    await openFocused(h);
    const secretHunk = hunk(`h-${path}`, 1, ["+TOKEN=hunter2"]);
    h.store().bodies.set(path, textBody(path, [secretHunk]));
    h.store().ready(1, [file(path)]);
    h.tui.input("\r");
    await flush();
    assert.deepEqual(h.store().loads, [], `${path}: body not even loaded`);
    assert.match(h.body(), /Sensitive file: contents hidden/, path);
    h.tui.input("n");
    assert.equal(h.view().selectedHunk, undefined, `${path}: hidden hunks are not selectable`);
    h.tui.input("a");
    assert.equal(h.editor.text.includes("hunter2"), false, path);
    assert.match(h.editor.text, /^@\S+ $/u, `${path}: path only`);
    assert.match(h.header(), /Sensitive file: only its path/);

    // v alone shows the body in the pane, but ask still inserts only the path.
    h.editor.text = "";
    await h.run("focus");
    h.tui.input("v");
    await flush();
    assert.match(h.body(), /hunter2/, `${path}: shown on v alone`);
    h.tui.input("n");
    assert.deepEqual(h.view().selectedHunk, { path, hunkId: `h-${path}` });
    h.tui.input("a");
    assert.equal(
      h.editor.text.includes("hunter2"),
      false,
      `${path}: hunk ask never inserts content`,
    );
    assert.match(h.header(), /never its contents/);
  }
});

test("v shows a sensitive body for this pane only: a reopened pane hides it again", async () => {
  const h = harness();
  await openFocused(h);
  h.store().bodies.set(".env", textBody(".env", [hunk("h", 1, ["+A=1"])]));
  h.store().ready(1, [file(".env")]);
  assert.doesNotMatch(h.body(), /A=1/);
  h.tui.input("v");
  await flush();
  assert.match(h.body(), /A=1/, "shown at once");
  assert.doesNotMatch(h.body(), /y to confirm/);
  await h.run("close");
  await h.run("focus");
  h.store().bodies.set(".env", textBody(".env", [hunk("h", 1, ["+A=1"])]));
  h.store().ready(1, [file(".env")]);
  assert.equal(h.view().revealed.has(".env"), false, "a reopened pane starts hidden");
  // The pane keeps which files were expanded; open it if it is not.
  if (!h.view().expanded.has(".env")) h.tui.input("\r");
  await flush();
  assert.match(h.body(), /Sensitive file: contents hidden/);
  assert.doesNotMatch(h.body(), /A=1/, "hidden again after reopening");
});

/* ------------------------------------------------------------------ notes */

function memoryIo(): PrefsIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (path) => files.get(path),
    write: async (path, contents) => {
      files.set(path, contents);
    },
  };
}

test("notes follow their hunk across a refresh, go outdated when it disappears, compose, and clear", async () => {
  const io = memoryIo();
  const h = harness({ notesIo: io, editorText: "Before:" });
  await openFocused(h);
  const original = hunk("h-a", 3, [" keep", "+added"]);
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [original]));
  h.store().ready(1, [file("src/a.ts"), file("src/b.ts")]);
  h.tui.input("n");
  await flush();
  h.tui.input("c");
  assert.match(h.header(), /Note on src\/a\.ts lines 3-4/);
  h.tui.type("check the bounds");
  h.tui.input("\r");
  assert.equal(h.probe.session()?.notes?.notes.length, 1);
  assert.match(h.body(), /✎1/, "marker on the file row");
  assert.match(h.body(), /✎ check the bounds/);
  await h.probe.session()?.notes?.flush();
  assert.match(io.files.get("/scratch/diff-notes/session.json") ?? "", /check the bounds/);

  // Lines above were inserted: same hunk id, new position.
  const moved = { ...original, newStart: 10, oldStart: 10, header: "@@ -10,1 +10,2 @@" };
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [moved]));
  h.store().ready(2, [file("src/a.ts"), file("src/b.ts")]);
  await flush();
  assert.match(h.body(), /✎ check the bounds/);
  assert.doesNotMatch(h.body(), /outdated/);
  h.tui.input("C");
  await flush();
  assert.ok(h.editor.text.startsWith("Before:\n"), "the editor's text is kept");
  assert.match(h.editor.text, /@src\/a\.ts lines 10-11\b.*check the bounds/u);
  assert.doesNotMatch(h.editor.text, /outdated/u);
  assert.equal(h.tui.paneFocused(), false, "focus returned; nothing sent");

  // The hunk's content changed: its id is gone, so the note is outdated.
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [hunk("h-other", 10, ["+rewritten"])]));
  h.store().ready(3, [file("src/a.ts"), file("src/b.ts")]);
  await flush();
  assert.match(h.body(), /✎ \(outdated, was lines 3-4\) check the bounds/);
  h.editor.text = "";
  await h.run("notes send");
  assert.match(h.editor.text, /@src\/a\.ts lines 3-4 \(outdated\b[^)]*\).*check the bounds/u);

  await h.run("notes clear");
  assert.equal(h.probe.session()?.notes?.notes.length, 0);
  assert.doesNotMatch(h.body(), /check the bounds/);
  await h.probe.session()?.notes?.flush();
  assert.match(io.files.get("/scratch/diff-notes/session.json") ?? "", /"notes":\[\]/);
});

test("c without a selected hunk explains how; Esc cancels a note", async () => {
  const h = harness();
  await openFocused(h);
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [hunk("h", 1, ["+x"])]));
  h.store().ready(1, [file("src/a.ts")]);
  h.tui.input("c");
  assert.match(h.header(), /Select a hunk first/);
  h.tui.input("n");
  await flush();
  h.tui.input("c");
  h.tui.type("q");
  h.tui.input("\u001b");
  assert.equal(h.probe.session()?.notes?.notes.length ?? 0, 0);
  assert.ok(h.tui.paneFocused(), "q and Esc went to the note input, not to unfocus");
});

/* ------------------------------------------------------- review and help */

test("R and /diff review put the /review instruction for the current source in the editor", async () => {
  const h = harness({ turns: TURNS, editorText: "" });
  await openFocused(h);
  h.store().ready(1, [file("src/a.ts")]);
  h.tui.input("R");
  assert.equal(
    h.editor.text,
    "/review current staged and unstaged changes against HEAD, including untracked files ",
  );
  assert.equal(h.tui.paneFocused(), false);
  h.editor.text = "";
  h.store().ready(2, [file("src/a.ts")], { kind: "branch-base", base: "develop" });
  await h.run("review");
  assert.match(h.editor.text, /^\/review the .*merge-base\(HEAD, develop\)/);
});

test("? toggles the key list; the focused hint mentions it", async () => {
  const h = harness();
  await openFocused(h);
  h.store().ready(1, [file("src/a.ts")]);
  assert.match(h.header(), /\? help/);
  const rows = () => h.header().split("\n").length;
  const closed = rows();
  h.tui.input("?");
  assert.ok(rows() > closed, "the key list opens");
  h.tui.input("?");
  assert.equal(rows(), closed);
  h.tui.input("?");
  h.tui.input("\u001b");
  assert.equal(rows(), closed, "Esc closes the list first");
  assert.ok(h.tui.paneFocused());
  assert.ok(h.probe.session()?.host);
});
