import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import {
  stripTerminalSequences,
  type AutocompleteProvider,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  findFdOnPath,
  parseEditorRule,
  ReviewInput,
} from "../.pi/extensions/review/ui/review-input.ts";

const EDITOR_THEME: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

function fakeTui(): TUI {
  return { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
}

/** Completion is asynchronous; let its request chain finish. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const TAB = "\t";
const ENTER = "\r";
const SHIFT_ENTER = "\u001b\r";
const UP = "\u001b[A";
const DOWN = "\u001b[B";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A stand-in review worktree. Its entries share no name with this repository's
 * own root, so a completion rooted at the wrong tree is visible as a miss.
 */
function reviewRoot(): string {
  const root = temporaryDirectory("review-input-root-");
  writeFileSync(join(root, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(root, "alpha-helpers.ts"), "export const helper = 1;\n");
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "beta", "gamma.ts"), "export const gamma = 2;\n");
  return root;
}

function createInput(
  root: string,
  width = 60,
): {
  input: ReviewInput;
  completions(): string[];
  text(): string;
  type(data: string): void;
} {
  // fdPath null keeps the test off the `@` fuzzy path, which shells out.
  const input = new ReviewInput(fakeTui(), EDITOR_THEME, { root, fdPath: null });
  const rendered = () => input.render(width);
  return {
    input,
    completions: () =>
      rendered()
        .autocompleteLines.map((line) => stripTerminalSequences(line).trim())
        .filter((line) => line.length > 0),
    text: () => input.getText(),
    type: (data) => input.handleInput(data),
  };
}

test("path completion resolves against the review root, never the process directory", async () => {
  const root = reviewRoot();
  const { input, completions, type } = createInput(root);

  type("al");
  type(TAB);
  await settle();
  assert.equal(input.isShowingAutocomplete(), true, "Tab opens the list");
  assert.deepEqual(
    completions(),
    ["→ alpha-helpers.ts", "alpha.ts"],
    "both review root entries are offered, the first one highlighted",
  );

  // This repository's root holds package.json, tsconfig.json, and tests/.
  // The review root holds none of them, and nothing may leak in from the cwd.
  for (const missing of ["pack", "tsconfig", "test"]) {
    input.setText("");
    type(missing);
    type(TAB);
    await settle();
    assert.equal(
      input.isShowingAutocomplete(),
      false,
      `"${missing}" matches an entry of ${process.cwd()}, which is not the review root`,
    );
    assert.equal(input.getText(), missing, "and nothing was completed behind the user's back");
  }
});

test("accepting a completion rewrites the text, files and directories alike", async () => {
  const root = reviewRoot();
  const { input, text, type } = createInput(root);

  type("al");
  type(TAB);
  await settle();
  type(TAB);
  assert.equal(text(), "alpha-helpers.ts", "Tab takes the highlighted row");
  assert.equal(input.isShowingAutocomplete(), false, "accepting closes the list");

  input.setText("");
  type("bet");
  type(TAB);
  await settle();
  assert.equal(text(), "beta/", "a lone match completes without a list, separator intact");
  type(TAB);
  await settle();
  assert.equal(text(), "beta/gamma.ts", "and completion continues into the directory");

  input.setText("");
  type("see alpha.");
  type(TAB);
  await settle();
  assert.equal(text(), "see alpha.ts", "only the path token is replaced");
});

test("render separates the completion rows from the text box", async () => {
  const root = reviewRoot();
  const { input, type } = createInput(root);

  const closed = input.render(60);
  assert.deepEqual(closed.autocompleteLines, []);
  assert.ok(parseEditorRule(closed.editorLines[0], "above"), "a rule opens the box");
  assert.ok(parseEditorRule(closed.editorLines.at(-1), "below"), "a rule closes the box");

  type("al");
  type(TAB);
  await settle();
  const open = input.render(60);
  assert.ok(parseEditorRule(open.editorLines.at(-1), "below"), "the box still closes on a rule");
  assert.equal(
    open.editorLines.length,
    closed.editorLines.length,
    "the list does not grow the text box",
  );
  assert.equal(open.autocompleteLines.length, 2, "one row per candidate");
  assert.ok(
    open.autocompleteLines.some((line) => stripTerminalSequences(line).includes("alpha.ts")),
  );
  for (const line of open.autocompleteLines) {
    assert.equal(
      parseEditorRule(line, "below"),
      undefined,
      "a completion row is never mistaken for the box's rule",
    );
  }
  assert.deepEqual(
    [...open.editorLines, ...open.autocompleteLines].length,
    input.render(60).editorLines.length + input.render(60).autocompleteLines.length,
    "the split loses no row",
  );
});

