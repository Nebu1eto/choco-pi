// Untrusted strings (file names, diff text, notes, reviewer output) must not reach the terminal with raw control
// characters, and sanitised lines must still fit the width they were given.
import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { RecordsReader } from "../.pi/extensions/lib/changes/findings.ts";
import {
  agentStringLiteral,
  escapeForAgent,
  sanitizeTerminalText,
} from "../.pi/extensions/lib/changes/terminal-text.ts";
import { fileRow, plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import { renderUnifiedBody } from "../.pi/extensions/diff/ui/pane-view.ts";
import type { PrefsIo } from "../.pi/extensions/diff/ui/prefs.ts";
import type { AgentParseRecord } from "../.pi/extensions/lib/verdict-blocks.ts";
import { file, flush, harness, hunk, snapshot, textBody, until } from "./diff-actions-fakes.ts";

/** ESC colour, OSC 52 clipboard write ended by BEL, CR, LF, C1 CSI, right-to-left override, tab. */
const NASTY = "a\u001b[31mred\u001b]52;c;SGVsbG8=\u0007b\rc\nd\u009be\u202ef\tg";
const WIDTH = 60;

/** Independent of the production predicate: C0, DEL, C1 and the bidirectional controls. */
function isUnsafe(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function unsafeCount(text: string, allowed: readonly string[] = []): number {
  let count = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnsafe(codePoint) && !allowed.includes(character)) count += 1;
  }
  return count;
}

type Rendered = { raw: number; overWidth: number; mentions: boolean };

/**
 * pi-tui's truncation wraps its ellipsis in SGR resets (`\u001b[0m…\u001b[0m`); with the plain test styler
 * that is the only escape the pane itself emits. NASTY contains no reset, so discounting it hides nothing.
 */
const PI_TUI_RESET = "\u001b[0m";

/** pi-tui 1.5.1's fake-cursor APC markers (`dist/tui.js`, not exported); the TUI consumes them before output. */
const FAKE_CURSOR_START = "\u001b_pi:fc\u0007";
const FAKE_CURSOR_END = "\u001b_pi:/fc\u0007";

/** The pane's own escapes: pi-tui's truncation reset and the focused input's cursor markers. */
function withoutOwnEscapes(line: string): string {
  return line
    .replaceAll(PI_TUI_RESET, "")
    .replaceAll(CURSOR_MARKER, "")
    .replaceAll(FAKE_CURSOR_START, "")
    .replaceAll(FAKE_CURSOR_END, "");
}

function inspect(lines: readonly string[], needle: string): Rendered {
  return {
    raw: lines.reduce((sum, line) => sum + unsafeCount(withoutOwnEscapes(line)), 0),
    overWidth: lines.filter((line) => visibleWidth(line) > WIDTH).length,
    mentions: lines.some((line) => line.includes(needle)),
  };
}

const SAFE: Rendered = { raw: 0, overWidth: 0, mentions: true };

async function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  return h;
}

const header = (h: ReturnType<typeof harness>) => h.view().renderHeader(WIDTH, true);
const body = (h: ReturnType<typeof harness>) => h.view().renderBody(WIDTH, true);

test("file names in list rows are sanitised", async () => {
  const h = await opened();
  h.store().ready(1, [file(`src/${NASTY}.ts`)]);
  assert.deepEqual(inspect(body(h), "src/a"), SAFE);
});

test("rename arrows are sanitised on both sides", async () => {
  const h = await opened();
  h.store().ready(1, [file(`n${NASTY}`, { status: "renamed", oldPath: `o${NASTY}` })]);
  assert.deepEqual(inspect(body(h), "R oa"), SAFE);
  // Wide enough to show both sides and the arrow.
  const wide = h.view().renderBody(200, true);
  assert.equal(
    wide.reduce((sum, line) => sum + unsafeCount(withoutOwnEscapes(line)), 0),
    0,
  );
  assert.ok(wide.some((line) => line.includes("→ na")));
});

