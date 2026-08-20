import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { relocateAnchor } from "../.pi/extensions/review/core/anchor.ts";
import type {
  ReviewChat,
  ReviewChatContext,
  ReviewChatMessage,
  ReviewChatOptions,
} from "../.pi/extensions/review/core/ask.ts";
import {
  launchEditor,
  resolveEditorCommand,
  type EditorSpawnOptions,
  type SpawnedEditor,
  type SpawnEditor,
} from "../.pi/extensions/review/core/editor-launch.ts";
import { planReviewSubmission } from "../.pi/extensions/review/core/github.ts";
import type { DiffAssessment } from "../.pi/extensions/review/core/heuristics.ts";
import type { PullRequestMetadata } from "../.pi/extensions/review/core/pr.ts";
import type { DiffStyler } from "../.pi/extensions/review/core/render/diff-render.ts";
import type {
  DiffFile,
  DiffHunk,
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewRecord,
  ReviewStore,
} from "../.pi/extensions/review/core/types.ts";
import {
  formatRelativeTime,
  openReviewView,
  REVIEW_CHAT_SPLIT_MIN_WIDTH,
  REVIEW_CHROME_ROWS,
  reviewViewHeights,
  type ReviewViewHost,
} from "../.pi/extensions/review/ui/review-view.ts";
import { type ZentuiLoader } from "../.pi/extensions/review/ui/zentui-frame.ts";
import {
  realBoxZentuiLoader as realZentuiLoader,
  SKIP_WITHOUT_ZENTUI,
  unavailableZentuiLoader,
} from "./zentui-build.ts";
import {
  beginCommentDraft,
  commitCommentDraft,
  createReviewViewState,
  currentCommentPosition,
  currentFile,
  currentHunk,
  discardCommentDraft,
  extendSelection,
  fileFoldReason,
  hunkFoldReason,
  markCurrentHunkReviewed,
  moveFile,
  moveHunk,
  moveLine,
  moveSearchMatch,
  selectedLineIndexes,
  setSearchQuery,
  toggleCurrentFold,
  toggleHunkFold,
  updateCommentDraft,
} from "../.pi/extensions/review/ui/view-state.ts";

const NOW = "2026-03-03T02:00:00.000Z";
// The chat pane renders agent markdown and tool calls through the main
// transcript's own components, which read the global theme.
initTheme("dark", false);
/** Shift+Tab as every terminal without the Kitty protocol sends it. */
const SHIFT_TAB = "\u001b[Z";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
/** Shift+arrow in the modified-CSI form every current terminal sends. */
const SHIFT_UP = "\u001b[1;2A";
const SHIFT_DOWN = "\u001b[1;2B";
const CONFIG: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};

function hunk(
  id: string,
  oldStart: number,
  newStart: number,
  changedText: string,
  kind: "add" | "del" = "add",
): DiffHunk {
  return {
    id,
    header: `@@ -${oldStart},2 +${newStart},2 @@ ${id}`,
    oldStart,
    oldLines: kind === "del" ? 2 : 1,
    newStart,
    newLines: kind === "add" ? 2 : 1,
    lines: [
      { kind: "context", oldLine: oldStart, newLine: newStart, text: `context ${id}` },
      kind === "add"
        ? { kind, newLine: newStart + 1, text: changedText }
        : { kind, oldLine: oldStart + 1, text: changedText },
    ],
  };
}

const LOW_HUNK_1 = hunk("low-1", 1, 1, "needle first");
const LOW_HUNK_2 = hunk("low-2", 20, 20, "ordinary change");
const HIGH_HUNK = hunk("high-1", 5, 5, "NEEDLE second", "del");

const LOW_FILE: DiffFile = {
  path: "src/ordinary.ts",
  kind: "modified",
  hunks: [LOW_HUNK_1, LOW_HUNK_2],
  additions: 2,
  deletions: 0,
};
const HIGH_FILE: DiffFile = {
  path: "src/auth.ts",
  kind: "modified",
  hunks: [HIGH_HUNK],
  additions: 0,
  deletions: 1,
};
const MODEL: DiffModel = {
  baseSha: "base-sha",
  headSha: "head-sha",
  // Deliberately opposite the review order.
  files: [LOW_FILE, HIGH_FILE],
};
const ASSESSMENTS: DiffAssessment = {
  files: [
    { path: LOW_FILE.path, riskScore: 0, reasons: [], collapsed: false },
    {
      path: HIGH_FILE.path,
      riskScore: 45,
      reasons: ["Authentication logic changed"],
      collapsed: true,
      collapseReason: "Seeded file fold",
    },
  ],
  hunks: [
    { hunkId: LOW_HUNK_1.id, collapsed: false },
    { hunkId: LOW_HUNK_2.id, collapsed: true, reason: "Formatting-only hunk" },
    { hunkId: HIGH_HUNK.id, collapsed: false },
  ],
  reviewOrder: [HIGH_FILE.path, LOW_FILE.path],
};

function record(reviewedHunkIds: string[] = []): ReviewRecord {
  return {
    version: 1,
    repoKey: "repo-key",
    target: { kind: "branch", base: "main" },
    baseSha: MODEL.baseSha,
    headSha: MODEL.headSha,
    cursor: { reviewedHunkIds, lastHeadSha: MODEL.headSha },
    comments: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function state(reviewedHunkIds: string[] = []) {
  return createReviewViewState({
    model: MODEL,
    assessments: ASSESSMENTS,
    record: record(reviewedHunkIds),
  });
}

const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const STORE: ReviewStore = {
  load: async () => undefined,
  save: async () => {},
  list: async () => [],
};

type MountedReview = {
  component: Component;
  notifications: string[];
  renders: { count: number };
  savedRecords: ReviewRecord[];
  close(): Promise<void>;
};

async function mountReview(
  options: {
    terminalRows?: number;
    model?: DiffModel;
    assessments?: DiffAssessment;
    record?: ReviewRecord;
    config?: ResolvedReviewConfig;
    createReviewChat?: (options: ReviewChatOptions) => ReviewChat;
    chatModel?: string;
    chatThinkingLevel?: string;
    listChatModels?: () => Promise<string[]>;
    execRunner?: ExecRunner;
    spawnEditor?: SpawnEditor;
    pullRequest?: PullRequestMetadata;
    now?: () => string;
    theme?: Theme;
    styler?: DiffStyler;
    createCommentId?: () => string;
    zentuiLoader?: ZentuiLoader;
    reviewRoot?: string;
  } = {},
): Promise<MountedReview> {
  let component: Component | undefined;
  let resolveResult: ((value: unknown) => void) | undefined;
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolveReady) => {
    ready = resolveReady;
  });
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const notifications: string[] = [];
  const renders = { count: 0 };
  const savedRecords: ReviewRecord[] = [];
  const custom: ReviewViewHost["custom"] = async (factory) => {
    component = await factory(
      {
        terminal: { rows: options.terminalRows ?? 16 },
        requestRender: () => {
          renders.count += 1;
        },
        stop: () => {},
        start: () => {},
      } as never,
      options.theme ?? PLAIN_THEME,
      {} as never,
      (value) => resolveResult?.(value),
    );
    ready();
    return (await resultPromise) as never;
  };
  const host: ReviewViewHost = {
    custom,
    input: async () => undefined,
    notify: (message) => notifications.push(message),
    select: async () => undefined,
    setEditorText: () => {},
  };
  const completion = openReviewView({
    host,
    store: {
      ...STORE,
      save: async (saved) => {
        savedRecords.push(structuredClone(saved));
      },
    },
    styler: options.styler ?? {
      fg: (_color, text) => text,
      inverse: (text) => text,
    },
    model: options.model ?? MODEL,
    assessments: options.assessments ?? ASSESSMENTS,
    record: options.record ?? record(),
    config: options.config ?? CONFIG,
    reviewRoot: options.reviewRoot ?? "/repo",
    now: options.now ?? (() => NOW),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.chatModel ? { chatModel: options.chatModel } : {}),
    ...(options.chatThinkingLevel ? { chatThinkingLevel: options.chatThinkingLevel } : {}),
    ...(options.listChatModels ? { listChatModels: options.listChatModels } : {}),
    createCommentId: options.createCommentId ?? (() => "mounted-comment"),
    ...(options.createReviewChat ? { createReviewChat: options.createReviewChat } : {}),
    ...(options.execRunner ? { execRunner: options.execRunner } : {}),
    ...(options.spawnEditor ? { spawnEditor: options.spawnEditor } : {}),
    ...(options.zentuiLoader ? { zentuiLoader: options.zentuiLoader } : {}),
  });
  await readyPromise;
  assert.ok(component?.handleInput);
  return {
    component,
    notifications,
    renders,
    savedRecords,
    close: async () => {
      component?.handleInput?.("q");
      await completion;
    },
  };
}

class FakeReviewChat implements ReviewChat {
  readonly messages: ReviewChatMessage[] = [];
  readonly asks: Array<{ question: string; context: ReviewChatContext }> = [];
  pending = false;
  disposed = false;
  status: { model?: string; thinkingLevel?: string } = {};
  readonly modelChanges: string[] = [];
  readonly effortChanges: string[] = [];
  private listeners = new Set<() => void>();

  async ask(question: string, context: ReviewChatContext): Promise<void> {
    this.asks.push({ question, context });
    this.messages.push({ role: "user", text: question });
    this.emitUpdate();
  }

  async setModel(query: string): Promise<string> {
    this.modelChanges.push(query);
    this.status = { ...this.status, model: query };
    return query;
  }

  async setThinkingLevel(level: string): Promise<string> {
    this.effortChanges.push(level);
    this.status = { ...this.status, thinkingLevel: level };
    return level;
  }

  reloads = 0;
  async reload(): Promise<void> {
    this.reloads += 1;
  }

  prepared: string[] = [];
  availableCommands: Array<{ name: string; description?: string }> = [];
  readonly ranCommands: string[] = [];
  async prepare(reviewRoot: string): Promise<void> {
    this.prepared.push(reviewRoot);
  }

  commands(): Array<{ name: string; description?: string }> {
    return this.availableCommands;
  }

  toolDefinitions: Record<string, unknown> = {};

  toolDefinition(name: string): unknown {
    return this.toolDefinitions[name];
  }

