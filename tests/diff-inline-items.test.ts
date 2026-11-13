import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FindingsSummary, RecordedFinding } from "../.pi/extensions/lib/changes/findings.ts";
import {
  createCommentReader,
  paneComments,
} from "../.pi/extensions/lib/changes/review-comments.ts";
import {
  listReviewRecords,
  repoKey,
  targetKey,
  type ReviewComment,
  type ReviewRecord,
  type ReviewTarget,
} from "../.pi/extensions/lib/changes/review-records.ts";
import type { DiffHunk } from "../.pi/extensions/lib/changes/types.ts";
import { HIDDEN_CONTENTS } from "../.pi/extensions/lib/changes/view/changes-view.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import {
  file,
  flush,
  harness,
  hunk,
  textBody,
  until,
  type HarnessOptions,
} from "./diff-actions-fakes.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const ISO = new Date(NOW).toISOString();
/** src/a.ts lines 10-12 as changed: context, an added line, context. */
const A_HUNK: DiffHunk = hunk("a-h", 10, [" ten", "+eleven", " twelve"]);
const A_LINES = Array.from({ length: 40 }, (_unused, index) => `line ${index + 1}`);

function finding(
  id: string,
  path: string,
  startLine: number,
  extra: Partial<RecordedFinding> = {},
): RecordedFinding {
  return {
    id,
    class: "finding",
    severity: "high",
    path,
    invariant: `${id} claim\nsecond line of ${id}`,
    evidence: "code_path",
    reproduction: `repro ${id}`,
    angle: "boundary",
    startLine,
    workTask: "wt-a",
    agentId: "rev-1",
    completedAt: NOW,
    ...extra,
  };
}

function summary(findings: RecordedFinding[]): FindingsSummary {
  return {
    tasks: [
      {
        workTask: "wt-a",
        claims: new Map(),
        review: {
          kind: "parsed",
          verdict: "FINDINGS",
          findings: findings.length,
          candidates: 0,
          agentId: "rev-1",
          completedAt: NOW,
        },
      },
    ],
    findings,
    malformed: 0,
    errors: [],
  };
}

async function pane(options: HarnessOptions = {}) {
  const h = harness(options);
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  const store = h.store();
  store.bodies.set("src/a.ts", textBody("src/a.ts", [A_HUNK]));
  store.contents.set("src/a.ts", A_LINES);
  store.ready(1, [file("src/a.ts"), file(".env")]);
  return h;
}

const lines = (h: Awaited<ReturnType<typeof pane>>) => h.body().split("\n");
const indexOf = (rows: string[], needle: string) => rows.findIndex((row) => row.includes(needle));

async function expandFirst(h: Awaited<ReturnType<typeof pane>>) {
  h.tui.input("\r");
  await flush();
}

test("a finding inside a hunk is drawn right after its line, open by default", async () => {
  const h = await pane();
  h.view().setRecorded(summary([finding("F1", "src/a.ts", 11)]), new Map());
  await expandFirst(h);
  const rows = lines(h);
  const added = indexOf(rows, "11|eleven");
  assert.ok(added >= 0, rows.join("\n"));
  assert.match(rows[added + 1] ?? "", /▾ ⚑ high finding F1 L11/u);
  assert.match(rows[added + 2] ?? "", /^\s+F1 claim$/u, "the whole claim");
  assert.match(rows[added + 3] ?? "", /^\s+second line of F1$/u);
  const detail = rows.slice(added + 1, added + 9).join("\n");
  assert.match(detail, /Reproduction: repro F1/u);
  assert.match(detail, /Angle: boundary/u);
  assert.match(detail, /verdict FINDINGS/u);
  assert.match(detail, /Work task: wt-a \(rev-1\)/u);
  assert.match(rows[indexOf(rows, "12|twelve")] ?? "", /12\|twelve/u);
  assert.ok(indexOf(rows, "12|twelve") > added + 3, "the next line follows the finding");
  assert.equal(h.store().contextLoads.length, 0, "no quote for a finding inside a hunk");
});

