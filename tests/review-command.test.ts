import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { propertiesWhen } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import type { GithubReviewPayload } from "../.pi/extensions/review/core/github.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import { assessDiff } from "../.pi/extensions/review/core/heuristics.ts";
import type {
  ExecRunner,
  ResolvedReviewConfig,
  ReviewRecord,
  ReviewStore,
  ReviewTarget,
} from "../.pi/extensions/review/core/types.ts";
import { repoKey, targetKey } from "../.pi/extensions/review/core/store.ts";
import {
  parseReviewCommand,
  registerReviewExtension,
  type ReviewExtensionDependencies,
} from "../.pi/extensions/review/index.ts";
import { openReviewView, type ReviewViewResult } from "../.pi/extensions/review/ui/review-view.ts";

const root = "/work/repository";
const sessionId = "session-9";
const prHead = "a".repeat(40);
const prBase = "b".repeat(40);
const pullRequest = {
  number: 42,
  title: "Keep review state",
  baseRefName: "main",
  headRefOid: prHead,
  author: { login: "octo", name: "Octo", is_bot: false },
  url: "https://github.com/octo/widget/pull/42",
  updatedAt: "2026-01-02T21:00:00.000Z",
};

const config: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};

const patch = [
  "diff --git a/src/value.ts b/src/value.ts",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

function record(target: ReviewTarget): ReviewRecord {
  return {
    version: 1,
    repoKey: repoKey(root),
    target,
    baseSha: "base-sha",
    headSha: "head-sha",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head-sha" },
    comments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

const resumable = record({ kind: "branch", base: "main" });

function createStore(): ReviewStore {
  return {
    load: async () => undefined,
    save: async () => undefined,
    list: async () => [resumable],
  };
}

function createRunner(calls: string[][]): ExecRunner {
  return async (command, args) => {
    calls.push(args);
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { stdout: JSON.stringify([pullRequest]), stderr: "", code: 0 };
    }
    if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
    if (args.includes("symbolic-ref")) return { stdout: "feature\n", stderr: "", code: 0 };
    if (args.includes("for-each-ref")) {
      return { stdout: "feature\nmain\norigin/main\n", stderr: "", code: 0 };
    }
    // The shared change layer validates object ids, so these are hexadecimal.
    if (args.includes("merge-base")) return { stdout: `${BASE_ID}\n`, stderr: "", code: 0 };
    if (args.includes("--verify")) return { stdout: "head-sha\n", stderr: "", code: 0 };
    if (args.includes("status")) {
      return {
        stdout: `# branch.oid ${HEAD_ID}\0# branch.head feature\0`,
        stderr: "",
        code: 0,
      };
    }
    // An empty change list: these tests follow targets, not file content.
    if (args.includes("diff-index") || args.includes("diff-tree")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args.includes("diff")) return { stdout: patch, stderr: "", code: 0 };
    throw new Error(`Unexpected ${command} invocation: ${args.join(" ")}`);
  };
}

const BASE_ID = "b".repeat(40);
const HEAD_ID = "a".repeat(40);
const TREE_1 = "1".repeat(40);
const TREE_2 = "2".repeat(40);
const TREE_3 = "3".repeat(40);
const TREE_4 = "4".repeat(40);

function checkpointEntry(id: string, turnIndex: number, tree: string) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "choco-pi:file-checkpoint",
    data: {
      version: 1,
      ref: `refs/choco-pi/checkpoints/${id}`,
      indexTree: tree,
      worktreeTree: tree,
      timestamp: "2026-01-01T00:00:00.000Z",
      turnIndex,
      label: `Turn ${turnIndex}`,
    },
  };
}

function userEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function checkpointEntries(): any[] {
  return [
    checkpointEntry("checkpoint-2", 2, TREE_2),
    userEntry("user-2", "Second turn"),
    checkpointEntry("checkpoint-3", 3, TREE_3),
    userEntry("user-3", "Third turn"),
  ];
}

/** Three prompts as Pi records them: every checkpoint's own turnIndex is 0. */
function threeTurnEntries(): any[] {
  return [
    checkpointEntry("checkpoint-a", 0, TREE_2),
    userEntry("user-a", "First prompt"),
    checkpointEntry("checkpoint-b", 0, TREE_3),
    userEntry("user-b", "Second prompt"),
    checkpointEntry("checkpoint-c", 0, TREE_4),
    userEntry("user-c", "Third prompt"),
  ];
}