  async runCommand(text: string, _reviewRoot: string): Promise<void> {
    this.ranCommands.push(text);
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitUpdate(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.disposed = true;
  }
}

test("full-screen geometry reserves a header and four distinct bottom rows", () => {
  for (const terminalRows of [2, 5, 7, 12, 24, 40, 80, 160]) {
    const heights = reviewViewHeights(terminalRows);
    assert.equal(heights.reservedRows, Math.min(REVIEW_CHROME_ROWS, terminalRows));
    assert.equal(heights.bodyHeight + heights.reservedRows, terminalRows);
    assert.equal(heights.overlayMaxHeight, "100%");
  }
  assert.equal(REVIEW_CHROME_ROWS, 5);
});

test("pull request relative time uses the injected clock across compact ranges", () => {
  const relative = (elapsedMs: number) =>
    formatRelativeTime(new Date(Date.parse(NOW) - elapsedMs).toISOString(), NOW);
  assert.equal(relative(30_000), "now");
  assert.equal(relative(20 * 60_000), "20m ago");
  assert.equal(relative(3 * 60 * 60_000), "3h ago");
  assert.equal(relative(2 * 24 * 60 * 60_000), "2d ago");
  assert.equal(relative(14 * 24 * 60 * 60_000), "2w ago");
  assert.equal(relative(60 * 24 * 60 * 60_000), "2mo ago");
  assert.equal(relative(2 * 365 * 24 * 60 * 60_000), "2y ago");
  assert.equal(formatRelativeTime(undefined, NOW), undefined);
});

test("pull request header protects its title while right metadata drops by priority", async () => {
  const title = "Preserve the complete pull request title";
  const pullRequest: PullRequestMetadata = {
    number: 42,
    title,
    baseRefName: "main",
    headSha: "a".repeat(40),
    author: { login: "octocat", name: "Octo Cat", isBot: false },
    url: "https://github.com/octo/widget/pull/42",
    updatedAt: "2026-03-02T23:00:00.000Z",
  };
  const mounted = await mountReview({
    terminalRows: 80,
    record: { ...record(), target: { kind: "pr", number: 42 } },
    pullRequest,
  });
  const identity = `#42 ${title}`;
  const focus = "Review [FOCUSED]";
  const base = "base main";
  const author = "@octocat";
  const updated = "3h ago";
  const right = [focus, base, author, updated].join(" · ");
  const widthFor = (...pieces: string[]) => identity.length + 2 + pieces.join(" · ").length;
  const headerAt = (width: number) =>
    stripTerminalSequences(mounted.component.render(width)[0] ?? "");

  const allWidth = widthFor(focus, base, author, updated);
  assert.equal(headerAt(allWidth), `${identity}  ${right}`);
  assert.ok(headerAt(allWidth + 8).endsWith(right), "metadata group remains right-aligned");

  const withoutUpdatedWidth = widthFor(focus, base, author);
  const noTime = headerAt(allWidth - 1);
  assert.ok(noTime.includes(identity));
  assert.ok(noTime.includes(author));
  assert.ok(!noTime.includes(updated));

  const noAuthor = headerAt(withoutUpdatedWidth - 1);
  assert.ok(noAuthor.includes(identity));
  assert.ok(noAuthor.includes(base));
  assert.ok(!noAuthor.includes(author));

  const withoutAuthorWidth = widthFor(focus, base);
  const noBase = headerAt(withoutAuthorWidth - 1);
  assert.ok(noBase.includes(identity));
  assert.ok(!noBase.includes(base));

  const titleAndFocusWidth = widthFor(focus);
  assert.ok(headerAt(titleAndFocusWidth).includes(identity));
  const truncated = headerAt(titleAndFocusWidth - 1);
  assert.match(truncated, /^#42 .*…\s+Review \[FOCUSED\]$/);
  await mounted.close();
});

test("styled header truncation preserves complete ANSI sequences", async () => {
  const pullRequest: PullRequestMetadata = {
    number: 7,
    title: "An ANSI styled title that must be clipped safely",
    baseRefName: "main",
    headSha: "a".repeat(40),
    author: { login: "octocat", name: null, isBot: false },
    url: "https://github.com/octo/widget/pull/7",
    updatedAt: "2026-03-02T23:00:00.000Z",
  };
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as Theme;
  const mounted = await mountReview({
    terminalRows: 80,
    record: { ...record(), target: { kind: "pr", number: 7 } },
    pullRequest,
    theme: ansiTheme,
  });
  const width = 44;
  const header = mounted.component.render(width)[0] ?? "";
  assert.equal(visibleWidth(header), width);
  assert.equal(header.replace(/\u001b\[[0-9;]*m/g, "").includes("\u001b"), false);
  assert.match(stripTerminalSequences(header), /…\s+Review \[FOCUSED\]$/);
  await mounted.close();
});

test("session and branch targets render specific headers without pull request slots", async () => {
  const session = await mountReview({
    terminalRows: 80,
    record: { ...record(), target: { kind: "session", sessionId: "session-1" } },
  });
  const sessionHeader = stripTerminalSequences(session.component.render(80)[0] ?? "").trimEnd();
  assert.match(sessionHeader, /^Session changes\s+Review \[FOCUSED\]$/);
  assert.doesNotMatch(sessionHeader, /base |@| ago| ·\s*·/);
  await session.close();

  const branch = await mountReview({ terminalRows: 80 });
  const branchHeader = stripTerminalSequences(branch.component.render(80)[0] ?? "").trimEnd();
  assert.match(branchHeader, /^Branch main → working tree\s+Review \[FOCUSED\]$/);
  assert.doesNotMatch(branchHeader, /base |@| ago| ·\s*·/);
  await branch.close();
});

test("hunk and file navigation follows heuristic risk order", () => {
  let review = state();
  assert.equal(currentFile(review)?.path, HIGH_FILE.path);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);

  review = moveHunk(review, 1);
  assert.equal(currentFile(review)?.path, LOW_FILE.path);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
  review = moveHunk(review, 1);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_2.id);
  review = moveHunk(review, -2);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);

  review = moveFile(review, 1);
  assert.equal(currentFile(review)?.path, LOW_FILE.path);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
});

test("line navigation crosses hunk and file boundaries in visible order", () => {
  let review = toggleCurrentFold(state());
  review = toggleHunkFold(review, LOW_HUNK_2.id);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);
  assert.equal(review.lineIndex, 0);

  review = moveLine(review, 1);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);
  assert.equal(review.lineIndex, 1);
  review = moveLine(review, 1);
  assert.equal(currentFile(review)?.path, LOW_FILE.path);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
  assert.equal(review.lineIndex, 0);
  review = moveLine(review, 2);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_2.id);
  assert.equal(review.lineIndex, 0);
  review = moveLine(review, -1);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
  assert.equal(review.lineIndex, 1);
});

test("folded file placeholder round-trips with line movement and expands to its first line", () => {
  let review = state();
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);
  assert.equal(review.lineIndex, undefined);

  review = moveLine(review, 1);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
  assert.equal(review.lineIndex, 0);
  review = moveLine(review, -1);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);
  assert.equal(review.lineIndex, undefined);
  assert.equal(currentCommentPosition(review), undefined);

  review = toggleCurrentFold(review);
  assert.equal(review.lineIndex, 0);
  assert.deepEqual(currentCommentPosition(review), {
    path: HIGH_FILE.path,
    hunkId: HIGH_HUNK.id,
    side: "LEFT",
    line: 5,
  });
});

test("folded hunk placeholder round-trips with line movement and expands to its first line", () => {
  const first = hunk("first-folded", 1, 1, "first");
  const second = hunk("second-open", 10, 10, "second");
  const model: DiffModel = {
    baseSha: MODEL.baseSha,
    headSha: MODEL.headSha,
    files: [
      {
        path: "src/folds.ts",
        kind: "modified",
        hunks: [first, second],
        additions: 2,
        deletions: 0,
      },
    ],
  };
  const assessments: DiffAssessment = {
    files: [{ path: "src/folds.ts", riskScore: 0, reasons: [], collapsed: false }],
    hunks: [
      { hunkId: first.id, collapsed: true, reason: "Seeded fold" },
      { hunkId: second.id, collapsed: false },
    ],
    reviewOrder: ["src/folds.ts"],
  };
  let review = createReviewViewState({ model, assessments, record: record() });
  assert.equal(currentHunk(review)?.id, first.id);
  assert.equal(review.lineIndex, undefined);

  review = moveLine(review, 1);
  assert.equal(currentHunk(review)?.id, second.id);
  assert.equal(review.lineIndex, 0);
  review = moveLine(review, -1);
  assert.equal(currentHunk(review)?.id, first.id);
  assert.equal(review.lineIndex, undefined);

  review = toggleCurrentFold(review);
  assert.equal(review.lineIndex, 0);
  assert.equal(currentCommentPosition(review)?.line, 1);
});

test("file and hunk folds seed from assessments and remain toggleable with reasons", () => {
  let review = state();
  assert.equal(review.fileFolds.has(HIGH_FILE.path), true);
  assert.equal(fileFoldReason(review, HIGH_FILE.path), "Seeded file fold");
  assert.equal(review.hunkFolds.has(LOW_HUNK_2.id), true);
  assert.equal(hunkFoldReason(review, LOW_HUNK_2.id), "Formatting-only hunk");

  review = toggleCurrentFold(review);
  assert.equal(review.fileFolds.has(HIGH_FILE.path), false);
  review = moveHunk(review, 2);
  review = toggleHunkFold(review);
  assert.equal(review.hunkFolds.has(LOW_HUNK_2.id), false);
});

test("search matches only changed lines and moves forward and backward with wraparound", () => {
  let review = setSearchQuery(state(), "needle");
  assert.equal(review.search?.matches.length, 2);
  assert.deepEqual(
    review.search?.matches.map((match) => [match.path, match.side, match.line]),
    [
      [LOW_FILE.path, "RIGHT", 2],
      [HIGH_FILE.path, "LEFT", 6],
    ],
  );
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
  assert.equal(review.fileFolds.has(LOW_FILE.path), false);

  review = moveSearchMatch(review, 1);
  assert.equal(currentHunk(review)?.id, HIGH_HUNK.id);
  assert.equal(review.fileFolds.has(HIGH_FILE.path), false);
  review = moveSearchMatch(review, -1);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_1.id);
});

test("comment cursor resolves context and removed lines on the LEFT side", () => {
  let review = toggleCurrentFold(state());
  assert.deepEqual(currentCommentPosition(review), {
    path: HIGH_FILE.path,
    hunkId: HIGH_HUNK.id,
    side: "LEFT",
    line: 5,
  });
  review = moveLine(review, 1);
  assert.deepEqual(currentCommentPosition(review), {
    path: HIGH_FILE.path,
    hunkId: HIGH_HUNK.id,
    side: "LEFT",
    line: 6,
  });
  review = beginCommentDraft(review);
  review = updateCommentDraft(review, "Explain why this removal is safe.");
  review = commitCommentDraft(review, { id: "left-comment", timestamp: NOW });
  assert.equal(review.record.comments[0]?.side, "LEFT");
  assert.equal(review.record.comments[0]?.line, 6);
  assert.match(review.record.comments[0]?.anchor.snippet ?? "", /NEEDLE second/);
});