test("header strings from git and the session are sanitised: branch, base, checkpoint label, error, cwd", async () => {
  const h = await opened();
  const branchy = snapshot(1, [file("a.ts")], { kind: "branch-base", base: `base${NASTY}` });
  branchy.branch = `br${NASTY}`;
  h.store().emit({ kind: "ready", snapshot: branchy, refreshing: false });
  assert.deepEqual(inspect(header(h), "Changes since base"), SAFE);
  h.store().ready(2, [], {
    kind: "since-checkpoint",
    checkpointId: "t",
    label: `turn 1 (${NASTY})`,
  });
  assert.deepEqual(inspect([...header(h), ...body(h)], "No changes since turn 1"), SAFE);
  h.store().emit({ kind: "error", message: `git failed on ${NASTY}` });
  assert.deepEqual(inspect(header(h), "Error: git failed"), SAFE);
  h.store().emit({ kind: "not-a-repository", cwd: `/tmp/${NASTY}` });
  assert.deepEqual(inspect(header(h), "Not a git repository"), SAFE);
});

test("the inline list fallback and notices are sanitised", async () => {
  const h = harness();
  h.tui.terminal.columns = 60;
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  h.store().ready(1, [file(`x${NASTY}`, { status: "renamed", oldPath: `y${NASTY}` })]);
  await h.run("refresh");
  await flush();
  const notices = h.notices.join("\n");
  assert.ok(notices.includes("R y"), "the inline list was shown");
  assert.equal(unsafeCount(notices, ["\n"]), 0);
  assert.equal(notices.includes("\u001b"), false);
});

test("pane messages that embed a file name are sanitised", async () => {
  const h = await opened();
  // On the sensitive list by its last segment; the directory carries the payload.
  const path = `${NASTY}/.env`;
  h.store().ready(1, [file(path)]);
  // v shows the file at once; the message that names it is checked.
  h.tui.input("v");
  assert.deepEqual(inspect(header(h), "Showing a"), SAFE);
  assert.deepEqual(inspect([...header(h), ...body(h)], "Showing a"), SAFE);
});

test("diff body lines and hunk headers are sanitised, through the production renderer too", async () => {
  for (const renderFileBody of [undefined, renderUnifiedBody]) {
    const h = await opened(renderFileBody ? { renderFileBody } : {});
    const path = `src/${NASTY}.ts`;
    const nasty = hunk("h", 1, [` ctx${NASTY}`, `+add${NASTY}`]);
    nasty.header = `@@ -1,1 +1,2 @@ fn${NASTY}`;
    h.store().bodies.set(path, textBody(path, [nasty]));
    h.store().ready(1, [file(path)]);
    h.tui.input("\r");
    await flush();
    assert.deepEqual(inspect(body(h), "add"), SAFE);
    // Selected hunks are drawn with a different prefix; check them too.
    h.tui.input("n");
    assert.deepEqual(inspect(body(h), "add"), SAFE);
  }
});

test("a body notice carrying an error reason is sanitised", async () => {
  const h = await opened();
  h.store().bodies.set("a.ts", { kind: "unreadable", reason: `cannot read ${NASTY}` });
  h.store().ready(1, [file("a.ts")]);
  h.tui.input("\r");
  await flush();
  assert.deepEqual(inspect(body(h), "Cannot read diff"), SAFE);
});

function memoryIo(contents: string): PrefsIo {
  return { read: async () => contents, write: async () => {} };
}

