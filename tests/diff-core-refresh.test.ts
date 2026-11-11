import assert from "node:assert/strict";
import test from "node:test";
import type { DiffClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import type { DiffStoreState } from "../.pi/extensions/lib/changes/git/model.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import { isNumber } from "../.pi/extensions/lib/runtime-values.ts";
import type { ExecRunner } from "../.pi/extensions/review/core/types.ts";

/* ------------------------------------------------------------- fake clock */

type FakeTimer = { id: number; due: number; fn: () => void };

class FakeClock implements DiffClock {
  current = 1_000_000;
  timers: FakeTimer[] = [];
  private nextId = 0;

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): number {
    this.nextId += 1;
    this.timers.push({ id: this.nextId, due: this.current + ms, fn });
    return this.nextId;
  }

  clearTimeout(handle: {} | null | undefined): void {
    if (!isNumber(handle)) return;
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Delays of pending timers relative to now, sorted. */
  pendingDelays(): number[] {
    return this.timers.map((timer) => timer.due - this.current).sort((a, b) => a - b);
  }

  /** Move time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > target) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.current = next.due;
      next.fn();
    }
    this.current = target;
  }
}

/* -------------------------------------------------------------- fake git */

const ROOT = "/nonexistent-diff-core-test/repo";

type FileFixture = { path: string; additions: number; deletions: number };

type World = {
  head: string;
  files: FileFixture[];
  /** Extra time the diff listing takes, applied to the fake clock. */
  diffCostMs: number;
};

type Call = { args: string[]; subcommand: string; release?: () => void };

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

function statusOutput(world: World): string {
  const records = [`# branch.oid ${world.head}`, "# branch.head main"];
  for (const file of world.files) {
    records.push(`1 .M N... 100644 100644 100644 ${"a".repeat(40)} ${"a".repeat(40)} ${file.path}`);
  }
  return `${records.join("\0")}\0`;
}

function diffOutput(world: World): string {
  const raw = world.files.map((file) => `:100644 100644 aaaaaaa 0000000 M\0${file.path}\0`);
  const numstat = world.files.map((file) => `${file.additions}\t${file.deletions}\t${file.path}\0`);
  return [...raw, ...numstat].join("");
}

function patchFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
}

class FakeGit {
  world: World = {
    head: "1".repeat(40),
    files: [{ path: "a.txt", additions: 1, deletions: 1 }],
    diffCostMs: 0,
  };
  calls: Call[] = [];
  /** Subcommands whose next call blocks until released. */
  gates = new Set<string>();
  /** When set, matching calls never settle. */
  hang = new Set<string>();

  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  readonly exec: ExecRunner = (cmd, args) => {
    assert.equal(cmd, "git");
    const subcommand = subcommandOf(args);
    const call: Call = { args: [...args], subcommand };
    this.calls.push(call);
    // Answer from the world as it is when the call starts.
    const world = structuredClone(this.world);
    const answer = () => {
      switch (subcommand) {
        case "rev-parse":
          return { stdout: `${ROOT}\n`, stderr: "", code: 0 };
        case "status":
          return { stdout: statusOutput(world), stderr: "", code: 0 };
        case "merge-base":
          return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
        case "diff-tree":
          return { stdout: "", stderr: "", code: 0 };
        case "diff-index": {
          if (args.includes("--patch")) {
            return { stdout: patchFor(args.at(-1) ?? ""), stderr: "", code: 0 };
          }
          this.clock.current += world.diffCostMs;
          return { stdout: diffOutput(world), stderr: "", code: 0 };
        }
        default:
          return { stdout: "", stderr: `unexpected ${subcommand}`, code: 1 };
      }
    };
    if (this.hang.has(subcommand)) return new Promise(() => {});
    if (this.gates.has(subcommand)) {
      this.gates.delete(subcommand);
      return new Promise((resolve) => {
        call.release = () => resolve(answer());
      });
    }
    return Promise.resolve(answer());
  };

  count(subcommand: string): number {
    return this.calls.filter((call) => call.subcommand === subcommand).length;
  }

  listingCalls(): number {
    return this.calls.filter(
      (call) => call.subcommand === "diff-index" && !call.args.includes("--patch"),
    ).length;
  }

  patchCalls(path: string): number {
    return this.calls.filter(
      (call) =>
        call.subcommand === "diff-index" &&
        call.args.includes("--patch") &&
        call.args.at(-1) === path,
    ).length;
  }

  pending(subcommand: string): Call | undefined {
    return this.calls.find((call) => call.subcommand === subcommand && call.release !== undefined);
  }
}

/** Let promise chains and fs callbacks run until `predicate` holds. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

/** Give in-flight work a chance to run, for asserting that nothing happens. */
async function quiesce(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function setup(limits: Parameters<typeof createDiffStore>[0]["limits"] = {}) {
  const clock = new FakeClock();
  const git = new FakeGit(clock);
  const store = createDiffStore({ cwd: ROOT, exec: git.exec, clock, limits });
  const states: DiffStoreState[] = [];
  store.subscribe((state) => states.push(state));
  return { clock, git, store, states };
}

function readyRevision(state: DiffStoreState): number | undefined {
  return state.kind === "ready" ? state.snapshot.revision : undefined;
}

/* ------------------------------------------------------------------ tests */

test("nothing runs before the first request, refreshNow, or setVisible(true)", async () => {
  const { clock, git, store, states } = setup();
  store.getState();
  store.setVisible(false);
  store.setSource({ kind: "branch-base", base: "main" });
  const unsubscribe = store.subscribe(() => {});
  unsubscribe();
  await quiesce();
  assert.equal(git.calls.length, 0);
  assert.equal(clock.timers.length, 0);
  assert.deepEqual(states, []);
  assert.deepEqual(store.getState(), { kind: "idle" });
  store.dispose();
});

test("requests within the debounce window coalesce into one refresh", async () => {
  const { clock, git, store } = setup();
  store.requestRefresh("tool");
  store.requestRefresh("turn");
  store.requestRefresh("subagent");
  assert.deepEqual(clock.pendingDelays(), [150]);
  clock.advance(149);
  await quiesce();
  assert.equal(git.calls.length, 0);
  clock.advance(1);
  await until(() => store.getState().kind === "ready", "first snapshot");
  assert.equal(git.count("rev-parse"), 1);
  assert.equal(git.count("status"), 1);
  assert.equal(git.listingCalls(), 1);
  assert.equal(readyRevision(store.getState()), 1);
  store.dispose();
});

test("one refresh runs at a time and requests during it schedule exactly one follow-up", async () => {
  const { clock, git, store } = setup();
  git.gates.add("status");
  store.requestRefresh("tool");
  clock.advance(150);
  await until(() => git.pending("status") !== undefined, "blocked status");
  for (let index = 0; index < 5; index += 1) store.requestRefresh("tool");
  // Stay below the 5 s per-call timeout, which would fail the blocked call.
  clock.advance(4_000);
  await quiesce();
  assert.equal(git.count("rev-parse"), 1, "no second refresh while one is in flight");
  git.pending("status")?.release?.();
  await until(() => store.getState().kind === "ready", "first snapshot");
  // The blocked refresh took 4 s of fake time, so backoff doubled the debounce.
  assert.deepEqual(clock.pendingDelays(), [300], "one debounced follow-up");
  clock.advance(300);
  await until(() => git.count("rev-parse") === 2, "follow-up refresh");
  await until(() => git.listingCalls() === 2, "follow-up listing");
  await quiesce();
  clock.advance(60_000);
  await quiesce();
  assert.equal(git.count("rev-parse"), 2, "exactly one follow-up");
  store.dispose();
});

test("a superseded refresh that finishes after the newer refresh applied never overwrites it", async () => {
  const { clock, git, store, states } = setup();
  await store.refreshNow();
  git.gates.add("diff-index");
  const pending = store.refreshNow();
  await until(() => git.pending("diff-index") !== undefined, "old refresh blocked");
  const oldCall = git.pending("diff-index");
  store.setSource({ kind: "branch-base", base: "main" });
  const marker = states.length;
  await pending;
  await until(() => {
    const state = store.getState();
    return state.kind === "ready" && state.snapshot.source.kind === "branch-base";
  }, "new source applied");
  oldCall?.release?.();
  await quiesce();
  const state = store.getState();
  assert.ok(state.kind === "ready" && state.snapshot.source.kind === "branch-base");
  for (const seen of states.slice(marker)) {
    if (seen.kind === "ready" && !seen.refreshing) {
      assert.equal(seen.snapshot.source.kind, "branch-base", "old source never applied");
    }
  }
  assert.equal(git.listingCalls(), 3, "the old refresh did not restart");
  assert.equal(clock.timers.length, 0);
  store.dispose();
});

test("a superseded refresh finishing while the newer one is still running is discarded", async () => {
  const { git, store, states } = setup();
  await store.refreshNow();
  git.gates.add("diff-index");
  void store.refreshNow();
  await until(() => git.pending("diff-index") !== undefined, "old refresh blocked");
  const oldCall = git.pending("diff-index");
  git.gates.add("merge-base");
  store.setSource({ kind: "branch-base", base: "main" });
  const marker = states.length;
  await until(() => git.pending("merge-base") !== undefined, "new refresh blocked");
  const newCall = git.pending("merge-base");
  oldCall?.release?.();
  await quiesce();
  for (const seen of states.slice(marker)) {
    if (seen.kind === "ready") {
      assert.equal(seen.refreshing, true, "nothing applied from the old source");
    }
  }
  newCall?.release?.();
  await until(() => {
    const state = store.getState();
    return state.kind === "ready" && state.snapshot.source.kind === "branch-base";
  }, "new source applied");
  for (const seen of states.slice(marker)) {
    if (seen.kind === "ready" && !seen.refreshing) {
      assert.equal(seen.snapshot.source.kind, "branch-base");
    }
  }
  store.dispose();
});

test("dispose during a refresh applies nothing and leaves no timers", async () => {
  const { clock, git, store, states } = setup();
  store.setVisible(true);
  git.gates.add("status");
  clock.advance(150);
  await until(() => git.pending("status") !== undefined, "blocked status");
  const waiting = store.refreshNow();
  const seen = states.length;
  store.dispose();
  store.dispose();
  assert.equal(clock.timers.length, 0, "dispose cleared every timer, including git deadlines");
  await waiting;
  git.pending("status")?.release?.();
  await quiesce();
  assert.equal(states.length, seen, "no state change after dispose");
  assert.deepEqual(store.getState(), { kind: "idle" });
  assert.equal(clock.timers.length, 0, "no timers left");
  store.requestRefresh("manual");
  store.setVisible(true);
  await store.refreshNow();
  assert.equal(clock.timers.length, 0);
  assert.equal(git.count("rev-parse"), 1);
});

test("revision is unchanged when nothing changed and increments when a count changes", async () => {
  const { git, store, states } = setup();
  await store.refreshNow();
  const first = store.getState();
  assert.equal(readyRevision(first), 1);
  await store.refreshNow();
  const second = store.getState();
  assert.equal(readyRevision(second), 1);
  assert.ok(first.kind === "ready" && second.kind === "ready");
  git.world.files = [{ path: "a.txt", additions: 2, deletions: 1 }];
  await store.refreshNow();
  assert.equal(readyRevision(store.getState()), 2);
  const final = store.getState();
  assert.ok(final.kind === "ready");
  assert.deepEqual(final.snapshot.totals, { files: 1, additions: 2, deletions: 1 });
  git.world.head = "2".repeat(40);
  await store.refreshNow();
  assert.equal(readyRevision(store.getState()), 3, "HEAD change bumps the revision");
  assert.ok(states.some((state) => state.kind === "ready" && state.refreshing));
  store.dispose();
});

test("polling runs only while visible, probes cheaply, and never overlaps a refresh", async () => {
  const { clock, git, store } = setup();
  await store.refreshNow();
  assert.equal(clock.timers.length, 0, "no poll while hidden");
  store.setVisible(true);
  clock.advance(0);
  await until(() => git.count("status") === 2, "probe on show");
  await until(() => clock.pendingDelays()[0] === 3_000, "poll armed");
  assert.equal(git.listingCalls(), 1, "unchanged probe skips the listing");
  clock.advance(3_000);
  await until(() => git.count("status") === 3, "poll probe");
  await until(() => clock.timers.length === 1, "poll re-armed");
  assert.equal(git.listingCalls(), 1);

  // A newly changed file alters the status output the probe fingerprints.
  git.world.files = [
    { path: "a.txt", additions: 1, deletions: 1 },
    { path: "b.txt", additions: 5, deletions: 1 },
  ];
  git.gates.add("diff-index");
  clock.advance(3_000);
  await until(() => git.pending("diff-index") !== undefined, "probe escalated to a listing");
  clock.advance(4_000);
  await quiesce();
  assert.equal(git.count("status"), 4, "no poll while a refresh is in flight");
  git.pending("diff-index")?.release?.();
  await until(() => readyRevision(store.getState()) === 2, "poll picked up the change");

  store.setVisible(false);
  assert.equal(clock.timers.length, 0, "hiding stops polling");
  clock.advance(60_000);
  await quiesce();
  assert.equal(git.count("status"), 4);
  store.dispose();
});

test("slow refreshes lengthen debounce and polling, and fast ones restore them", async () => {
  const { clock, git, store } = setup();
  store.setVisible(true);
  git.world.diffCostMs = 1_500;
  clock.advance(150);
  await until(() => store.getState().kind === "ready", "slow snapshot");
  await until(() => clock.timers.length === 1, "poll armed");
  assert.deepEqual(clock.pendingDelays(), [6_000], "poll doubled after a slow refresh");
  store.requestRefresh("tool");
  assert.deepEqual(clock.pendingDelays(), [300], "debounce doubled");
  git.world.files = [{ path: "a.txt", additions: 9, deletions: 9 }];
  clock.advance(300);
  await until(() => readyRevision(store.getState()) === 2, "second slow snapshot");
  await until(() => clock.timers.length === 1, "poll armed again");
  assert.deepEqual(clock.pendingDelays(), [12_000], "backoff grows");
  git.world.diffCostMs = 0;
  git.world.files = [{ path: "a.txt", additions: 1, deletions: 9 }];
  store.requestRefresh("tool");
  clock.advance(600);
  await until(() => readyRevision(store.getState()) === 3, "fast snapshot");
  await until(() => clock.timers.length === 1, "poll armed after fast refresh");
  assert.deepEqual(clock.pendingDelays(), [3_000], "recovered");
  store.dispose();
});

test("file bodies are cached per path and invalidated only when that file changes", async () => {
  const { git, store } = setup();
  git.world.files = [
    { path: "a.txt", additions: 1, deletions: 1 },
    { path: "b.txt", additions: 1, deletions: 1 },
  ];
  await store.refreshNow();
  const a1 = await store.loadFile("a.txt");
  const b1 = await store.loadFile("b.txt");
  assert.equal(a1.revision, 1);
  assert.equal(a1.body.kind, "text");
  assert.equal(git.patchCalls("a.txt"), 1);
  assert.equal(git.patchCalls("b.txt"), 1);
  await store.loadFile("a.txt");
  assert.equal(git.patchCalls("a.txt"), 1, "served from cache");

  git.world.files = [
    { path: "a.txt", additions: 3, deletions: 1 },
    { path: "b.txt", additions: 1, deletions: 1 },
  ];
  await store.refreshNow();
  const a2 = await store.loadFile("a.txt");
  const b2 = await store.loadFile("b.txt");
  assert.equal(a2.revision, 2);
  assert.equal(b2.revision, 2);
  assert.equal(git.patchCalls("a.txt"), 2, "changed file reloaded");
  assert.equal(git.patchCalls("b.txt"), 1, "unchanged file still cached");
  assert.deepEqual(b2.body, b1.body);
  const gone = await store.loadFile("missing.txt");
  assert.deepEqual(gone, { revision: 2, body: { kind: "gone" } });
  store.dispose();
});

test("a hung git call times out into an error state and the next refresh retries", async () => {
  const { clock, git, store } = setup();
  git.hang.add("status");
  const waiting = store.refreshNow();
  await until(() => git.count("status") === 1, "status started");
  clock.advance(5_000);
  await waiting;
  const state = store.getState();
  assert.equal(state.kind, "error");
  assert.match(state.kind === "error" ? state.message : "", /timed out/);
  git.hang.clear();
  await store.refreshNow();
  assert.equal(store.getState().kind, "ready");
  store.dispose();
  assert.equal(clock.timers.length, 0);
});

test("every git call carries the pinned no-lock and safety options", async () => {
  const { git, store } = setup();
  await store.refreshNow();
  await store.loadFile("a.txt");
  store.setSource({ kind: "branch-base", base: "main" });
  await store.refreshNow();
  assert.ok(git.calls.length >= 7);
  for (const call of git.calls) {
    const subcommandAt = call.args.indexOf(call.subcommand);
    const globals = call.args.slice(0, subcommandAt);
    assert.ok(globals.includes("--no-optional-locks"), `${call.subcommand} takes no index lock`);
    assert.ok(globals.includes("--no-pager"));
    assert.ok(globals.includes("core.fsmonitor=false"));
    assert.ok(globals.includes("core.quotepath=false"));
    if (call.subcommand.startsWith("diff")) {
      assert.ok(call.args.includes("--no-ext-diff"));
      assert.ok(call.args.includes("--no-textconv"));
      assert.ok(call.args.includes("-z") || call.args.includes("--patch"));
    }
  }
  store.dispose();
});

test("since-checkpoint without a provider reports an error naming the missing provider", async () => {
  const { store } = setup();
  store.setSource({ kind: "since-checkpoint", checkpointId: "3", label: "Turn 3" });
  await store.refreshNow();
  const state = store.getState();
  assert.equal(state.kind, "error");
  assert.match(state.kind === "error" ? state.message : "", /SessionCheckpointProvider/);
  store.dispose();
});