test("comment draft attachment produces a valid side-specific anchor", () => {
  let review = moveHunk(state(), 1);
  review = moveLine(review, 1);
  review = beginCommentDraft(review);
  assert.deepEqual(review.commentDraft?.position, {
    path: LOW_FILE.path,
    hunkId: LOW_HUNK_1.id,
    side: "RIGHT",
    line: 2,
  });
  review = updateCommentDraft(review, "Please cover this branch.");
  review = commitCommentDraft(review, { id: "comment-1", timestamp: NOW });

  assert.equal(review.commentDraft, undefined);
  assert.equal(review.record.comments.length, 1);
  const comment = review.record.comments[0]!;
  assert.equal(comment.path, LOW_FILE.path);
  assert.equal(comment.side, "RIGHT");
  assert.equal(comment.line, 2);
  assert.equal(comment.anchor.hunkHash, LOW_HUNK_1.id);
  assert.match(comment.anchor.snippet, /needle first/);
  assert.match(comment.anchor.snippetHash, /^[a-f0-9]{64}$/);
});

/**
 * One hunk holding both sides, so a selection can be pushed at the boundary
 * between removed and added lines in either direction.
 */
function mixedReviewFixture(): {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
} {
  const mixed: DiffHunk = {
    id: "mixed-hunk",
    header: "@@ -10,5 +10,6 @@ function mixed",
    oldStart: 10,
    oldLines: 5,
    newStart: 10,
    newLines: 6,
    lines: [
      { kind: "context", oldLine: 10, newLine: 10, text: "const before = 1;" },
      { kind: "context", oldLine: 11, newLine: 11, text: "const guard = 0;" },
      { kind: "del", oldLine: 12, text: "const removed = 2;" },
      { kind: "add", newLine: 12, text: "const added = 2;" },
      { kind: "add", newLine: 13, text: "const extra = 3;" },
      { kind: "context", oldLine: 13, newLine: 14, text: "const after = 4;" },
      { kind: "context", oldLine: 14, newLine: 15, text: "const tail = 5;" },
    ],
  };
  return {
    model: {
      baseSha: MODEL.baseSha,
      headSha: MODEL.headSha,
      files: [
        {
          path: "src/mixed.ts",
          kind: "modified",
          hunks: [mixed],
          additions: 2,
          deletions: 1,
        },
      ],
    },
    assessments: {
      files: [{ path: "src/mixed.ts", riskScore: 0, reasons: [], collapsed: false }],
      hunks: [{ hunkId: mixed.id, collapsed: false }],
      reviewOrder: ["src/mixed.ts"],
    },
    record: record(),
  };
}

test("Shift+Up and Shift+Down extend one anchor in both directions and plain movement collapses it", () => {
  let review = createReviewViewState(mixedReviewFixture());
  // Anchor on the second added line, which comments on RIGHT line 13.
  review = moveLine(review, 4);
  assert.deepEqual(selectedLineIndexes(review), [4]);
  assert.equal(currentCommentPosition(review)?.line, 13);
  assert.equal(currentCommentPosition(review)?.startLine, undefined);

  review = extendSelection(review, -1);
  assert.deepEqual(selectedLineIndexes(review), [3, 4]);
  assert.deepEqual(currentCommentPosition(review), {
    path: "src/mixed.ts",
    hunkId: "mixed-hunk",
    side: "RIGHT",
    line: 13,
    startLine: 12,
  });

  // Reversing returns to the same anchor rather than starting a new one, so a
  // one-line selection reports no range at all.
  review = extendSelection(review, 1);
  assert.deepEqual(selectedLineIndexes(review), [4]);
  assert.equal(currentCommentPosition(review)?.startLine, undefined);

  review = extendSelection(review, 1);
  review = extendSelection(review, 1);
  assert.deepEqual(selectedLineIndexes(review), [4, 5, 6]);
  assert.deepEqual(currentCommentPosition(review), {
    path: "src/mixed.ts",
    hunkId: "mixed-hunk",
    side: "RIGHT",
    line: 15,
    startLine: 13,
  });

  review = moveLine(review, -1);
  assert.equal(review.selectionAnchor, undefined);
  assert.deepEqual(selectedLineIndexes(review), [5]);
  assert.equal(currentCommentPosition(review)?.startLine, undefined);
});

test("a selection stops at a side boundary and never leaves its hunk, file, or fold", () => {
  let mixed = createReviewViewState(mixedReviewFixture());
  mixed = moveLine(mixed, 1);
  mixed = extendSelection(mixed, 1);
  assert.deepEqual(selectedLineIndexes(mixed), [1, 2]);
  assert.deepEqual(currentCommentPosition(mixed), {
    path: "src/mixed.ts",
    hunkId: "mixed-hunk",
    side: "LEFT",
    line: 12,
    startLine: 11,
  });
  // The next row is an added line, which carries no LEFT number; the cursor
  // itself still crosses that boundary under plain movement.
  assert.equal(extendSelection(mixed, 1), mixed);
  assert.equal(moveLine(mixed, 1).lineIndex, 3);

  // A hunk edge ends the selection even though line movement continues into
  // the next hunk of another file.
  let across = toggleCurrentFold(state());
  across = moveLine(across, 1);
  assert.equal(across.lineIndex, 1);
  assert.equal(extendSelection(across, 1), across);
  assert.equal(currentFile(moveLine(across, 1))?.path, LOW_FILE.path);

  // A folded hunk's placeholder is a movable row but never a selectable one.
  let folded = moveHunk(state(), 1);
  folded = moveLine(folded, 1);
  assert.equal(folded.lineIndex, 1);
  assert.equal(extendSelection(folded, 1), folded);
  const placeholder = moveLine(folded, 1);
  assert.equal(currentHunk(placeholder)?.id, LOW_HUNK_2.id);
  assert.equal(placeholder.lineIndex, undefined);
  assert.deepEqual(selectedLineIndexes(placeholder), []);
  assert.equal(extendSelection(placeholder, 1), placeholder);
});

test("revealing context collapses an open selection instead of shifting its anchor", async () => {
  const mounted = await mountReview({ terminalRows: 50, ...expansionReviewFixture() });
  mounted.component.render(100);
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.(SHIFT_DOWN);
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Target src\/expand\.ts:12-13 RIGHT/,
  );
  // The overlay renumbers displayed rows, so the range is dropped rather than
  // carried onto whichever line the old anchor index now names.
  mounted.component.handleInput?.("+");
  await settleInput();
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Target src\/expand\.ts:12 LEFT/,
  );
  await mounted.close();
});

test("every selected row renders highlighted, not only the ends", async () => {
  const mounted = await mountReview({
    terminalRows: 24,
    ...mixedReviewFixture(),
    styler: { fg: (_color, text) => text, inverse: (text) => `«${text}` },
  });
  mounted.component.render(100);
  for (let step = 0; step < 4; step += 1) mounted.component.handleInput?.("j");
  let highlighted = mounted.component
    .render(100)
    .map(stripTerminalSequences)
    .filter((line) => line.startsWith("«"));
  assert.equal(highlighted.length, 1, "a collapsed cursor highlights exactly one row");

  mounted.component.handleInput?.(SHIFT_DOWN);
  mounted.component.handleInput?.(SHIFT_DOWN);
  const rendered = mounted.component.render(100).map(stripTerminalSequences);
  highlighted = rendered.filter((line) => line.startsWith("«"));
  assert.equal(highlighted.length, 3, "the middle row is highlighted too");
  assert.match(highlighted[0] ?? "", /const extra = 3;/);
  assert.match(highlighted[1] ?? "", /const after = 4;/);
  assert.match(highlighted[2] ?? "", /const tail = 5;/);
  assert.match(rendered.join("\n"), /Target src\/mixed\.ts:13-15 RIGHT/);

  // Split mode pairs a removed line with an added one on the same row, so the
  // three selected lines must still read as three highlighted rows.
  mounted.component.handleInput?.("v");
  const split = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(split.join("\n"), /· split ·/);
  assert.equal(split.filter((line) => line.startsWith("«")).length, 3);
  mounted.component.handleInput?.("v");

  mounted.component.handleInput?.(SHIFT_UP);
  mounted.component.handleInput?.(SHIFT_UP);
  assert.equal(
    mounted.component
      .render(100)
      .map(stripTerminalSequences)
      .filter((line) => line.startsWith("«")).length,
    1,
  );
  await mounted.close();
});

test("a committed comment renders beneath its anchored line with a range label", async () => {
  let nextComment = 0;
  const mounted = await mountReview({
    terminalRows: 40,
    ...mixedReviewFixture(),
    createCommentId: () => `comment-${(nextComment += 1)}`,
    styler: { fg: (_color, text) => text, inverse: (text) => `«${text}` },
  });
  mounted.component.render(100);
  for (let step = 0; step < 4; step += 1) mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Rename this variable.");
  mounted.component.handleInput?.("\r");

  let rendered = mounted.component.render(100).map(stripTerminalSequences);
  const anchorRow = rendered.findIndex((line) => line.includes("const extra = 3;"));
  assert.ok(anchorRow >= 0, "the anchored diff line remains rendered");
  assert.match(rendered[anchorRow + 1] ?? "", /● 13 Rename this variable\./);

  // A range comment carries its whole span in the label.
  mounted.component.handleInput?.(SHIFT_DOWN);
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Both lines together.");
  mounted.component.handleInput?.("\r");
  rendered = mounted.component.render(100).map(stripTerminalSequences);
  const rangeRow = rendered.findIndex((line) => line.includes("const after = 4;"));
  assert.match(rendered[rangeRow + 1] ?? "", /● 13-14 Both lines together\./);
  await mounted.close();
});

test("comment rows shift cursor tracking so the selected line stays visible", async () => {
  const mounted = await mountReview({
    terminalRows: 12,
    ...mixedReviewFixture(),
    styler: { fg: (_color, text) => text, inverse: (text) => `«${text}` },
  });
  mounted.component.render(100);
  for (let step = 0; step < 4; step += 1) mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("A comment inserted above the rows below it.");
  mounted.component.handleInput?.("\r");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("j");
  const rendered = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /«.*const tail = 5;/);
  await mounted.close();
});