function commandContext(
  notifications: Array<{ message: string; type?: string }>,
  entries = checkpointEntries(),
  select: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined,
  editorText: string[] = [],
  widgets: Array<string | undefined> = [],
  /** Every entry of the session file; the active branch (`entries`) when omitted. */
  sessionEntries: any[] = entries,
): ExtensionCommandContext {
  // SAFETY: The fixture supplies every host member exercised by this test.
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    // SAFETY: The fixture supplies every host member exercised by this test.
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getEntries: () => sessionEntries,
    } as any,
    // SAFETY: The fixture supplies every host member exercised by this test.
    ui: {
      // SAFETY: The fixture supplies every host member exercised by this test.
      theme: {
        fg: (_color: string, text: string) => text,
        inverse: (text: string) => text,
      } as any,
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      select,
      setEditorText: (text: string) => editorText.push(text),
      setWidget: (_key: string, content?: string[]) => widgets.push(content?.[0]),
    } as any,
    waitForIdle: async () => undefined,
  } as ExtensionCommandContext;
}

function register(
  options: {
    calls?: string[][];
    runner?: ExecRunner;
    store?: ReviewStore;
    reviewDirectory?: string;
    onView?: (
      target: ReviewTarget,
      pullRequest: Parameters<
        NonNullable<ReviewExtensionDependencies["openView"]>
      >[0]["pullRequest"],
    ) => void;
    viewResult?: (record: ReviewRecord) => ReviewViewResult | undefined;
    viewError?: Error;
    /** Sees each view's options: whether it ends at the working tree and can refresh. */
    onOpen?: (view: { includesWorkingTree: boolean | undefined; refreshes: boolean }) => void;
    /** Sees the session baseline label a session view names in its header. */
    onBaseline?: (label: string | undefined) => void;
  } = {},
) {
  const calls = options.calls ?? [];
  const handlers = new Map<string, (event: RuntimeValue, ctx: any) => void>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const api = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, ctx: any) => void) =>
      handlers.set(event, handler),
    registerCommand: (name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      assert.ok(!commands.has(name), `/${name} is registered once`);
      commands.set(name, value);
    },
    appendEntry: () => undefined,
  });
  registerReviewExtension(api, {
    runner: options.runner ?? createRunner(calls),
    store: options.store ?? createStore(),
    loadConfig: async () => config,
    openView: async (view) => {
      options.onView?.(view.record.target, view.pullRequest);
      options.onOpen?.({
        includesWorkingTree: view.includesWorkingTree,
        refreshes: view.reload !== undefined,
      });
      options.onBaseline?.(
        view.sessionBaseline?.kind === "checkpoint" ? view.sessionBaseline.label : undefined,
      );
      if (options.viewError) throw options.viewError;
      return options.viewResult?.(view.record);
    },
    ...propertiesWhen(!(options.reviewDirectory === undefined), () => ({
      reviewDirectory: options.reviewDirectory,
    })),
    now: () => "2026-01-03T00:00:00.000Z",
  } satisfies ReviewExtensionDependencies);
  // `/review` belongs to the agent review prompt; this extension must not take it.
  assert.deepEqual([...commands.keys()], ["review-assist"]);
  const command = commands.get("review-assist");
  assert.ok(command, "/review-assist must be registered");
  return { command, handlers, calls };
}

type PrRunnerCall = {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
};