test("note text and ranges restored from the notes file are sanitised on screen", async () => {
  const path = "src/a.ts";
  const note = {
    id: "n1",
    path,
    hunkId: "h",
    range: `lines ${NASTY}`,
    text: `note ${NASTY}`,
    createdAt: 1,
  };
  const outdated = { ...note, id: "n2", hunkId: "gone", text: `old ${NASTY}` };
  const unlisted = { ...note, id: "n3", path: `elsewhere${NASTY}`, text: `far ${NASTY}` };
  const h = await opened({
    notesIo: memoryIo(JSON.stringify({ version: 1, notes: [note, outdated, unlisted] })),
  });
  h.store().bodies.set(path, textBody(path, [hunk("h", 1, ["+x"])]));
  h.store().ready(1, [file(path)]);
  await until(() => (h.probe.session()?.notes?.notes.length ?? 0) === 3, "notes restored");
  h.tui.input("\r");
  await flush();
  const lines = body(h);
  assert.deepEqual(inspect(lines, "note a"), SAFE);
  assert.ok(
    lines.some((line) => line.includes("(outdated, was lines a")),
    "outdated note drawn",
  );
  assert.ok(
    lines.some((line) => line.includes("✎ elsewherea")),
    "unlisted note drawn",
  );
});

test("the note prompt's file name is sanitised", async () => {
  const h = await opened();
  const path = `${NASTY}.ts`;
  h.store().bodies.set(path, textBody(path, [hunk("h", 1, ["+x"])]));
  h.store().ready(1, [file(path)]);
  h.tui.input("n");
  await flush();
  h.tui.input("c");
  assert.deepEqual(inspect(header(h), "Note on a"), SAFE);
});

function reviewRecord(path: string): AgentParseRecord {
  return {
    schema: 1,
    agentId: "rev",
    agentType: "reviewer",
    workTask: "wt",
    completedAt: "2026-01-01T00:00:00.000Z",
    status: "parsed",
    review: {
      schema: 1,
      verdict: "FINDINGS",
      bundleDigest: "sha256:x",
      findings: [
        {
          id: `F${NASTY}`,
          class: "finding",
          severity: "high",
          path,
          startLine: 1,
          invariant: `inv ${NASTY}`,
          evidence: "code_path",
          reproduction: "",
        },
        {
          id: "F2",
          class: "candidate",
          severity: "low",
          path: `gone${NASTY}`,
          invariant: `far ${NASTY}`,
          evidence: "code_path",
          reproduction: "",
        },
      ],
    },
  };
}

test("reviewer findings read from the review records are sanitised in place and in the not-in-this-diff list", async () => {
  const path = `src/${NASTY}.ts`;
  const reader: RecordsReader = async () => ({
    tasks: [{ workTask: "wt", records: [reviewRecord(path)], invalid: [] }],
    errors: [],
  });
  const h = await opened({ scratchDir: "/scratch", readRecords: reader });
  h.store().bodies.set(path, textBody(path, [hunk("h", 1, ["+x"])]));
  h.store().ready(1, [file(path)]);
  await h.run("refresh");
  await until(() => h.view().recorded.findings.length === 2, "records read");
  h.tui.input("f");
  await flush();
  const lines = [...header(h), ...body(h)];
  assert.deepEqual(inspect(lines, "high finding Fa"), SAFE);
  assert.ok(
    lines.some((line) => line.includes("candidate F2 gonea")),
    "unlisted finding drawn",
  );
  // Wide enough to show the whole invariant text.
  const wide = h.view().renderBody(300, true);
  assert.equal(
    wide.reduce((sum, line) => sum + unsafeCount(withoutOwnEscapes(line)), 0),
    0,
  );
  // Open by default: the finding's whole invariant is drawn under it.
  assert.ok(wide.some((line) => line.includes("▾ ⚑ high finding Fa")));
  assert.ok(wide.some((line) => line.includes("inv a")));
});

/** The `@"..."` mention in `text`, decoded as JSON, or the bare `@path` token. */
function mentionedPath(text: string): string | undefined {
  const quoted = /@("(?:[^"\\]|\\.)*")/u.exec(text);
  if (quoted?.[1] !== undefined) {
    const decoded: string = JSON.parse(quoted[1]);
    return decoded;
  }
  return /@(\S+)/u.exec(text)?.[1];
}