test("a folded hunk's placeholder counts the comments it hides", async () => {
  const commented: ReviewRecord = {
    ...record(),
    comments: [
      {
        id: "hidden-1",
        path: LOW_FILE.path,
        side: "RIGHT",
        line: 21,
        body: "Hidden under the fold.",
        anchor: {
          hunkHash: LOW_HUNK_2.id,
          snippetHash: "0".repeat(64),
          snippet: "ordinary change",
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "visible-1",
        path: LOW_FILE.path,
        side: "RIGHT",
        line: 2,
        body: "Visible inline.",
        anchor: { hunkHash: LOW_HUNK_1.id, snippetHash: "1".repeat(64), snippet: "needle first" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
  const mounted = await mountReview({ terminalRows: 40, record: commented });
  mounted.component.render(100);
  mounted.component.handleInput?.("n");
  const rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Formatting-only hunk · 1 comment inside/);
  assert.match(rendered, /● 2 Visible inline\./);
  assert.match(rendered, /needle first\s*\n\s*▎ ● 2 Visible inline\./);
  await mounted.close();
});

test("file list shows counts and risk badges, a rule separates it from the diff, and a re-expanded reviewed hunk keeps its verdict", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  let rendered = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(
    rendered.join("\n"),
    /❯ ▸ src\/auth\.ts {2}\+0 -1 {2}▲45 Authentication logic changed/,
  );
  assert.match(
    rendered.join("\n"),
    / {2}▾ src\/ordinary\.ts {2}\+2 -0 {2}No elevated risk signals/,
  );
  assert.ok(
    rendered.some((line) => /^─+$/.test(line.trimEnd())),
    "a rule separates the file list from the diff",
  );

  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("m");
  mounted.component.handleInput?.(" ");
  rendered = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /@@ -5,2 \+5,2 @@ high-1 ✓ reviewed/);
  await mounted.close();
});

test("a range comment stores startLine and submits start_line and start_side; one line submits neither", async () => {
  let nextComment = 0;
  const mounted = await mountReview({
    terminalRows: 24,
    ...mixedReviewFixture(),
    createCommentId: () => `comment-${(nextComment += 1)}`,
  });
  mounted.component.render(100);
  for (let step = 0; step < 4; step += 1) mounted.component.handleInput?.("j");
  mounted.component.handleInput?.(SHIFT_DOWN);
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Target src\/mixed\.ts:13-14 RIGHT/,
  );
  mounted.component.handleInput?.("c");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Comment attaches to selected lines 13-14 on RIGHT/,
  );
  mounted.component.handleInput?.("These lines belong together.");
  mounted.component.handleInput?.("\r");

  // Plain movement collapses the selection, so the next comment is single-line.
  mounted.component.handleInput?.("k");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("One line only.");
  mounted.component.handleInput?.("\r");
  await mounted.close();

  const saved = mounted.savedRecords.at(-1)!;
  assert.deepEqual(
    saved.comments.map((entry) => [entry.side, entry.startLine, entry.line]),
    [
      ["RIGHT", 13, 14],
      ["RIGHT", undefined, 13],
    ],
  );
  assert.equal(Object.hasOwn(saved.comments[1]!, "startLine"), false);
  assert.match(saved.comments[0]!.anchor.snippet, /const extra = 3;\nconst after = 4;/);

  const plan = planReviewSubmission({
    record: { ...saved, body: "Overall summary." },
    pullRequest: { owner: "octo", repo: "widget", number: 42 },
    event: "COMMENT",
    currentHeadSha: saved.headSha,
  });
  assert.deepEqual(plan.payload.comments, [
    {
      path: "src/mixed.ts",
      body: "These lines belong together.",
      line: 14,
      side: "RIGHT",
      start_line: 13,
      start_side: "RIGHT",
    },
    { path: "src/mixed.ts", body: "One line only.", line: 13, side: "RIGHT" },
  ]);
  assert.equal(Object.hasOwn(plan.payload.comments[1]!, "start_line"), false);
  assert.equal(Object.hasOwn(plan.payload.comments[1]!, "start_side"), false);
});

test("comment draft accumulates text and cancel leaves the record untouched", () => {
  let review = toggleCurrentFold(state());
  const before = structuredClone(review.record);
  review = beginCommentDraft(review);
  review = updateCommentDraft(review, "first");
  review = updateCommentDraft(review, `${review.commentDraft?.body} second`);
  assert.equal(review.commentDraft?.body, "first second");

  review = discardCommentDraft(review);
  assert.equal(review.commentDraft, undefined);
  assert.deepEqual(review.record, before);
});

test("in-view comment editor wraps, accepts newlines, submits, and cancels without a host input", async () => {
  let component: Component | undefined;
  let overlaySettings: unknown;
  let inputCalls = 0;
  const sourceRecord = record();
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const custom: ReviewViewHost["custom"] = async (factory, customOptions) => {
    overlaySettings =
      typeof customOptions?.overlayOptions === "function"
        ? customOptions.overlayOptions()
        : customOptions?.overlayOptions;
    component = await factory(
      {
        terminal: { rows: 12 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      } as never,
      plainTheme,
      {} as never,
      () => {},
    );
    return undefined as never;
  };
  const host: ReviewViewHost = {
    custom,
    input: async () => {
      inputCalls += 1;
      return undefined;
    },
    notify: () => {},
    select: async () => undefined,
    setEditorText: () => {},
  };
  const store: ReviewStore = {
    load: async () => undefined,
    save: async () => {},
    list: async () => [],
  };
  await openReviewView({
    host,
    store,
    styler: {
      fg: (_color, text) => text,
      inverse: (text) => text,
    },
    model: MODEL,
    assessments: ASSESSMENTS,
    record: sourceRecord,
    config: CONFIG,
    reviewRoot: "/repo",
    now: () => NOW,
    createCommentId: () => "unused-comment",
  });
  assert.deepEqual(overlaySettings, { width: "100%", maxHeight: "100%", margin: 0 });
  assert.ok(component?.handleInput);

  component.handleInput(" ");
  component.handleInput("c");
  component.handleInput("draft");
  component.handleInput("\u001b[D");
  component.handleInput("\u007f");
  let rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/auth\.ts:5 LEFT/);
  assert.match(rendered, /drat/);
  assert.match(rendered, /Comment · Enter submit · Shift\+Enter newline · Tab path · Esc cancel/);
  assert.match(rendered, /─{10}/);
  assert.equal(rendered.split("\n").length, 12);

  component.handleInput("\u001b");
  rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.doesNotMatch(rendered, /drat/);
  assert.match(rendered, /0 comments/);

  component.handleInput("c");
  component.handleInput("kept");
  component.handleInput("\u001b\r");
  component.handleInput("second line");
  rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /kept/);
  assert.match(rendered, /second line/);
  assert.match(rendered, /0 comments/);
  component.handleInput("\r");
  rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /1 comments/);
  assert.equal(inputCalls, 0);
  assert.deepEqual(sourceRecord, record());
});

test("commenting on a fold placeholder is refused", async () => {
  const mounted = await mountReview();
  mounted.component.handleInput?.("c");
  assert.deepEqual(mounted.notifications, ["Select an expanded diff line before commenting."]);
  const rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Input inactive/);
  assert.doesNotMatch(rendered, /Comment · Enter submit/);
  await mounted.close();
});

test("chat takes focus, routes typing, sends only bounded review context, and repaints on updates", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("a");

  let rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Chat \[FOCUSED\]/);
  assert.match(rendered, /Agent chat \[FOCUSED\]/);
  assert.match(rendered, /Ask agent · Enter ask · Shift\+Enter newline/);

  mounted.component.handleInput?.("j");
  rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /\bj\b/);
  assert.match(rendered, /Target src\/auth\.ts:5 LEFT/);

  // Tab belongs to the chat's editor, so Shift+Tab is what returns to the diff.
  mounted.component.handleInput?.(SHIFT_TAB);
  mounted.component.handleInput?.("j");
  rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Review \[FOCUSED\]/);
  assert.match(rendered, /Target src\/auth\.ts:6 LEFT/);
  mounted.component.handleInput?.("\t");
  mounted.component.handleInput?.("\u001b\r");
  mounted.component.handleInput?.("why?");
  rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /why\?/);
  mounted.component.handleInput?.("\r");
  assert.equal(fakeChat.asks.length, 1);
  assert.equal(fakeChat.asks[0]?.question, "j\nwhy?");
  assert.deepEqual(Object.keys(fakeChat.asks[0]!.context).sort(), [
    "focusedLineText",
    "hunkHeader",
    "line",
    "path",
    "reviewRoot",
    "side",
  ]);
  assert.deepEqual(
    {
      path: fakeChat.asks[0]?.context.path,
      side: fakeChat.asks[0]?.context.side,
      line: fakeChat.asks[0]?.context.line,
      reviewRoot: fakeChat.asks[0]?.context.reviewRoot,
    },
    { path: HIGH_FILE.path, side: "LEFT", line: 6, reviewRoot: "/repo" },
  );
  assert.match(fakeChat.asks[0]!.context.hunkHeader, /@@ -5,2 \+5,2 @@ high-1/);
  assert.equal(fakeChat.asks[0]!.context.focusedLineText, "NEEDLE second");

  const beforeUpdate = mounted.renders.count;
  fakeChat.emitUpdate();
  assert.equal(mounted.renders.count, beforeUpdate + 1);
  mounted.component.handleInput?.("discard me");
  mounted.component.handleInput?.("\u001b");
  rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Review \[FOCUSED\]/);
  assert.doesNotMatch(rendered, /discard me/);
  assert.equal(fakeChat.asks.length, 1);
  await mounted.close();
  assert.equal(fakeChat.disposed, true);
});

