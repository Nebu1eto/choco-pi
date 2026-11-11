// Every checkpoint records turnIndex 0: Pi restarts turn_start's index for each prompt. /diff numbers turns itself.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_ENTRY, type FileCheckpoint } from "../.pi/extensions/checkpoints/turns.ts";
import {
  chooseTurn,
  createTurnCheckpointProvider,
  turnCheckpointsOf,
  turnSource,
} from "../.pi/extensions/diff/core/checkpoints.ts";
import fileCheckpoints from "../.pi/extensions/file-checkpoints.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const execFileAsync = promisify(execFile);
const TEMP = tmpdir();
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  assert.ok(cwd.startsWith(TEMP + sep) || cwd.startsWith("/private" + TEMP + sep), cwd);
  const env = { ...process.env, ...ISOLATED, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" };
  return (await execFileAsync("git", args, { cwd, env, encoding: "utf8" })).stdout;
}

async function repository(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await realpath(await mkdtemp(join(TEMP, "diff-turn-index-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Diff Test");
  await git(root, "config", "user.email", "diff@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  return root;
}

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;

test("file-checkpoints records Pi's per-prompt turn index, so every checkpoint says 0", async (t) => {
  const root = await repository(t);
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, ISOLATED);
  t.after(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
  });
  const handlers = new Map<string, Handler[]>();
  const recorded: FileCheckpoint[] = [];
  const fakePi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: () => {},
    appendEntry: (customType: string, data: FileCheckpoint) => {
      if (customType === CHECKPOINT_ENTRY) recorded.push(data);
    },
  };
  const ctx = reinterpretHostValue<ExtensionContext>({
    cwd: root,
    mode: "tui",
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionId: () => "turn-index-test",
      getEntries: (): SessionEntry[] => [],
    },
  });
  fileCheckpoints(reinterpretHostValue<ExtensionAPI>(fakePi));
  const fire = async (event: string, payload: RuntimeValue) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  await fire("session_start", { reason: "startup" });
  // What AgentSession emits: agent_start resets its turn counter, so each prompt's first turn is 0.
  for (const [prompt, file] of [
    ["first prompt", "b.txt"],
    ["second prompt", "c.txt"],
  ] as const) {
    await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    await fire("message_start", {
      type: "message_start",
      message: { role: "user", content: prompt, timestamp: Date.now() },
    });
    // The agent works for two more turns in the same prompt; they record nothing.
    await fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    await fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
    await writeFile(join(root, file), `${prompt}\n`);
  }
  await fire("session_shutdown", { reason: "quit" });
  assert.deepEqual(
    recorded.map((checkpoint) => [checkpoint.label, checkpoint.turnIndex]),
    [
      ["first prompt", 0],
      ["second prompt", 0],
    ],
  );
});

test("/diff source turn picks a middle turn although every checkpoint recorded turnIndex 0", async (t) => {
  const root = await repository(t);
  const session = SessionManager.inMemory(root);
  const trees: string[] = [];
  for (const [index, prompt] of ["one", "two", "three"].entries()) {
    await writeFile(join(root, "a.txt"), `state ${index}\n`);
    await git(root, "add", "-A");
    const tree = (await git(root, "write-tree")).trim();
    trees.push(tree);
    session.appendCustomEntry(CHECKPOINT_ENTRY, {
      version: 2,
      worktreeTree: tree,
      timestamp: new Date().toISOString(),
      turnIndex: 0,
      label: prompt,
    });
    session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
  }
  const turns = turnCheckpointsOf(session.getBranch());
  assert.deepEqual(
    turns.map((turn) => [turn.turn, turn.checkpointTurnIndex]),
    [
      [1, 0],
      [2, 0],
      [3, 0],
    ],
  );
  const middle = chooseTurn(turns, 2);
  assert.equal(middle.kind, "found");
  if (middle.kind !== "found") return;
  assert.equal(middle.turn.tree, trees[1]);

  const store = createDiffStore({
    cwd: root,
    checkpoints: createTurnCheckpointProvider(() => turns),
    source: turnSource(middle.turn),
  });
  t.after(() => store.dispose());
  await store.refreshNow();
  const state = store.getState();
  assert.equal(state.kind, "ready", state.kind === "error" ? state.message : state.kind);
  if (state.kind !== "ready") return;
  assert.equal(state.snapshot.base, trees[1], "the store resolves the turn by its tree");
  assert.deepEqual(
    state.snapshot.files.map((file) => file.path),
    ["a.txt"],
  );
});