test("ask references put in the editor carry no raw controls, yet still name the file exactly", async () => {
  const h = await opened({ editorText: "" });
  const path = `src/${NASTY}.ts`;
  h.store().bodies.set(path, textBody(path, [hunk("h", 1, [`+code${NASTY}`])]));
  h.store().ready(1, [file(path)]);
  h.tui.input("a");
  assert.equal(unsafeCount(h.editor.text, ["\n"]), 0, "file ask");
  assert.equal(mentionedPath(h.editor.text), path);
  assert.deepEqual(inspect(header(h), "File reference added"), SAFE);
  h.editor.text = "";
  await h.run("focus");
  h.tui.input("n");
  await flush();
  h.tui.input("a");
  // Tabs inside code stay; every other control is escaped.
  assert.equal(unsafeCount(h.editor.text, ["\n", "\t"]), 0, "hunk ask");
  assert.equal(mentionedPath(h.editor.text), path);
  assert.ok(h.editor.text.includes("\\u001b[31m"), "escaped, not dropped");
});

test("notes sent to the editor carry no raw controls", async () => {
  const path = `src/${NASTY}.ts`;
  const note = {
    id: "n1",
    path,
    hunkId: "h",
    range: "line 1",
    text: `note ${NASTY}`,
    createdAt: 1,
  };
  const h = await opened({
    editorText: "",
    notesIo: memoryIo(JSON.stringify({ version: 1, notes: [note] })),
  });
  h.store().bodies.set(path, textBody(path, [hunk("h", 1, ["+x"])]));
  h.store().ready(1, [file(path)]);
  await h.run("notes send");
  assert.ok(h.editor.text.startsWith("Notes on the current diff:"));
  assert.equal(unsafeCount(h.editor.text, ["\n"]), 0);
  assert.equal(mentionedPath(h.editor.text), path);
});

/* ---------------------------------------------------------- the pure functions */

test("sanitizeTerminalText: every control becomes one visible column; tabs by policy; clean text is unchanged", () => {
  const clean = "src/normal file ✓ 日本.ts";
  assert.equal(sanitizeTerminalText(clean), clean);
  const safeText = sanitizeTerminalText(NASTY);
  assert.equal(unsafeCount(safeText), 0);
  assert.equal(
    safeText,
    "a␛[31mred␛]52;c;SGVsbG8=␇b␍c␊d\uFFFDe\uFFFDf␉g",
    "C0 as Control Pictures, C1 and bidi as U+FFFD, tab as ␉",
  );
  // One column per replaced code point: the width equals the code point count.
  assert.equal(visibleWidth(safeText), [...NASTY].length);
  assert.equal(sanitizeTerminalText("a\tb", "spaces"), "a   b");
  assert.equal(sanitizeTerminalText("\u007f\u0000\u2066\u200f"), "␡␀\uFFFD\uFFFD");
});

test("the pane's own styling survives sanitising: it is applied afterwards", () => {
  const styler = {
    ...plainPaneStyler,
    fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
  };
  const row = fileRow(file(`x${NASTY}`), false, 200, styler);
  assert.ok(row.includes("\u001b[36m"), "styling present");
  const withoutStyling = row.replaceAll("\u001b[36m", "").replaceAll("\u001b[39m", "");
  assert.equal(unsafeCount(withoutOwnEscapes(withoutStyling)), 0, "only our own escapes remain");
});

test("agentStringLiteral round-trips the exact text and holds no raw control", () => {
  const literal = agentStringLiteral(NASTY);
  assert.equal(unsafeCount(literal), 0);
  const decoded: string = JSON.parse(literal);
  assert.equal(decoded, NASTY);
  assert.equal(escapeForAgent("a\tb\u001b", true), "a\tb\\u001b");
  assert.equal(escapeForAgent("plain"), "plain");
});
