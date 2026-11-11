// The patch parser enforces hunk line counts and section boundaries, and reports a section
// it cannot read by name instead of giving its lines to another file.
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";

const parse = (lines: string[]) => parseGitDiff(lines.join("\n"), "base", "head");

function summary(lines: string[]) {
  const model = parse(lines);
  return {
    files: model.files.map(
      (file) =>
        `${file.path}:${file.kind}:${file.hunks.map((hunk) => hunk.lines.length).join("+")}`,
    ),
    notices: (model.notices ?? []).map((notice) => notice.path),
    texts: model.files.flatMap((file) =>
      file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)),
    ),
  };
}

const A_HEAD = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt"];
const B_SECTION = [
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1 +1 @@",
  "-b-old",
  "+b-new",
];

test("another file's header after a complete hunk never becomes that hunk's lines", () => {
  const result = summary([
    ...A_HEAD,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-wrong-old",
    "+wrong-new",
  ]);
  assert.deepEqual(result.files, ["a.txt:modified:"]);
  assert.deepEqual(result.notices, ["a.txt"]);
  assert.equal(result.texts.includes("wrong-old"), false);
  const model = parse([...A_HEAD, "@@ -1 +1 @@", "-old", "+new", "--- a/b.txt"]);
  assert.match(model.notices?.[0]?.message ?? "", /could not be read.*line 7/);
});

test("a hunk shorter than its header is reported; the next file still parses", () => {
  const result = summary([...A_HEAD, "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", ...B_SECTION]);
  assert.deepEqual(result.files, ["a.txt:modified:", "b.txt:modified:2"]);
  assert.deepEqual(result.notices, ["a.txt"]);
});

test("a hunk longer than its header is reported", () => {
  const result = summary([...A_HEAD, "@@ -1 +1 @@", "-a", "+b", "+c"]);
  assert.deepEqual(result.files, ["a.txt:modified:"]);
  assert.deepEqual(result.notices, ["a.txt"]);
});

test("a combined-diff header is reported, not skipped", () => {
  const result = summary([
    "diff --cc a.txt",
    "diff --git a/a.txt b/a.txt",
    "@@@ -1,1 -1,1 +1,1 @@@",
    "- a",
    " +b",
  ]);
  assert.deepEqual(result.notices, ["a.txt"]);
  assert.deepEqual(result.files, ["a.txt:modified:"]);
});

test("an unreadable file header is reported by its text; other files parse", () => {
  const result = summary(["diff --git nonsense", "@@ -1 +1 @@", "-x", "+y", ...B_SECTION]);
  assert.deepEqual(result.notices, ["nonsense"]);
  assert.deepEqual(result.files, ["nonsense:modified:", "b.txt:modified:2"]);
});

test("an empty line inside a hunk is an empty context line, as git apply reads it", () => {
  const result = summary([...A_HEAD, "@@ -1,3 +1,3 @@", " a", "", "-c", "+C"]);
  assert.deepEqual(result.files, ["a.txt:modified:4"]);
  assert.deepEqual(result.notices, []);
});

test("content that looks like a header is content while the hunk's counts remain", () => {
  const result = summary([
    ...A_HEAD,
    "@@ -1,3 +1,5 @@",
    " keep",
    "+--- a/b.txt",
    "-+++ b/b.txt",
    "++@@ -1 +1 @@",
    " diff --git a/x b/x",
    "+last",
  ]);
  assert.deepEqual(result.files, ["a.txt:modified:6"]);
  assert.deepEqual(result.notices, []);
});

// The cases below are correct before and after the change; they pin the sweep.
test("well-formed variants parse unchanged", () => {
  const result = summary([
    ...A_HEAD,
    "@@ -1 +1 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
    "\\ No newline at end of file",
    "@@ -10,0 +11,2 @@ section",
    "+x",
    "+y",
    "@@ -20,1 +21,0 @@",
    "-z",
    "diff --git a/new file.txt b/new file.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new file.txt\t",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/b/c.txt b/b/c.txt",
    "old mode 100644",
    "new mode 100755",
    'diff --git "a/q\\"x.txt" "b/q\\"x.txt"',
    'Binary files "a/q\\"x.txt" and "b/q\\"x.txt" differ',
  ]);
  assert.deepEqual(result.files, [
    "a.txt:modified:2+2+1",
    "new file.txt:added:1",
    "b/c.txt:modified:",
    'q"x.txt:binary:',
  ]);
  assert.deepEqual(result.notices, []);
});

test("CRLF line endings parse with counts enforced", () => {
  const model = parseGitDiff(
    [...A_HEAD, "@@ -1,2 +1,2 @@", " a", "-b", "+c", ""].join("\r\n"),
    "",
    "",
  );
  assert.equal(model.files[0]?.hunks[0]?.lines.length, 3);
  assert.equal(model.notices, undefined);
});
