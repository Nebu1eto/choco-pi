// The shared changes view (lib/changes/view): the options and key table the
// pane leaves at their defaults, exercised on a real store.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import type { FileSummary } from "../.pi/extensions/lib/changes/git/model.ts";
import type { DiffFile, DiffHunk } from "../.pi/extensions/lib/changes/types.ts";
import { changedLineMatches } from "../.pi/extensions/lib/changes/view/line-cursor.ts";
import { isString } from "../.pi/extensions/lib/runtime-values.ts";
import {
  ChangesView,
  renderUnifiedBody,
  type AskTarget,
  type ChangesViewOptions,
} from "../.pi/extensions/lib/changes/view/changes-view.ts";
import {
  actionFor,
  COPY_KEY,
  copyKeyFor,
  CHANGES_ACTIONS,
  PANE_KEYS,
  type ChangesAction,
  type ChangesKeyTable,
} from "../.pi/extensions/lib/changes/view/keys.ts";
import { plainPaneStyler, type PaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import { flush, until } from "./diff-actions-fakes.ts";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SECRET = "TOKEN=VIEW-SECRET-41";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, env: ENV, encoding: "utf8" })).stdout;
}

type Cleanup = { after(fn: () => void | Promise<void>): void };

/** .env, a.ts and b.ts modified; returns the view over a real store. */
async function mount(t: Cleanup, options: Partial<ChangesViewOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "changes-view-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "View Test");
  await git(root, "config", "user.email", "view@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  for (const name of [".env", "a.ts", "b.ts"]) await writeFile(join(root, name), "old\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  await writeFile(join(root, ".env"), `${SECRET}\n`);
  await writeFile(join(root, "a.ts"), "new a\n");
  await writeFile(join(root, "b.ts"), "new b\n");
  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  store.setSource({ kind: "uncommitted" });
  const unfocused: string[] = [];
  let renders = 0;
  const view = new ChangesView({
    store,
    styler: plainPaneStyler,
    renderFileBody: renderUnifiedBody,
    keyHint: "hint",
    helpLines: ["help line"],
    actions: {
      unfocus: () => unfocused.push("unfocus"),
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {
        renders += 1;
      },
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
    ...options,
  });
  t.after(() => view.dispose());
  await store.refreshNow();
  view.setState(store.getState());
  return { view, unfocused, renders: () => renders };
}

test("the pane's key table binds each key to exactly one action", () => {
  const seen = new Map<string, ChangesAction>();
  for (const action of CHANGES_ACTIONS) {
    for (const binding of PANE_KEYS[action]) {
      const name = isString(binding) ? binding : binding.key;
      assert.equal(seen.has(name), false, `${name} is bound twice`);
      seen.set(name, action);
    }
  }
  assert.equal(actionFor(PANE_KEYS, "v"), "reveal");
  assert.equal(actionFor(PANE_KEYS, "j"), "fileDown");
  assert.equal(actionFor(PANE_KEYS, "\u001b[B"), "down");
  assert.equal(actionFor(PANE_KEYS, "\t"), "back");
  assert.equal(actionFor(PANE_KEYS, "\u001b[D"), "olderTurn");
  assert.equal(actionFor(PANE_KEYS, "\u001b[C"), "newerTurn");
  assert.equal(actionFor(PANE_KEYS, "\u001b[1;2D"), "back", "Shift+← still leaves the pane");
  // Copying is Cmd+C on macOS, where Ctrl+C stays the interrupt key, and Ctrl+C elsewhere.
  assert.deepEqual(copyKeyFor("darwin"), { key: "super+c", label: "Cmd+C" });
  assert.deepEqual(copyKeyFor("linux"), { key: "ctrl+c", label: "Ctrl+C" });
  const CMD_C = "\u001b[99;9u";
  const CTRL_C = "\u0003";
  const mac: ChangesKeyTable = { ...PANE_KEYS, copy: [{ key: copyKeyFor("darwin").key }] };
  assert.equal(actionFor(mac, CMD_C), "copy");
  assert.equal(actionFor(mac, CTRL_C), undefined);
  const other: ChangesKeyTable = { ...PANE_KEYS, copy: [{ key: copyKeyFor("win32").key }] };
  assert.equal(actionFor(other, CTRL_C), "copy");
  assert.equal(actionFor(other, CMD_C), undefined);
  assert.equal(actionFor(PANE_KEYS, COPY_KEY.key === "super+c" ? CMD_C : CTRL_C), "copy");
  assert.equal(actionFor(PANE_KEYS, "\r"), "toggle");
  assert.equal(actionFor(PANE_KEYS, "y"), undefined);
});

test("a host's key table rebinds actions; unbound keys do nothing", async (t) => {
  const keys: ChangesKeyTable = { ...PANE_KEYS, fileDown: ["x"], back: ["Q"] };
  const { view, unfocused } = await mount(t, { keys });
  assert.equal(view.selectedIndex, 0);
  view.handleKey("j");
  assert.equal(view.selectedIndex, 0, "j is unbound in this table");
  view.handleKey("x");
  assert.equal(view.selectedIndex, 1);
  view.handleKey("q");
  assert.deepEqual(unfocused, []);
  view.handleKey("Q");
  assert.deepEqual(unfocused, ["unfocus"]);
});

test("reveal: v shows a sensitive file at once, with no confirmation; a host's table can rebind it", async (t) => {
  const shown = async (view: ChangesView, renders: () => number) => {
    await until(() => view.bodies.has(".env") && renders() > 0, ".env body loaded");
    await flush();
    return view.renderBody(80, true).join("\n").includes(SECRET);
  };

  const pane = await mount(t);
  assert.equal(pane.view.selectedFile()?.path, ".env");
  assert.equal(
    pane.view.renderBody(80, true).join("\n").includes(SECRET),
    false,
    "hidden at first",
  );
  pane.view.handleKey("v");
  assert.equal(pane.view.revealed.has(".env"), true, "one key, no confirmation step");
  assert.equal(await shown(pane.view, pane.renders), true);

  const rebound = await mount(t, { keys: { ...PANE_KEYS, reveal: ["y"] } });
  rebound.view.handleKey("v");
  assert.equal(rebound.view.revealed.has(".env"), false, "v is not bound here");
  rebound.view.handleKey("y");
  assert.equal(rebound.view.revealed.has(".env"), true);
  assert.equal(await shown(rebound.view, rebound.renders), true);
});

test("fileOrder orders the list and selection; rowBadges add to the row", async (t) => {
  let score = 7;
  const { view } = await mount(t, {
    fileOrder: (files) => [...files].reverse(),
    rowBadges: (path) => (path === "b.ts" ? [{ text: `▲${score}`, color: "warning" }] : []),
  });
  assert.deepEqual(
    view.files().map((file) => file.path),
    ["b.ts", "a.ts", ".env"],
  );
  assert.equal(view.selectedFile()?.path, "b.ts");
  view.handleKey("j");
  assert.equal(view.selectedFile()?.path, "a.ts");
  const drawn = view.renderBody(80, false);
  const rowOf = (name: string) => drawn.findIndex((line) => line.includes(` ${name}`));
  assert.ok(
    rowOf("b.ts") < rowOf("a.ts") && rowOf("a.ts") < rowOf(".env"),
    "rows follow the order",
  );
  assert.match(drawn[rowOf("a.ts")] ?? "", /^❯/, "the marker is on the selected file");
  const row = () => view.renderBody(80, false).find((line) => line.includes("b.ts")) ?? "";
  assert.match(row(), /▲7/);
  score = 9;
  assert.match(row(), /▲9/, "a changed badge is not served from the row cache");
});

/* ------------------------------------------------- the review's options */

const H1: DiffHunk = {
  id: "h1",
  header: "@@ -1,3 +1,3 @@ first",
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    { kind: "context", oldLine: 1, newLine: 1, text: "keep one" },
    { kind: "del", oldLine: 2, text: "old two" },
    { kind: "add", newLine: 2, text: "new two" },
    { kind: "context", oldLine: 3, newLine: 3, text: "keep three" },
  ],
};
const H2: DiffHunk = {
  id: "h2",
  header: "@@ -20,1 +20,2 @@ second",
  oldStart: 20,
  oldLines: 1,
  newStart: 20,
  newLines: 2,
  lines: [
    { kind: "context", oldLine: 20, newLine: 20, text: "keep twenty" },
    { kind: "add", newLine: 21, text: "added twenty-one" },
  ],
};
const H3: DiffHunk = {
  id: "h3",
  header: "@@ -5,1 +5,1 @@ third",
  oldStart: 5,
  oldLines: 1,
  newStart: 5,
  newLines: 1,
  lines: [
    { kind: "del", oldLine: 5, text: "the old needle" },
    { kind: "add", newLine: 5, text: "the new line" },
  ],
};
const FILES: DiffFile[] = [
  { path: "a.ts", kind: "modified", hunks: [H1, H2], additions: 2, deletions: 1 },
  { path: "b.ts", kind: "modified", hunks: [H3], additions: 1, deletions: 1 },
];

/** Inverted rows read as <…>, so a selection is visible in plain text. */
const MARKING: PaneStyler = { ...plainPaneStyler, inverse: (text) => `<${text}>` };

function fileNamed(path: string): DiffFile {
  const found = FILES.find((file) => file.path === path);
  if (!found) throw new Error(`no fixture file ${path}`);
  return found;
}

/** A line-cursor view over an in-memory store, every file expanded and loaded. */
async function lineView(options: Partial<ChangesViewOptions> = {}): Promise<ChangesView> {
  const summaries: FileSummary[] = FILES.map((file) => ({
    path: file.path,
    status: "modified",
    additions: file.additions,
    deletions: file.deletions,
    binary: false,
    staged: false,
    unstaged: true,
  }));
  const view = new ChangesView({
    store: {
      loadFile: async (path) => ({ revision: 1, body: { kind: "text", file: fileNamed(path) } }),
    },
    styler: MARKING,
    keyHint: "hint",
    helpLines: [],
    cursor: "line",
    // The review's movement: j/k and the arrows both walk lines.
    keys: {
      ...PANE_KEYS,
      down: ["j", { key: "down" }],
      up: ["k", { key: "up" }],
      fileDown: [],
      fileUp: [],
    },
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
    ...options,
  });
  view.setState({
    kind: "ready",
    refreshing: false,
    snapshot: {
      revision: 1,
      source: { kind: "uncommitted" },
      repoRoot: "/repo",
      head: "head",
      branch: "main",
      base: "head",
      capturedAt: 0,
      files: summaries,
      totals: { files: 2, additions: 3, deletions: 2 },
      omittedFiles: 0,
    },
  });
  for (const file of FILES) view.expand(file.path);
  await until(() => view.bodies.size === FILES.length, "bodies loaded");
  return view;
}

const SHIFT_DOWN = "\u001b[1;2B";
const ENTER = "\r";
/** Word-level changes are inverted too, so marks are dropped before matching text. */
const unmarked = (line: string) => line.replaceAll(/[<>]/gu, "");
/** Rows inverted whole (from the gutter or the file row on), as the cursor draws them. */
const inverted = (view: ChangesView, width = 80) =>
  view
    .renderBody(width, true)
    .filter((line) => line.slice(1).startsWith("<"))
    .map(unmarked);
const body = (view: ChangesView, width = 80) =>
  view.renderBody(width, true).map(unmarked).join("\n");

test("line cursor: j/k walk file rows and lines, Shift selects a range drawn inverted", async () => {
  const view = await lineView();
  assert.deepEqual(view.lineCursor(), { path: "a.ts" });
  assert.equal(inverted(view).length, 1);
  assert.match(inverted(view)[0] ?? "", /a\.ts/, "the file row is the cursor");
  view.handleKey("j");
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 0 });
  view.handleKey(SHIFT_DOWN);
  assert.deepEqual(view.commentPosition(), {
    path: "a.ts",
    hunkId: "h1",
    side: "LEFT",
    line: 2,
    startLine: 1,
  });
  const rows = inverted(view);
  assert.equal(rows.length, 2);
  assert.match(rows[0] ?? "", /keep one/);
  assert.match(rows[1] ?? "", /old two/);
  view.handleKey("k");
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h1", lineIndex: 0 },
    "plain movement collapses",
  );
  view.handleKey("G");
  assert.deepEqual(view.lineCursor(), { path: "b.ts", hunkId: "h3", lineIndex: 1 });
  view.handleKey("g");
  assert.deepEqual(view.lineCursor(), { path: "a.ts" });
});