test("the side chat session inherits the caller's chat model", async () => {
  let received: ReviewChatOptions | undefined;
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({
    terminalRows: 24,
    chatModel: "anthropic/claude-fable-5",
    chatThinkingLevel: "high",
    createReviewChat: (chatOptions) => {
      received = chatOptions;
      return fakeChat;
    },
  });
  mounted.component.handleInput?.("a");
  assert.equal(received?.model, "anthropic/claude-fable-5");
  assert.equal(received?.thinkingLevel, "high");
  assert.equal(received?.cwd, "/repo");
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("/quit and /exit leave the review from the chat, saving the record", async () => {
  for (const command of ["/quit", "/exit"]) {
    const fakeChat = new FakeReviewChat();
    const mounted = await mountReview({ terminalRows: 24, createReviewChat: () => fakeChat });
    mounted.component.handleInput?.("a");
    mounted.component.handleInput?.(command);
    mounted.component.handleInput?.("\r");
    await settleInput();
    assert.equal(mounted.savedRecords.length, 1, `${command} saves and closes`);
    await mounted.close();
  }
});

test("page keys scroll the chat pane and the heading counts the rows below", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 16, createReviewChat: () => fakeChat });
  mounted.component.handleInput?.("a");
  for (let index = 1; index <= 30; index += 1) {
    fakeChat.messages.push({ role: "assistant", text: `line ${index}` });
  }
  fakeChat.emitUpdate();

  let rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /line 30/, "the pane follows the tail");
  assert.doesNotMatch(rendered, /line 3\b/);

  mounted.component.handleInput?.("\u001b[5~");
  rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.doesNotMatch(rendered, /line 30\b/, "PgUp leaves the tail");
  assert.match(rendered, /Agent chat \[FOCUSED\] · ↓\d+ below/);

  // PgUp clamps at the top instead of running past the transcript.
  for (let page = 0; page < 20; page += 1) mounted.component.handleInput?.("\u001b[5~");
  rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /line 1\b/, "the first row is reachable");

  for (let page = 0; page < 25; page += 1) mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /line 30/, "PgDn returns to the tail");
  assert.doesNotMatch(rendered, /↓\d+ below/);

  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("the chat input completes /model and /effort like the main prompt", async () => {
  const fakeChat = new FakeReviewChat();
  fakeChat.availableCommands = [{ name: "review-agent", description: "Adversarial review" }];
  const mounted = await mountReview({
    terminalRows: 24,
    createReviewChat: () => fakeChat,
    listChatModels: async () => ["anthropic/claude-fable-5", "openai/gpt-5.6-sol"],
  });
  mounted.component.handleInput?.("a");
  await settleInput();
  mounted.component.handleInput?.("/");
  await settleCompletion();
  let rendered = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /→ model\s+<provider\/model> — Switch the chat's model/);
  assert.match(rendered, /effort\s+<level> — Switch the chat's thinking level/);

  // Tab accepts the command without executing it, exactly like the main
  // prompt; the argument then completes from the model catalog.
  mounted.component.handleInput?.("\t");
  await settleCompletion();
  mounted.component.handleInput?.("sol");
  await settleCompletion();
  rendered = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /openai\/gpt-5\.6-sol/);
  mounted.component.handleInput?.("\r");
  await settleCompletion();
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.modelChanges, ["openai/gpt-5.6-sol"]);

  // Effort arguments complete from Pi's thinking levels.
  mounted.component.handleInput?.("/effort");
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("x");
  await settleCompletion();
  rendered = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /xhigh/);
  mounted.component.handleInput?.("\r");
  await settleCompletion();
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.effortChanges, ["xhigh"]);

  // The session's own commands join the menu and filter like any other.
  mounted.component.handleInput?.("/rev");
  await settleCompletion();
  rendered = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /review-agent\s+Adversarial review/, "session commands join the menu");
  mounted.component.handleInput?.("\u001b");

  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("without zentui the keys row carries model and effort, and /model and /effort switch them", async () => {
  const fakeChat = new FakeReviewChat();
  fakeChat.status = { model: "anthropic/claude-fable-5", thinkingLevel: "high" };
  const mounted = await mountReview({
    terminalRows: 24,
    createReviewChat: () => fakeChat,
    // zentui's frame names them under the input; the plain editor cannot,
    // so the keys row is where they survive.
    zentuiLoader: unavailableZentuiLoader,
  });
  // No diff line is selected on purpose: commands must not need context.
  mounted.component.handleInput?.("a");
  let rendered = mounted.component.render(140).map(stripTerminalSequences);
  const inputRow = rendered.findIndex((line) => /Input inactive|╭|^─{4,}/.test(line.trim()));
  assert.match(
    rendered.find((line) => /claude-fable-5 · high\s*$/.test(line)) ?? "",
    /Ask agent .* claude-fable-5 · high\s*$/,
    "the status is right-aligned on the key row under the input",
  );
  assert.ok(inputRow >= 0, "the input area is rendered");
  assert.doesNotMatch(
    rendered.join("\n"),
    /Agent chat \[FOCUSED\] · claude/,
    "the heading no longer carries the status",
  );

  mounted.component.handleInput?.("/model claude-sonnet-5");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.modelChanges, ["claude-sonnet-5"]);
  assert.ok(
    mounted.notifications.some((note) => note.includes("Chat model set to claude-sonnet-5")),
  );

  mounted.component.handleInput?.("/effort low");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.effortChanges, ["low"]);
  assert.ok(mounted.notifications.some((note) => note.includes("Chat effort set to low")));

  rendered = mounted.component.render(140).map(stripTerminalSequences);
  assert.match(
    rendered.find((line) => /claude-sonnet-5 · low\s*$/.test(line)) ?? "",
    /claude-sonnet-5 · low\s*$/,
    "a switch is reflected under the input",
  );

  // /reload reloads the chat session's resources; the transcript survives.
  fakeChat.messages.push({ role: "user", text: "earlier question" });
  mounted.component.handleInput?.("/reload");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.equal(fakeChat.reloads, 1);
  assert.equal(fakeChat.messages.length, 1, "the transcript is kept");
  assert.ok(mounted.notifications.some((note) => note.includes("Chat session resources reloaded")));

  // A command the chat session registers routes through its prompt path;
  // an unknown command warns and puts the text back for correction.
  fakeChat.availableCommands = [{ name: "review-agent", description: "Adversarial review" }];
  mounted.component.handleInput?.("/review-agent HEAD");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.ranCommands, ["/review-agent HEAD"]);
  mounted.component.handleInput?.("/frobnicate now");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.ok(
    mounted.notifications.some((note) =>
      note.includes("/frobnicate is not available in the review chat"),
    ),
  );
  assert.deepEqual(
    fakeChat.ranCommands,
    ["/review-agent HEAD"],
    "unknown commands never reach the session",
  );
  assert.ok(
    !mounted.notifications.some((note) => note.includes("Select an expanded diff line")),
    "commands run without a selected diff line",
  );
  assert.equal(fakeChat.asks.length, 0, "commands are not sent as questions");

  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("agent replies render as markdown and tool calls render like the main transcript", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 40, createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("a");
  fakeChat.messages.push(
    {
      role: "assistant",
      text: "### Verdict\n\nThe guard is **safe** because `parse` rejects flags.",
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "src/auth.ts" },
      result: { content: [{ type: "text", text: "const token = read();" }] },
      isError: false,
      done: true,
    },
    { role: "assistant", text: "- first point\n- second point" },
  );
  fakeChat.emitUpdate();

  let rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  // Markdown goes through the main transcript's renderer: emphasis and
  // inline-code markers are consumed, not shown.
  assert.match(rendered, /### Verdict/);
  assert.match(rendered, /The guard is safe because parse rejects flags\./);
  assert.doesNotMatch(rendered, /\*\*safe\*\*/);
  assert.doesNotMatch(rendered, /`parse`/);
  assert.match(rendered, /- first point/);
  // The tool call renders through ToolExecutionComponent, exactly as the
  // main agent's transcript titles it.
  assert.match(rendered, /read src\/auth\.ts/);
  // Collapsed by default like the main transcript: the result body is hidden
  // until Ctrl+O expands it, and a second Ctrl+O collapses it again.
  assert.doesNotMatch(rendered, /const token = read\(\);/);
  mounted.component.handleInput?.("\u000f");
  rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /const token = read\(\);/);
  mounted.component.handleInput?.("\u000f");
  rendered = mounted.component.render(200).map(stripTerminalSequences).join("\n");
  assert.doesNotMatch(rendered, /const token = read\(\);/);
  // `q` would be typed into the focused chat input; leave the chat first.
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("a collapsed tool preview truncates long lines to the pane instead of flooding it", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 40, createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("a");
  const longLine = `match start ${"x".repeat(300)}ENDMARK`;
  fakeChat.messages.push({
    role: "tool",
    toolCallId: "call-long",
    toolName: "grep",
    args: { pattern: "match", path: "." },
    result: { content: [{ type: "text", text: `src/a.ts:1:${longLine}\nsrc/b.ts:2:short match` }] },
    isError: false,
    done: true,
  });
  fakeChat.emitUpdate();

  // Wrapping can split the marker across rows, so search a squashed form.
  const squash = (lines: string[]) => lines.join("").replace(/[\s│]+/g, "");
  // Collapsed to the maximum: only the one-line call title renders; the
  // preview and its long lines stay behind Ctrl+O.
  let rendered = mounted.component.render(200).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /grep \/match\/ in \./);
  assert.doesNotMatch(rendered.join("\n"), /match start x/);
  assert.ok(!squash(rendered).includes("ENDMARK"), "the long line's tail is cut away");
  assert.equal(
    rendered.filter((line) => line.includes("xxxx")).length,
    0,
    "no preview rows at all",
  );

  // Expanded: the component wraps at the pane width and the tail is visible.
  mounted.component.handleInput?.("\u000f");
  rendered = mounted.component.render(200).map(stripTerminalSequences);
  assert.ok(squash(rendered).includes("ENDMARK"), "expanded shows the full line");
  assert.ok(
    rendered.filter((line) => line.includes("xxxx")).length > 1,
    "expanded wraps the full line",
  );

  mounted.component.handleInput?.("\u000f");
  // A failed tool keeps its message visible even collapsed.
  fakeChat.messages.push({
    role: "tool",
    toolCallId: "call-error",
    toolName: "grep",
    args: { pattern: "broken", path: "." },
    result: { content: [{ type: "text", text: "boom failure" }] },
    isError: true,
    done: true,
  });
  fakeChat.emitUpdate();
  rendered = mounted.component.render(200).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /boom failure/);

  // A session-registered tool renders through its own renderer, exactly as
  // the main transcript does with session.getToolDefinition.
  fakeChat.toolDefinitions["custom_probe"] = {
    renderCall: () => ({ render: () => ["custom probe title"] }),
  };
  fakeChat.messages.push({
    role: "tool",
    toolCallId: "call-custom",
    toolName: "custom_probe",
    args: { anything: "x".repeat(200) },
    result: { content: [{ type: "text", text: "detailed output that should stay hidden" }] },
    isError: false,
    done: true,
  });
  fakeChat.emitUpdate();
  rendered = mounted.component.render(200).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /custom probe title/);
  assert.doesNotMatch(rendered.join("\n"), /detailed output that should stay hidden/);
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("chat splits at 120 columns and replaces the diff below that width", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("a");

  assert.equal(REVIEW_CHAT_SPLIT_MIN_WIDTH, 120);
  let rendered = mounted.component
    .render(REVIEW_CHAT_SPLIT_MIN_WIDTH)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(rendered, /Agent chat \[FOCUSED\]/);
  assert.match(rendered, /@@ -5,2 \+5,2 @@ high-1/);

  rendered = mounted.component
    .render(REVIEW_CHAT_SPLIT_MIN_WIDTH - 1)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(rendered, /Agent chat \[FOCUSED\]/);
  assert.doesNotMatch(rendered, /@@ -5,2 \+5,2 @@ high-1/);

  mounted.component.handleInput?.(SHIFT_TAB);
  rendered = mounted.component
    .render(REVIEW_CHAT_SPLIT_MIN_WIDTH - 1)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(rendered, /@@ -5,2 \+5,2 @@ high-1/);
  assert.doesNotMatch(rendered, /Agent chat/);
  await mounted.close();
});

/** Rows the view devotes to the diff body: everything above the status row. */
function bodyRowCount(lines: string[]): number {
  const status = lines.findIndex((line) => /\d+\/\d+ files/.test(line));
  assert.notEqual(status, -1, "status row is rendered");
  return status - 1;
}

