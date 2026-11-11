import assert from "node:assert/strict";
import test from "node:test";
import {
  Editor,
  isKeyRelease,
  stripTerminalSequences,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";
import {
  at,
  EDITOR_THEME,
  type FramedEditor,
  STYLES,
  TUI_FIXTURE,
  WIDTH,
  zentui,
} from "./zentui-editor-fixture.ts";

const TEXT = "hello world\nsecond line";
const BACKSPACE = "\x7f";
const FORWARD_DELETE = "\x1b[3~";
const LEFT = "\x1b[D";
const SELECTED = "\x1b[7m";
const UNSELECTED = "\x1b[27m";

/** The inverted run of each drawn row that has one. */
function selected(editor: FramedEditor, width = WIDTH): string[] {
  return editor.render(width).flatMap((row) => {
    const from = row.indexOf(SELECTED);
    if (from < 0) return [];
    const to = row.indexOf(UNSELECTED, from);
    assert.ok(to > from, "an inverted run is closed on its row");
    return [stripTerminalSequences(row.slice(from + SELECTED.length, to))];
  });
}

/** Press on the cell where `from` starts, drag to where `to` starts, and release there. */
function drag(editor: FramedEditor, from: string, to: string, width = WIDTH): void {
  const press = editor.handleMouse(at(editor, from, "press", width));
  assert.deepEqual(press, { handled: true, capture: true, focus: true, render: true });
  assert.equal(editor.handleMouse(at(editor, to, "drag", width))?.handled, true);
  assert.equal(editor.handleMouse(at(editor, to, "release", width))?.handled, true);
}

/** zentui around Pi's own editor, which the test can also reach directly. */
async function wrappedEditor(options: { paddingX?: number; text: string }) {
  const make = await zentui("opencode", "both");
  const inner = new Editor(TUI_FIXTURE, EDITOR_THEME, { paddingX: options.paddingX ?? 0 });
  const editor = make.wrapped(inner);
  editor.focused = true;
  editor.setText(options.text);
  return { editor, inner };
}

test(
  "a drag selects text; Backspace removes it at once and typing replaces it, in every style",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    for (const [style, paddingRows] of STYLES) {
      const make = await zentui(style, paddingRows);
      for (const [name, editor] of [
        ["wrapped", make.wrapped()],
        ["polished", make.polished()],
      ] as const) {
        const where = `${name} ${style} padding ${paddingRows}`;
        editor.focused = true;
        editor.setText(TEXT);

        // Forwards, over the line break: the break is drawn as one cell after the line.
        drag(editor, "world", "line");
        assert.deepEqual(selected(editor), ["world ", "second "], where);
        assert.deepEqual(
          editor.getCursor(),
          { line: 1, col: 7 },
          `${where}: cursor at the drag's end`,
        );
        editor.handleInput(BACKSPACE);
        assert.equal(editor.getText(), "hello line", where);
        assert.deepEqual(editor.getCursor(), { line: 0, col: 6 }, where);
        assert.deepEqual(selected(editor), [], where);

        // Backwards: the cursor is at the selection's start, and a typed key replaces it.
        drag(editor, "line", "hello");
        assert.deepEqual(selected(editor), ["hello "], where);
        editor.handleInput("X");
        assert.equal(editor.getText(), "Xline", where);
        assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, where);
        editor.handleInput("Y");
        assert.equal(editor.getText(), "XYline", `${where}: the next key only inserts`);
      }
    }
  },
);