test("foldReason and reviewedHunks: Enter folds the cursor's hunk to one placeholder stop", async () => {
  const view = await lineView({
    foldReason: (hunkId) => `reason for ${hunkId}`,
    reviewedHunks: () => new Set(["h1", "h2"]),
  });
  assert.equal(body(view).match(/✓ reviewed/g)?.length, 2, "unfolded reviewed hunks say so");
  view.handleKey("j");
  view.handleKey(ENTER);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" });
  assert.match(body(view), /\(reason for h1\)/);
  assert.doesNotMatch(body(view), /keep one/);
  assert.equal(
    body(view).match(/✓ reviewed/g)?.length,
    1,
    "a folded hunk shows its reason instead",
  );
  view.handleKey("j");
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h2", lineIndex: 0 },
    "the fold is one stop",
  );
  view.handleKey("k");
  view.handleKey(ENTER);
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h1", lineIndex: 0 },
    "unfolding enters its first line",
  );
  view.handleKey("g");
  view.handleKey(ENTER);
  assert.doesNotMatch(body(view), /keep twenty/, "Enter on a file row collapses the file");
});

test("mode: split lays a removed and an added line on one row; unified on two", async () => {
  let mode: "unified" | "split" = "split";
  const view = await lineView({ mode: () => mode });
  const paired = () =>
    body(view, 140)
      .split("\n")
      .some((line) => /old two.*new two/.test(line));
  assert.equal(paired(), true);
  mode = "unified";
  view.invalidate();
  assert.equal(paired(), false);
});