test("the framed input names the chat's model instead of repeating it in the keys row", async () => {
  const frames: { modelLabel?: string; thinkingLevel?: string }[] = [];
  const loader: ZentuiLoader = async () => ({
    renderMinimalistFrame: (frame) => {
      frames.push({
        ...(frame.metadata.modelLabel === undefined
          ? {}
          : { modelLabel: frame.metadata.modelLabel }),
        ...(frame.metadata.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: frame.metadata.thinkingLevel }),
      });
      return ["┌ framed ┐"];
    },
    loadConfig: () => ({ components: { editor: { style: "minimalist" } } }),
  });
  const fakeChat = new FakeReviewChat();
  fakeChat.status = { model: "anthropic/claude-fable-5", thinkingLevel: "high" };
  const mounted = await mountReview({
    terminalRows: 24,
    createReviewChat: () => fakeChat,
    zentuiLoader: loader,
  });

  mounted.component.handleInput?.("a");
  const rendered = mounted.component.render(140).map(stripTerminalSequences);

  assert.deepEqual(
    frames.at(-1),
    { modelLabel: "claude-fable-5", thinkingLevel: "high" },
    "the frame is told the model without its provider prefix, and the effort",
  );
  assert.doesNotMatch(
    rendered.join("\n"),
    /claude-fable-5 · high/,
    "the keys row does not repeat what the input already names",
  );
});

test(
  "the framed comment input fits the reserved rows at every width",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const framed = await mountReview({ terminalRows: 16, zentuiLoader: realZentuiLoader });
    const unframed = await mountReview({ terminalRows: 16, zentuiLoader: unavailableZentuiLoader });
    for (const mounted of [framed, unframed]) {
      mounted.component.handleInput?.(" ");
      mounted.component.handleInput?.("c");
      mounted.component.handleInput?.("draft");
    }

    for (const width of [40, 80, 120, 200]) {
      const lines = framed.component.render(width).map(stripTerminalSequences);
      const plain = unframed.component.render(width).map(stripTerminalSequences);
      const label = `width ${width}`;

      assert.equal(lines.length, 16, `${label} fills the terminal`);
      assert.equal(plain.length, 16, `${label} fills the terminal unframed`);
      for (const line of lines) assert.equal(visibleWidth(line), width, `${label} row width`);
      assert.equal(bodyRowCount(lines), bodyRowCount(plain), `${label} keeps the diff's rows`);

      const top = lines.findIndex((line) => line.startsWith("╭"));
      assert.notEqual(top, -1, `${label} draws the zentui frame`);
      assert.match(lines[top]!, /^╭─+╮$/, `${label} top border carries no metadata`);
      assert.match(lines[top + 1]!, /^│ draft/, `${label} input sits inside the frame`);
      assert.match(lines[top + 2]!, /^╰─.*╯$/, `${label} bottom border closes the frame`);
      assert.equal(top + 3, lines.length - 2, `${label} leaves both keymap rows`);
      // Narrow terminals truncate the hints, but both rows survive the frame.
      assert.match(lines.at(-2)!, /^Comment · Enter submit/, `${label} first keymap row`);
      assert.match(lines.at(-1)!, /^Comment attaches only/, `${label} second keymap row`);
      if (width >= 80) {
        assert.match(
          lines.at(-2)!,
          /Comment · Enter submit · Shift\+Enter newline · Tab path · Esc cancel/,
        );
        assert.match(lines.at(-1)!, /Comment attaches only to the selected visible line/);
      }
      // The frame replaces pi-tui's rule rows, so the diff ends on the same row.
      // The body's own file-list separator is also a full rule, so the
      // editor's rule is the first one below the status row.
      const status = plain.findIndex((line) => /\d+\/\d+ files/.test(line));
      const editorRule = plain.findIndex((line, index) => index > status && /^─{4,}$/.test(line));
      assert.equal(top, editorRule, `${label} row offset`);
    }

    assert.match(framed.component.render(80).map(stripTerminalSequences).at(-3)!, /repo ─╯$/);
    // The helper quits with `q`, which an open draft would swallow as text.
    for (const mounted of [framed, unframed]) mounted.component.handleInput?.("\u001b");
    await framed.close();
    await unframed.close();
  },
);

test(
  "framed comment and chat inputs keep typing, Enter, Shift+Enter, and Esc",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const fakeChat = new FakeReviewChat();
    const mounted = await mountReview({
      terminalRows: 20,
      zentuiLoader: realZentuiLoader,
      createReviewChat: () => fakeChat,
    });
    const read = (width = 100) => mounted.component.render(width).map(stripTerminalSequences);
    const framedRows = (lines: string[]) => {
      const top = lines.findIndex((line) => line.startsWith("╭"));
      assert.notEqual(top, -1, "the zentui frame is drawn");
      return lines.slice(top, lines.findIndex((line) => line.startsWith("╰")) + 1);
    };

    mounted.component.handleInput?.(" ");
    mounted.component.handleInput?.("c");
    mounted.component.handleInput?.("kept");
    mounted.component.handleInput?.("\u001b\r");
    mounted.component.handleInput?.("second line");
    let rows = framedRows(read());
    assert.equal(rows.length, 4, "two text rows inside the frame");
    assert.match(rows[1]!, /^│ kept/);
    assert.match(rows[2]!, /^│ second line/);
    assert.match(read().join("\n"), /0 comments/);

    mounted.component.handleInput?.("\u001b");
    assert.doesNotMatch(read().join("\n"), /kept/);
    assert.match(read().join("\n"), /Input inactive/);

    mounted.component.handleInput?.("c");
    mounted.component.handleInput?.("framed comment");
    assert.match(framedRows(read())[1]!, /^│ framed comment/);
    mounted.component.handleInput?.("\r");
    const afterSubmit = read().join("\n");
    assert.match(afterSubmit, /1 comments/);
    assert.match(afterSubmit, /Input inactive/, "submitting closes the framed editor");
    assert.match(
      afterSubmit,
      /● 5 framed comment/,
      "the comment reappears inline, not in the input",
    );

    mounted.component.handleInput?.("a");
    mounted.component.handleInput?.("why");
    mounted.component.handleInput?.("\u001b\r");
    mounted.component.handleInput?.("this line?");
    rows = framedRows(read(140));
    assert.equal(rows.length, 4);
    assert.match(rows[1]!, /^│ why/);
    assert.match(rows[2]!, /^│ this line\?/);
    assert.match(read(140).at(-2)!, /Ask agent · Enter ask · Shift\+Enter newline/);
    mounted.component.handleInput?.("\r");
    assert.equal(fakeChat.asks.length, 1);
    assert.equal(fakeChat.asks[0]?.question, "why\nthis line?");

    mounted.component.handleInput?.("\u001b");
    assert.match(read(140).join("\n"), /Input inactive/);
    await mounted.close();
  },
);

/** Completion is asynchronous; let pi-tui's request chain finish. */
async function settleCompletion(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in worktree for the review. Nothing in it shares a name with this
 * repository's root, so completing against the process directory would show.
 */
function temporaryReviewRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "review-view-root-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(root, "alpha-helpers.ts"), "export const helper = 1;\n");
  return root;
}

test(
  "the comment input completes the review root's paths, inside the frame and without it",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const reviewRoot = temporaryReviewRoot();
    const framed = await mountReview({
      terminalRows: 24,
      reviewRoot,
      zentuiLoader: realZentuiLoader,
    });
    const unframed = await mountReview({
      terminalRows: 24,
      reviewRoot,
      zentuiLoader: unavailableZentuiLoader,
    });
    for (const mounted of [framed, unframed]) {
      mounted.component.handleInput?.(" ");
      mounted.component.handleInput?.("c");
      mounted.component.handleInput?.("al");
      mounted.component.handleInput?.("\t");
    }
    await settleCompletion();

    const framedLines = framed.component.render(100).map(stripTerminalSequences);
    const top = framedLines.findIndex((line) => line.startsWith("╭"));
    const bottom = framedLines.findIndex((line) => line.startsWith("╰"));
    assert.notEqual(top, -1, "the frame is drawn");
    assert.match(framedLines[top + 1]!, /^│ al/, "the typed prefix stays in the text row");
    assert.match(framedLines[top + 2]!, /^├─+┤$/, "the list is separated from the text");
    assert.match(framedLines[top + 3]!, /^│ → alpha-helpers\.ts +│$/);
    assert.match(framedLines[top + 4]!, /^│ {3}alpha\.ts +│$/);
    assert.equal(bottom, top + 5, "the frame closes below the list");
    for (const line of framedLines) assert.equal(visibleWidth(line), 100);
    assert.equal(framedLines.length, 24, "the list takes its rows from the diff, not the terminal");

    const plain = unframed.component.render(100).map(stripTerminalSequences);
    const rules = plain.reduce<number[]>(
      (found, line, index) => (/^─{4,}$/.test(line) ? [...found, index] : found),
      [],
    );
    const closingRule = rules.at(-1)!;
    assert.match(plain[closingRule + 1]!, /^→ alpha-helpers\.ts/, "no zentui, list still shown");
    assert.match(plain[closingRule + 2]!, /^ {2}alpha\.ts/);
    assert.equal(plain.length, 24);

    for (const mounted of [framed, unframed]) {
      const rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
      // package.json and tests/ live in the process directory, not the review root.
      assert.doesNotMatch(rendered, /package\.json|tsconfig\.json/);
      // Esc dismisses the list first, then cancels the draft; a live draft would
      // swallow the `q` that closes the view.
      mounted.component.handleInput?.("\u001b");
      mounted.component.handleInput?.("\u001b");
      assert.match(
        mounted.component.render(100).map(stripTerminalSequences).join("\n"),
        /Input inactive/,
      );
    }
    await framed.close();
    await unframed.close();
  },
);

test("accepting a completion writes the review root's path into the comment", async () => {
  const mounted = await mountReview({ terminalRows: 24, reviewRoot: temporaryReviewRoot() });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("see alpha.");
  mounted.component.handleInput?.("\t");
  await settleCompletion();
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /see alpha\.ts/,
    "a lone match completes in place",
  );

  mounted.component.handleInput?.("\r");
  await mounted.close();
  assert.equal(mounted.savedRecords.at(-1)?.comments[0]?.body, "see alpha.ts");
});

