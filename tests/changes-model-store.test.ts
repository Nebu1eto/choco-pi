// The review's model store: a refresh whose comparison moved is a new model even when the hunks match.
import assert from "node:assert/strict";
import test from "node:test";
import { createModelStore } from "../.pi/extensions/lib/changes/model-store.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import type { DiffModel } from "../.pi/extensions/lib/changes/types.ts";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const model = (base: string, head: string): DiffModel => parseGitDiff(PATCH, base, head);

function snapshotIds(store: ReturnType<typeof createModelStore>): [string, string | null, number] {
  const state = store.getState();
  assert.ok(state.kind === "ready");
  return [state.snapshot.base, state.snapshot.head, state.snapshot.revision];
}

test("a moved base or head with identical hunks is a changed model with the new ids", async () => {
  for (const [base, head] of [
    ["b".repeat(40), "h".repeat(40)],
    ["a".repeat(40), "i".repeat(40)],
  ]) {
    let next = model("a".repeat(40), "h".repeat(40));
    const store = createModelStore({
      model: next,
      source: { kind: "range", base: "main", head: "feature", label: "main…feature" },
      repoRoot: "/repo",
      reload: async () => next,
    });
    next = model(base, head);
    assert.equal(
      next.files[0]?.hunks[0]?.id,
      store.model().files[0]?.hunks[0]?.id,
      "the hunk ids do not name the comparison",
    );
    assert.equal(await store.refresh(), "changed");
    assert.deepEqual(snapshotIds(store), [base, head, 2]);
    assert.deepEqual([store.model().baseSha, store.model().headSha], [base, head]);
    store.dispose();
  }
});

test("the same comparison and hunks is still unchanged", async () => {
  const store = createModelStore({
    model: model("a".repeat(40), "h".repeat(40)),
    source: { kind: "session" },
    repoRoot: "/repo",
    reload: async () => model("a".repeat(40), "h".repeat(40)),
  });
  assert.equal(await store.refresh(), "unchanged");
  assert.deepEqual(snapshotIds(store), ["a".repeat(40), "h".repeat(40), 1]);
  store.dispose();
});

test("an identical hunk that moved is a changed model with its new coordinates and the same id", async () => {
  const at = (line: number): DiffModel =>
    parseGitDiff(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        `@@ -${line} +${line} @@`,
        "-old",
        "+new",
        "",
      ].join("\n"),
      "a".repeat(40),
      "h".repeat(40),
    );
  let next = at(1);
  const store = createModelStore({
    model: next,
    source: { kind: "session" },
    repoRoot: "/repo",
    reload: async () => next,
  });
  next = at(10);
  const before = store.model().files[0]?.hunks[0];
  assert.equal(next.files[0]?.hunks[0]?.id, before?.id, "same content hash");
  assert.equal(await store.refresh(), "changed");
  const moved = store.model().files[0]?.hunks[0];
  assert.equal(moved?.newStart, 10);
  assert.equal(moved?.id, before?.id, "annotation ids are stable");
  assert.equal(await store.refresh(), "unchanged", "and stays unchanged when nothing moves");
  store.dispose();
});
