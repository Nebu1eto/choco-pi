// Every string /review-assist draws that it did not author is drawn with its
// control characters as visible glyphs, and text it hands to the editor or a
// model has them escaped. Pattern: tests/diff-actions-control-chars.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import {
  buildReviewChatPrompt,
  type ReviewChat,
  type ReviewChatMessage,
} from "../.pi/extensions/review/core/ask.ts";
import { renderReviewMarkdown } from "../.pi/extensions/review/core/markdown-export.ts";
import { headlessSafeText } from "../.pi/extensions/review/headless.ts";
import type { DiffModel, ReviewRecord } from "../.pi/extensions/review/core/types.ts";
import { pickReviewRecord, pickReviewTarget } from "../.pi/extensions/review/ui/target-picker.ts";
import {
  baseRecord,
  changedFile,
  mount,
  NASTY,
  NOW,
  overWidth,
  rawControls,
  rawControlsExceptNewlines,
  showsGlyphs,
  textHunk,
} from "./review-safety-fakes.ts";

initTheme("dark", false);
const WIDTH = 200;
const NARROW = 60;

function model(...files: DiffModel["files"]): DiffModel {
  return { baseSha: "b", headSha: "h", files };
}

/** Render at a wide and a narrow width; both must be clean and fit. */
function check(lines: (width: number) => string[]): string {
  for (const width of [WIDTH, NARROW]) {
    const rendered = lines(width);
    assert.equal(rawControls(rendered), 0, `raw control characters at width ${width}`);
    assert.equal(overWidth(rendered, width), 0, `lines wider than ${width}`);
  }
  return lines(WIDTH).join("\n");
}

