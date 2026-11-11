import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommentAnchor,
  hashSnippet,
  locateComment,
} from "../.pi/extensions/review/core/anchor.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";

function patch(header: string, alpha = "alpha"): string {
  return [
    "diff --git a/example.txt b/example.txt",
    "index 1111111..2222222 100644",
    "--- a/example.txt",
    "+++ b/example.txt",
    header,
    ` ${alpha}`,
    "-old",
    "+new",
    " omega",
    " tail",
    "",
  ].join("\n");
}

test("comment anchors contain side-specific verbatim context and a content hash", () => {
  const model = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
  const hunk = model.files[0]!.hunks[0]!;
  const anchor = buildCommentAnchor(hunk, "RIGHT", 11);

  assert.equal(anchor.hunkHash, hunk.id);
  assert.equal(anchor.snippet, "alpha\nnew\nomega\ntail");
  assert.equal(anchor.snippetHash, hashSnippet(anchor.snippet));
  assert.doesNotMatch(anchor.snippet, /old/);
});

/** Wide enough that a range anchor and a single-line anchor differ. */
function rangePatch(): string {
  return [
    "diff --git a/range.txt b/range.txt",
    "index 1111111..2222222 100644",
    "--- a/range.txt",
    "+++ b/range.txt",
    "@@ -1,6 +1,8 @@ function range",
    " one",
    " two",
    "+three",
    "+four",
    " five",
    " six",
    " seven",
    " eight",
    "",
  ].join("\n");
}

test("a range anchor covers the whole range and round-trips to both of its ends", () => {
  const hunk = parseGitDiff(rangePatch(), "base", "head").files[0]!.hunks[0]!;
  const range = buildCommentAnchor(hunk, "RIGHT", 4, 3);
  const single = buildCommentAnchor(hunk, "RIGHT", 4);

  assert.equal(range.snippet, "one\ntwo\nthree\nfour\nfive\nsix");
  assert.equal(single.snippet, "two\nthree\nfour\nfive\nsix");
  assert.equal(range.snippetHash, hashSnippet(range.snippet));

  // Located in the same hunk after it moved two lines down, the range keeps both ends.
  const moved = parseGitDiff(
    rangePatch().replace("@@ -1,6 +1,8 @@", "@@ -3,6 +3,8 @@"),
    "base",
    "head",
  );
  assert.deepEqual(
    locateComment(
      { path: "range.txt", side: "RIGHT", line: 4, startLine: 3, anchor: range },
      moved,
    ),
    { status: "placed", side: "RIGHT", hunkId: hunk.id, startLine: 5, line: 6, position: 2 },
  );

  // The range is verified against the requested side, not merely clamped.
  assert.throws(() => buildCommentAnchor(hunk, "RIGHT", 3, 4), /range is invalid/);
  assert.throws(() => buildCommentAnchor(hunk, "LEFT", 99, 98), /not present on the LEFT side/);
});

test("a comment is located in its hunk after line numbers move, by its text", () => {
  const original = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head-1");
  const moved = parseGitDiff(patch("@@ -20,4 +30,4 @@ function example"), "base", "head-2");
  const anchor = buildCommentAnchor(original.files[0]!.hunks[0]!, "RIGHT", 11);
  assert.equal(moved.files[0]!.hunks[0]!.id, anchor.hunkHash);
  assert.deepEqual(locateComment({ path: "example.txt", side: "RIGHT", line: 11, anchor }, moved), {
    status: "placed",
    side: "RIGHT",
    hunkId: anchor.hunkHash,
    startLine: 31,
    line: 31,
    position: 1,
  });
});

test("when another line of its hunk changed, the comment is found in the new hunk by its exact text", () => {
  const original = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
  const anchor = buildCommentAnchor(original.files[0]!.hunks[0]!, "RIGHT", 13);
  // "alpha" is outside the snippet of line 13 (omega's neighbours are new, tail).
  const changed = parseGitDiff(
    patch("@@ -10,4 +10,4 @@ function example", "alpha!"),
    "base",
    "head",
  );
  const hunk = changed.files[0]!.hunks[0]!;
  assert.notEqual(hunk.id, anchor.hunkHash);
  assert.deepEqual(
    locateComment({ path: "example.txt", side: "RIGHT", line: 13, anchor }, changed),
    {
      status: "placed",
      side: "RIGHT",
      hunkId: hunk.id,
      startLine: 13,
      line: 13,
      position: 3,
    },
  );
});

test("a snippet whose context changed is outdated, never matched on part of it", () => {
  const model = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
  const anchor = buildCommentAnchor(model.files[0]!.hunks[0]!, "RIGHT", 11);
  const changed = parseGitDiff(
    patch("@@ -10,4 +10,4 @@ function example", "alpha changed"),
    "base",
    "head",
  );
  const located = locateComment({ path: "example.txt", side: "RIGHT", line: 11, anchor }, changed);
  assert.equal(located.status, "outdated");
  assert.equal(located.status === "outdated" ? located.reason : undefined, "not-found");
});

test("a snippet found twice in its file is ambiguous; a file not in the comparison is gone", () => {
  const model = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
  const anchor = buildCommentAnchor(model.files[0]!.hunks[0]!, "RIGHT", 11);
  const twice = parseGitDiff(
    [
      patch("@@ -10,4 +10,4 @@ function example", "beta").trimEnd(),
      ...patch("@@ -40,4 +40,4 @@ function example", "gamma").split("\n").slice(4),
    ].join("\n"),
    "base",
    "head",
  );
  const sameSnippet = { ...anchor, hunkHash: "gone", snippet: "new\nomega\ntail" };
  assert.equal(
    locateComment({ path: "example.txt", side: "RIGHT", line: 11, anchor: sameSnippet }, twice)
      .status,
    "outdated",
  );
  const located = locateComment(
    { path: "example.txt", side: "RIGHT", line: 11, anchor: sameSnippet },
    twice,
  );
  assert.equal(located.status === "outdated" ? located.reason : undefined, "ambiguous");
  assert.equal(
    locateComment({ path: "other.txt", side: "RIGHT", line: 1, anchor }, model).status,
    "outdated",
  );
});