test("a finding outside every hunk gets the file's lines around it, in line order between hunks", async () => {
  const h = await pane();
  h.view().setRecorded(
    summary([finding("F3", "src/a.ts", 3), finding("F30", "src/a.ts", 30)]),
    new Map(),
  );
  await expandFirst(h);
  await until(() => /┆ line 3/u.test(h.body()), "quotes read");
  const rows = lines(h);
  const header = indexOf(rows, "@@ -10,");
  const quote = indexOf(rows, "L1-5 as the file is now");
  assert.ok(quote >= 0 && quote < header, "the quote before the hunk sits above it");
  assert.deepEqual(
    rows.slice(quote + 1, quote + 4).map((row) => row.trim()),
    ["1 ┆ line 1", "2 ┆ line 2", "3 ┆ line 3"],
  );
  assert.match(rows[quote + 4] ?? "", /▾ ⚑ high finding F3 L3/u, "the finding follows its line");
  const after = indexOf(rows, "F3 claim");
  assert.equal(rows[after + 4]?.trim().startsWith("4 ┆ line 4") ?? false, false);
  assert.ok(rows.some((row) => /^\s+5 ┆ line 5$/u.test(row)));
  const later = indexOf(rows, "L28-32 as the file is now");
  assert.ok(later > header, "the quote after the hunk follows it");
  assert.deepEqual(h.store().contextLoads, [
    { path: "src/a.ts", from: 1, to: 5 },
    { path: "src/a.ts", from: 28, to: 32 },
  ]);
  // Drawn again, the quotes are not read again.
  h.body();
  assert.equal(h.store().contextLoads.length, 2);
});

test("a hidden sensitive file never gets a quote; findings elsewhere stay under Not in this diff", async () => {
  const h = await pane();
  h.view().setRecorded(summary([finding("S1", ".env", 3), finding("G1", "gone.ts", 9)]), new Map());
  h.tui.input("j");
  await expandFirst(h);
  await flush();
  const body = h.body();
  assert.ok(body.includes(HIDDEN_CONTENTS));
  assert.match(body, /▾ ⚑ high finding S1 L3/u, "the finding is still listed");
  assert.doesNotMatch(body, /┆/u, "no lines of the file");
  assert.equal(h.store().contextLoads.length, 0, "nothing is read");
  assert.match(body, /Not in this diff:\n\s+⚑ high finding G1 gone\.ts L9/u);
});

test("Enter toggles the item under the cursor, e toggles all in the file, and the state survives a refresh", async () => {
  const h = await pane();
  h.view().setRecorded(
    summary([finding("F1", "src/a.ts", 11), finding("F2", "src/a.ts", 12)]),
    new Map(),
  );
  await expandFirst(h);
  // The cursor lands on item rows: walk down until it is on F1.
  for (let step = 0; step < 12 && h.view().selectedItem === undefined; step += 1) {
    h.tui.input("\u001b[B");
    await flush();
  }
  assert.equal(h.view().selectedItem, "finding:wt-a/F1", "the cursor lands on the finding row");
  assert.match(h.body(), /▶ ▾ ⚑ high finding F1/u, "the cursor's item is marked");
  h.tui.input("\r");
  await flush();
  let body = h.body();
  assert.match(
    body,
    /▶ ▸ ⚑ high wt-a: F1 claim/u,
    "closed: one line, severity, task and the claim's start",
  );
  assert.doesNotMatch(body, /second line of F1/u);
  assert.match(body, /second line of F2/u, "the other stays open");
  assert.equal(h.view().isItemOpen("finding:wt-a/F1"), false);

  h.tui.input("e");
  await flush();
  body = h.body();
  assert.match(body, /second line of F1/u, "e opens every item when one is closed");
  assert.match(body, /second line of F2/u);
  h.tui.input("e");
  await flush();
  body = h.body();
  assert.doesNotMatch(body, /second line of F[12]/u, "e closes every item when all are open");

  h.store().ready(2, [file("src/a.ts"), file(".env")]);
  await flush();
  h.view().setRecorded(
    summary([finding("F1", "src/a.ts", 11), finding("F2", "src/a.ts", 12)]),
    new Map(),
  );
  await flush();
  body = h.body();
  assert.doesNotMatch(body, /second line of F[12]/u, "closed items stay closed after a refresh");
  assert.match(body, /▸ ⚑ high wt-a: F2 claim/u);
});