test("file names: list rows, the diff header and the rename arrow", async () => {
  const view = await mount({
    model: model(changedFile(`new ${NASTY}.ts`, "x", "y", `old ${NASTY}.ts`)),
  });
  const screen = check(view.render);
  assert.ok(showsGlyphs(screen));
  assert.match(screen, /old a␛\[31mred.*→ new a␛\[31mred/);
});

test("diff body lines and the hunk header's section text", async () => {
  const file = changedFile("app.ts", `old ${NASTY}`, `new ${NASTY}`);
  file.hunks = [
    textHunk(
      "app.ts",
      [
        { kind: "del", oldLine: 1, text: `old ${NASTY}` },
        { kind: "add", newLine: 1, text: `new ${NASTY}` },
      ],
      `function ${NASTY}`,
    ),
  ];
  const view = await mount({ model: model(file) });
  // Unified, then split.
  assert.ok(showsGlyphs(check(view.render)));
  await view.press("v");
  assert.ok(showsGlyphs(check(view.render)));
  // A folded hunk draws its header in the placeholder.
  await view.press(" ");
  assert.ok(check(view.render).includes("function a␛[31mred"));
});

test("comment text under its line and in the file's comment summary", async () => {
  const file = changedFile("app.ts", "old", "new");
  const hunk = file.hunks[0];
  assert.ok(hunk);
  const record = baseRecord(model(file), {
    comments: [
      {
        id: "c1",
        path: "app.ts",
        side: "RIGHT",
        line: 1,
        body: NASTY,
        anchor: buildCommentAnchor(hunk, "RIGHT", 1),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });
  const view = await mount({ model: model(file), record });
  const screen = check(view.render);
  assert.ok(screen.includes("a␛[31mred␛]52;c;SGVsbG8=␇b␍c"));
  assert.ok(screen.includes("d\uFFFDe\uFFFDf"), "the line break stays a line break");
});

test("a read-limit notice, which can carry git's own message", async () => {
  const empty = { ...changedFile("big.txt", "a", "b"), hunks: [] };
  const view = await mount({
    model: { ...model(empty), notices: [{ path: "big.txt", message: `Not shown: ${NASTY}` }] },
  });
  assert.ok(showsGlyphs(check(view.render)));
});

test("branch and ref names in the title", async () => {
  const file = changedFile("app.ts", "a", "b");
  const view = await mount({
    model: model(file),
    record: baseRecord(model(file), { target: { kind: "branch", base: NASTY, target: NASTY } }),
  });
  assert.ok(check(view.render).includes("Branch a␛[31mred"));
});

test("a pull request's title, author and base branch from GitHub", async () => {
  const file = changedFile("app.ts", "a", "b");
  const view = await mount({
    model: model(file),
    record: baseRecord(model(file), { target: { kind: "pr", number: 7 } }),
    pullRequest: {
      number: 7,
      title: NASTY,
      baseRefName: `b${NASTY}`,
      headSha: "h".repeat(40),
      author: { login: `u${NASTY}`, name: "n", isBot: false },
      url: "https://example.test/7",
      updatedAt: NOW,
    },
  });
  const screen = check(view.render);
  assert.ok(screen.includes("#7 a␛[31mred"));
  assert.ok(screen.includes("@ua␛[31mred"));
  assert.ok(screen.includes("base ba␛[31mred"));
});

/** Just enough of ReviewChat to show a transcript. */
function staticChat(messages: ReviewChatMessage[]): ReviewChat {
  return {
    ask: async () => {},
    messages,
    onUpdate: () => () => {},
    pending: false,
    status: { model: "m", thinkingLevel: "low" },
    setModel: async (query) => query,
    setThinkingLevel: async (level) => level,
    reload: async () => {},
    prepare: async () => {},
    commands: () => [],
    toolDefinition: (): RuntimeValue => undefined,
    runCommand: async () => {},
    dispose: () => {},
  };
}

test("side chat: the question, the model's answer, and its tool calls", async () => {
  const chat = staticChat([
    { role: "user", text: `q ${NASTY}` },
    { role: "assistant", text: `answer ${NASTY}` },
    {
      role: "tool",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: `echo ${NASTY}` },
      result: { content: [{ type: "text", text: `out ${NASTY}` }] },
      isError: false,
      done: true,
    },
  ]);
  const view = await mount({
    model: model(changedFile("app.ts", "a", "b")),
    createReviewChat: () => chat,
  });
  await view.press("a");
  const screen = check(view.render);
  assert.ok(screen.includes("q a␛[31mred"));
  assert.ok(screen.includes("answer a␛[31mred"));
  assert.ok(screen.includes("echo a␛[31mred"), "the tool call's arguments");
  // Expanded, the tool shows its output too.
  await view.press("\u000f");
  assert.ok(check(view.render).includes("out a␛[31mred"), "the tool's output");
});

test("error notifications that embed repository or tool text", async () => {
  const view = await mount({
    model: model(changedFile("app.ts", "a", "b")),
    spawnEditor: () => {
      throw new Error(`cannot open ${NASTY}`);
    },
  });
  await view.press("e");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(view.notifications.length, 1);
  assert.equal(rawControls(view.notifications), 0);
  assert.ok(showsGlyphs(view.notifications.join("\n")));
});

test("target and resume pickers show branch names and pull request titles as glyphs", async () => {
  const shown: string[][] = [];
  const host = {
    select: async (_title: string, options: string[]) => {
      shown.push(options);
      return options[0];
    },
  };
  const picked = await pickReviewTarget(host, [
    { label: `Branch base: ${NASTY}`, target: { kind: "branch", base: NASTY } },
    { label: `Pull request #7: ${NASTY}`, target: { kind: "pr", number: 7 } },
  ]);
  assert.deepEqual(picked, { kind: "branch", base: NASTY }, "the choice still maps to its target");
  const record: ReviewRecord = baseRecord(model(), { target: { kind: "branch", base: NASTY } });
  const resumed = await pickReviewRecord(
    host,
    { load: async () => undefined, save: async () => {}, list: async () => [record] },
    "repo",
  );
  assert.equal(resumed, record);
  assert.equal(rawControls(shown.flat()), 0);
  assert.ok(shown.flat().every((option) => option.includes("a␛[31mred")));
});

test("text for the editor and the model escapes control characters but keeps line breaks", () => {
  const file = changedFile(NASTY, "old", `line ${NASTY}`);
  const hunk = file.hunks[0];
  assert.ok(hunk);
  const record = baseRecord(model(file), {
    comments: [
      {
        id: "c1",
        path: NASTY,
        side: "RIGHT",
        line: 1,
        body: `first line\nsecond ${NASTY}`,
        anchor: buildCommentAnchor(hunk, "RIGHT", 1),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });
  const markdown = renderReviewMarkdown(record);
  assert.equal(rawControlsExceptNewlines(markdown), 0);
  assert.ok(markdown.includes("### a\\u001b[31mred\\u001b]52;c;SGVsbG8=\\u0007b\\u000dc\\u000ad"));
  assert.ok(
    markdown.includes("first line\nsecond a\\u001b[31mred"),
    "the author's line break stays",
  );

  const prompt = buildReviewChatPrompt(`why ${"?"}`, {
    path: NASTY,
    side: "RIGHT",
    line: 1,
    focusedLineText: NASTY,
    hunkHeader: `@@ -1 +1 @@ ${NASTY}`,
    reviewRoot: `/repo/${NASTY}`,
  });
  assert.equal(rawControlsExceptNewlines(prompt), 0);
  // Each context field stays on its own line.
  assert.equal(prompt.split("\n").filter((line) => line.startsWith("- ")).length, 6);
});

test("side chat: tool-result details (an edit's diff) reach the screen as glyphs", async () => {
  const chat = staticChat([
    { role: "user", text: "q" },
    {
      role: "tool",
      toolCallId: "t2",
      toolName: "edit",
      args: { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] },
      result: {
        content: [{ type: "text", text: "Edited f.ts" }],
        details: { diff: `-1 old\n+1 new ${NASTY}`, firstChangedLine: 1 },
      },
      isError: false,
      done: true,
    },
  ]);
  const view = await mount({
    model: model(changedFile("app.ts", "a", "b")),
    createReviewChat: () => chat,
  });
  await view.press("a");
  await view.press("\u000f");
  const screen = check(view.render);
  assert.ok(screen.includes("new a␛[31mred"), "the edit's diff is drawn, as glyphs");
});

test("headless output draws control characters from file names as glyphs, keeping tab and CRLF", () => {
  assert.equal(
    headlessSafeText(`a\tb\r\n${NASTY}`),
    "a\tb\r\na␛[31mred␛]52;c;SGVsbG8=␇b␍c\nd\uFFFDe\uFFFDf",
  );
  assert.equal(headlessSafeText("plain\ttext\r\nline two"), "plain\ttext\r\nline two");
});
