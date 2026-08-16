import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCommentAnchor,
	hashSnippet,
	relocateAnchor,
} from "../.pi/extensions/review/core/anchor.ts";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";

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

	// Relocating against the head file returns the matched snippet's own ends,
	// which stay a fixed distance from the commented range.
	const head = ["header", "one", "two", "three", "four", "five", "six", "seven", "eight", ""].join("\n");
	assert.deepEqual(relocateAnchor(range, head), {
		status: "mapped",
		method: "exact",
		startLine: 2,
		line: 7,
		matchedSnippet: "one\ntwo\nthree\nfour\nfive\nsix",
	});

	// The range is verified against the requested side, not merely clamped.
	assert.throws(() => buildCommentAnchor(hunk, "RIGHT", 3, 4), /range is invalid/);
	assert.throws(() => buildCommentAnchor(hunk, "LEFT", 99, 98), /not present on the LEFT side/);
});

test("anchors relocate exactly in a recomputed model after line numbers move", () => {
	const original = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head-1");
	const moved = parseGitDiff(patch("@@ -20,4 +30,4 @@ function example"), "base", "head-2");
	const anchor = buildCommentAnchor(original.files[0]!.hunks[0]!, "RIGHT", 11);

	assert.equal(moved.files[0]!.hunks[0]!.id, anchor.hunkHash);
	assert.deepEqual(relocateAnchor(anchor, moved, { path: "example.txt", side: "RIGHT" }), {
		status: "mapped",
		method: "exact",
		startLine: 30,
		line: 33,
		matchedSnippet: "alpha\nnew\nomega\ntail",
		path: "example.txt",
		side: "RIGHT",
		hunkHash: moved.files[0]!.hunks[0]!.id,
	});
});

test("a unique substring relocates an anchor when surrounding file context changed", () => {
	const model = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
	const anchor = buildCommentAnchor(model.files[0]!.hunks[0]!, "RIGHT", 11);
	const content = ["prefix", "alpha changed", "new", "omega", "tail", "suffix", ""].join("\n");

	assert.deepEqual(relocateAnchor(anchor, content), {
		status: "mapped",
		method: "unique-substring",
		startLine: 3,
		line: 5,
		matchedSnippet: "new\nomega\ntail",
	});
});

test("ambiguous and absent snippets are explicitly unmappable", () => {
	const model = parseGitDiff(patch("@@ -10,4 +10,4 @@ function example"), "base", "head");
	const anchor = buildCommentAnchor(model.files[0]!.hunks[0]!, "RIGHT", 11);
	const ambiguous = [
		"new", "omega", "tail",
		"separator",
		"new", "omega", "tail",
	].join("\n");

	assert.deepEqual(relocateAnchor(anchor, ambiguous), {
		status: "unmappable",
		reason: "ambiguous",
		message: "The anchor has multiple possible substring matches.",
	});
	assert.deepEqual(relocateAnchor(anchor, "unrelated\ncontent\n"), {
		status: "unmappable",
		reason: "not-found",
		message: "The anchor snippet is no longer present in the review content.",
	});
});

test("a corrupted anchor hash is rejected before relocation", () => {
	const result = relocateAnchor({
		hunkHash: "hunk",
		snippet: "target",
		snippetHash: "not-the-hash",
	}, "target\n");
	assert.deepEqual(result, {
		status: "unmappable",
		reason: "invalid-anchor",
		message: "The anchor snippet does not match its stored hash.",
	});
});
