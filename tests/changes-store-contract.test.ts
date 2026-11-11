// The tests' fake store (tests/diff-actions-fakes.ts FakeStore) must answer body loads the way
// the real store (lib/changes/git/store.ts) does. One sequence of refreshes and loads runs
// against both; the revisions each load reports must agree.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import type { DiffStore, DiffStoreState } from "../.pi/extensions/lib/changes/git/model.ts";
import { FakeStore, file, textBody, hunk } from "./diff-actions-fakes.ts";

const run = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function revisionOf(state: DiffStoreState): number {
  assert.equal(state.kind, "ready");
  return state.kind === "ready" ? state.snapshot.revision : -1;
}

/**
 * The sequence: a load begins, the snapshot moves, a second load begins, the second load
 * completes before the first. Returns each load's revision relative to the first snapshot.
 */
async function sequence(
  store: Pick<DiffStore, "getState" | "loadFile">,
  move: () => Promise<void>,
  finish: () => Promise<void>,
): Promise<number[]> {
  const first = revisionOf(store.getState());
  const early = store.loadFile("a.txt");
  await move();
  const late = store.loadFile("a.txt");
  const unlisted = store.loadFile("not-listed.txt");
  await finish();
  const [lateResult, earlyResult, unlistedResult] = await Promise.all([late, early, unlisted]);
  return [earlyResult.revision, lateResult.revision, unlistedResult.revision].map(
    (revision) => revision - first,
  );
}

test("the fake store reports each load's revision as the real store does", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "changes-store-contract-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => run("git", args, { cwd: root, env: ENV });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Contract");
  await git("config", "user.email", "contract@example.test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "a.txt"), "one\n");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  await writeFile(join(root, "a.txt"), "two\n");
  const real = createDiffStore({ cwd: root });
  t.after(() => real.dispose());
  real.setSource({ kind: "uncommitted" });
  await real.refreshNow();
  const realRevisions = await sequence(
    real,
    async () => {
      await writeFile(join(root, "a.txt"), "three\nfour\n");
      await real.refreshNow();
    },
    async () => {},
  );

  const fake = new FakeStore(undefined);
  fake.bodies.set("a.txt", textBody("a.txt", [hunk("h", 1, ["-one", "+two"])]));
  fake.ready(1, [file("a.txt")]);
  fake.holdLoads = true;
  const fakeRevisions = await sequence(
    fake,
    async () => {
      fake.ready(2, [file("a.txt")]);
    },
    async () => {
      // Out of order: the later load first.
      for (const entry of [...fake.held].reverse()) entry.release();
    },
  );

  assert.deepEqual(realRevisions, [0, 1, 1]);
  assert.deepEqual(fakeRevisions, realRevisions);
});
