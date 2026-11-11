import assert from "node:assert/strict";
import test from "node:test";
import {
  Editor,
  stripTerminalSequences,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";

/** The parts of a zentui editor these tests use. */
type FramedEditor = {
  focused: boolean;
  render(width: number): string[];
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  setText(text: string): void;
  getCursor(): RuntimeValue;
};

type EditorConfig = {
  components: { editor: { enabled: boolean; style: string; paddingRows: string } };
};

type Constructor = new (...args: RuntimeValue[]) => FramedEditor;

const WIDTH = 60;
const TEXT = "hello world\nsecond line";
const EDITOR_THEME = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const UI_THEME = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const MODEL_META = {
  modelLabel: "model",
  modelId: "model",
  modelName: "Model",
  providerLabel: "Provider",
  sessionName: "",
};
const TUI_FIXTURE = reinterpretHostValue<TUI>({ terminal: { rows: 40 }, requestRender: () => {} });

async function zentui(style: string, paddingRows: string, enabled = true) {
  const ui = await loadZentuiModule("ui.js");
  const { defaultConfig } = await loadZentuiModule("config.js");
  // SAFETY: the clone copies the package's own default config, which has these members.
  const config = structuredClone(defaultConfig) as EditorConfig;
  config.components.editor.enabled = enabled;
  config.components.editor.style = style;
  config.components.editor.paddingRows = paddingRows;
  const shared = [UI_THEME, () => config, () => MODEL_META, () => "high"];
  // SAFETY: the compiled package exports these two editor classes.
  const Wrapped = ui.WrappedPolishedEditor as Constructor;
  // SAFETY: as above.
  const Polished = ui.PolishedEditor as Constructor;
  return {
    /** zentui around another extension's editor, as the harness installs it. */
    wrapped: (base: RuntimeValue = new Editor(TUI_FIXTURE, EDITOR_THEME)) =>
      new Wrapped(base, ...shared),
    /** zentui's own editor, used when no other extension supplies one. */
    polished: () => new Polished(TUI_FIXTURE, EDITOR_THEME, {}, ...shared),
  };
}

/** A mouse event on the cell where `text` starts in the frame the editor just drew. */
function at(
  editor: FramedEditor,
  text: string,
  type: TuiMouseEvent["type"] = "click",
): TuiMouseEvent {
  const rows = editor.render(WIDTH).map((row) => stripTerminalSequences(row));
  const y = rows.findIndex((row) => row.includes(text));
  assert.ok(y >= 0, `no row shows ${text}`);
  const row = rows[y] ?? "";
  const x = visibleWidth(row.slice(0, row.indexOf(text)));
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y + 20,
    width: WIDTH,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

const STYLES: [style: string, paddingRows: string][] = [
  ["opencode", "both"],
  ["opencode", "none"],
  ["opencode", "top"],
  ["opencode-copy-friendly", "both"],
  ["opencode-copy-friendly", "none"],
  ["minimalist", "none"],
];

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

        // A press is left to Pi, which starts its text selection with it.
        assert.equal(editor.handleMouse(at(editor, "world", "press")), undefined, where);
        assert.equal(editor.handleMouse(at(editor, "world", "drag")), undefined, where);
        assert.deepEqual(editor.getCursor(), { line: 1, col: 11 }, `${where}: press`);
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