test("a leading slash offers nothing, because no command here would run", async () => {
  const { input, type } = createInput(reviewRoot());
  type("/mod");
  await settle();
  assert.equal(input.isShowingAutocomplete(), false);
  assert.equal(input.getText(), "/mod");
});

test("each input recalls only what was typed into it", () => {
  const root = reviewRoot();
  const comments = createInput(root);
  const questions = createInput(root);
  comments.input.onSubmit = (text) => comments.input.remember(text);
  questions.input.onSubmit = (text) => questions.input.remember(text);

  comments.type("this cast hides a null");
  comments.type(ENTER);
  questions.type("why is this cast safe?");
  questions.type(ENTER);
  assert.equal(comments.text(), "", "submitting clears the box");
  assert.equal(questions.text(), "");

  comments.input.render(60);
  comments.type(UP);
  assert.equal(comments.text(), "this cast hides a null");

  questions.input.render(60);
  questions.type(UP);
  assert.equal(questions.text(), "why is this cast safe?");

  questions.type(UP);
  assert.equal(questions.text(), "why is this cast safe?", "no older entry exists to reach");
  questions.type(DOWN);
  assert.equal(questions.text(), "", "the draft returns unchanged");
});

test("up and down move through the text before they reach history", () => {
  const { input, text, type } = createInput(reviewRoot());
  input.onSubmit = (submitted) => input.remember(submitted);
  type("an earlier comment");
  type(ENTER);

  type("line one");
  type(SHIFT_ENTER);
  type("line two");
  input.render(60);
  assert.equal(text(), "line one\nline two");

  type(UP);
  assert.equal(text(), "line one\nline two", "the first up moves the cursor, not the text");
  type(UP);
  assert.equal(text(), "line one\nline two", "the second up only reaches the start of the line");
  type(UP);
  assert.equal(text(), "an earlier comment", "history is reached from the text's edge");
  type(DOWN);
  assert.equal(text(), "line one\nline two", "the draft comes back intact");
});

test("the provider is built for the review root with whatever fd was found", () => {
  const built: Array<{ root: string; fdPath: string | null }> = [];
  const stub: AutocompleteProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
  const createAutocompleteProvider = (root: string, fdPath: string | null) => {
    built.push({ root, fdPath });
    return stub;
  };

  new ReviewInput(fakeTui(), EDITOR_THEME, {
    root: "/worktree/pr-42",
    fdPath: "/managed/bin/fd",
    createAutocompleteProvider,
  });
  new ReviewInput(fakeTui(), EDITOR_THEME, {
    root: "/worktree/pr-42",
    fdPath: null,
    createAutocompleteProvider,
  });

  assert.deepEqual(built, [
    { root: "/worktree/pr-42", fdPath: "/managed/bin/fd" },
    { root: "/worktree/pr-42", fdPath: null },
  ]);
});

test("fd is found on PATH when it is executable there and nowhere else", () => {
  const directory = temporaryDirectory("review-input-bin-");
  const empty = temporaryDirectory("review-input-empty-");
  const executable = join(directory, process.platform === "win32" ? "fd.exe" : "fd");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);

  assert.equal(findFdOnPath({ PATH: [empty, directory].join(delimiter) }), executable);
  assert.equal(findFdOnPath({ PATH: empty }), null);
  assert.equal(findFdOnPath({}), null);
  assert.equal(findFdOnPath({ PATH: "" }), null);
});
