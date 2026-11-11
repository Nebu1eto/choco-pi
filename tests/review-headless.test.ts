import assert from "node:assert/strict";
import test from "node:test";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import {
  MAX_HEADLESS_PRESENTATION_BYTES,
  createHeadlessReviewPresentation,
} from "../.pi/extensions/review/core/headless-presentation.ts";
import { assessDiff } from "../.pi/extensions/review/core/heuristics.ts";
import type {
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewRecord,
  ReviewStore,
} from "../.pi/extensions/review/core/types.ts";
import { presentHeadlessReview } from "../.pi/extensions/review/headless.ts";
import { pickReviewRecord } from "../.pi/extensions/review/ui/target-picker.ts";

const root = "/repo";
const target = { kind: "branch", base: "main" } as const;
const config = {
  editor: { command: ["zed"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 1, maxDiffLines: 1 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
} satisfies ResolvedReviewConfig;

function createStore(): ReviewStore {
  return {
    load: async () => undefined,
    save: async () => undefined,
    list: async () => [],
  };
}

function pickerRunner(pullRequestFailure?: string): ExecRunner {
  return async (command, args) => {
    if (command === "git" && args.includes("--show-toplevel")) {
      return { stdout: `${root}\n`, stderr: "", code: 0 };
    }
    if (command === "git" && args.includes("for-each-ref")) {
      return { stdout: "main\n", stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return pullRequestFailure
        ? { stdout: "", stderr: pullRequestFailure, code: 1 }
        : { stdout: "[]", stderr: "", code: 0 };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

function patchModel(): DiffModel {
  return parseGitDiff(
    [
      "diff --git a/added.ts b/added.ts",
      "--- /dev/null",
      "+++ b/added.ts",
      "@@ -0,0 +1,2 @@",
      "+first added line",
      "+second added line",
      "diff --git a/deleted.ts b/deleted.ts",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -9,2 +9,0 @@",
      "-first deleted line",
      "-second deleted line",
      "",
    ].join("\n"),
    "base",
    "head",
  );
}

test("cancelled headless target selection notifies without reading a diff", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  let diffReads = 0;

  // Hosts bound elicitation; the presenter intentionally adds no picker timeout.
  await presentHeadlessReview({
    request: { action: "pick" },
    cwd: root,
    sessionId: "session",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      select: async () => undefined,
    },
    dependencies: {
      store: createStore(),
      runner: pickerRunner(),
      loadConfig: async () => config,
      checkpointProvider: { listTurns: async () => [] },
      readTargetDiff: async () => {
        diffReads += 1;
        return patchModel();
      },
      isCurrent: () => true,
    },
  });

  assert.equal(diffReads, 0);
  assert.deepEqual(notifications, [
    { message: "Review target selection was cancelled.", type: "info" },
  ]);
});

test("pull request listing warning survives cancelled headless selection", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  let diffReads = 0;

  await presentHeadlessReview({
    request: { action: "pick" },
    cwd: root,
    sessionId: "session",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      select: async () => undefined,
    },
    dependencies: {
      store: createStore(),
      runner: pickerRunner("gh unavailable"),
      loadConfig: async () => config,
      checkpointProvider: { listTurns: async () => [] },
      readTargetDiff: async () => {
        diffReads += 1;
        return patchModel();
      },
      isCurrent: () => true,
    },
  });

  assert.equal(diffReads, 0);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(
    notifications[0]?.message ?? "",
    /Pull request targets are unavailable:.*gh unavailable/,
  );
  assert.deepEqual(notifications[1], {
    message: "Review target selection was cancelled.",
    type: "info",
  });
});

test("branch headless output is one-based, per-file, limited, and display-only", async () => {
  const model = patchModel();
  const notifications: Array<{ message: string; type?: string }> = [];
  const forbiddenCalls: string[] = [];
  let saves = 0;
  const poison = (name: string): never => {
    forbiddenCalls.push(name);
    throw new Error(`Headless review called forbidden model-context channel: ${name}`);
  };
  const ui = {
    notify: (message: string, type?: "info" | "warning" | "error") =>
      notifications.push({ message, type }),
    select: async () => undefined,
    appendEntry: () => poison("appendEntry"),
    prompt: async () => poison("prompt"),
    sendMessage: () => poison("sendMessage"),
    setEditorText: () => poison("setEditorText"),
  };

  await presentHeadlessReview({
    request: { action: "review", target },
    cwd: root,
    sessionId: "session",
    ui,
    dependencies: {
      store: {
        load: async () => undefined,
        save: async () => {
          saves += 1;
        },
        list: async () => [],
      },
      runner: async () => ({ stdout: `${root}\n`, stderr: "", code: 0 }),
      loadConfig: async () => config,
      checkpointProvider: {
        listTurns: async () => [],
        appendReviewState: () => poison("appendReviewState"),
      },
      readTargetDiff: async () => model,
      isCurrent: () => true,
    },
  });

  assert.equal(saves, 0);
  assert.deepEqual(forbiddenCalls, []);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "info");
  const output = notifications[0]?.message ?? "";
  assert.match(output, /- added\.ts:1/);
  assert.match(output, /- deleted\.ts:9/);
  assert.match(output, /--- added\.ts \(old\)/);
  assert.match(output, /\+\+\+ added\.ts \(new\)[\s\S]*first added line/);
  assert.match(output, /--- deleted\.ts \(old\)[\s\S]*first deleted line/);
  assert.match(output, /\+\+\+ deleted\.ts \(new\)/);
  assert.match(output, /This headless review is read-only/);
  assert.match(
    output,
    /Comment editing, approve\/reject decisions, and pull-request submission remain TUI-only/,
  );
});

test("many large files stay within the total presentation bound and flag truncation", () => {
  const body = "x".repeat(16 * 1024);
  const raw = Array.from({ length: 50 }, (_, index) =>
    [
      `diff --git a/file-${index}.ts b/file-${index}.ts`,
      `--- a/file-${index}.ts`,
      `+++ b/file-${index}.ts`,
      "@@ -1 +1 @@",
      `-${body}`,
      `+${body}y`,
    ].join("\n"),
  ).join("\n");
  const model = parseGitDiff(`${raw}\n`, "base", "head");
  const presentation = createHeadlessReviewPresentation({
    target,
    model,
    assessments: assessDiff(model, config),
    savedReviews: [],
  });

  assert.equal(presentation.truncated, true);
  assert.ok(presentation.diffUnits.length < model.files.length);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(presentation)).byteLength <=
      MAX_HEADLESS_PRESENTATION_BYTES,
  );
});