test("search sends the cursor to each match, expanding its file and unfolding its hunk, and wraps", async () => {
  const view = await lineView({ search: (query) => changedLineMatches(FILES, query) });
  view.setFolded("h3", true);
  view.setCursor({ path: "b.ts" });
  view.handleKey(ENTER);
  assert.equal(view.expanded.has("b.ts"), false);
  view.setSearch("needle");
  assert.deepEqual(view.lineCursor(), { path: "b.ts", hunkId: "h3", lineIndex: 0 });
  assert.equal(view.expanded.has("b.ts"), true);
  assert.equal(view.foldedHunks.has("h3"), false);
  view.setSearch("two");
  assert.equal(view.searchState?.matches.length, 2, "changed lines only");
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 1 });
  view.moveSearchMatch(1);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 2 });
  view.moveSearchMatch(1);
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h1", lineIndex: 1 },
    "wraps forward",
  );
  view.moveSearchMatch(-1);
  assert.equal(view.searchState?.index, 1, "wraps back");
  view.setSearch("");
  assert.equal(view.searchState, undefined);
});

test("expandContext, annotations, rowDetails and trailers: host rows sit where they belong", async () => {
  let revealed = false;
  const above = { kind: "context" as const, oldLine: 0, newLine: 0, text: "revealed zero" };
  const view = await lineView({
    expandContext: (hunk) =>
      revealed && hunk.id === "h1" ? { ...hunk, lines: [above, ...hunk.lines] } : hunk,
    annotations: (path, hunks) => {
      const h1 = hunks.find((hunk) => hunk.id === "h1");
      const after = h1?.lines.findIndex((line) => line.newLine === 2) ?? -1;
      return path === "a.ts" && after >= 0
        ? [{ hunkId: "h1", place: { afterLine: after }, lines: ["COMMENT"] }]
        : [];
    },
    rowDetails: (path) => (path === "b.ts" ? [{ text: "risk reason", color: "warning" }] : []),
    fileTrailer: (path) => (path === "a.ts" ? ["A-TRAILER"] : []),
    trailer: () => ["LIST-TRAILER"],
  });
  const lines = view.renderBody(80, true).map(unmarked);
  const index = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
  assert.equal(index(/COMMENT/), index(/new two/) + 1);
  assert.equal(index(/A-TRAILER/), index(/added twenty-one/) + 1);
  assert.equal(index(/risk reason/), index(/b\.ts/) + 1);
  assert.equal(index(/LIST-TRAILER/), lines.length - 1);

  view.setCursor({ path: "a.ts", hunkId: "h1", lineIndex: 1 });
  revealed = true;
  view.contextChanged("h1", 1);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 2 });
  assert.match(inverted(view)[0] ?? "", /old two/, "the cursor stays on its line");
  assert.match(body(view), /revealed zero/);
  view.setFolded("h1", true);
  assert.doesNotMatch(body(view), /COMMENT/, "a folded hunk's annotations are not drawn");
});

