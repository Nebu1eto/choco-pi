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
  assert.deepEqual(
    JSON.parse(await readFile(join(repositoryDirectory, names[0]!), "utf8")),
    replacement,
  );
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
  assert.notEqual(
    targetKey({ kind: "branch", base: "a", target: "b" }),
    targetKey({ kind: "branch", base: "a:b" }),
  );
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
    files: [
      {
        path: "src/file.ts",
        kind: "modified",
        hunks: [hunk("stable-hunk"), hunk("new-hunk")],
        additions: 1,
        deletions: 1,
      },
    ],
  };

  assert.deepEqual(
    unreviewedHunks(existing, diff).map(({ hunk: item }) => item.id),
    ["new-hunk"],
  );
  const updated = markHunksReviewed(existing, ["new-hunk", "stable-hunk"], diff.headSha);
  assert.deepEqual(updated.cursor, {
    reviewedHunkIds: ["stable-hunk", "new-hunk"],
    lastHeadSha: "new-head",
  });
  assert.deepEqual(existing.cursor, { reviewedHunkIds: ["stable-hunk"], lastHeadSha: "old-head" });
  assert.deepEqual(unreviewedHunks(updated, diff), []);
});

test("Markdown export includes verdict, body, file groups, locations, and standalone snippets", () => {
  const markdown = renderReviewMarkdown(
    record({
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
          anchor: {
            hunkHash: "h1",
            snippetHash: "s1",
            snippet: "const value = load();\nsave(value);",
          },
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
    }),
  );

  assert.match(markdown, /\*\*Verdict:\*\* Request changes/);
  assert.match(markdown, /Please address the inline findings\./);
  assert.match(markdown, /### src\/a\.ts[\s\S]*#### src\/a\.ts:12 \(lines 10-12\) \(RIGHT\)/);
  assert.match(markdown, /```text\nconst value = load\(\);\nsave\(value\);\n```/);
  assert.match(markdown, /### src\/b\.ts[\s\S]*#### src\/b\.ts:4 \(LEFT\)/);
});

test("a save whose directory another session's clean-up removes mid-save creates it again and succeeds", async (t) => {
  const directory = await sandbox(t);
  const removed: string[] = [];
  const store = createReviewStore(directory, undefined, {
    cleanup: false,
    beforeWrite: async (repositoryDirectory) => {
      if (removed.length > 0) return;
      // What the clean-up's removeIfEmpty does to a directory it has just emptied.
      await rm(repositoryDirectory, { recursive: true });
      removed.push(repositoryDirectory);
    },
  });
  const saved = record();
  await store.save(saved);
  assert.equal(removed.length, 1);
  assert.deepEqual(await store.load(saved.repoKey, targetKey(saved.target)), saved);
});

test("a save retries a vanished directory once, then reports the failure", async (t) => {
  const directory = await sandbox(t);
  let attempts = 0;
  const store = createReviewStore(directory, undefined, {
    cleanup: false,
    beforeWrite: async (repositoryDirectory) => {
      attempts += 1;
      await rm(repositoryDirectory, { recursive: true });
    },
  });
  await assert.rejects(store.save(record()), { code: "ENOENT" });
  assert.equal(attempts, 2);
});

test("a save does not retry a failure other than a missing directory", async (t) => {
  const directory = await sandbox(t);
  let attempts = 0;
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const store = createReviewStore(directory, undefined, {
    cleanup: false,
    beforeWrite: async () => {
      attempts += 1;
      throw failure;
    },
  });
  await assert.rejects(store.save(record()), failure);
  assert.equal(attempts, 1);
});

/* ----------------------------- an abandoned save never overwrites a newer one */

/** Until the save the test holds is waiting in its write. */
async function held(gates: readonly unknown[]): Promise<void> {
  while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** A store whose writes wait, in order, until the test releases them; the rest run as normal. */
function heldWrites(directory: string) {
  const gates: Array<{ release: () => void; fail: (error: Error) => void }> = [];
  const holds: boolean[] = [];
  const store = createReviewStore(directory, undefined, {
    cleanup: false,
    beforeWrite: () => {
      if (!holds.shift()) return Promise.resolve();
      return new Promise<void>((release, fail) => gates.push({ release, fail }));
    },
  });
  return { store, gates, holds };
}

test("a save held in its write that finishes after a newer one leaves the newer on disk", async (t) => {
  const directory = await sandbox(t);
  const { store, gates, holds } = heldWrites(directory);
  const older = record({ body: "A" });
  const newer = record({ body: "B" });
  holds.push(true, false);
  const a = store.save(older);
  await held(gates);
  await store.save(newer);
  gates[0]?.release();
  await a;
  assert.equal((await store.load(older.repoKey, targetKey(older.target)))?.body, "B");
  const left = await readdir(join(directory, older.repoKey));
  assert.deepEqual(
    left.filter((name) => name.endsWith(".tmp")),
    [],
    "the superseded temporary file is removed",
  );
});

test("saves that finish in order leave the last; a single save is unchanged; a failed older save does not matter", async (t) => {
  const directory = await sandbox(t);
  const { store, gates, holds } = heldWrites(directory);
  const first = record({ body: "A" });
  await store.save(first);
  await store.save(record({ body: "B" }));
  assert.equal((await store.load(first.repoKey, targetKey(first.target)))?.body, "B");

  const single = createReviewStore(await sandbox(t), undefined, { cleanup: false });
  const only = record({ body: "only" });
  await single.save(only);
  assert.deepEqual(await single.load(only.repoKey, targetKey(only.target)), only);

  holds.push(true, false);
  const failing = store.save(record({ body: "C" }));
  await held(gates);
  const succeeding = store.save(record({ body: "D" }));
  gates[0]?.fail(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  await assert.rejects(failing, /disk full/);
  await succeeding;
  assert.equal((await store.load(first.repoKey, targetKey(first.target)))?.body, "D");
});
