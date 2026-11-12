import assert from "node:assert/strict";
import test from "node:test";
import { SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";
import { type FramedEditor, zentui } from "./zentui-editor-fixture.ts";

const DRAFT = "draft";
const ESC = "\x1b";

/** The editors with a draft and the cursor after it. */
async function editors(): Promise<[string, FramedEditor][]> {
  const make = await zentui("opencode", "both");
  const made: [string, FramedEditor][] = [
    ["wrapped", make.wrapped()],
    ["polished", make.polished()],
  ];
  for (const [, editor] of made) {
    editor.focused = true;
    editor.setText(DRAFT);
  }
  return made;
}

/** Feed keys one at a time, as pi-tui's stdin buffer does after it flushed a fragment. */
function type(editor: FramedEditor, text: string): void {
  for (const char of text) editor.handleInput(char);
}

/** Let the end of the current burst of input pass. */
const burstEnd = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test(
  "the tail of a mouse report that pi-tui split never reaches the draft",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    // Splits seen in the field: after a report's prefix, after ESC [, and after a bare ESC.
    for (const [fragment, tail] of [
      [`${ESC}[<64;19`, "1;47M"],
      [`${ESC}[<`, "64;191;47M"],
      [`${ESC}[`, "<64;191;47M"],
      [ESC, "[<64;191;47M"],
      [`${ESC}[<65;80;12`, "m"],
    ]) {
      for (const [name, editor] of await editors()) {
        editor.handleInput(fragment);
        type(editor, tail);
        await burstEnd();
        assert.equal(editor.getText(), DRAFT, `${name}: ${JSON.stringify(fragment + tail)}`);
      }
    }
  },
);

test(
  "keys typed after Escape, after a fragment, or with no fragment still reach the draft",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    for (const [name, editor] of await editors()) {
      // A bracket typed after Escape is held only until its burst of input ends.
      editor.handleInput(ESC);
      editor.handleInput("[");
      await burstEnd();
      assert.equal(editor.getText(), `${DRAFT}[`, `${name}: [ after Escape`);
      editor.handleInput(ESC);
      type(editor, "[<a");
      await burstEnd();
      assert.equal(editor.getText(), `${DRAFT}[[<a`, `${name}: [<a after Escape`);
      // A character that cannot continue the report is typed input.
      editor.handleInput(`${ESC}[<64;19`);
      type(editor, "x");
      assert.equal(editor.getText(), `${DRAFT}[[<ax`, `${name}: x after a fragment`);
      // Report characters with no fragment before them are text.
      type(editor, "1;47M");
      await burstEnd();
      assert.equal(editor.getText(), `${DRAFT}[[<ax1;47M`, `${name}: no fragment`);
      // A report stays open only for the burst that continued it.
      editor.handleInput(`${ESC}[<64;19`);
      type(editor, "1;4");
      await burstEnd();
      type(editor, "7");
      assert.equal(editor.getText(), `${DRAFT}[[<ax1;47M7`, `${name}: after the burst`);
    }
  },
);