test("each input recalls its own history and never the other's", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({
    terminalRows: 24,
    createReviewChat: () => fakeChat,
    // History is the subject here, so the input keeps pi-tui's own chrome
    // rather than depending on the reader's zentui configuration.
    zentuiLoader: unavailableZentuiLoader,
  });
  const read = () => mounted.component.render(120).map(stripTerminalSequences).join("\n");
  const COMMENT = "this cast hides a null";
  const QUESTION = "why is this cast safe";
  // The committed comment legitimately renders inline in the diff, so the
  // history assertions must read the input rows alone. They sit between the
  // status row and the two keymap rows the view always closes with.
  const inputRows = (text: string) => {
    const lines = text.split("\n");
    const status = lines.findIndex((line) => /\d+\/\d+ files/.test(line));
    if (status === -1) return "";
    return lines.slice(status + 1, -2).join("\n");
  };

  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.(COMMENT);
  mounted.component.handleInput?.("\r");
  assert.match(read(), /1 comments/);

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.(UP);
  assert.match(inputRows(read()), new RegExp(COMMENT), "the comment box recalls the last comment");
  mounted.component.handleInput?.("\u001b");

  mounted.component.handleInput?.("a");
  mounted.component.handleInput?.(UP);
  let rendered = read();
  assert.match(rendered, /Chat \[FOCUSED\]/);
  assert.doesNotMatch(
    inputRows(rendered),
    new RegExp(COMMENT),
    "comments stay out of the question box",
  );
  mounted.component.handleInput?.(QUESTION);
  mounted.component.handleInput?.("\r");
  assert.equal(fakeChat.asks.at(-1)?.question, QUESTION);

  mounted.component.handleInput?.(UP);
  assert.match(
    inputRows(read()),
    new RegExp(QUESTION),
    "the question box recalls the last question",
  );
  mounted.component.handleInput?.("\u001b");

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.(UP);
  rendered = read();
  assert.match(inputRows(rendered), new RegExp(COMMENT));
  assert.doesNotMatch(rendered, new RegExp(QUESTION), "questions stay out of the comment box");
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("a focused input owns the cursor keys and hands them back when it closes", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 24, createReviewChat: () => fakeChat });
  const read = () => mounted.component.render(120).map(stripTerminalSequences).join("\n");

  mounted.component.handleInput?.(" ");
  assert.match(read(), /Target src\/auth\.ts:5 LEFT/);

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("first");
  mounted.component.handleInput?.("\u001b\r");
  mounted.component.handleInput?.("second");
  for (let press = 0; press < 3; press += 1) mounted.component.handleInput?.(UP);
  let rendered = read();
  assert.match(rendered, /first/);
  assert.match(rendered, /second/);
  assert.match(rendered, /Target src\/auth\.ts:5 LEFT/, "the diff cursor never moved");
  for (let press = 0; press < 3; press += 1) mounted.component.handleInput?.(DOWN);
  assert.match(read(), /Target src\/auth\.ts:5 LEFT/);

  mounted.component.handleInput?.("\u001b");
  mounted.component.handleInput?.(DOWN);
  assert.match(read(), /Target src\/auth\.ts:6 LEFT/, "the review takes the keys back");

  mounted.component.handleInput?.("a");
  mounted.component.handleInput?.("a question");
  for (const key of [UP, DOWN, UP]) mounted.component.handleInput?.(key);
  rendered = read();
  assert.match(rendered, /a question/, "the question survives its own cursor keys");
  assert.match(rendered, /Target src\/auth\.ts:6 LEFT/, "and the diff cursor still has not moved");

  mounted.component.handleInput?.(SHIFT_TAB);
  mounted.component.handleInput?.(UP);
  assert.match(read(), /Target src\/auth\.ts:5 LEFT/, "leaving the input returns the keys");
  await mounted.close();
});

function expansionReviewFixture({
  oldStart = 11,
  fileLines = 40,
}: {
  oldStart?: number;
  fileLines?: number;
} = {}): {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
  execRunner: ExecRunner;
} {
  const expandableHunk: DiffHunk = {
    id: "expandable-hunk",
    header: `@@ -${oldStart},2 +${oldStart},3 @@ expandable`,
    oldStart,
    oldLines: 2,
    newStart: oldStart,
    newLines: 3,
    lines: [
      { kind: "context", oldLine: oldStart, newLine: oldStart, text: `base line ${oldStart}` },
      { kind: "add", newLine: oldStart + 1, text: "inserted line" },
      {
        kind: "context",
        oldLine: oldStart + 1,
        newLine: oldStart + 2,
        text: `base line ${oldStart + 1}`,
      },
    ],
  };
  const model: DiffModel = {
    baseSha: "expand-base",
    headSha: "expand-head",
    files: [
      {
        path: "src/expand.ts",
        kind: "modified",
        hunks: [expandableHunk],
        additions: 1,
        deletions: 0,
      },
    ],
  };
  const expansionRecord: ReviewRecord = {
    ...record(),
    baseSha: model.baseSha,
    headSha: model.headSha,
    cursor: { reviewedHunkIds: [], lastHeadSha: model.headSha },
  };
  return {
    model,
    assessments: {
      files: [{ path: "src/expand.ts", riskScore: 0, reasons: [], collapsed: false }],
      hunks: [{ hunkId: expandableHunk.id, collapsed: false }],
      reviewOrder: ["src/expand.ts"],
    },
    record: expansionRecord,
    execRunner: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(-3), ["cat-file", "blob", "expand-base:src/expand.ts"]);
      return {
        stdout: `${Array.from({ length: fileLines }, (_unused, index) => `base line ${index + 1}`).join("\n")}\n`,
        stderr: "",
        code: 0,
      };
    },
  };
}

async function settleInput(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("+ and - change both hunk edges from an interior line and use the remaining side", async () => {
  const mounted = await mountReview({ terminalRows: 50, ...expansionReviewFixture() });
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("+");
  await settleInput();
  let rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:12 RIGHT/);
  assert.match(rendered, /\bbase line 1\b/);
  assert.match(rendered, /\bbase line 22\b/);

  mounted.component.handleInput?.("+");
  await settleInput();
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:12 RIGHT/);
  assert.match(rendered, /\bbase line 32\b/);

  mounted.component.handleInput?.("+");
  await settleInput();
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /\bbase line 40\b/);
  mounted.component.handleInput?.("+");
  await settleInput();
  assert.equal(mounted.notifications.at(-1), "No more unchanged context to expand.");

  mounted.component.handleInput?.("-");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:12 RIGHT/);
  assert.doesNotMatch(rendered, /\bbase line 1\b/);
  assert.match(rendered, /\bbase line 30\b/);
  assert.doesNotMatch(rendered, /\bbase line 31\b/);
  mounted.component.handleInput?.("-");
  mounted.component.handleInput?.("-");
  mounted.component.handleInput?.("-");
  assert.equal(mounted.notifications.at(-1), "No expanded context to collapse.");
  await mounted.close();
});

test("hunk-wide expansion keeps the 100-line per-edge ceiling", async () => {
  const mounted = await mountReview({
    terminalRows: 20,
    ...expansionReviewFixture({ oldStart: 111, fileLines: 250 }),
  });
  mounted.component.handleInput?.("j");
  for (let step = 0; step < 10; step += 1) {
    mounted.component.handleInput?.("+");
    await settleInput();
  }
  let rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:112 RIGHT/);
  mounted.component.handleInput?.("+");
  await settleInput();
  assert.equal(mounted.notifications.at(-1), "No more unchanged context to expand.");

  for (let page = 0; page < 30; page += 1) mounted.component.handleInput?.("\u001b[5~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:11 LEFT/);
  for (let page = 0; page < 30; page += 1) mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:212 LEFT/);
  await mounted.close();
});

test("revealed rows participate in line and page movement and produce stable comment anchors", async () => {
  const mounted = await mountReview({ terminalRows: 12, ...expansionReviewFixture() });
  mounted.component.handleInput?.("+");
  await settleInput();
  for (let line = 0; line < 9; line += 1) mounted.component.handleInput?.("k");
  let rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:2 LEFT/);

  mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:7 LEFT/);
  assert.match(rendered, /base line 7/);

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Review surrounding setup.");
  mounted.component.handleInput?.("\r");
  await mounted.close();
  const comment = mounted.savedRecords.at(-1)?.comments[0];
  assert.equal(comment?.path, "src/expand.ts");
  assert.equal(comment?.side, "LEFT");
  assert.equal(comment?.line, 7);
  assert.equal(comment?.anchor.hunkHash, "expandable-hunk");
  assert.match(comment?.anchor.snippet ?? "", /base line 7/);
  assert.deepEqual(
    comment
      ? relocateAnchor(
          comment.anchor,
          `${Array.from({ length: 40 }, (_unused, index) => `base line ${index + 1}`).join("\n")}\n`,
        )
      : undefined,
    {
      status: "mapped",
      method: "exact",
      startLine: 5,
      line: 9,
      matchedSnippet: "base line 5\nbase line 6\nbase line 7\nbase line 8\nbase line 9",
    },
  );
});

function longReviewFixture(lineCount = 30): {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
} {
  const longHunk: DiffHunk = {
    id: "long-hunk",
    header: `@@ -1,${lineCount} +1,${lineCount} @@ long-hunk`,
    oldStart: 1,
    oldLines: lineCount,
    newStart: 1,
    newLines: lineCount,
    lines: Array.from({ length: lineCount }, (_unused, index) => ({
      kind: "context" as const,
      oldLine: index + 1,
      newLine: index + 1,
      text: `line-${index + 1}`,
    })),
  };
  const model: DiffModel = {
    baseSha: MODEL.baseSha,
    headSha: MODEL.headSha,
    files: [
      {
        path: "src/long.ts",
        kind: "modified",
        hunks: [longHunk],
        additions: 0,
        deletions: 0,
      },
    ],
  };
  return {
    model,
    assessments: {
      files: [{ path: "src/long.ts", riskScore: 0, reasons: [], collapsed: false }],
      hunks: [{ hunkId: longHunk.id, collapsed: false }],
      reviewOrder: ["src/long.ts"],
    },
    record: record(),
  };
}