function createPullRequestRunner(
  calls: PrRunnerCall[],
  worktreePaths: string[],
  options: { authenticationFailure?: boolean } = {},
): ExecRunner {
  return async (command, args, runnerOptions) => {
    calls.push({
      command,
      args: [...args],
      ...propertiesWhen(!(runnerOptions?.cwd === undefined), () => ({ cwd: runnerOptions?.cwd })),
      ...propertiesWhen(
        // SAFETY: The fixture supplies every host member exercised by this test.
        !((runnerOptions as { input?: string } | undefined)?.input === undefined),
        () => ({
          // SAFETY: The fixture supplies every host member exercised by this test.
          input: (runnerOptions as { input?: string }).input,
        }),
      ),
    });
    if (command === "gh") {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: JSON.stringify([pullRequest]), stderr: "", code: 0 };
      }
      if (args[0] === "pr" && args[1] === "view") {
        if (options.authenticationFailure) {
          return { stdout: "", stderr: "authentication required; run gh auth login", code: 4 };
        }
        return { stdout: JSON.stringify(pullRequest), stderr: "", code: 0 };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            nameWithOwner: "octo/widget",
            url: "https://github.com/octo/widget",
            sshUrl: "git@github.com:octo/widget.git",
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "api" && args.includes("--method")) {
        return {
          stdout: JSON.stringify({ id: 9, state: "COMMENTED", html_url: pullRequest.url }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "api") {
        return {
          stdout: JSON.stringify({
            headSha: prHead,
            baseSha: prBase,
            headRef: "topic",
            state: "open",
          }),
          stderr: "",
          code: 0,
        };
      }
    }
    if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
    if (args.includes("--git-common-dir")) return { stdout: `${root}/.git\n`, stderr: "", code: 0 };
    if (args.includes("for-each-ref")) return { stdout: "main\n", stderr: "", code: 0 };
    const remoteIndex = args.indexOf("remote");
    if (remoteIndex >= 0 && args.length === remoteIndex + 1)
      return { stdout: "origin\n", stderr: "", code: 0 };
    if (remoteIndex >= 0 && args[remoteIndex + 1] === "get-url") {
      return { stdout: "git@github.com:octo/widget.git\n", stderr: "", code: 0 };
    }
    if (args.includes("fetch")) return { stdout: "", stderr: "", code: 0 };
    if (args.includes("rev-parse") && args.includes("--verify")) {
      return { stdout: `${prHead}\n`, stderr: "", code: 0 };
    }
    if (args.includes("merge-base")) return { stdout: `${prBase}\n`, stderr: "", code: 0 };
    if (args.includes("diff")) return { stdout: patch, stderr: "", code: 0 };
    const worktreeIndex = args.indexOf("worktree");
    if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "add") {
      worktreePaths.push(args[worktreeIndex + 3]!);
      return { stdout: "", stderr: "", code: 0 };
    }
    if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "remove") {
      return { stdout: "", stderr: "", code: 0 };
    }
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  };
}

function finishedPullRequestRecord(
  review: ReviewRecord,
  verdict: ReviewRecord["verdict"],
): ReviewViewResult {
  return {
    action: "finish",
    record: {
      ...review,
      ...propertiesWhen(!(verdict === undefined), () => ({ verdict })),
      body: "Overall summary",
    },
    markdown: "# Offline review\n",
  };
}