test(
  "with a selection, deleting keys remove only it, inserting input replaces it, other keys drop it",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const select = async () => {
      const { editor } = await wrappedEditor({ text: "one two three" });
      drag(editor, "two", "three");
      assert.deepEqual(selected(editor), ["two "]);
      return editor;
    };
    const after = async (data: string) => {
      const editor = await select();
      editor.handleInput(data);
      assert.deepEqual(selected(editor), [], JSON.stringify(data));
      return editor.getText();
    };
    assert.equal(await after(FORWARD_DELETE), "one three");
    assert.equal(await after("\x17"), "one three", "Ctrl+W removes the selection, not a word more");
    assert.equal(await after("\x15"), "one three", "Ctrl+U likewise");
    assert.equal(await after("\x1b[200~pasted text\x1b[201~"), "one pasted textthree");
    assert.equal(await after("한글"), "one 한글three");
    assert.equal(await after("\x1b[13;2u"), "one \nthree", "Shift+Enter");
    assert.equal(await after("\x1b[97u"), "one athree", "a key in the Kitty protocol");
    assert.equal(
      await after("\x1b[27;2;65~"),
      "one Athree",
      "Shift+A from a terminal in modifyOtherKeys mode",
    );
    assert.equal(await after(LEFT), "one two three", "a cursor key keeps the text");

    // After a cursor key the next Backspace is an ordinary one.
    const editor = await select();
    editor.handleInput(LEFT);
    editor.handleInput(BACKSPACE);
    assert.equal(editor.getText(), "one tw three", "one character left of the moved cursor");

    // Pi sends key releases only to an editor that asks for them; one is not a key press.
    const make = await zentui("opencode", "both");
    const inner = new Editor(TUI_FIXTURE, EDITOR_THEME);
    const received: string[] = [];
    const wantsReleases = make.wrapped({
      render: (width: number) => inner.render(width),
      invalidate: () => inner.invalidate(),
      handleInput: (data: string) => {
        received.push(data);
        if (!isKeyRelease(data)) inner.handleInput(data);
      },
      handleMouse: (event: TuiMouseEvent) => inner.handleMouse(event),
      getText: () => inner.getText(),
      setText: (text: string) => inner.setText(text),
      getLines: () => inner.getLines(),
      getCursor: () => inner.getCursor(),
      getPaddingX: () => inner.getPaddingX(),
    });
    wantsReleases.setText("one two three");
    drag(wantsReleases, "two", "three");
    wantsReleases.handleInput("\x1b[97;1:3u");
    assert.deepEqual(selected(wantsReleases), ["two "]);
    assert.equal(wantsReleases.getText(), "one two three");

    // Escape drops the selection and goes no further: it would interrupt the agent.
    received.length = 0;
    wantsReleases.handleInput("\x1b");
    assert.deepEqual(selected(wantsReleases), []);
    assert.deepEqual(received, []);
    wantsReleases.handleInput("\x1b");
    assert.deepEqual(received, ["\x1b"], "with nothing selected Escape is the editor's again");
  },
);

test(
  "the selection follows wrapped rows, padding and wide characters exactly",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const text =
      "hello world this is a long line that wraps around 한글도 넓은 글자로 줄을 넘깁니다 and ends";
    for (const paddingX of [0, 1, 3]) {
      for (const width of [24, 31, 40]) {
        const where = `padding ${paddingX} width ${width}`;
        const { editor } = await wrappedEditor({ paddingX, text });
        const rows = editor.render(width).length;
        drag(editor, "world", "ends", width);
        const cells = selected(editor, width);
        assert.ok(cells.length > 2, `${where}: several rows are selected`);
        assert.equal(editor.render(width).length, rows, `${where}: the frame keeps its rows`);
        // Rows are consecutive slices of the line, so the runs join into the selected text.
        assert.equal(
          cells.join(""),
          text.slice(text.indexOf("world"), text.indexOf("ends")),
          where,
        );
        editor.handleInput(BACKSPACE);
        assert.equal(editor.getText(), "hello ends", where);
      }
    }
  },
);

test(
  "text the editor lays out in unusual ways can still be selected from end to end",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const texts = [
      "averyveryverylongwordwithoutanyspacesthatmustbebrokenatthecolumn tail",
      "spaces      in      long      runs      between      words      here",
      "한글만으로이루어진아주긴문장은어디에서나줄을바꿀수있습니다그리고계속이어집니다",
      "mixed 한글 and latin words 섞여 있는 문장 with punctuation, commas; and (brackets) too",
      "first\n\nthird after an empty line\n    indented line\ntrailing spaces   ",
      "[paste #1 +20 lines] looks like a marker but is typed text that wraps past the row",
    ];
    for (const text of texts) {
      for (const width of [12, 20, 33]) {
        const where = `${JSON.stringify(text.slice(0, 24))} at ${width}`;
        const { editor } = await wrappedEditor({ text });
        const frame = editor.render(width).map((row) => stripTerminalSequences(row));
        const first = frame.findIndex((row) => row.includes(text.slice(0, 4)));
        const event = at(editor, text.slice(0, 4), "press", width);
        editor.handleMouse(event);
        // Drag far below and right of the text: the last cell of the last row.
        editor.handleMouse({ ...event, type: "drag", x: width + 40, y: first + 99 });
        editor.handleMouse({ ...event, type: "release", x: width + 40, y: first + 99 });
        assert.equal(
          selected(editor, width).join("").replaceAll(" ", ""),
          text.replaceAll(/\s/g, ""),
          where,
        );
        editor.handleInput(BACKSPACE);
        assert.equal(editor.getText(), "", where);
      }
    }
  },
);