test("page keys move the line cursor, keep it rendered, and reach the final diff row", async () => {
  const fixture = longReviewFixture();
  const mounted = await mountReview({ terminalRows: 12, ...fixture });
  let lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.equal(lines.length, 12);
  assert.match(lines.at(-4) ?? "", /1\/1 files/);
  assert.match(lines.at(-3) ?? "", /Input inactive/);
  assert.match(lines.at(-2) ?? "", /PgUp\/PgDn page/);
  assert.match(lines.at(-1) ?? "", /Space fold/);
  assert.match(lines.join("\n"), /Target src\/long\.ts:1 LEFT/);

  mounted.component.handleInput?.("\u001b[6~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:6 LEFT/);
  assert.match(lines.slice(1, 1 + reviewViewHeights(12).bodyHeight).join("\n"), /line-6/);
  mounted.component.handleInput?.("\u001b[5~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:1 LEFT/);

  for (let index = 0; index < 20; index += 1) mounted.component.handleInput?.("\u001b[6~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:30 LEFT/);
  assert.match(lines.slice(1, 1 + reviewViewHeights(12).bodyHeight).join("\n"), /line-30/);
  assert.equal(lines.length, 12);
  await mounted.close();
});

test("page movement counts each folded hunk as one rendered placeholder row", async () => {
  const hunks = Array.from({ length: 12 }, (_unused, index) =>
    hunk(`fold-${index + 1}`, index * 10 + 1, index * 10 + 1, `change-${index + 1}`),
  );
  const model: DiffModel = {
    baseSha: MODEL.baseSha,
    headSha: MODEL.headSha,
    files: [
      {
        path: "src/folded-pages.ts",
        kind: "modified",
        hunks,
        additions: 12,
        deletions: 0,
      },
    ],
  };
  const assessments: DiffAssessment = {
    files: [{ path: "src/folded-pages.ts", riskScore: 0, reasons: [], collapsed: false }],
    hunks: hunks.map((candidate) => ({
      hunkId: candidate.id,
      collapsed: true,
      reason: "Seeded fold",
    })),
    reviewOrder: ["src/folded-pages.ts"],
  };
  const mounted = await mountReview({ terminalRows: 12, model, assessments, record: record() });
  mounted.component.render(100);
  mounted.component.handleInput?.("\u001b[6~");
  let rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /6\/12 hunks/);
  assert.match(rendered, /fold-6/);

  for (let index = 0; index < 3; index += 1) mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /12\/12 hunks/);
  assert.match(rendered, /fold-12/);
  await mounted.close();
});

test("mark reviewed updates the record head and folds the current hunk", () => {
  const review = markCurrentHunkReviewed(state(), "2026-03-03T02:01:00.000Z");
  assert.deepEqual(review.record.cursor.reviewedHunkIds, [HIGH_HUNK.id]);
  assert.equal(review.record.cursor.lastHeadSha, MODEL.headSha);
  assert.equal(review.record.updatedAt, "2026-03-03T02:01:00.000Z");
  assert.equal(review.hunkFolds.has(HIGH_HUNK.id), true);
  assert.equal(hunkFoldReason(review, HIGH_HUNK.id), "Already reviewed in this review");
});

test("resumed review folds reviewed hunks and starts at the first unreviewed hunk in risk order", () => {
  const review = state([HIGH_HUNK.id, LOW_HUNK_1.id]);
  assert.equal(currentFile(review)?.path, LOW_FILE.path);
  assert.equal(currentHunk(review)?.id, LOW_HUNK_2.id);
  assert.equal(review.hunkFolds.has(HIGH_HUNK.id), true);
  assert.equal(review.hunkFolds.has(LOW_HUNK_1.id), true);
  assert.equal(review.hunkFolds.has(LOW_HUNK_2.id), true);
});

class FakeChild extends EventEmitter implements SpawnedEditor {
  unrefCalled = false;

  unref(): void {
    this.unrefCalled = true;
  }
}

test("e opens at the cursor's side-specific line, including revealed context", async () => {
  const launches: string[][] = [];
  const spawn: SpawnEditor = (_command, args) => {
    launches.push([...args]);
    const child = new FakeChild();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const mounted = await mountReview({
    terminalRows: 40,
    ...expansionReviewFixture(),
    config: {
      ...CONFIG,
      editor: { command: ["editor", "{path}:{line}"], mode: "gui" },
    },
    spawnEditor: spawn,
  });

  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("e");
  await settleInput();
  mounted.component.handleInput?.("+");
  await settleInput();
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("j");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Target src\/expand\.ts:13 LEFT/,
  );
  mounted.component.handleInput?.("e");
  await settleInput();

  assert.deepEqual(launches, [["/repo/src/expand.ts:12"], ["/repo/src/expand.ts:13"]]);
  await mounted.close();
});

test("editor command substitutes embedded path, line, column, and directory tokens", () => {
  assert.deepEqual(
    resolveEditorCommand(
      { mode: "gui", command: ["zed", "--wait", "{path}:{line}:{column}", "--cwd={dir}"] },
      { path: "/repo/src/a.ts", line: 17, column: 4, dir: "/repo" },
    ),
    {
      command: "zed",
      args: ["--wait", "/repo/src/a.ts:17:4", "--cwd=/repo"],
    },
  );
});

test("GUI editor launches detached without stopping the TUI", async () => {
  const events: string[] = [];
  const child = new FakeChild();
  const spawn: SpawnEditor = (command, args, options) => {
    events.push(`spawn:${command}:${args.join(",")}:${options.detached}:${options.stdio}`);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await launchEditor(
    { mode: "gui", command: ["zed", "{path}:{line}"] },
    { path: "/repo/a.ts", line: 9, dir: "/repo" },
    {
      stop: () => events.push("stop"),
      start: () => events.push("start"),
      requestRender: () => events.push("render"),
    },
    spawn,
  );
  assert.deepEqual(events, ["spawn:zed:/repo/a.ts:9:true:ignore"]);
  assert.equal(child.unrefCalled, true);
});

test("terminal editor stops before spawn and restores after exit", async () => {
  const events: string[] = [];
  const child = new FakeChild();
  let capturedOptions: EditorSpawnOptions | undefined;
  const spawn: SpawnEditor = (_command, _args, options) => {
    capturedOptions = options;
    events.push("spawn");
    queueMicrotask(() => {
      events.push("close");
      child.emit("close", 0, null);
    });
    return child;
  };
  await launchEditor(
    { mode: "terminal", command: ["nvim", "+{line}", "{path}"] },
    { path: "/repo/a.ts", line: 11, dir: "/repo" },
    {
      stop: () => events.push("stop"),
      start: () => events.push("start"),
      requestRender: (force) => events.push(`render:${String(force)}`),
    },
    spawn,
  );
  assert.deepEqual(events, ["stop", "spawn", "close", "start", "render:true"]);
  assert.deepEqual(capturedOptions, { cwd: "/repo", stdio: "inherit" });
});

test("terminal editor restores the TUI when spawning throws", async () => {
  const events: string[] = [];
  await assert.rejects(
    () =>
      launchEditor(
        { mode: "terminal", command: ["nvim", "{path}"] },
        { path: "/repo/a.ts", line: 1, dir: "/repo" },
        {
          stop: () => events.push("stop"),
          start: () => events.push("start"),
          requestRender: (force) => events.push(`render:${String(force)}`),
        },
        () => {
          events.push("spawn");
          throw new Error("ENOENT");
        },
      ),
    /ENOENT/,
  );
  assert.deepEqual(events, ["stop", "spawn", "start", "render:true"]);
});

test("terminal editor restores the TUI when the child exits unsuccessfully", async () => {
  const events: string[] = [];
  const child = new FakeChild();
  await assert.rejects(
    () =>
      launchEditor(
        { mode: "terminal", command: ["nvim", "{path}"] },
        { path: "/repo/a.ts", line: 1, dir: "/repo" },
        {
          stop: () => events.push("stop"),
          start: () => events.push("start"),
          requestRender: (force) => events.push(`render:${String(force)}`),
        },
        () => {
          events.push("spawn");
          queueMicrotask(() => child.emit("close", 9, null));
          return child;
        },
      ),
    /status 9/,
  );
  assert.deepEqual(events, ["stop", "spawn", "start", "render:true"]);
});

/**
 * The review is a focus-capturing overlay. A host prompt opened from inside it
 * mounts underneath, so it renders invisibly while stealing the keyboard: the
 * review looks frozen and its promise never settles. Every prompt must
 * therefore hide the overlay first and restore it afterwards.
 */
type OverlayLog = { events: string[]; hiddenDuringPrompt: string[] };

async function mountWithOverlayHandle(options: {
  pullRequest?: PullRequestMetadata;
  select?: (title: string, choices: string[]) => Promise<string | undefined>;
  input?: (title: string, prefill: string) => Promise<string | undefined>;
  record?: ReviewRecord;
}): Promise<{ component: Component; log: OverlayLog; completion: Promise<unknown> }> {
  const log: OverlayLog = { events: [], hiddenDuringPrompt: [] };
  let hidden = false;
  let component: Component | undefined;
  let resolveResult: ((value: unknown) => void) | undefined;
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const custom: ReviewViewHost["custom"] = async (factory, customOptions) => {
    component = await factory(
      {
        terminal: { rows: 24 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      } as never,
      PLAIN_THEME,
      {} as never,
      (value) => resolveResult?.(value),
    );
    customOptions?.onHandle?.({
      hide: () => {},
      setHidden: (value: boolean) => {
        hidden = value;
        log.events.push(value ? "hide" : "show");
      },
      isHidden: () => hidden,
      focus: () => {},
      unfocus: () => {},
    } as never);
    ready();
    return (await resultPromise) as never;
  };
  const host: ReviewViewHost = {
    custom,
    input: async (title, prefill) => {
      log.hiddenDuringPrompt.push(`input:${String(hidden)}`);
      return await (options.input?.(title, prefill ?? "") ?? Promise.resolve(undefined));
    },
    notify: () => {},
    select: async (title, choices) => {
      log.hiddenDuringPrompt.push(`select:${String(hidden)}`);
      return await (options.select?.(title, [...choices]) ?? Promise.resolve(undefined));
    },
    setEditorText: () => {},
  };
  const completion = openReviewView({
    host,
    store: STORE,
    styler: { fg: (_color, text) => text, inverse: (text) => text },
    model: MODEL,
    assessments: ASSESSMENTS,
    record: options.record ?? record(),
    config: CONFIG,
    reviewRoot: "/repo",
    now: () => NOW,
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    createCommentId: () => "overlay-comment",
  });
  await readyPromise;
  assert.ok(component?.handleInput);
  return { component: component as Component, log, completion };
}

const OVERLAY_PR: PullRequestMetadata = {
  number: 7,
  title: "Add a thing",
  baseRefName: "main",
  headSha: "head-sha",
  author: { login: "octocat", name: "Octo", isBot: false },
  url: "https://github.com/octo/widget/pull/7",
  updatedAt: NOW,
};

/** The pull request branch of Finish is chosen by the record's own target. */
function pullRequestRecord(): ReviewRecord {
  return { ...record(), target: { kind: "pr", number: OVERLAY_PR.number } };
}

test("Finish hides the review overlay while the pull request prompts are open", async () => {
  const mounted = await mountWithOverlayHandle({
    pullRequest: OVERLAY_PR,
    record: pullRequestRecord(),
    select: async () => "Approve",
    input: async () => "Looks good",
  });
  mounted.component.handleInput?.("S");
  await mounted.completion;
  // Both prompts ran with the overlay hidden, and each restored it afterwards.
  assert.deepEqual(mounted.log.hiddenDuringPrompt, ["select:true", "input:true"]);
  assert.deepEqual(mounted.log.events, ["hide", "show", "hide", "show"]);
});

test("Finish restores the review overlay when the outcome prompt is cancelled", async () => {
  const mounted = await mountWithOverlayHandle({
    pullRequest: OVERLAY_PR,
    record: pullRequestRecord(),
    select: async () => undefined,
  });
  mounted.component.handleInput?.("S");
  // Cancelling leaves the review open, so close it the normal way.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(mounted.log.events, ["hide", "show"]);
  mounted.component.handleInput?.("q");
  await mounted.completion;
});

test("Search hides the review overlay while its prompt is open", async () => {
  const mounted = await mountWithOverlayHandle({
    input: async () => "needle",
  });
  mounted.component.handleInput?.("/");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(mounted.log.hiddenDuringPrompt, ["input:true"]);
  assert.deepEqual(mounted.log.events, ["hide", "show"]);
  mounted.component.handleInput?.("q");
  await mounted.completion;
});
