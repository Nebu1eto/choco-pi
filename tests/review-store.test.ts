import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderReviewMarkdown } from "../.pi/extensions/review/core/markdown-export.ts";
import {
	createReviewStore,
	markHunksReviewed,
	repoKey,
	targetKey,
	unreviewedHunks,
} from "../.pi/extensions/review/core/store.ts";
import type {
	DiffHunk,
	DiffModel,
	ReviewRecord,
	ReviewTarget,
} from "../.pi/extensions/review/core/types.ts";

const NOW = "2026-03-01T12:00:00.000Z";

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
	return {
		version: 1,
		repoKey: "repo-123",
		target: { kind: "branch", base: "main" },
		baseSha: "base",
		headSha: "head",
		cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
		comments: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

async function sandbox(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "review-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function hunk(id: string): DiffHunk {
	return {
		id,
		header: "@@ -1 +1 @@",
		oldStart: 1,
		oldLines: 1,
		newStart: 1,
		newLines: 1,
		lines: [{ kind: "context", oldLine: 1, newLine: 1, text: id }],
	};
}

test("records round-trip through an injected directory and list by repository", async (t) => {
	const directory = await sandbox(t);
	const store = createReviewStore(directory);
	const saved = record({ body: "Review body", verdict: "approve" });

	await store.save(saved);

	assert.deepEqual(await store.load(saved.repoKey, targetKey(saved.target)), saved);
	assert.deepEqual(await store.list(saved.repoKey), [saved]);
	assert.deepEqual(await store.list("another-repo"), []);
});

test("saving replaces the record atomically without leaving temporary files", async (t) => {
	const directory = await sandbox(t);
	const store = createReviewStore(directory);
	const original = record({ body: "first" });
	const replacement = record({ body: "second", updatedAt: "2026-03-02T12:00:00.000Z" });
	await store.save(original);
	await store.save(replacement);

	const repositoryDirectory = join(directory, original.repoKey);
	const names = await readdir(repositoryDirectory);
	assert.deepEqual(names, [`${targetKey(original.target)}.json`]);
	assert.deepEqual(JSON.parse(await readFile(join(repositoryDirectory, names[0]!), "utf8")), replacement);
});

test("listing skips and reports corrupt and unknown-version records while load rejects the future version", async (t) => {
	const directory = await sandbox(t);
	const warnings: string[] = [];
	const store = createReviewStore(directory, ({ fileName }) => warnings.push(fileName));
	const valid = record({ target: { kind: "session", sessionId: "session-1" } });
	await store.save(valid);
	const repositoryDirectory = join(directory, valid.repoKey);
	await writeFile(join(repositoryDirectory, "corrupt.json"), '{"version":1,"repoKey"');
	await writeFile(join(repositoryDirectory, "future.json"), JSON.stringify({ version: 2 }));

	assert.deepEqual(await store.list(valid.repoKey), [valid]);
	assert.deepEqual(warnings, ["corrupt.json", "future.json"]);
	assert.equal(await store.load(valid.repoKey, "corrupt"), undefined);
	await assert.rejects(store.load(valid.repoKey, "future"), /Unsupported review record version/);
	assert.deepEqual(await store.load(valid.repoKey, targetKey(valid.target)), valid);
});

test("target keys are deterministic, distinct, and filesystem-safe for every target variant", () => {
	const targets: ReviewTarget[] = [
		{ kind: "session", sessionId: "session/with spaces" },
		{ kind: "session-turn", sessionId: "session/with spaces", turnIndex: 7 },
		{ kind: "branch", base: "feature/a" },
		{ kind: "branch", base: "feature/a", target: "release..next" },
		{ kind: "pr", number: 42 },
	];
	const keys = targets.map(targetKey);

	assert.deepEqual(targets.map(targetKey), keys);
	assert.equal(new Set(keys).size, targets.length);
	for (const key of keys) assert.match(key, /^[A-Za-z0-9._-]+$/);
	assert.notEqual(targetKey({ kind: "branch", base: "a", target: "b" }), targetKey({ kind: "branch", base: "a:b" }));
});

test("repository keys hash the normalized repository identity rather than its directory name", () => {
	const first = repoKey("/checkouts/one/project/.git");
	const same = repoKey("/checkouts/one/project/./.git");
	const second = repoKey("/checkouts/two/project/.git");
	assert.equal(first, same);
	assert.notEqual(first, second);
	assert.match(first, /^[A-Za-z0-9._-]+$/);
});

test("reviewed hunk ids survive a moved head SHA and marking is immutable", () => {
	const existing = record({
		headSha: "old-head",
		cursor: { reviewedHunkIds: ["stable-hunk"], lastHeadSha: "old-head" },
	});
	const diff: DiffModel = {
		baseSha: "base",
		headSha: "new-head",
		files: [{
			path: "src/file.ts",
			kind: "modified",
			hunks: [hunk("stable-hunk"), hunk("new-hunk")],
			additions: 1,
			deletions: 1,
		}],
	};

	assert.deepEqual(unreviewedHunks(existing, diff).map(({ hunk: item }) => item.id), ["new-hunk"]);
	const updated = markHunksReviewed(existing, ["new-hunk", "stable-hunk"], diff.headSha);
	assert.deepEqual(updated.cursor, { reviewedHunkIds: ["stable-hunk", "new-hunk"], lastHeadSha: "new-head" });
	assert.deepEqual(existing.cursor, { reviewedHunkIds: ["stable-hunk"], lastHeadSha: "old-head" });
	assert.deepEqual(unreviewedHunks(updated, diff), []);
});

test("Markdown export includes verdict, body, file groups, locations, and standalone snippets", () => {
	const markdown = renderReviewMarkdown(record({
		verdict: "request-changes",
		body: "Please address the inline findings.",
		comments: [
			{
				id: "c1",
				path: "src/a.ts",
				side: "RIGHT",
				line: 12,
				startLine: 10,
				body: "This can lose data.",
				anchor: { hunkHash: "h1", snippetHash: "s1", snippet: "const value = load();\nsave(value);" },
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "c2",
				path: "src/b.ts",
				side: "LEFT",
				line: 4,
				body: "Keep this check.",
				anchor: { hunkHash: "h2", snippetHash: "s2", snippet: "if (!input) return;" },
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	}));

	assert.match(markdown, /\*\*Verdict:\*\* Request changes/);
	assert.match(markdown, /Please address the inline findings\./);
	assert.match(markdown, /### src\/a\.ts[\s\S]*#### src\/a\.ts:12 \(lines 10-12\) \(RIGHT\)/);
	assert.match(markdown, /```text\nconst value = load\(\);\nsave\(value\);\n```/);
	assert.match(markdown, /### src\/b\.ts[\s\S]*#### src\/b\.ts:4 \(LEFT\)/);
});
