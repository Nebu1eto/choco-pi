import assert from "node:assert/strict";
import test from "node:test";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";
import {
  MAX_HEADLESS_PRESENTATION_BYTES,
  createHeadlessReviewPresentation,
} from "../.pi/extensions/review/core/headless-presentation.ts";
import { assessDiff } from "../.pi/extensions/review/core/heuristics.ts";
import type {
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewStore,
} from "../.pi/extensions/review/core/types.ts";
import { presentHeadlessReview } from "../.pi/extensions/review/headless.ts";

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