test("parses every documented review target grammar", () => {
  const cases: Array<[string, unknown]> = [
    ["", { ok: true, action: "pick" }],
    ["session", { ok: true, action: "review", target: { kind: "session", sessionId } }],
    [
      "session turn 3",
      { ok: true, action: "review", target: { kind: "session-turn", sessionId, turnIndex: 3 } },
    ],
    ["branch main", { ok: true, action: "review", target: { kind: "branch", base: "main" } }],
    [
      "branch main feature",
      { ok: true, action: "review", target: { kind: "branch", base: "main", target: "feature" } },
    ],
    ["resume", { ok: true, action: "resume" }],
    ["pr 42", { ok: true, action: "review", target: { kind: "pr", number: 42 } }],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(parseReviewCommand(input, sessionId), expected);
});

test("invalid review arguments return helpful parse results", async () => {
  for (const input of [
    "session turn",
    "session turn -1",
    // Turns are numbered from 1, the first checkpointed turn.
    "session turn 0",
    "branch",
    "branch a b c",
    "resume extra",
    "pr 0",
    "unknown",
  ]) {
    const result = parseReviewCommand(input, sessionId);
    assert.equal(result.ok, false, input);
    if (!result.ok) assert.match(result.message, /Usage: \/review-assist \[/);
  }

  const notifications: Array<{ message: string; type?: string }> = [];
  const { command, calls } = register();
  await command.handler("branch", commandContext(notifications));
  assert.equal(calls.length, 0, "invalid input must not run git");
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /requires a base.*Usage: \/review-assist /i);
});

test("registers contextual, non-throwing argument completions", async () => {
  const { command, handlers } = register();
  const ctx = commandContext([]);
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const complete = command.getArgumentCompletions!;

  assert.deepEqual(
    (await complete(""))?.map((item) => item.value),
    ["session", "branch", "uncommitted", "resume", "pr"],
  );
  assert.deepEqual(
    (await complete("br"))?.map((item) => item.value),
    ["branch"],
  );
  assert.deepEqual(
    (await complete("session "))?.map((item) => item.value),
    ["session turn"],
  );
  assert.deepEqual(
    (await complete("session turn "))?.map((item) => item.value),
    ["session turn 1", "session turn 2"],
    "turns are numbered by position, not by the checkpoint's own turnIndex",
  );
  assert.deepEqual(
    (await complete("branch "))?.map((item) => item.value),
    ["branch feature", "branch main", "branch origin/main"],
  );
  assert.deepEqual(
    (await complete("branch main "))?.map((item) => item.value),
    ["branch main feature", "branch main main", "branch main origin/main"],
  );
  assert.deepEqual(
    (await complete("pr "))?.map((item) => ({ value: item.value, label: item.label })),
    [{ value: "pr 42", label: "#42 Keep review state" }],
  );
  assert.deepEqual(
    (await complete("resume "))?.map((item) => ({ value: item.value, label: item.label })),
    [{ value: "resume", label: "main → working tree" }],
  );
});

test("completion failures are contained", async () => {
  const handlers = new Map<string, (event: RuntimeValue, ctx: any) => void>();
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const api = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, ctx: any) => void) =>
      handlers.set(event, handler),
    registerCommand: (name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      if (name === "review-assist") command = value;
    },
  });
  registerReviewExtension(api, {
    runner: async () => {
      throw new Error("git unavailable");
    },
    store: createStore(),
  });
  assert.ok(command);
  handlers.get("session_start")?.({}, commandContext([]));
  await assert.doesNotReject(async () => command!.getArgumentCompletions!("branch "));
  assert.equal(await command.getArgumentCompletions!("branch "), null);
});

test("runs branch review through the local diff pipeline", async () => {
  const seen: ReviewTarget[] = [];
  const { command, calls } = register({ onView: (target) => seen.push(target) });
  await command.handler("branch main", commandContext([]));
  assert.deepEqual(seen, [{ kind: "branch", base: "main" }]);
  assert.ok(calls.some((args) => args.includes("merge-base")));
  assert.ok(
    calls.some((args) => args.includes("status")),
    "one-argument branch review includes the working tree",
  );
});

test("runs session and single-turn review through checkpoint data", async () => {
  const seen: ReviewTarget[] = [];
  const { command, calls } = register({ onView: (target) => seen.push(target) });
  await command.handler("session", commandContext([]));
  await command.handler("session turn 1", commandContext([]));
  assert.deepEqual(seen, [
    { kind: "session", sessionId },
    { kind: "session-turn", sessionId, turnIndex: 1 },
  ]);
  assert.ok(calls.some((args) => args.includes(TREE_2) && args.includes(TREE_3)));
});

test("session turn 2 of three selects the middle turn: its checkpoint to the next one", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  const opened: Array<{ includesWorkingTree: boolean | undefined; refreshes: boolean }> = [];
  const { command, calls } = register({ onOpen: (view) => opened.push(view) });
  await command.handler("session turn 2", commandContext(notifications, threeTurnEntries()));
  assert.deepEqual(notifications, []);
  assert.ok(
    calls.some((args) => args.includes(TREE_3) && args.includes(TREE_4)),
    "turn 2 compares its own checkpoint with turn 3's",
  );
  assert.equal(
    calls.some((args) => args.includes(TREE_2)),
    false,
    "turn 1 is not involved",
  );
  assert.deepEqual(opened, [{ includesWorkingTree: false, refreshes: false }]);

  calls.length = 0;
  opened.length = 0;
  await command.handler("session turn 3", commandContext(notifications, threeTurnEntries()));
  assert.ok(calls.some((args) => args.includes(TREE_4)));
  assert.deepEqual(
    opened,
    [{ includesWorkingTree: true, refreshes: true }],
    "the last turn ends at the working tree and can be refreshed",
  );
  const missing: Array<{ message: string; type?: string }> = [];
  await command.handler("session turn 4", commandContext(missing, threeTurnEntries()));
  assert.match(
    missing.at(-1)?.message ?? "",
    /Session turn 4 has no file checkpoint\. Available turns: 1, 2, 3\./,
  );
});