/* --------------------------------------------- the pane's cursor and mouse */

const DOWN = "\u001b[B";
const UP = "\u001b[A";

/** The line view as the /diff pane configures it, recording what `a` asks about. */
async function paneLineView() {
  const asked: AskTarget[] = [];
  const view = await lineView({
    keys: PANE_KEYS,
    hunkStops: true,
    freeSelection: true,
    enterFolds: false,
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
      ask: (target) => asked.push(target),
    },
  });
  /** The body row showing `pattern`, as just drawn. */
  const rowOf = (pattern: RegExp) => {
    const row = view.renderBody(80, true).findIndex((line) => pattern.test(unmarked(line)));
    assert.ok(row >= 0, `no row matches ${pattern}`);
    return row;
  };
  return { view, asked, rowOf };
}

test("pane cursor: j/k step files, the arrows walk a hunk's header and lines, and a asks about the selection", async () => {
  const { view, asked } = await paneLineView();
  view.handleKey(DOWN);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" }, "the header is a stop");
  view.handleKey("a");
  assert.deepEqual(asked.at(-1), { file: view.selectedFile(), hunk: H1 }, "the whole hunk");
  view.handleKey(DOWN);
  view.handleKey(DOWN);
  view.handleKey(SHIFT_DOWN);
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h1", lineIndex: 2, anchorIndex: 1 },
    "a removed and an added line together",
  );
  view.handleKey("a");
  assert.deepEqual(asked.at(-1), {
    file: view.selectedFile(),
    hunk: H1,
    lines: { first: 1, last: 2 },
  });
  view.handleKey("j");
  assert.deepEqual(view.lineCursor(), { path: "b.ts" }, "j leaves the lines for the next file");
  view.handleKey("k");
  view.handleKey("n");
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" }, "n lands on the header");
  view.handleKey(DOWN);
  view.handleKey(ENTER);
  assert.equal(view.expanded.has("a.ts"), false, "Enter on a line collapses its file");
  assert.deepEqual(view.lineCursor(), { path: "a.ts" });
});

