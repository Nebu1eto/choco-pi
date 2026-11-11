// /diff source branch without a base: the remote's default branch, then main, then master, else a clear message.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, VStack } from "@earendil-works/pi-tui";
import { registerDiffPane } from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import { createSystemClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import {
  NO_DEFAULT_BASE_MESSAGE,
  resolveDefaultBranchBase,
} from "../.pi/extensions/lib/changes/git/default-base.ts";
import { createGitExecRunner } from "../.pi/extensions/lib/changes/git/exec.ts";
import { DEFAULT_DIFF_LIMITS } from "../.pi/extensions/lib/changes/git/limits.ts";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { FakeTui } from "./diff-actions-fakes.ts";

const execFileAsync = promisify(execFile);
const TEMP = tmpdir();
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  assert.ok(cwd.startsWith(TEMP + sep) || cwd.startsWith("/private" + TEMP + sep), cwd);
  return (await execFileAsync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" })).stdout;
}

async function tempDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await realpath(await mkdtemp(join(TEMP, "diff-branch-default-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A repository whose only branch is the given one, with one commit. */
async function repository(root: string, branch: string): Promise<string> {
  await git(root, "init", "-q", "-b", branch);
  await git(root, "config", "user.name", "Diff Test");
  await git(root, "config", "user.email", "diff@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  return root;
}

const runner = createGitExecRunner(DEFAULT_DIFF_LIMITS);

test("the default base is the remote's default branch, then main, then master, else none", async (t) => {
  const masterOnly = await repository(await tempDir(t), "master");
  assert.deepEqual(await resolveDefaultBranchBase(runner, masterOnly), {
    kind: "found",
    base: "master",
  });

  const both = await repository(await tempDir(t), "master");
  await git(both, "branch", "main");
  assert.deepEqual(await resolveDefaultBranchBase(runner, both), { kind: "found", base: "main" });

  const upstream = await repository(await tempDir(t), "trunk");
  const clone = await tempDir(t);
  await git(clone, "clone", "-q", upstream, "work");
  const work = join(clone, "work");
  await git(work, "checkout", "-q", "-b", "main");
  assert.deepEqual(
    await resolveDefaultBranchBase(runner, work),
    { kind: "found", base: "origin/trunk" },
    "the remote's default branch wins over a local main",
  );

  const neither = await repository(await tempDir(t), "dev");
  assert.deepEqual(await resolveDefaultBranchBase(runner, neither), {
    kind: "none",
    message: NO_DEFAULT_BASE_MESSAGE,
  });
});

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;

/** The pane with the real store and the real default-base resolver, as index.ts wires them. */
function pane(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const notices: string[] = [];
  const clock = createSystemClock();
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new VStack([]), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const tui = new FakeTui(root);
  const fakePi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on: () => () => {}, emit: () => {} },
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.set(name, command);
    },
    registerShortcut: () => {},
  };
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    mode: "tui",
    hasUI: true,
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  });
  const probe = registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), {
    createStore: (storeCwd, checkpoints, source) =>
      createDiffStore({ cwd: storeCwd, clock, checkpoints, source }),
    clock,
    prefsIo: { read: async () => undefined, write: async () => {} },
    agentDir: () => "/agent",
    probe: () => tui,
    styler: () => plainPaneStyler,
    renderFileBody: () => [],
    listTurns: () => [],
    defaultBranchBase: (base) => resolveDefaultBranchBase(runner, base),
  });
  const fire = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({ reason: "startup" }, ctx);
  };
  const run = async (args: string) => {
    const command = commands.get("diff");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const state = probe.session()?.store?.getState();
      if (state && state.kind !== "idle" && !(state.kind === "ready" && state.refreshing)) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("the store never settled");
  };
  const header = () => probe.session()?.view?.renderHeader(120, false).join("\n") ?? "";
  return { fire, run, ready, header, notices, probe };
}

test("/diff source branch works in a repository without main, and says so when no base exists", async (t) => {
  const root = await repository(await tempDir(t), "master");
  await git(root, "checkout", "-q", "-b", "feature");
  await writeFile(join(root, "b.txt"), "feature\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "feature work");
  const h = pane(root);
  t.after(() => h.fire("session_shutdown"));
  await h.fire("session_start");
  await h.run("source branch");
  const state = await h.ready();
  assert.equal(state.kind, "ready", state.kind === "error" ? state.message : state.kind);
  if (state.kind !== "ready") return;
  assert.deepEqual(state.snapshot.source, { kind: "branch-base", base: "master" });
  assert.deepEqual(
    state.snapshot.files.map((file) => file.path),
    ["b.txt"],
  );
  assert.match(h.header(), /Changes since master/u);

  const lonely = await repository(await tempDir(t), "dev");
  const none = pane(lonely);
  t.after(() => none.fire("session_shutdown"));
  await none.fire("session_start");
  await none.run("source branch");
  assert.match(none.notices.join("\n"), /no remote default branch, no main and no master/u);
  assert.equal(none.probe.session()?.host, undefined, "nothing opened for an impossible source");
  assert.equal(none.probe.session()?.source.kind, "session", "the source is unchanged");
});