test("a saved record from before positional turns (turnIndex 0) opens its first turn to the working tree", async () => {
  const opened: Array<{ includesWorkingTree: boolean | undefined; refreshes: boolean }> = [];
  const calls: string[][] = [];
  const legacy: ReviewRecord = {
    version: 1,
    repoKey: "repo",
    target: { kind: "session-turn", sessionId, turnIndex: 0 },
    baseSha: TREE_2,
    headSha: HEAD_ID,
    cursor: { reviewedHunkIds: [], lastHeadSha: HEAD_ID },
    comments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const store: ReviewStore = {
    load: async () => undefined,
    save: async () => undefined,
    list: async () => [legacy],
  };
  const { command } = register({ calls, store, onOpen: (view) => opened.push(view) });
  await command.handler(
    "resume",
    commandContext([], threeTurnEntries(), async (_title, options) => options[0]),
  );
  assert.ok(
    calls.some((args) => args.includes(TREE_2)),
    "the first checkpoint",
  );
  assert.equal(
    calls.some((args) => args.includes(TREE_3) || args.includes(TREE_4)),
    false,
  );
  assert.deepEqual(opened, [{ includesWorkingTree: true, refreshes: true }]);
});

test("session review starts at the session's first checkpoint, the same baseline as /diff", async () => {
  const calls: string[][] = [];
  const labels: Array<string | undefined> = [];
  const { command } = register({ calls, onBaseline: (label) => labels.push(label) });
  // The active branch starts after /tree navigation; the session file holds an earlier checkpoint.
  const earlier = [checkpointEntry("checkpoint-1", 0, TREE_1), userEntry("user-1", "Earlier")];
  await command.handler(
    "session",
    commandContext(
      [],
      checkpointEntries(),
      undefined,
      [],
      [],
      [...earlier, ...checkpointEntries()],
    ),
  );
  assert.ok(
    calls.some((args) => args.includes(TREE_1)),
    "the first checkpoint in the session file",
  );
  assert.equal(
    calls.some((args) => args.includes(TREE_2)),
    false,
    "not the branch's first turn",
  );
  assert.deepEqual(labels, ["turn 1 (Earlier)"], "the header names the pane's baseline");
});

test("reports missing session checkpoints without disabling branch review", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  const seen: ReviewTarget[] = [];
  const { command } = register({ onView: (target) => seen.push(target) });
  const ctx = commandContext(notifications, []);
  await command.handler("session", ctx);
  assert.match(
    notifications[0]?.message ?? "",
    /No file checkpoints.*branch review remains available/i,
  );
  await command.handler("branch main", ctx);
  assert.deepEqual(seen, [{ kind: "branch", base: "main" }]);
});

test("the picker offers the default branch base first and never the checked-out branch", async () => {
  let offered: string[] = [];
  const { command } = register();
  await command.handler(
    "",
    commandContext([], checkpointEntries(), async (title, options) => {
      assert.equal(title, "Review target");
      offered = options;
      return undefined;
    }),
  );
  const bases = offered.filter((option) => option.startsWith("Branch base: "));
  assert.equal(
    bases[0],
    "Branch base: main",
    "the default base (main, as no remote names one) comes first",
  );
  assert.equal(bases.includes("Branch base: feature"), false, "feature is checked out");
  assert.deepEqual(bases, ["Branch base: main", "Branch base: origin/main"]);
});

test("includes pull requests in the target picker", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-picker-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const calls: PrRunnerCall[] = [];
  const worktreePaths: string[] = [];
  const seen: ReviewTarget[] = [];
  const seenMetadata: unknown[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, worktreePaths),
    reviewDirectory,
    onView: (target, metadata) => {
      seen.push(target);
      seenMetadata.push(metadata);
    },
  });
  await command.handler(
    "",
    commandContext(notifications, checkpointEntries(), async (title, options) => {
      assert.equal(title, "Review target");
      return options.find((option) => option.includes("Pull request #42"));
    }),
  );
  assert.deepEqual(seen, [{ kind: "pr", number: 42 }], JSON.stringify(notifications));
  assert.deepEqual(seenMetadata, [
    {
      number: 42,
      title: "Keep review state",
      baseRefName: "main",
      headSha: prHead,
      author: { login: "octo", name: "Octo", isBot: false },
      url: "https://github.com/octo/widget/pull/42",
      updatedAt: "2026-01-02T21:00:00.000Z",
    },
  ]);
});