test("mouse: a click on a file row expands or collapses it; a press and drags select lines of one hunk", async () => {
  const { view, asked, rowOf } = await paneLineView();
  assert.equal(
    view.pointer({ kind: "press", row: rowOf(/b\.ts/) }),
    false,
    "a file row takes the click",
  );
  assert.equal(view.pointer({ kind: "click", row: rowOf(/b\.ts/) }), true);
  assert.equal(view.selectedPath, "b.ts");
  assert.equal(view.expanded.has("b.ts"), false);
  view.pointer({ kind: "click", row: rowOf(/b\.ts/) });
  assert.equal(view.expanded.has("b.ts"), true);

  assert.equal(view.pointer({ kind: "press", row: rowOf(/old two/) }), true);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 1 });
  view.pointer({ kind: "drag", row: rowOf(/added twenty-one/) });
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h1", lineIndex: 3, anchorIndex: 1 },
    "a drag into the next hunk stops at this hunk's last line",
  );
  assert.equal(inverted(view).length, 3);
  view.pointer({ kind: "drag", row: rowOf(/a\.ts/) });
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1", lineIndex: 0, anchorIndex: 1 });
  view.handleKey("a");
  assert.deepEqual(asked.at(-1)?.lines, { first: 0, last: 1 });

  view.pointer({ kind: "click", row: rowOf(/second/) });
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h2" }, "a header selects its hunk");
  assert.equal(view.pointer({ kind: "click", row: 999 }), false, "no row there");
});