test(
  "a pasted block stays one piece: selected with other text it goes whole, and its contents survive a deletion beside it",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const pasted = Array.from({ length: 30 }, (_unused, index) => `pasted line ${index}`).join(
      "\n",
    );
    const start = async () => {
      const { editor } = await wrappedEditor({ text: "" });
      editor.handleInput("before ");
      editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
      editor.handleInput(" after");
      assert.match(editor.getText(), /^before \[paste #1 \+30 lines\] after$/);
      return editor;
    };
    const beside = await start();
    drag(beside, "before", "[paste");
    beside.handleInput(BACKSPACE);
    assert.equal(beside.getText(), "[paste #1 +30 lines] after");
    assert.equal(beside.getExpandedText(), `${pasted} after`, "the paste is still what is sent");

    const through = await start();
    drag(through, "fore", "ter");
    assert.deepEqual(selected(through), ["fore [paste #1 +30 lines] af"]);
    through.handleInput("-");
    assert.equal(through.getText(), "be-ter");
    assert.equal(through.getExpandedText(), "be-ter");
  },
);

test(
  "a selection in a scrolled editor is of the rows shown, and a drag past them stops at the edge",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const lines = Array.from({ length: 30 }, (_unused, index) => `row number ${index}`);
    const { editor } = await wrappedEditor({ text: lines.join("\n") });
    const frame = editor.render(WIDTH).map((row) => stripTerminalSequences(row));
    assert.ok(
      !frame.some((row) => row.includes("row number 3 ")),
      "the first rows are scrolled out",
    );
    drag(editor, "number 25", "number 27");
    assert.deepEqual(selected(editor), ["number 25 ", "row number 26 ", "row "]);
    editor.handleInput(BACKSPACE);
    assert.equal(editor.getText().split("\n")[25], "row number 27");
    assert.equal(editor.getText().split("\n").length, 28);

    // Above the first shown row the drag selects up to that row, not beyond it.
    const press = at(editor, "number 22", "press");
    editor.handleMouse(press);
    editor.handleMouse({ ...press, type: "drag", x: 0, y: -5 });
    editor.handleMouse({ ...press, type: "release", x: 0, y: -5 });
    const top = stripTerminalSequences(
      editor.render(WIDTH).find((row) => row.includes(SELECTED)) ?? "",
    );
    const runs = selected(editor);
    assert.ok(runs.length >= 2 && runs.length <= 12);
    assert.ok(top.includes(runs[0]?.trim() ?? "none"));
    editor.handleInput(BACKSPACE);
    assert.ok(
      editor.getText().startsWith("row number 0\n"),
      "nothing above the shown rows was removed",
    );
  },
);

test(
  "a change from elsewhere drops the selection, and so does a press outside the text",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { editor, inner } = await wrappedEditor({ text: TEXT });
    drag(editor, "world", "line");
    inner.insertTextAtCursor("!");
    assert.deepEqual(selected(editor), [], "text put in by an extension");
    editor.handleInput(BACKSPACE);
    assert.equal(
      editor.getText(),
      "hello world\nsecond line",
      "Backspace removes the one character",
    );

    drag(editor, "world", "line");
    editor.setText("replaced");
    assert.deepEqual(selected(editor), []);
    editor.handleInput("x");
    assert.equal(editor.getText(), "replacedx");

    drag(editor, "replaced", "dx");
    assert.deepEqual(selected(editor), ["replace"]);
    const border: TuiMouseEvent = { ...at(editor, "replaced", "press"), y: 0 };
    assert.deepEqual(editor.handleMouse(border), { handled: true, focus: true, render: true });
    assert.deepEqual(selected(editor), []);
    assert.equal(
      editor.handleMouse(border),
      undefined,
      "with nothing selected the press is Pi's again",
    );
  },
);

test(
  "whole selected lines go with one key each, not one key a character",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const make = await zentui("opencode", "both");
    const inner = new Editor(TUI_FIXTURE, EDITOR_THEME);
    let keys = 0;
    const base = {
      get focused() {
        return inner.focused;
      },
      set focused(value: boolean) {
        inner.focused = value;
      },
      render: (width: number) => inner.render(width),
      invalidate: () => inner.invalidate(),
      handleInput: (data: string) => {
        keys += 1;
        inner.handleInput(data);
      },
      handleMouse: (event: TuiMouseEvent) => inner.handleMouse(event),
      getText: () => inner.getText(),
      setText: (text: string) => inner.setText(text),
      getLines: () => inner.getLines(),
      getCursor: () => inner.getCursor(),
      getPaddingX: () => inner.getPaddingX(),
    };
    const editor = make.wrapped(base);
    editor.focused = true;
    const lines = Array.from({ length: 10 }, (_unused, index) => `line ${index} ${"x".repeat(40)}`);
    for (const [from, to] of [
      ["line 1", "line 8"],
      ["line 8", "line 1"],
    ] as const) {
      editor.setText(lines.join("\n"));
      drag(editor, from, to);
      keys = 0;
      editor.handleInput(BACKSPACE);
      assert.equal(editor.getText(), [lines[0], lines[8], lines[9]].join("\n"), `${from} to ${to}`);
      assert.ok(keys <= 16, `${keys} keys for seven lines of 47 characters`);
    }
  },
);