test("reports pull request resolution failures with gh authentication guidance", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-resolution-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const notifications: Array<{ message: string; type?: string }> = [];
  const calls: PrRunnerCall[] = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, [], { authenticationFailure: true }),
    reviewDirectory,
  });
  await command.handler("pr 42", commandContext(notifications));
  assert.equal(notifications.at(-1)?.type, "error");
  assert.match(notifications.at(-1)?.message ?? "", /GitHub CLI.*gh auth login/i);
  assert.ok(!calls.some((call) => call.args.includes("worktree") && call.args.includes("add")));
});

test("a preparing indicator shows while the pull request review is assembled and clears before the view", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-loading-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const widgets: Array<string | undefined> = [];
  let widgetWhenViewOpened: string | undefined | null = null;
  const { command } = register({
    runner: createPullRequestRunner([], []),
    reviewDirectory,
    onView: () => {
      widgetWhenViewOpened = widgets.at(-1);
    },
  });
  await command.handler(
    "pr 42",
    commandContext([], checkpointEntries(), async () => undefined, [], widgets),
  );
  assert.match(widgets[0] ?? "", /Preparing pull request #42/);
  assert.equal(widgetWhenViewOpened, undefined, "the indicator is cleared before the view opens");
  assert.equal(widgets.at(-1), undefined, "the indicator does not outlive the command");
});

test("disposes the owned pull request worktree when the view closes", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-close-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const calls: PrRunnerCall[] = [];
  const worktreePaths: string[] = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, worktreePaths),
    reviewDirectory,
  });
  await command.handler("pr 42", commandContext([]));
  assert.equal(worktreePaths.length, 1);
  await assert.rejects(access(worktreePaths[0]!), { code: "ENOENT" });
  assert.ok(
    calls.some(
      (call) =>
        call.args.includes("worktree") &&
        call.args.includes("remove") &&
        call.args.includes(worktreePaths[0]!),
    ),
  );
});

test("disposes the owned pull request worktree when the view throws", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-throw-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const notifications: Array<{ message: string; type?: string }> = [];
  const calls: PrRunnerCall[] = [];
  const worktreePaths: string[] = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, worktreePaths),
    reviewDirectory,
    viewError: new Error("view crashed"),
  });
  await command.handler("pr 42", commandContext(notifications));
  assert.equal(worktreePaths.length, 1);
  await assert.rejects(access(worktreePaths[0]!), { code: "ENOENT" });
  assert.match(notifications.at(-1)?.message ?? "", /Review failed: view crashed/);
});

test("S records a pull request outcome locally before command-level planning", async () => {
  const model = parseGitDiff(patch, "base-sha", "head-sha");
  const saved: ReviewRecord[] = [];
  const notifications: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  };
  const result = await openReviewView({
    model,
    assessments: assessDiff(model, config),
    record: record({ kind: "pr", number: 42 }),
    config,
    reviewRoot: root,
    host: {
      // SAFETY: The fixture supplies every host member exercised by this test.
      custom: ((factory: any) =>
        new Promise((resolve) => {
          const component = factory(
            {
              terminal: { rows: 24 },
              requestRender: () => undefined,
            },
            theme,
            {},
            resolve,
          );
          component.handleInput("S");
        })) as any,
      input: async () => "Overall summary",
      notify: (message: string) => notifications.push(message),
      select: async () => "Approve",
      setEditorText: () => undefined,
    },
    store: {
      load: async () => undefined,
      save: async (review) => {
        saved.push(review);
      },
      list: async () => [],
    },
    // SAFETY: The fixture supplies every host member exercised by this test.
    styler: theme as any,
    now: () => "2026-01-03T00:00:00.000Z",
  });
  assert.equal(result?.action, "finish");
  assert.equal(result?.record.verdict, "approve");
  assert.equal(result?.record.body, "Overall summary");
  assert.equal(saved.length, 1);
  assert.deepEqual(notifications, []);
});

