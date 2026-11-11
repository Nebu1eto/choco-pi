// A loaded diff body must match the comparison of the snapshot it is reported under: when HEAD,
// a range head, or another base moves while a file's summary stays the same, the body is reread;
// when the comparison itself did not move (a session's baseline while HEAD moves), it is kept.
import assert from "node:assert/strict";
import test from "node:test";
import type { DiffSource, FileBody } from "../.pi/extensions/lib/changes/git/model.ts";
import { createDiffStore, type DiffStoreOptions } from "../.pi/extensions/lib/changes/git/store.ts";
import type { ExecRunner } from "../.pi/extensions/review/core/types.ts";

const ROOT = "/nonexistent-diff-body-base/repo";
const id = (character: string): string => character.repeat(40);

type World = { head: string; refs: Map<string, string> };

function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-c") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

/** The revisions a diff command compares: the non-option arguments after the subcommand, before "--". */
function revisionsOf(args: readonly string[], subcommand: string): string[] {
  const start = args.indexOf(subcommand) + 1;
  const end = args.indexOf("--");
  return args.slice(start, end < 0 ? undefined : end).filter((arg) => !arg.startsWith("-"));
}

/** The fake's runner and the number of patch reads it answered. */
type FakeGit = { exec: ExecRunner; patches: () => number };

/** A fake git whose patch text names what it was computed against. */
function fakeGit(world: World): FakeGit {
  let patches = 0;
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
  const listing = ":100644 100644 aaaaaaa 0000000 M\0a.txt\0" + "1\t1\ta.txt\0";
  const exec: ExecRunner = async (command, args) => {
    assert.equal(command, "git");
    const subcommand = subcommandOf(args);
    if (subcommand === "rev-parse") {
      const wanted = args.find((arg) => arg.endsWith("^{object}"));
      if (wanted === undefined) return ok(`${ROOT}\n`);
      const resolved = world.refs.get(wanted.slice(0, -"^{object}".length));
      return resolved ? ok(`${resolved}\n`) : { stdout: "", stderr: "unknown revision", code: 1 };
    }
    if (subcommand === "status") {
      const records = [`# branch.oid ${world.head}`, "# branch.head main"];
      records.push(`1 .M N... 100644 100644 100644 ${id("a")} ${id("a")} a.txt`);
      return ok(`${records.join("\0")}\0`);
    }
    if (subcommand === "cat-file") return ok("10\n");
    if (subcommand === "diff-index" || subcommand === "diff-tree") {
      if (!args.includes("--patch")) return ok(listing);
      patches += 1;
      const [base, head] = revisionsOf(args, subcommand);
      return ok(
        [
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1 +1 @@",
          `-base ${base}`,
          `+head ${head ?? "worktree"}`,
          "",
        ].join("\n"),
      );
    }
    return { stdout: "", stderr: `unexpected ${subcommand}`, code: 1 };
  };
  return { exec, patches: () => patches };
}

function linesOf(body: FileBody): string[] {
  assert.equal(body.kind, "text");
  return body.kind === "text"
    ? body.file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
    : [];
}

function setup(world: World, source: DiffSource, sessionTree?: string) {
  const git = fakeGit(world);
  const options: DiffStoreOptions = { cwd: ROOT, exec: git.exec, source };
  if (sessionTree !== undefined) {
    options.checkpoints = {
      listTurns: async () => [],
      sessionBaseline: async () => ({ kind: "checkpoint", tree: sessionTree, label: "turn 1" }),
    };
  }
  const store = createDiffStore(options);
  const revision = (): number => {
    const state = store.getState();
    return state.kind === "ready" ? state.snapshot.revision : 0;
  };
  return { git, store, revision };
}

test("after HEAD moves under an unchanged summary, the body is read against the new HEAD", async () => {
  const world: World = { head: id("1"), refs: new Map() };
  const { git, store, revision } = setup(world, { kind: "uncommitted" });
  await store.refreshNow();
  const first = await store.loadFile("a.txt");
  assert.deepEqual(linesOf(first.body), [`base ${id("1")}`, "head worktree"]);
  world.head = id("2");
  await store.refreshNow();
  assert.equal(revision(), first.revision + 1);
  const second = await store.loadFile("a.txt");
  assert.equal(second.revision, revision());
  assert.deepEqual(linesOf(second.body), [`base ${id("2")}`, "head worktree"]);
  assert.equal(git.patches(), 2);
  store.dispose();
});

test("a session's body survives a HEAD move that leaves its baseline unchanged", async () => {
  const world: World = { head: id("1"), refs: new Map() };
  const tree = id("c");
  const { git, store, revision } = setup(world, { kind: "session" }, tree);
  await store.refreshNow();
  const first = await store.loadFile("a.txt");
  assert.deepEqual(linesOf(first.body), [`base ${tree}`, "head worktree"]);
  world.head = id("2");
  await store.refreshNow();
  const second = await store.loadFile("a.txt");
  assert.equal(second.revision, revision());
  assert.deepEqual(linesOf(second.body), [`base ${tree}`, "head worktree"]);
  assert.equal(git.patches(), 1, "the body was not reread");
  store.dispose();
});

test("a range whose head ref moves gets a new revision and a body read against the new head", async () => {
  const world: World = {
    head: id("1"),
    refs: new Map([
      ["main", id("b")],
      ["feature", id("e")],
    ]),
  };
  const source: DiffSource = {
    kind: "range",
    base: "main",
    head: "feature",
    label: "main…feature",
  };
  const { git, store, revision } = setup(world, source);
  await store.refreshNow();
  const first = await store.loadFile("a.txt");
  assert.deepEqual(linesOf(first.body), [`base ${id("b")}`, `head ${id("e")}`]);
  world.refs.set("feature", id("f"));
  await store.refreshNow();
  assert.equal(revision(), first.revision + 1);
  const second = await store.loadFile("a.txt");
  assert.deepEqual(linesOf(second.body), [`base ${id("b")}`, `head ${id("f")}`]);
  // The snapshot still names the range as it was asked for.
  const state = store.getState();
  assert.ok(state.kind === "ready");
  assert.deepEqual([state.snapshot.base, state.snapshot.head], ["main", "feature"]);
  assert.equal(git.patches(), 2);
  store.dispose();
});