test("sticky rows: an open file's row, then its hunk's header, stay pinned; a click goes to them; the cursor never hides under them", async () => {
  const { view, rowOf } = await paneLineView();
  const body = view.renderBody(80, true);
  const file = rowOf(/a\.ts/);
  const first = rowOf(/@@ -1,3 \+1,3 @@ first/);
  const second = rowOf(/@@ -20,1 \+20,2 @@ second/);
  assert.deepEqual([first, second], [file + 1, file + 6], "h1 spans five rows; h2 follows");
  assert.match(
    body[first] ?? "",
    /▾ @@ -1,3/u,
    "an open hunk's header is marked like an open file",
  );
  assert.deepEqual(view.stickyRows(file, 6), [], "the file's own row is showing");
  assert.deepEqual(view.stickyRows(0, 6), []);
  const both = [body[file], body[first]];
  assert.deepEqual(
    view.stickyRows(first, 6),
    both,
    "the header under the file's pin is pinned below it",
  );
  assert.deepEqual(view.stickyRows(file + 4, 6), both);
  assert.deepEqual(
    view.stickyRows(file + 5, 6),
    [body[file]],
    "h1's last row: h2's header shows below",
  );
  assert.deepEqual(view.stickyRows(second, 6), [body[file], body[second]]);
  assert.deepEqual(view.stickyRows(first, 2), [body[file]], "never every row of the viewport");
  assert.deepEqual(view.stickyRows(rowOf(/b\.ts/), 6), [], "the next file's own row");

  let top = 0;
  view.attachScroller({
    top: () => top,
    viewportHeight: () => 6,
    scrollTo: (next) => {
      top = Math.max(0, next);
    },
    scrollBy: (lines) => {
      top = Math.max(0, top + lines);
    },
  });

  // A press on the first unpinned row puts the cursor there; up moves it under the pins.
  top = file + 3;
  view.stickyRows(top, 6);
  assert.equal(view.pointer({ kind: "press", row: top + 2 }), true);
  view.handleKey(UP);
  assert.equal(top, file + 2, "scrolled so the line shows below both pinned rows");

  // A click on the pinned hunk header: the hunk is selected and its header shown, not folded.
  top = file + 3;
  view.stickyRows(top, 6);
  assert.equal(
    view.pointer({ kind: "press", row: top + 1 }),
    false,
    "a press there selects nothing",
  );
  assert.equal(view.pointer({ kind: "click", row: top + 1 }), true);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" });
  assert.equal(view.foldedHunks.has("h1"), false, "still open");
  assert.equal(top, file, "its header shows below the file's row");

  // A click on the pinned file row: the file is selected and its own row scrolled into view, not folded.
  top = file + 3;
  view.stickyRows(top, 6);
  assert.equal(view.pointer({ kind: "click", row: top }), true);
  assert.deepEqual(view.lineCursor(), { path: "a.ts" });
  assert.equal(view.expanded.has("a.ts"), true, "still open");
  assert.equal(top, file);
  assert.deepEqual(view.stickyRows(top, 6), []);
});

test("hunks fold: Enter or a click on a header folds and unfolds its hunk; the cursor stays on the header", async () => {
  const { view, rowOf } = await paneLineView();
  view.handleKey("n");
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" }, "n lands on the header");
  view.handleKey(ENTER);
  assert.equal(view.foldedHunks.has("h1"), true);
  assert.equal(view.expanded.has("a.ts"), true, "the file stays open");
  assert.match(
    view.renderBody(80, true)[rowOf(/@@ -1,3/)] ?? "",
    /▸ … @@ -1,3 \+1,3 @@ first \(folded\)/u,
  );
  assert.ok(
    !view.renderBody(80, true).some((row) => row.includes("old two")),
    "its lines are hidden",
  );
  view.handleKey(DOWN);
  assert.deepEqual(
    view.lineCursor(),
    { path: "a.ts", hunkId: "h2" },
    "the cursor steps over a folded hunk",
  );
  view.handleKey(UP);
  view.handleKey(ENTER);
  assert.equal(view.foldedHunks.has("h1"), false);
  assert.deepEqual(view.lineCursor(), { path: "a.ts", hunkId: "h1" }, "still on the header");

  view.pointer({ kind: "click", row: rowOf(/@@ -20,1/) });
  assert.equal(view.foldedHunks.has("h2"), true, "a click on a header folds its hunk");
  view.pointer({ kind: "click", row: rowOf(/@@ -20,1/) });
  assert.equal(view.foldedHunks.has("h2"), false, "and on the folded row unfolds it");

  view.handleKey(DOWN);
  view.handleKey(ENTER);
  assert.equal(view.expanded.has("a.ts"), false, "Enter on a line still collapses its file");
});

/* ------------------------------------------- a cursor move is cheap work */