test("pull request finish builds a confirmation plan and decline never submits", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-plan-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const notifications: Array<{ message: string; type?: string }> = [];
  const editorText: string[] = [];
  const calls: PrRunnerCall[] = [];
  const loadedTargets: string[] = [];
  const store = createStore();
  store.load = async (_repository, target) => {
    loadedTargets.push(target);
    return undefined;
  };
  const confirmationTitles: string[] = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, []),
    reviewDirectory,
    store,
    viewResult: (review) => finishedPullRequestRecord(review, "approve"),
  });
  await command.handler(
    "pr 42",
    commandContext(
      notifications,
      checkpointEntries(),
      async (title, options) => {
        confirmationTitles.push(title);
        return options[1];
      },
      editorText,
    ),
  );
  assert.deepEqual(loadedTargets, [targetKey({ kind: "pr", number: 42 })]);
  assert.equal(confirmationTitles.length, 1);
  assert.match(confirmationTitles[0]!, /octo\/widget#42 — Approve/);
  assert.match(confirmationTitles[0]!, /Confirmation required/);
  assert.ok(!calls.some((call) => call.command === "gh" && call.args.includes("POST")));
  assert.deepEqual(editorText, ["# Offline review\n"]);
  assert.match(
    notifications.at(-1)?.message ?? "",
    /Nothing was submitted.*local review record was kept/i,
  );
});

test("a plain comment submits through the stub runner without asking for confirmation", async (t) => {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-comment-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const calls: PrRunnerCall[] = [];
  const { command } = register({
    runner: createPullRequestRunner(calls, []),
    reviewDirectory,
    viewResult: (review) => finishedPullRequestRecord(review, "comment"),
  });
  await command.handler(
    "pr 42",
    commandContext([], checkpointEntries(), async () => {
      throw new Error("plain comments must not open a confirmation picker");
    }),
  );
  const submissions = calls.filter((call) => call.command === "gh" && call.args.includes("POST"));
  assert.equal(submissions.length, 1);
  assert.ok(submissions[0]?.input, "the stubbed submission receives a JSON payload on stdin");
});

/** ESC colour, OSC 52 ended by BEL, C1 CSI and right-to-left override; one line, as git and gh report names. */
const CONTROL_NAME = "a\u001b[31mred\u001b]52;c;SGVsbG8=\u0007b\u009be\u202ef";

function controlCount(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x202e) count += 1;
  }
  return count;
}

test("completion labels and failure notifications draw branch names and pull request text as glyphs", async () => {
  const calls: string[][] = [];
  const base = createRunner(calls);
  const runner: ExecRunner = async (command, args, opts) => {
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const nasty = {
        ...pullRequest,
        title: CONTROL_NAME,
        baseRefName: CONTROL_NAME,
        author: { ...pullRequest.author, login: CONTROL_NAME },
      };
      return { stdout: JSON.stringify([nasty]), stderr: "", code: 0 };
    }
    if (args.includes("for-each-ref")) return { stdout: `${CONTROL_NAME}\n`, stderr: "", code: 0 };
    return base(command, args, opts);
  };
  const notifications: Array<{ message: string; type?: string }> = [];
  const { command, handlers } = register({ runner, viewError: new Error(`view ${CONTROL_NAME}`) });
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, commandContext([]));
  const complete = command.getArgumentCompletions!;
  const items = [...((await complete("branch ")) ?? []), ...((await complete("pr ")) ?? [])];
  assert.equal(items.length, 2);
  const drawn = items.map((item) => `${item.label} ${item.description ?? ""}`).join(" | ");
  assert.equal(controlCount(drawn), 0);
  assert.ok(drawn.includes("a␛[31mred␛]52;c;SGVsbG8=␇b\uFFFDe\uFFFDf"));
  // The branch completion still inserts the real name.
  assert.equal(items[0]?.value, `branch ${CONTROL_NAME}`);

  await command.handler("branch main", commandContext(notifications));
  const failure = notifications.at(-1)?.message ?? "";
  assert.match(failure, /^Review failed: view a␛\[31mred/);
  assert.equal(controlCount(failure), 0);
});

/* ------------- submission decides inline against the head it names */

const movedHead = "c".repeat(40);
/** The same change two lines lower, as after a force-push that added lines above it. */
const movedPatch = patch.replace("@@ -1 +1 @@", "@@ -3 +3 @@");
/** The changed line is different, so the comment's text is gone. */
const rewrittenPatch = patch.replace("+export const value = 2;", "+export const value = 3;");