test("f and F step through findings and comments in display order and wrap", async () => {
  const h = await pane();
  h.view().setRecorded(
    summary([finding("F3", "src/a.ts", 3), finding("F1", "src/a.ts", 11)]),
    new Map(),
  );
  h.tui.input("f");
  await until(() => h.view().selectedItem !== undefined, "first item");
  assert.equal(h.view().selectedItem, "finding:wt-a/F3", "the first item, in line order");
  h.tui.input("f");
  await flush();
  assert.equal(h.view().selectedItem, "finding:wt-a/F1");
  h.tui.input("f");
  await flush();
  assert.equal(h.view().selectedItem, "finding:wt-a/F3", "wraps");
  h.tui.input("F");
  await flush();
  assert.equal(h.view().selectedItem, "finding:wt-a/F1", "F goes back, wrapping");
});

test("a click on an item puts the cursor on it and opens or closes it", async () => {
  const h = await pane();
  h.view().setRecorded(summary([finding("F1", "src/a.ts", 11)]), new Map());
  await expandFirst(h);
  const row = indexOf(lines(h), "finding F1");
  assert.ok(h.view().pointer({ kind: "click", row }));
  assert.equal(h.view().selectedItem, "finding:wt-a/F1");
  assert.equal(h.view().isItemOpen("finding:wt-a/F1"), false);
});

/* ------------------------------------------------------- /review-assist comments */

const SESSION: ReviewTarget = { kind: "session", sessionId: "session-1" };