test("moving the cursor or the selection never renders a file's hunks again; a fold or new contents do", async () => {
  let renders = 0;
  let frames = 0;
  const { view, rowOf } = await paneLineView();
  const counted = await lineView({
    keys: PANE_KEYS,
    hunkStops: true,
    freeSelection: true,
    renderFileBody: (file, width, styler, layout) => {
      renders += 1;
      return renderUnifiedBody(file, width, styler, layout);
    },
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {
        frames += 1;
      },
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  const expected = view.renderBody(80, true);
  assert.deepEqual(counted.renderBody(80, true), expected, "same rows as the plain view");
  const drawn = renders;
  assert.ok(drawn > 0);

  // Keys, a press and drags move the cursor over both files' lines.
  for (const key of [DOWN, DOWN, DOWN, SHIFT_DOWN, SHIFT_DOWN, "n", DOWN, "j", "k"]) {
    counted.handleKey(key);
    counted.renderBody(80, true);
  }
  counted.pointer({ kind: "press", row: rowOf(/old two/) });
  counted.pointer({ kind: "drag", row: rowOf(/keep three/) });
  const selected = counted.renderBody(80, true);
  assert.equal(renders, drawn, "the hunks were rendered once");
  assert.equal(inverted(counted).length, 3, "and the selection is drawn on them");

  // A drag that leaves the selection as it was (the pointer moved inside a row) asks for no frame.
  frames = 0;
  counted.pointer({ kind: "drag", row: rowOf(/keep three/) });
  counted.pointer({ kind: "drag", row: rowOf(/keep three/) });
  assert.equal(frames, 0);
  assert.deepEqual(counted.renderBody(80, true), selected);
  counted.pointer({ kind: "drag", row: rowOf(/new two/) });
  assert.equal(frames, 1, "a changed selection asks for one");

  counted.invalidate();
  counted.renderBody(80, true);
  assert.ok(renders > drawn, "an invalidated view renders its hunks again");
  const again = renders;
  counted.renderBody(60, true);
  assert.ok(renders > again, "and so does a new width");
});

test("the blocks kept for earlier cursor positions are bounded", async () => {
  const lines = Array.from({ length: 80 }, (_unused, index) => ({
    kind: "add" as const,
    newLine: index + 1,
    text: `line ${index + 1}`,
  }));
  const long: DiffFile = {
    path: "long.ts",
    kind: "added",
    additions: 80,
    deletions: 0,
    hunks: [
      {
        id: "long",
        header: "@@ -0,0 +1,80 @@",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 80,
        lines,
      },
    ],
  };
  const view = new ChangesView({
    store: { loadFile: async () => ({ revision: 1, body: { kind: "text", file: long } }) },
    styler: MARKING,
    keyHint: "hint",
    helpLines: [],
    cursor: "line",
    keys: PANE_KEYS,
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  view.setState({
    kind: "ready",
    refreshing: false,
    snapshot: {
      revision: 1,
      source: { kind: "uncommitted" },
      repoRoot: "/repo",
      head: "head",
      branch: "main",
      base: "head",
      capturedAt: 0,
      files: [
        {
          path: long.path,
          status: "added",
          additions: 80,
          deletions: 0,
          binary: false,
          staged: false,
          unstaged: true,
        },
      ],
      totals: { files: 1, additions: 80, deletions: 0 },
      omittedFiles: 0,
    },
  });
  view.expand(long.path);
  await until(() => view.bodies.size === 1, "body loaded");
  view.renderBody(80, true);
  view.handleKey(DOWN);
  view.renderBody(80, true);
  const first = view.blockRenders;
  view.handleKey(DOWN);
  view.renderBody(80, true);
  view.handleKey("\u001b[A");
  view.renderBody(80, true);
  assert.equal(view.blockRenders, first + 1, "one position back is still kept");
  for (let step = 0; step < 60; step += 1) {
    view.handleKey(DOWN);
    view.renderBody(80, true);
  }
  const far = view.blockRenders;
  view.handleKey("g");
  view.handleKey(DOWN);
  const rows = view.renderBody(80, true);
  assert.equal(view.blockRenders, far + 1, "sixty positions back was dropped and is drawn again");
  assert.equal(inverted(view).length, 1);
  assert.match(unmarked(rows.join("\n")), /line 80/);
});