/**
 * The pull request runner, with GitHub's head (and the diff a re-read sees)
 * switched to `movedHead` once the review has been shown.
 */
function movingRunner(calls: PrRunnerCall[], moved: { now: boolean; diff: string }): ExecRunner {
  const base = createPullRequestRunner(calls, []);
  return async (command, args, options) => {
    if (!moved.now) return base(command, args, options);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      calls.push({ command, args: [...args] });
      return {
        stdout: JSON.stringify({ ...pullRequest, headRefOid: movedHead }),
        stderr: "",
        code: 0,
      };
    }
    if (command === "gh" && args[0] === "api" && !args.includes("--method")) {
      calls.push({ command, args: [...args] });
      return {
        stdout: JSON.stringify({
          headSha: movedHead,
          baseSha: prBase,
          headRef: "topic",
          state: "open",
        }),
        stderr: "",
        code: 0,
      };
    }
    if (command === "git" && args.includes("rev-parse") && args.includes("--verify")) {
      calls.push({ command, args: [...args] });
      return { stdout: `${movedHead}\n`, stderr: "", code: 0 };
    }
    if (command === "git" && args.includes("diff")) {
      calls.push({ command, args: [...args] });
      return { stdout: moved.diff, stderr: "", code: 0 };
    }
    return base(command, args, options);
  };
}

async function submitWithHead(
  t: TestContext,
  moved: { now: boolean; diff: string },
  move: boolean,
) {
  const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-head-"));
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
  const calls: PrRunnerCall[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const shown = parseGitDiff(patch, prBase, prHead);
  const hunk = shown.files[0]!.hunks[0]!;
  const { command } = register({
    runner: movingRunner(calls, moved),
    reviewDirectory,
    viewResult: (review) => {
      moved.now = move;
      const finished = finishedPullRequestRecord(review, "comment");
      finished.record.comments = [
        {
          id: "c1",
          path: "src/value.ts",
          side: "RIGHT",
          line: 1,
          body: "Why 2?",
          anchor: buildCommentAnchor(hunk, "RIGHT", 1),
          createdAt: "2026-01-02T21:00:00.000Z",
          updatedAt: "2026-01-02T21:00:00.000Z",
        },
      ];
      return finished;
    },
  });
  await command.handler(
    "pr 42",
    commandContext(notifications, checkpointEntries(), async () => undefined),
  );
  const post = calls.find((call) => call.command === "gh" && call.args.includes("--method"));
  // SAFETY: The request body is the JSON this module wrote for GitHub's create-review call.
  const sent = post?.input ? (JSON.parse(post.input) as GithubReviewPayload) : undefined;
  const diffReads = calls.filter(
    (call) => call.command === "git" && call.args.includes("diff"),
  ).length;
  return { sent, diffReads, notifications };
}

test("head unchanged: the shown diff decides, nothing is read again, and the comment goes inline", async (t) => {
  const { sent, diffReads, notifications } = await submitWithHead(
    t,
    { now: false, diff: patch },
    false,
  );
  assert.equal(diffReads, 1, "the diff is read once, when the review opens");
  assert.equal(sent?.commit_id, prHead, notifications.at(-1)?.message ?? "");
  assert.deepEqual(
    sent?.comments?.map((entry) => [entry.side, entry.line]),
    [["RIGHT", 1]],
  );
});

test("head moved, text still there: the new head's diff is read and the comment goes inline where it is now", async (t) => {
  const { sent, diffReads, notifications } = await submitWithHead(
    t,
    { now: false, diff: movedPatch },
    true,
  );
  assert.equal(diffReads, 2, "the moved head's diff is read");
  assert.equal(sent?.commit_id, movedHead, notifications.at(-1)?.message ?? "");
  assert.deepEqual(
    sent?.comments?.map((entry) => [entry.side, entry.line]),
    [["RIGHT", 3]],
  );
});

test("head moved, text gone: the comment goes into the body, never inline at its old line", async (t) => {
  const { sent, notifications } = await submitWithHead(
    t,
    { now: false, diff: rewrittenPatch },
    true,
  );
  assert.equal(sent?.commit_id, movedHead, notifications.at(-1)?.message ?? "");
  assert.equal(sent?.comments, undefined);
  assert.match(sent?.body ?? "", /src\/value\.ts`\*\* line 1 \(RIGHT\)[\s\S]*> Why 2\?/);
});
