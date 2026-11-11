import assert from "node:assert/strict";
import test from "node:test";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import type { DiffModel, ReviewComment } from "../.pi/extensions/review/core/types.ts";
import { baseRecord, changedFile, mount, NOW } from "./review-safety-fakes.ts";

/**
 * Comments whose hunk is gone are drawn as outdated under their file, in the
 * pane's wording; comments on files that left the diff go to a "Not in this
 * diff" trailer. Nothing is relocated and the stored comment is unchanged.
 */

function commentOn(file: ReturnType<typeof changedFile>, id: string, body: string): ReviewComment {
  const hunk = file.hunks[0];
  assert.ok(hunk);
  return {
    id,
    path: file.path,
    side: "RIGHT",
    line: 1,
    body,
    anchor: buildCommentAnchor(hunk, "RIGHT", 1),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const before = changedFile("app.ts", "a = 1", "a = 2");
const after = changedFile("app.ts", "a = 1", "a = 3");
const gone = changedFile("old.ts", "x", "y");
const secretBefore = changedFile(".env", "TOKEN=old", "TOKEN=SECRET-LINE-1");

function model(...files: DiffModel["files"]): DiffModel {
  return { baseSha: "b", headSha: "h", files };
}

test("an outdated comment is drawn under its file and counted; a removed file's comment goes to the trailer", async () => {
  const current = model(after);
  const comments = [
    commentOn(before, "c1", "check the constant"),
    commentOn(gone, "c2", "why remove?"),
  ];
  const record = baseRecord(current, { comments });
  const stored = structuredClone(record.comments);
  const view = await mount({ model: current, record });
  const screen = view.render(140).join("\n");
  assert.match(screen, /✎ \(outdated, was app\.ts:1\) check the constant/);
  assert.match(screen, /Not in this diff: *\n.*✎ old\.ts \(outdated, was line 1\) why remove\?/);
  assert.match(screen, /2 comments \(2 outdated\)/);
  await view.press("q");
  await view.closed;
  // Neither is moved or rewritten; each is saved marked outdated, keeping the lines it had.
  assert.deepEqual(
    view.savedRecords[0]?.comments,
    stored.map((entry) => ({ ...entry, stale: "outdated" })),
    "no relocation, no rewrite",
  );
});

test("a current comment is not outdated and the status shows no outdated count", async () => {
  const current = model(after);
  const view = await mount({
    model: current,
    record: baseRecord(current, { comments: [commentOn(after, "c1", "fine")] }),
  });
  const screen = view.render(140).join("\n");
  assert.doesNotMatch(screen, /outdated/);
  assert.match(screen, /1 comments ·/);
});

test("Finish puts every branch review in the editor; only the working tree is asked to be addressed", async () => {
  for (const [target, lead] of [
    [{ kind: "branch", base: "main" }, /^Please address the following human code review/],
    [
      { kind: "branch", base: "main", target: "HEAD~1" },
      /^The following human code review refers to an earlier comparison/,
    ],
  ] as const) {
    const current = model(after);
    const view = await mount({
      model: current,
      record: baseRecord(current, { target, comments: [commentOn(after, "c1", "fix it")] }),
    });
    await view.press("S");
    const result = await view.result;
    assert.equal(view.editorTexts.length, 1, JSON.stringify(target));
    assert.match(view.editorTexts[0] ?? "", lead);
    assert.match(view.editorTexts[0] ?? "", /fix it/);
    assert.equal(result?.agentInstruction, view.editorTexts[0]);
  }
});

test("a hidden or removed sensitive file's comments show no source line anywhere", async () => {
  // .env is hidden now; secrets.env left the diff. Both comments quote their line in the anchor.
  const removedSecret = changedFile("secrets.env", "a", "TOKEN=SECRET-LINE-2");
  const current: DiffModel = { ...model({ ...secretBefore, hunks: [] }, after), hidden: [".env"] };
  const record = baseRecord(current, {
    comments: [
      commentOn(secretBefore, "c1", "rotate"),
      commentOn(removedSecret, "c2", "gone secret"),
    ],
  });
  assert.ok(JSON.stringify(record).includes("SECRET-LINE-1"));
  const view = await mount({ model: current, record });
  for (const key of ["n", "p", "p"]) {
    await view.press(key);
    assert.doesNotMatch(view.render(140).join("\n"), /SECRET-LINE/);
  }
  await view.press("S");
  const result = await view.result;
  assert.doesNotMatch(result?.markdown ?? "", /SECRET-LINE/);
  assert.match(result?.markdown ?? "", /gone secret/);
  assert.doesNotMatch(view.editorTexts.join("\n"), /SECRET-LINE/);
});

test("an untracked file shows the pane's ? and an added one A", async () => {
  const added = { ...changedFile("added.ts", "", "x"), kind: "added" as const };
  const fresh = { ...changedFile("fresh.ts", "", "y"), kind: "added" as const };
  const current: DiffModel = { ...model(added, fresh), untracked: ["fresh.ts"] };
  const screen = (await mount({ model: current })).render(120).join("\n");
  assert.match(screen, /▾ A added\.ts/);
  assert.match(screen, /▾ \? fresh\.ts/);
});