function comment(id: string, hunkValue: DiffHunk, line: number, body: string): ReviewComment {
  return {
    id,
    path: "src/a.ts",
    side: "RIGHT",
    line,
    body,
    anchor: buildCommentAnchor(hunkValue, "RIGHT", line),
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function record(target: ReviewTarget, comments: ReviewComment[]): ReviewRecord {
  return {
    version: 1,
    repoKey: repoKey("/repo"),
    target,
    baseSha: "base",
    headSha: "head",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
    comments,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

/** A review directory holding \`records\`, plus files the store did not write. */
async function reviewDirectory(records: ReviewRecord[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diff-comments-"));
  const folder = join(directory, repoKey("/repo"));
  await mkdir(folder, { recursive: true });
  for (const entry of records) {
    await writeFile(join(folder, `${targetKey(entry.target)}.json`), JSON.stringify(entry));
  }
  await writeFile(join(folder, "junk.json"), "{ not json");
  await writeFile(join(folder, "session-0.json.123.tmp"), "partial");
  return directory;
}

async function snapshotTree(directory: string): Promise<Array<[string, string, number]>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const out: Array<[string, string, number]> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out.push([path, await readFile(path, "utf8"), (await stat(path)).mtimeMs]);
  }
  return out.sort((left, right) => left[0].localeCompare(right[0]));
}

test("comments of this session's and branch's reviews are placed inline; other reviews are ignored; nothing is written", async () => {
  const outdatedHunk = hunk("old-h", 10, [" ten", "+was here", " twelve"]);
  const directory = await reviewDirectory([
    record(SESSION, [
      comment("c1", A_HUNK, 11, "Is eleven right?\nSecond thought."),
      comment("c2", outdatedHunk, 11, "About a line that changed"),
    ]),
    record({ kind: "branch", base: "origin/main" }, [comment("c3", A_HUNK, 12, "Branch note")]),
    record({ kind: "session", sessionId: "other-session" }, [
      comment("x1", A_HUNK, 11, "OTHER SESSION"),
    ]),
    record({ kind: "session-turn", sessionId: "other-session", turnIndex: 0 }, [
      comment("x2", A_HUNK, 11, "OTHER TURN"),
    ]),
    record({ kind: "branch", base: "main", target: "feature" }, [
      comment("x3", A_HUNK, 11, "OTHER BRANCH"),
    ]),
    record({ kind: "pr", number: 7 }, [comment("x4", A_HUNK, 11, "PULL REQUEST")]),
  ]);
  try {
    const before = await snapshotTree(directory);
    const h = await pane({ readComments: createCommentReader(() => directory) });
    await until(() => h.view().comments.length > 0, "comments read");
    assert.deepEqual(
      h
        .view()
        .comments.map((entry) => entry.body.split("\n")[0])
        .sort(),
      ["About a line that changed", "Branch note", "Is eleven right?"],
    );
    assert.match(h.body(), /src\/a\.ts\s+●3/u, "the file row has a comment badge");
    await expandFirst(h);
    const rows = lines(h);
    const eleven = indexOf(rows, "11|eleven");
    assert.match(rows[eleven + 1] ?? "", /▾ ● L11 · session review/u, "placed after its line");
    assert.match(rows[eleven + 2] ?? "", /^\s+Is eleven right\?$/u);
    assert.match(rows[eleven + 3] ?? "", /^\s+Second thought\.$/u);
    const twelve = indexOf(rows, "12|twelve");
    assert.match(rows[twelve + 1] ?? "", /▾ ● L12 · branch review against origin\/main/u);
    const outdated = indexOf(rows, "(outdated)");
    assert.ok(outdated > twelve, "an outdated comment is listed at the file's end");
    assert.match(rows[outdated] ?? "", /● L11 \(outdated\)/u);
    assert.match(rows.slice(outdated).join("\n"), /Outdated: Its text is no longer present/u);
    assert.doesNotMatch(h.body(), /OTHER|PULL REQUEST/u);
    assert.deepEqual(await snapshotTree(directory), before, "no file is written, moved or removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the record lister is read-only and skips what the store did not write", async () => {
  const directory = await reviewDirectory([record(SESSION, [comment("c1", A_HUNK, 11, "hi")])]);
  try {
    const before = await snapshotTree(directory);
    const records = await listReviewRecords(directory, repoKey("/repo"));
    assert.equal(records.length, 1);
    assert.deepEqual(
      await listReviewRecords(directory, repoKey("/elsewhere")),
      [],
      "no folder: nothing",
    );
    await assert.rejects(listReviewRecords(directory, "../escape"), /filesystem-safe/u);
    assert.deepEqual(await snapshotTree(directory), before);
    const comments = paneComments(records, {
      repoRoot: "/repo",
      sessionId: undefined,
      branch: "main",
    });
    assert.deepEqual(comments, [], "without a session id, session reviews are not this session's");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("comments are read again on a refresh", async () => {
  let reads = 0;
  const h = await pane({
    readComments: async () => {
      reads += 1;
      return [];
    },
  });
  await until(() => reads === 1, "first read");
  await h.run("refresh");
  await until(() => reads >= 2, "read again on refresh");
});

test("a placed comment is labelled with the lines it was found at, not the lines it was saved at", async () => {
  const stored = comment("moved", A_HUNK, 11, "Single line");
  const range: ReviewComment = {
    ...comment("moved-range", A_HUNK, 12, "Two lines"),
    startLine: 11,
    anchor: buildCommentAnchor(A_HUNK, "RIGHT", 12, 11),
  };
  const gone: ReviewComment = {
    ...comment("gone", hunk("other", 30, [" x", "+not here", " y"]), 31, "Lost"),
    startLine: 30,
    anchor: buildCommentAnchor(hunk("other", 30, [" x", "+not here", " y"]), "RIGHT", 31, 30),
  };
  const h = await pane();
  // Ten lines were inserted above: the unchanged hunk (same content id) now starts at line 20.
  const shifted = hunk("a-h", 20, [" ten", "+eleven", " twelve"]);
  h.store().bodies.set("src/a.ts", textBody("src/a.ts", [shifted]));
  h.store().ready(2, [file("src/a.ts"), file(".env")]);
  h.view().setComments(
    paneComments([record(SESSION, [stored, range, gone])], {
      repoRoot: "/repo",
      sessionId: "session-1",
      branch: "main",
    }),
  );
  await expandFirst(h);
  const rows = lines(h);
  const twentyOne = indexOf(rows, "21|eleven");
  assert.ok(twentyOne >= 0, rows.join("\n"));
  assert.match(
    rows[twentyOne + 1] ?? "",
    /▾ ● L21 · session review/u,
    "placed under L21, labelled L21",
  );
  const twentyTwo = indexOf(rows, "22|twelve");
  assert.match(
    rows[twentyTwo + 1] ?? "",
    /▾ ● L21-22 · session review/u,
    "both ends of a range shift",
  );
  assert.doesNotMatch(
    rows.join("\n"),
    /● L11 ·|● L11-12 ·/u,
    "no stored range on a placed comment",
  );
  assert.match(
    rows.join("\n"),
    /● L30-31 \(outdated\)/u,
    "an outdated comment keeps its stored range",
  );
  assert.equal(stored.line, 11, "the stored record is untouched");
  assert.equal(range.startLine, 11);
  assert.equal(range.line, 12);
});
