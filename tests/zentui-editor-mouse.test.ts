import assert from "node:assert/strict";
import test from "node:test";
import { Editor, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";
import { at, EDITOR_THEME, STYLES, TUI_FIXTURE, WIDTH, zentui } from "./zentui-editor-fixture.ts";

const TEXT = "hello world\nsecond line";

test(
  "a click in the editor's text puts the cursor on the clicked character in every style",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const plain = new Editor(TUI_FIXTURE, EDITOR_THEME);
    plain.focused = true;
    plain.setText(TEXT);
    const undecorated = plain.render(WIDTH).map((row) => stripTerminalSequences(row));
    for (const [style, paddingRows] of STYLES) {
      const make = await zentui(style, paddingRows);
      for (const [name, editor] of [
        ["wrapped", make.wrapped()],
        ["polished", make.polished()],
      ] as const) {
        const where = `${name} ${style} padding ${paddingRows}`;
        editor.focused = true;
        editor.setText(TEXT);
        assert.deepEqual(editor.getCursor(), { line: 1, col: 11 }, where);
        const frame = editor.render(WIDTH).map((row) => stripTerminalSequences(row));
        assert.notDeepEqual(frame, undecorated, `${where}: decorated`);

        assert.deepEqual(editor.handleMouse(at(editor, "line")), { handled: true, focus: true });
        assert.deepEqual(editor.getCursor(), { line: 1, col: 7 }, `${where}: second row`);
        editor.handleMouse(at(editor, "world"));
        assert.deepEqual(editor.getCursor(), { line: 0, col: 6 }, `${where}: first row`);
        editor.handleMouse(at(editor, "hello"));
        assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, `${where}: first column`);

        // Past the end of a row the cursor goes to the row's end.
        const end = at(editor, "second");
        editor.handleMouse({ ...end, x: WIDTH - 3 });
        assert.deepEqual(editor.getCursor(), { line: 1, col: 11 }, `${where}: row end`);

        // The frame's own rows take focus and leave the cursor alone.
        for (const y of [0, frame.length - 1]) {
          assert.deepEqual(
            editor.handleMouse({ ...end, x: 5, y }),
            { handled: true, focus: true },
            `${where}: frame row ${y}`,
          );
        }
        assert.deepEqual(editor.getCursor(), { line: 1, col: 11 }, `${where}: unmoved`);

        // A press on the text is taken (it may start a selection) and already moves the
        // cursor; released on the same cell it is a click, and nothing is selected.
        assert.deepEqual(
          editor.handleMouse(at(editor, "world", "press")),
          { handled: true, capture: true, focus: true, render: true },
          where,
        );
        assert.deepEqual(editor.getCursor(), { line: 0, col: 6 }, `${where}: press`);
        assert.equal(editor.handleMouse(at(editor, "world", "release"))?.handled, true, where);
        assert.deepEqual(editor.handleMouse(at(editor, "world")), { handled: true, focus: true });
        assert.equal(
          editor.render(WIDTH).join("\n").includes("\u001b[7m"),
          false,
          `${where}: no selection`,
        );
        // A press on the frame's own rows is still left to Pi's text selection.
        assert.equal(editor.handleMouse({ ...end, type: "press", x: 5, y: 0 }), undefined, where);
        assert.equal(editor.handleMouse({ ...end, type: "drag", x: 9, y: 0 }), undefined, where);
      }
    }
  },
);

test("an undecorated editor gets the click as it came", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const make = await zentui("opencode", "both", false);
  for (const editor of [make.wrapped(), make.polished()]) {
    editor.focused = true;
    editor.setText(TEXT);
    assert.deepEqual(editor.handleMouse(at(editor, "line")), { handled: true, focus: true });
    assert.deepEqual(editor.getCursor(), { line: 1, col: 7 });
  }
});

test(
  "an editor without mouse support still takes focus on a click",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const make = await zentui("opencode", "both");
    const inner = new Editor(TUI_FIXTURE, EDITOR_THEME);
    const seen: TuiMouseEvent[] = [];
    const base = {
      render: (width: number) => inner.render(width),
      invalidate: () => inner.invalidate(),
      handleInput: (data: string) => inner.handleInput(data),
      getText: () => inner.getText(),
      setText: (text: string) => inner.setText(text),
      getCursor: () => inner.getCursor(),
    };
    const editor = make.wrapped(base);
    editor.setText(TEXT);
    assert.deepEqual(editor.handleMouse(at(editor, "world")), { handled: true, focus: true });
    assert.equal(editor.handleMouse(at(editor, "world", "press")), undefined);
    assert.deepEqual(editor.getCursor(), { line: 1, col: 11 }, "the cursor stays");

    // An editor with its own handler gets coordinates of its own frame.
    const own = make.wrapped({
      ...base,
      handleMouse: (event: TuiMouseEvent) => {
        seen.push(event);
        return undefined;
      },
    });
    own.setText(TEXT);
    assert.deepEqual(own.handleMouse(at(own, "world")), { handled: true, focus: true });
    assert.deepEqual(
      seen.map((event) => [event.x, event.y, event.width]),
      [[6, 1, WIDTH - 2]],
      "column 6 of the first text row, at the width the editor was drawn",
    );
  },
);