test("headless output names each file a read limit kept out and the omitted-file count", () => {
  const model: DiffModel = {
    baseSha: "base",
    headSha: "head",
    files: [{ path: "big.txt", kind: "modified", hunks: [], additions: 1, deletions: 0 }],
    notices: [{ path: "big.txt", message: "Not shown: 2 MiB is over the 1 MiB file limit." }],
    omittedFiles: 1,
  };
  const presentation = createHeadlessReviewPresentation({
    target,
    model,
    assessments: assessDiff(model, config),
    savedReviews: [],
  });
  const limits = presentation.limitations.join("\n");
  assert.ok(limits.includes("big.txt: Not shown: 2 MiB is over the 1 MiB file limit."), limits);
  assert.match(limits, /\b1 more changed file\b.*not listed/u);
  const empty: DiffModel = { baseSha: "base", headSha: "head", files: [] };
  const plain = createHeadlessReviewPresentation({
    target,
    model: empty,
    assessments: assessDiff(empty, config),
    savedReviews: [],
  });
  assert.equal(plain.limitations.length, 1, "no limit hit adds nothing");
});

test("targets that end at the working tree are titled with the working tree", () => {
  const titleOf = (reviewed: Parameters<typeof createHeadlessReviewPresentation>[0]["target"]) =>
    createHeadlessReviewPresentation({
      target: reviewed,
      model: patchModel(),
      assessments: assessDiff(patchModel(), config),
      savedReviews: [],
    }).title;
  // Regression: uncommitted changes were titled "HEAD…HEAD".
  assert.equal(
    titleOf({ kind: "branch", base: "HEAD" }),
    "Review: uncommitted changes (HEAD → working tree)",
  );
  assert.equal(titleOf({ kind: "branch", base: "main", target: "topic" }), "Review: main…topic");
});

test("the resume picker and every other target description name the working tree truthfully", async () => {
  const record = (target: ReviewRecord["target"], updatedAt: string): ReviewRecord => ({
    version: 1,
    repoKey: "repo",
    target,
    baseSha: "b",
    headSha: "h",
    cursor: { reviewedHunkIds: [], lastHeadSha: "h" },
    comments: [],
    createdAt: updatedAt,
    updatedAt,
  });
  const records = [
    record({ kind: "branch", base: "HEAD" }, "2026-03-04T00:00:00.000Z"),
    record({ kind: "branch", base: "main" }, "2026-03-03T00:00:00.000Z"),
    record({ kind: "branch", base: "main", target: "topic" }, "2026-03-02T00:00:00.000Z"),
    record({ kind: "pr", number: 42 }, "2026-03-01T00:00:00.000Z"),
  ];
  let shown: string[] = [];
  await pickReviewRecord(
    {
      select: async (_title, options) => {
        shown = options;
        return undefined;
      },
    },
    { load: async () => undefined, save: async () => {}, list: async () => records },
    "repo",
  );
  const labels = shown.map((label) => label.split(" — ")[0]);
  assert.deepEqual(labels, [
    "uncommitted changes (HEAD → working tree)",
    "main → working tree",
    "main…topic",
    "pull request #42",
  ]);
  assert.equal(
    shown.some((label) => label.includes("…HEAD")),
    false,
  );
});
