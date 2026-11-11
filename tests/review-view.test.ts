import { propertiesWhen } from "../.pi/extensions/lib/runtime-values.ts";
import {
  isFunction,
  isNumber,
  isString,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { hunkWithExpandedContext } from "../.pi/extensions/review/core/expand.ts";
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
import type { DiffStyler } from "../.pi/extensions/lib/changes/render/diff-render.ts";
import type {
  DiffFile,
  DiffHunk,
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
} from "../.pi/extensions/review/core/types.ts";
import {
  formatRelativeTime,
  openReviewView,
  REVIEW_CHAT_SPLIT_MIN_WIDTH,
  REVIEW_CHROME_ROWS,
  reviewViewHeights,
  type OpenReviewViewOptions,
  type ReviewViewHost,
} from "../.pi/extensions/review/ui/review-view.ts";
import { type ZentuiLoader } from "../.pi/extensions/review/ui/zentui-frame.ts";
import {
  REVIEW_KEYS,
  REVIEW_ONLY_KEYS,
  SPLIT_TOGGLE_KEY,
} from "../.pi/extensions/review/ui/review-keys.ts";
import {
  COPY_KEY,
  PANE_KEYS,
  type ChangesKeyTable,
} from "../.pi/extensions/lib/changes/view/keys.ts";
import type { FindingsSummary } from "../.pi/extensions/lib/changes/findings.ts";
import {
  realBoxZentuiLoader as realZentuiLoader,
  SKIP_WITHOUT_ZENTUI,
  unavailableZentuiLoader,
} from "./zentui-build.ts";

const NOW = "2026-03-03T02:00:00.000Z";
// The chat pane renders agent markdown and tool calls through the main
// transcript's own components, which read the global theme.
initTheme("dark", false);
/** Shift+Tab as every terminal without the Kitty protocol sends it. */
const SHIFT_TAB = "\u001b[Z";
const ANSI_STYLE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
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

// SAFETY: The fixture supplies every host member exercised by this test.
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
    reload?: () => Promise<DiffModel>;
    loadFindings?: OpenReviewViewOptions["loadFindings"];
    input?: ReviewViewHost["input"];
    copyText?: (text: string) => Promise<void>;
  } = {},
): Promise<MountedReview> {
  let component: Component | undefined;
  let resolveResult: ((value: RuntimeValue) => void) | undefined;
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
      // SAFETY: The fixture supplies every host member exercised by this test.
      {
        terminal: { rows: options.terminalRows ?? 16 },
        requestRender: () => {
          renders.count += 1;
        },
        stop: () => {},
        start: () => {},
      } as never,
      options.theme ?? PLAIN_THEME,
      // SAFETY: The fixture supplies every host member exercised by this test.
      {} as never,
      (value) => resolveResult?.(value),
    );
    ready();
    // SAFETY: The fixture supplies every host member exercised by this test.
    return (await resultPromise) as never;
  };
  const host: ReviewViewHost = {
    custom,
    input: options.input ?? (async () => undefined),
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
    ...propertiesWhen(options.pullRequest, () => ({ pullRequest: options.pullRequest })),
    ...propertiesWhen(options.chatModel, () => ({ chatModel: options.chatModel })),
    ...propertiesWhen(options.chatThinkingLevel, () => ({
      chatThinkingLevel: options.chatThinkingLevel,
    })),
    ...propertiesWhen(options.listChatModels, () => ({ listChatModels: options.listChatModels })),
    createCommentId: options.createCommentId ?? (() => "mounted-comment"),
    ...propertiesWhen(options.createReviewChat, () => ({
      createReviewChat: options.createReviewChat,
    })),
    ...propertiesWhen(options.execRunner, () => ({ execRunner: options.execRunner })),
    ...propertiesWhen(options.spawnEditor, () => ({ spawnEditor: options.spawnEditor })),
    ...propertiesWhen(options.zentuiLoader, () => ({ zentuiLoader: options.zentuiLoader })),
    ...propertiesWhen(options.reload, () => ({ reload: options.reload })),
    ...propertiesWhen(options.loadFindings, () => ({ loadFindings: options.loadFindings })),
    ...propertiesWhen(options.copyText, () => ({ copyText: options.copyText })),
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

type FakeReviewChatStatus = { model?: string; thinkingLevel?: string };

class FakeReviewChat implements ReviewChat {
  readonly messages: ReviewChatMessage[] = [];
  readonly asks: Array<{ question: string; context: ReviewChatContext }> = [];
  pending = false;
  disposed = false;
  status: FakeReviewChatStatus = {};
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

  toolDefinitions: Record<string, RuntimeValue> = {};

  toolDefinition(name: string): RuntimeValue {
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
  // SAFETY: The fixture supplies every host member exercised by this test.
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
  assert.equal(header.replace(ANSI_STYLE, "").includes("\u001b"), false);
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

/**
 * One hunk holding both sides, so a selection can be pushed at the boundary
 * between removed and added lines in either direction.
 */
type ReviewFixture = {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
};

type ExpansionReviewFixture = ReviewFixture & { execRunner: ExecRunner };

function mixedReviewFixture(): ReviewFixture {
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
    // The cursor's unchanged line: old 12, new 13; it is addressed at its new number.
    /Target src\/expand\.ts:13 RIGHT/,
  );
  await mounted.close();
});

/** A row drawn inverted whole, after the one-column selection marker. */
const highlightedRow = (line: string) => line.slice(1).startsWith("«");

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
    .filter(highlightedRow);
  assert.equal(highlighted.length, 1, "a collapsed cursor highlights exactly one row");

  mounted.component.handleInput?.(SHIFT_DOWN);
  mounted.component.handleInput?.(SHIFT_DOWN);
  const rendered = mounted.component.render(100).map(stripTerminalSequences);
  highlighted = rendered.filter(highlightedRow);
  assert.equal(highlighted.length, 3, "the middle row is highlighted too");
  assert.match(highlighted[0] ?? "", /const extra = 3;/);
  assert.match(highlighted[1] ?? "", /const after = 4;/);
  assert.match(highlighted[2] ?? "", /const tail = 5;/);
  assert.match(rendered.join("\n"), /Target src\/mixed\.ts:13-15 RIGHT/);

  // Split mode pairs a removed line with an added one on the same row, so the
  // three selected lines must still read as three highlighted rows. Split moved
  // from v (now reveal, as in the pane) to |.
  mounted.component.handleInput?.("|");
  const split = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(split.join("\n"), /· split ·/);
  assert.equal(split.filter(highlightedRow).length, 3);
  mounted.component.handleInput?.("|");
  assert.match(mounted.component.render(100).map(stripTerminalSequences).join("\n"), /· unified ·/);

  mounted.component.handleInput?.(SHIFT_UP);
  mounted.component.handleInput?.(SHIFT_UP);
  assert.equal(
    mounted.component.render(100).map(stripTerminalSequences).filter(highlightedRow).length,
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
        anchor: buildCommentAnchor(LOW_HUNK_2, "RIGHT", 21),
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "visible-1",
        path: LOW_FILE.path,
        side: "RIGHT",
        line: 2,
        body: "Visible inline.",
        anchor: buildCommentAnchor(LOW_HUNK_1, "RIGHT", 2),
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

test("file rows show counts, risk badges and reasons, a rule ends the header, and a re-expanded reviewed hunk keeps its verdict", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  let rendered = mounted.component.render(100).map(stripTerminalSequences);
  // The pane's row: marker, fold arrow, status letter, path, risk badge and counts at the right;
  // the risk reasons follow on their own line, then why a rule-folded file is collapsed.
  assert.match(
    rendered.join("\n"),
    /❯▸ M src\/auth\.ts +▲45 \+0 -1 *\n {3}Authentication logic changed *\n {3}Hidden: Seeded file fold · ⏎ shows it/,
  );
  assert.match(rendered.join("\n"), /\n ▾ M src\/ordinary\.ts +\+2 -0 *\n/);
  assert.ok(
    rendered.some((line) => /^─+$/.test(line.trimEnd())),
    "a rule separates the header from the files",
  );

  // Space on the collapsed row expands the file; j enters its hunk; m folds it reviewed;
  // Space on the placeholder unfolds it again, keeping the verdict on its header.
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("m");
  rendered = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(
    rendered.join("\n"),
    /… @@ -5,2 \+5,2 @@ high-1 \(Already reviewed in this review\)/,
  );
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
    currentDiff: { ...mixedReviewFixture().model, baseSha: saved.baseSha },
  });
  assert.deepEqual(plan.payload.comments ?? [], [
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
  assert.equal(Object.hasOwn(plan.payload.comments?.[1] ?? {}, "start_line"), false);
  assert.equal(Object.hasOwn(plan.payload.comments?.[1] ?? {}, "start_side"), false);
});

test("comment draft accumulates text and cancel leaves the record untouched", async () => {
  const before = record();
  const mounted = await mountReview({ terminalRows: 30, record: record() });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("first");
  mounted.component.handleInput?.(" second");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /first second/,
  );
  mounted.component.handleInput?.("\u001b");
  const rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.doesNotMatch(rendered, /first second/);
  assert.match(rendered, /Input inactive/);
  await mounted.close();
  assert.deepEqual(mounted.savedRecords[0]?.comments, before.comments);
});

test("in-view comment editor wraps, accepts newlines, submits, and cancels without a host input", async () => {
  let component: Component | undefined;
  let overlaySettings: unknown;
  let inputCalls = 0;
  // The host keeps the view open until it calls done, as Pi does; keys after that are ignored.
  let closeView: ((value: RuntimeValue) => void) | undefined;
  let ready!: () => void;
  const mounted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sourceRecord = record();
  // SAFETY: The fixture supplies every host member exercised by this test.
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const custom: ReviewViewHost["custom"] = async (factory, customOptions) => {
    overlaySettings = isFunction(customOptions?.overlayOptions)
      ? customOptions.overlayOptions()
      : customOptions?.overlayOptions;
    component = await factory(
      // SAFETY: The fixture supplies every host member exercised by this test.
      {
        terminal: { rows: 12 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      } as never,
      plainTheme,
      // SAFETY: The fixture supplies every host member exercised by this test.
      {} as never,
      (value) => closeView?.(value),
    );
    ready();
    // SAFETY: The view resolves with its own result type.
    return (await new Promise<RuntimeValue>((resolve) => {
      closeView = resolve;
    })) as never;
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
  const completion = openReviewView({
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
  await mounted;
  assert.deepEqual(overlaySettings, { width: "100%", maxHeight: "100%", margin: 0 });
  assert.ok(component?.handleInput);

  component.handleInput(" ");
  component.handleInput("j");
  component.handleInput("c");
  component.handleInput("draft");
  component.handleInput("\u001b[D");
  component.handleInput("\u007f");
  let rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/auth\.ts:5 RIGHT/);
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
  component.handleInput("q");
  await completion;
});

test("commenting on a fold placeholder is refused", async () => {
  const mounted = await mountReview();
  mounted.component.handleInput?.("c");
  const rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  // Pi's notifications are drawn behind the full-screen review: the warning is on its message line.
  assert.match(rendered, /Select an expanded diff line before commenting\./);
  assert.deepEqual(mounted.notifications, []);
  assert.match(rendered, /Input inactive/);
  assert.doesNotMatch(rendered, /Comment · Enter submit/);
  await mounted.close();
});

test("a message stays on the review's line until another replaces it, in every layout", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 30, createReviewChat: () => fakeChat });
  const screen = (width: number) =>
    mounted.component.render(width).map(stripTerminalSequences).join("\n");
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("k");
  assert.match(
    screen(100),
    /Select an expanded diff line before commenting\./,
    "keys do not clear it",
  );

  // Below 120 columns the chat replaces the diff and its header: the message moves above the status.
  mounted.component.handleInput?.("a");
  mounted.component.handleInput?.("why?");
  mounted.component.handleInput?.("\r");
  const narrow = screen(100);
  assert.match(narrow, /Agent chat \[FOCUSED\]/);
  assert.match(narrow, /Select an expanded diff line before asking the agent\./);
  assert.match(screen(140), /Select an expanded diff line before asking the agent\./, "split view");
  assert.equal(fakeChat.asks.length, 0);
  assert.deepEqual(mounted.notifications, [], "a warning is not sent behind the review");
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("chat takes focus, routes typing, sends only bounded review context, and repaints on updates", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("a");

  let rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Chat \[FOCUSED\]/);
  assert.match(rendered, /Agent chat \[FOCUSED\]/);
  assert.match(rendered, /Ask agent · Enter ask · Shift\+Enter newline/);

  mounted.component.handleInput?.("j");
  rendered = mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /\bj\b/);
  assert.match(rendered, /Target src\/auth\.ts:5 RIGHT/);

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
  fakeChat.availableCommands = [{ name: "review", description: "Adversarial review" }];
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
  assert.match(rendered, /review\s+Adversarial review/, "session commands join the menu");
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
  const screen = () => mounted.component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(screen(), /Chat model set to claude-sonnet-5/);

  mounted.component.handleInput?.("/effort low");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.effortChanges, ["low"]);
  assert.match(screen(), /Chat effort set to low/);

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
  assert.match(screen(), /Chat session resources reloaded/);

  // A command the chat session registers routes through its prompt path;
  // an unknown command warns and puts the text back for correction.
  fakeChat.availableCommands = [{ name: "review", description: "Adversarial review" }];
  mounted.component.handleInput?.("/review HEAD");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.deepEqual(fakeChat.ranCommands, ["/review HEAD"]);
  mounted.component.handleInput?.("/frobnicate now");
  mounted.component.handleInput?.("\r");
  await settleInput();
  assert.match(screen(), /\/frobnicate is not available in the review chat/);
  assert.deepEqual(
    fakeChat.ranCommands,
    ["/review HEAD"],
    "unknown commands never reach the session",
  );
  assert.doesNotMatch(
    screen(),
    /Select an expanded diff line/,
    "commands run without a selected diff line",
  );
  assert.deepEqual(mounted.notifications, [], "none of these is an error");
  assert.equal(fakeChat.asks.length, 0, "commands are not sent as questions");

  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("agent replies render as markdown and tool calls render like the main transcript", async () => {
  const fakeChat = new FakeReviewChat();
  const mounted = await mountReview({ terminalRows: 40, createReviewChat: () => fakeChat });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
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
  mounted.component.handleInput?.("j");
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

  // Wrapping can split the marker across rows, so search a squashed form of the
  // chat column alone (the text after the column divider; the diff sits left of it).
  const squash = (lines: string[]) =>
    lines
      .map((line) => line.split("│").at(-1) ?? "")
      .join("")
      .replace(/\s+/g, "");
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
  mounted.component.handleInput?.("j");
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
        ...propertiesWhen(!(frame.metadata.modelLabel === undefined), () => ({
          modelLabel: frame.metadata.modelLabel,
        })),
        ...propertiesWhen(!(frame.metadata.thinkingLevel === undefined), () => ({
          thinkingLevel: frame.metadata.thinkingLevel,
        })),
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
      mounted.component.handleInput?.("j");
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
    mounted.component.handleInput?.("j");
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
      mounted.component.handleInput?.("j");
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
  mounted.component.handleInput?.("j");
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
  mounted.component.handleInput?.("j");
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
  mounted.component.handleInput?.("j");
  assert.match(read(), /Target src\/auth\.ts:5 RIGHT/);

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("first");
  mounted.component.handleInput?.("\u001b\r");
  mounted.component.handleInput?.("second");
  for (let press = 0; press < 3; press += 1) mounted.component.handleInput?.(UP);
  let rendered = read();
  assert.match(rendered, /first/);
  assert.match(rendered, /second/);
  assert.match(rendered, /Target src\/auth\.ts:5 RIGHT/, "the diff cursor never moved");
  for (let press = 0; press < 3; press += 1) mounted.component.handleInput?.(DOWN);
  assert.match(read(), /Target src\/auth\.ts:5 RIGHT/);

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
  assert.match(read(), /Target src\/auth\.ts:5 RIGHT/, "leaving the input returns the keys");
  await mounted.close();
});

function expansionReviewFixture({
  oldStart = 11,
  fileLines = 40,
}: {
  oldStart?: number;
  fileLines?: number;
} = {}): ExpansionReviewFixture {
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
  // The shared header takes three rows (totals, keys, rule), so the screen is taller.
  const mounted = await mountReview({ terminalRows: 60, ...expansionReviewFixture() });
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
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /No more unchanged context to expand\./,
  );

  mounted.component.handleInput?.("-");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:12 RIGHT/);
  assert.doesNotMatch(rendered, /\bbase line 1\b/);
  assert.match(rendered, /\bbase line 30\b/);
  assert.doesNotMatch(rendered, /\bbase line 31\b/);
  mounted.component.handleInput?.("-");
  mounted.component.handleInput?.("-");
  mounted.component.handleInput?.("-");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /No expanded context to collapse\./,
  );
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
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /No more unchanged context to expand\./,
  );

  for (let page = 0; page < 30; page += 1) mounted.component.handleInput?.("\u001b[5~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  // Paging up stops at the file row, the first stop; j enters the first revealed line.
  assert.match(rendered, /No line selected/);
  mounted.component.handleInput?.("j");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:11 RIGHT/);
  for (let page = 0; page < 30; page += 1) mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:213 RIGHT/);
  await mounted.close();
});

test("revealed rows participate in line and page movement and produce stable comment anchors", async () => {
  // 14 rows leave a six-row body under the shared header, so a page is five lines, as before.
  const mounted = await mountReview({ terminalRows: 14, ...expansionReviewFixture() });
  mounted.component.handleInput?.("+");
  await settleInput();
  for (let line = 0; line < 9; line += 1) mounted.component.handleInput?.("k");
  let rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:2 RIGHT/);

  mounted.component.handleInput?.("\u001b[6~");
  rendered = mounted.component.render(100).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /Target src\/expand\.ts:7 RIGHT/);
  assert.match(rendered, /base line 7/);

  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Review surrounding setup.");
  mounted.component.handleInput?.("\r");
  await mounted.close();
  const comment = mounted.savedRecords.at(-1)?.comments[0];
  assert.equal(comment?.path, "src/expand.ts");
  assert.equal(comment?.side, "RIGHT", "an unchanged line is addressed at its new number");
  assert.equal(comment?.line, 7);
  assert.equal(comment?.anchor.hunkHash, "expandable-hunk");
  // The anchor quotes the revealed lines around it, as they read in the file.
  assert.equal(
    comment?.anchor.snippet,
    "base line 5\nbase line 6\nbase line 7\nbase line 8\nbase line 9",
  );
});

function longReviewFixture(lineCount = 30): ReviewFixture {
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
  // 14 rows: identity line, the shared header's three, a six-row body, the four-row footer.
  const mounted = await mountReview({ terminalRows: 14, ...fixture });
  let lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.equal(lines.length, 14);
  assert.match(lines.at(-4) ?? "", /1\/1 files/);
  assert.match(lines.at(-3) ?? "", /Input inactive/);
  assert.match(lines.at(-2) ?? "", /PgUp\/PgDn page/);
  assert.match(lines.at(-1) ?? "", /\| split/);
  assert.match(lines.join("\n"), /⏎\/space fold/, "the shared keys line under the header");
  assert.match(lines.join("\n"), /Target src\/long\.ts:1 RIGHT/);

  mounted.component.handleInput?.("\u001b[6~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:6 RIGHT/);
  assert.match(lines.slice(1, 1 + reviewViewHeights(14).bodyHeight).join("\n"), /line-6/);
  mounted.component.handleInput?.("\u001b[5~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:1 RIGHT/);

  for (let index = 0; index < 20; index += 1) mounted.component.handleInput?.("\u001b[6~");
  lines = mounted.component.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Target src\/long\.ts:30 RIGHT/);
  assert.match(lines.slice(1, 1 + reviewViewHeights(14).bodyHeight).join("\n"), /line-30/);
  assert.equal(lines.length, 14);
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
  const mounted = await mountReview({ terminalRows: 14, model, assessments, record: record() });
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
    /Target src\/expand\.ts:14 RIGHT/,
  );
  mounted.component.handleInput?.("e");
  await settleInput();

  // The second line is unchanged (old 13, new 14): the editor opens the file as it is now, at 14.
  assert.deepEqual(launches, [["/repo/src/expand.ts:12"], ["/repo/src/expand.ts:14"]]);
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
  let resolveResult: ((value: RuntimeValue) => void) | undefined;
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const custom: ReviewViewHost["custom"] = async (factory, customOptions) => {
    component = await factory(
      // SAFETY: The fixture supplies every host member exercised by this test.
      {
        terminal: { rows: 24 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      } as never,
      PLAIN_THEME,
      // SAFETY: The fixture supplies every host member exercised by this test.
      {} as never,
      (value) => resolveResult?.(value),
    );
    // SAFETY: The fixture supplies every host member exercised by this test.
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
    // SAFETY: The fixture supplies every host member exercised by this test.
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
    ...propertiesWhen(options.pullRequest, () => ({ pullRequest: options.pullRequest })),
    createCommentId: () => "overlay-comment",
  });
  await readyPromise;
  assert.ok(component?.handleInput);
  // SAFETY: The fixture supplies every host member exercised by this test.
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

test("a file kept out by a read limit shows its notice in the list and the diff, and omitted files are counted", async () => {
  const big: DiffFile = {
    path: "assets/huge.json",
    kind: "modified",
    hunks: [],
    additions: 9,
    deletions: 1,
  };
  const notice = "Not shown: 2 MiB is over the 1 MiB file limit.";
  const model: DiffModel = {
    ...MODEL,
    files: [...MODEL.files, big],
    notices: [{ path: big.path, message: notice }],
    omittedFiles: 3,
  };
  const assessments: DiffAssessment = {
    ...ASSESSMENTS,
    files: [{ path: big.path, riskScore: 0, reasons: [], collapsed: false }, ...ASSESSMENTS.files],
    reviewOrder: [big.path, ...ASSESSMENTS.reviewOrder],
  };
  const mounted = await mountReview({ terminalRows: 40, model, assessments });
  // The view opens on the first hunk to review; the notice file has none, so move back to it (←).
  mounted.component.handleInput?.("\u001b[D");
  const rendered = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.ok(rendered.includes(`\n   ${notice}`), "the file row carries the notice");
  assert.ok(
    rendered.includes("Cannot read diff: 2 MiB is over the 1 MiB file limit."),
    "the diff body explains the empty file",
  );
  assert.ok(
    rendered.includes("3 more files not shown"),
    "omitted files are counted, as in the pane",
  );
  await mounted.close();
});

/* ------------------------------------------------ the shared view's keys */

const screenOf = (mounted: MountedReview, width = 100) =>
  mounted.component.render(width).map(stripTerminalSequences).join("\n");

async function settled(): Promise<void> {
  for (let step = 0; step < 5; step += 1) await settleInput();
}

test("n/N and [/] move by hunk across files in risk order; ←/→ move by file", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  assert.match(
    screenOf(mounted),
    /1\/2 files · 0\/0 hunks .*No line selected/,
    "on the folded auth.ts row",
  );
  mounted.component.handleInput?.("n");
  assert.match(screenOf(mounted), /1\/2 files · 1\/1 hunks .*Target src\/auth\.ts:5 RIGHT/);
  mounted.component.handleInput?.("n");
  assert.match(screenOf(mounted), /2\/2 files · 1\/2 hunks .*Target src\/ordinary\.ts:1 RIGHT/);
  mounted.component.handleInput?.("]");
  assert.match(screenOf(mounted), /2\/2 files · 2\/2 hunks .*No line selected/, "the folded hunk");
  mounted.component.handleInput?.("N");
  assert.match(screenOf(mounted), /1\/2 hunks .*Target src\/ordinary\.ts:1 RIGHT/);
  mounted.component.handleInput?.("[");
  assert.match(screenOf(mounted), /1\/2 files · 1\/1 hunks .*Target src\/auth\.ts:5 RIGHT/);
  mounted.component.handleInput?.("\u001b[C");
  assert.match(screenOf(mounted), /2\/2 files .*Target src\/ordinary\.ts:1 RIGHT/);
  mounted.component.handleInput?.("\u001b[D");
  assert.match(screenOf(mounted), /1\/2 files .*Target src\/auth\.ts:5 RIGHT/);
  await mounted.close();
});

test("j walks file rows, lines and fold placeholders; Enter unfolds a hunk at its first line", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  const steps: string[] = [];
  const target = () => /(No line selected|Target \S+ \w+)/.exec(screenOf(mounted))?.[1] ?? "";
  for (let step = 0; step < 4; step += 1) {
    mounted.component.handleInput?.("j");
    steps.push(target());
  }
  assert.deepEqual(steps, [
    "No line selected",
    "Target src/ordinary.ts:1 RIGHT",
    "Target src/ordinary.ts:2 RIGHT",
    "No line selected",
  ]);
  assert.match(screenOf(mounted), /2\/2 hunks/, "the last stop is low-2's placeholder");
  mounted.component.handleInput?.("\r");
  assert.equal(target(), "Target src/ordinary.ts:20 RIGHT");
  mounted.component.handleInput?.("k");
  assert.equal(target(), "Target src/ordinary.ts:2 RIGHT");
  await mounted.close();
});

test("a rule-folded file opens with Space and closes again; a folded hunk names its reason", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  let screen = screenOf(mounted);
  assert.match(screen, /Hidden: Seeded file fold/);
  assert.match(screen, /… @@ -20,2 \+20,2 @@ low-2 \(Formatting-only hunk\)/);
  assert.doesNotMatch(screen, /context high-1/);
  mounted.component.handleInput?.(" ");
  screen = screenOf(mounted);
  assert.match(screen, /context high-1/);
  assert.doesNotMatch(screen, /Hidden: Seeded file fold/);
  mounted.component.handleInput?.("j");
  assert.match(screenOf(mounted), /Target src\/auth\.ts:5 RIGHT/);
  mounted.component.handleInput?.(" ");
  assert.match(screenOf(mounted), /… @@ -5,2 \+5,2 @@ high-1 \(Folded by reviewer\)/);
  mounted.component.handleInput?.("k");
  mounted.component.handleInput?.(" ");
  assert.match(screenOf(mounted), /Hidden: Seeded file fold/);
  await mounted.close();
});

test("/ searches changed lines; > and < move between matches with wraparound, opening folded files", async () => {
  const mounted = await mountReview({ terminalRows: 40, input: async () => "needle" });
  mounted.component.handleInput?.("/");
  await settled();
  let screen = screenOf(mounted, 160);
  assert.match(screen, /search “needle”: 1\/2 · Target src\/ordinary\.ts:2 RIGHT/);
  mounted.component.handleInput?.(">");
  screen = screenOf(mounted, 160);
  assert.match(screen, /search “needle”: 2\/2 · Target src\/auth\.ts:6 LEFT/);
  assert.match(screen, /❯▾ M src\/auth\.ts/, "the folded file opened");
  mounted.component.handleInput?.(">");
  assert.match(screenOf(mounted, 160), /1\/2 · Target src\/ordinary\.ts:2 RIGHT/, "wraps forward");
  mounted.component.handleInput?.("<");
  assert.match(screenOf(mounted, 160), /2\/2 · Target src\/auth\.ts:6 LEFT/, "wraps back");
  await mounted.close();
});

test("comments take GitHub's side: removed and context lines LEFT, added lines RIGHT, with anchors", async () => {
  let next = 0;
  const mounted = await mountReview({
    terminalRows: 40,
    createCommentId: () => `c-${(next += 1)}`,
  });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("j");
  assert.match(screenOf(mounted), /Target src\/auth\.ts:6 LEFT/);
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Explain why this removal is safe.");
  mounted.component.handleInput?.("\r");
  mounted.component.handleInput?.("\u001b[C");
  mounted.component.handleInput?.("j");
  assert.match(screenOf(mounted), /Target src\/ordinary\.ts:2 RIGHT/);
  mounted.component.handleInput?.("c");
  mounted.component.handleInput?.("Please cover this branch.");
  mounted.component.handleInput?.("\r");
  await mounted.close();
  const comments = mounted.savedRecords.at(-1)?.comments ?? [];
  assert.deepEqual(
    comments.map((entry) => [entry.path, entry.side, entry.line, entry.anchor.hunkHash]),
    [
      [HIGH_FILE.path, "LEFT", 6, HIGH_HUNK.id],
      [LOW_FILE.path, "RIGHT", 2, LOW_HUNK_1.id],
    ],
  );
  assert.match(comments[0]?.anchor.snippet ?? "", /NEEDLE second/);
  assert.match(comments[1]?.anchor.snippet ?? "", /needle first/);
  assert.match(comments[1]?.anchor.snippetHash ?? "", /^[a-f0-9]{64}$/);
});

test("m marks the hunk reviewed: the record's head and time update and the hunk folds", async () => {
  const mounted = await mountReview({ terminalRows: 40, now: () => "2026-03-03T02:01:00.000Z" });
  mounted.component.handleInput?.("n");
  mounted.component.handleInput?.("m");
  const screen = screenOf(mounted);
  assert.match(screen, /… @@ -5,2 \+5,2 @@ high-1 \(Already reviewed in this review\)/);
  assert.match(screen, /1 reviewed/);
  await mounted.close();
  const saved = mounted.savedRecords.at(-1);
  assert.deepEqual(saved?.cursor, { reviewedHunkIds: [HIGH_HUNK.id], lastHeadSha: MODEL.headSha });
  assert.equal(saved?.updatedAt, "2026-03-03T02:01:00.000Z");
});

test("a resumed review folds reviewed hunks and starts at the first unreviewed hunk in risk order", async () => {
  const mounted = await mountReview({
    terminalRows: 40,
    record: record([HIGH_HUNK.id, LOW_HUNK_1.id]),
  });
  const screen = screenOf(mounted);
  assert.match(screen, /2\/2 files · 2\/2 hunks · 2 reviewed .*No line selected/, "on low-2");
  assert.match(screen, /… @@ -1,2 \+1,2 @@ low-1 \(Already reviewed in this review\)/);
  assert.match(screen, /… @@ -20,2 \+20,2 @@ low-2 \(Formatting-only hunk\)/);
  mounted.component.handleInput?.("[");
  mounted.component.handleInput?.("[");
  assert.match(screenOf(mounted), /… @@ -5,2 \+5,2 @@ high-1 \(Already reviewed in this review\)/);
  await mounted.close();
});

/* --------------------------------------------- refresh and recorded findings */

function commentOn(id: string, hunkId: string, line: number, body: string): ReviewComment {
  // A real anchor on the fixture hunk, as the view writes one: comments are placed by their text.
  const anchoredHunk = [LOW_HUNK_1, LOW_HUNK_2].find((candidate) => candidate.id === hunkId);
  return {
    id,
    path: LOW_FILE.path,
    side: "RIGHT",
    line,
    body,
    anchor: anchoredHunk
      ? buildCommentAnchor(anchoredHunk, "RIGHT", line)
      : { hunkHash: hunkId, snippetHash: "0".repeat(64), snippet: body },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("r reads the changes again; reviewed marks and comments follow their content-hash hunk ids", async () => {
  const changedLow2: DiffHunk = {
    ...hunk("low-2-edited", 20, 20, "edited change"),
    header: "@@ -20,2 +20,2 @@ low-2 edited",
  };
  const refreshed: DiffModel = {
    ...MODEL,
    files: [{ ...LOW_FILE, hunks: [LOW_HUNK_1, changedLow2] }, HIGH_FILE],
  };
  let reads = 0;
  const reviewed: ReviewRecord = {
    ...record([LOW_HUNK_1.id]),
    comments: [
      commentOn("kept", LOW_HUNK_1.id, 2, "Still on an unchanged hunk."),
      commentOn("moved", LOW_HUNK_2.id, 21, "Its hunk changes."),
    ],
  };
  const mounted = await mountReview({
    terminalRows: 50,
    record: reviewed,
    reload: async () => {
      reads += 1;
      return refreshed;
    },
  });
  let screen = screenOf(mounted, 120);
  assert.match(screen, /low-1 \(Already reviewed in this review · 1 comment inside\)/);
  assert.match(screen, /2 comments ·/, "nothing outdated yet");
  mounted.component.handleInput?.("r");
  await settled();
  assert.equal(reads, 1);
  screen = screenOf(mounted, 120);
  assert.match(screen, /Read the changes again\./);
  assert.match(screen, /low-2 edited/, "the new content is shown");
  assert.match(
    screen,
    /low-1 \(Already reviewed in this review · 1 comment inside\)/,
    "the unchanged hunk keeps its reviewed mark, fold and comment",
  );
  assert.match(screen, /1 reviewed/);
  assert.match(screen, /2 comments \(1 outdated\)/);
  assert.match(screen, /✎ \(outdated, was src\/ordinary\.ts:21\) Its hunk changes\./);
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(screenOf(mounted, 120), /nothing changed/);
  await mounted.close();
  const saved = mounted.savedRecords.at(-1);
  assert.deepEqual(saved?.cursor.reviewedHunkIds, [LOW_HUNK_1.id]);
  assert.deepEqual(
    saved?.comments.map((entry) => entry.id),
    ["kept", "moved"],
  );
});

test("a target that cannot change says so on r", async () => {
  const mounted = await mountReview({ terminalRows: 40 });
  mounted.component.handleInput?.("r");
  assert.match(screenOf(mounted, 120), /This review's target cannot change/);
  await mounted.close();
});

test("a finished side-chat tool call reads the changes again, once per call", async () => {
  const fakeChat = new FakeReviewChat();
  let reads = 0;
  const mounted = await mountReview({
    terminalRows: 40,
    createReviewChat: () => fakeChat,
    reload: async () => {
      reads += 1;
      return MODEL;
    },
  });
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("a");
  const call = {
    role: "tool" as const,
    toolCallId: "edit-1",
    toolName: "edit",
    args: { path: "src/ordinary.ts" },
    done: false,
  };
  fakeChat.messages.push(call);
  fakeChat.emitUpdate();
  await settled();
  assert.equal(reads, 0, "a running call changes nothing yet");
  call.done = true;
  fakeChat.emitUpdate();
  await settled();
  assert.equal(reads, 1);
  fakeChat.emitUpdate();
  await settled();
  assert.equal(reads, 1, "the same call does not refresh twice");
  // Esc closes the chat (q there would be typed into it); then q leaves.
  mounted.component.handleInput?.("\u001b");
  await mounted.close();
});

test("f and F step through recorded reviewer findings on a working-tree review", async () => {
  const recorded: FindingsSummary = {
    tasks: [],
    findings: [
      {
        id: "F1",
        class: "finding",
        severity: "high",
        path: LOW_FILE.path,
        invariant: "keeps the needle",
        evidence: "code_path",
        reproduction: "",
        startLine: 2,
        workTask: "wt-a",
        agentId: "rev-1",
        completedAt: Date.parse(NOW),
      },
    ],
    malformed: 0,
    errors: [],
  };
  const asked: string[][] = [];
  const mounted = await mountReview({
    terminalRows: 40,
    loadFindings: async (paths) => {
      asked.push([...paths]);
      return { recorded, changeTimes: new Map() };
    },
  });
  await settled();
  assert.deepEqual(
    asked.map((paths) => [...paths].sort()),
    [[HIGH_FILE.path, LOW_FILE.path].sort()],
    "asked once, for the listed files",
  );
  let screen = screenOf(mounted, 120);
  assert.match(screen, /src\/ordinary\.ts +⚑1/);
  mounted.component.handleInput?.("f");
  screen = screenOf(mounted, 120);
  assert.match(screen, /▶ ⚑ high finding F1 L2: keeps the needle/);
  assert.match(screen, /2\/2 files/);
  mounted.component.handleInput?.("F");
  assert.match(screenOf(mounted, 120), /▶ ⚑ high finding F1 L2/, "one finding: F wraps to it");
  await mounted.close();

  const fixed = await mountReview({ terminalRows: 40 });
  fixed.component.handleInput?.("f");
  assert.match(screenOf(fixed, 120), /No recorded review findings\./);
  await fixed.close();
});

test("the review's keys: one action per key, none shared with a review-only key; the pane reveals with v", () => {
  const names = (table: ChangesKeyTable) =>
    Object.values(table).flatMap((bindings) =>
      bindings.map((binding) => (isString(binding) ? binding : binding.key)),
    );
  const review = names(REVIEW_KEYS);
  assert.equal(new Set(review).size, review.length, "each key runs one action");
  for (const key of REVIEW_ONLY_KEYS) {
    assert.equal(review.includes(key), false, `${key} is the host's own`);
  }
  assert.equal(
    names(PANE_KEYS).includes(SPLIT_TOGGLE_KEY),
    false,
    "the split key is free in the pane",
  );
  assert.equal(review.includes(SPLIT_TOGGLE_KEY), false);
  assert.deepEqual(PANE_KEYS.reveal, ["v"]);
});

/* ------------------------------------- the record follows the comparison it shows */

test("after r moves the comparison, the saved review names the new base and head and keeps marks and comments", async () => {
  const changedLow2: DiffHunk = {
    ...hunk("low-2-edited", 20, 20, "edited change"),
    header: "@@ -20,2 +20,2 @@ low-2 edited",
  };
  const moved: DiffModel = {
    baseSha: "moved-base",
    headSha: "moved-head",
    files: [{ ...LOW_FILE, hunks: [LOW_HUNK_1, changedLow2] }, HIGH_FILE],
  };
  const reviewed: ReviewRecord = {
    ...record([LOW_HUNK_1.id]),
    target: { kind: "branch", base: "HEAD" },
    comments: [
      commentOn("kept", LOW_HUNK_1.id, 2, "Still on an unchanged hunk."),
      commentOn("moved", LOW_HUNK_2.id, 21, "Its hunk changes."),
    ],
  };
  const mounted = await mountReview({
    terminalRows: 50,
    record: reviewed,
    reload: async () => moved,
  });
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(screenOf(mounted, 120), /2 comments \(1 outdated\)/, "drawn outdated as before");
  await mounted.close();
  const saved = mounted.savedRecords.at(-1);
  assert.equal(saved?.baseSha, "moved-base");
  assert.equal(saved?.headSha, "moved-head");
  assert.equal(saved?.cursor.lastHeadSha, "moved-head");
  assert.deepEqual(saved?.cursor.reviewedHunkIds, [LOW_HUNK_1.id]);
  assert.deepEqual(
    saved?.comments.map((entry) => entry.id),
    ["kept", "moved"],
  );
  assert.equal(mounted.savedRecords.length, 1, "saved once, by q, through the normal path");
});

test("a failed refresh keeps the ids; a refresh that lands after the view closed writes nothing", async () => {
  let fail = true;
  const failing = await mountReview({
    terminalRows: 40,
    reload: async () => {
      if (fail) throw new Error("git gone");
      return MODEL;
    },
  });
  failing.component.handleInput?.("r");
  await settled();
  await failing.close();
  assert.equal(failing.savedRecords.at(-1)?.baseSha, MODEL.baseSha);
  assert.equal(failing.savedRecords.at(-1)?.headSha, MODEL.headSha);
  fail = false;

  let land: ((model: DiffModel) => void) | undefined;
  const late = await mountReview({
    terminalRows: 40,
    reload: () =>
      new Promise<DiffModel>((resolve) => {
        land = resolve;
      }),
  });
  late.component.handleInput?.("r");
  await settled();
  await late.close();
  assert.equal(late.savedRecords.length, 1);
  land?.({ ...MODEL, baseSha: "late-base", headSha: "late-head" });
  await settled();
  assert.equal(late.savedRecords.length, 1, "nothing written after close");
  assert.equal(late.savedRecords[0]?.baseSha, MODEL.baseSha);
});

/* -------------------------------------------- containment of render and input */

test("a review that cannot draw closes at once, saves through the store, and says so once", async () => {
  let broken = false;
  let calls = 0;
  const theme = reinterpretHostValue<Theme>({
    fg: (_color: string, text: string) => {
      calls += 1;
      if (broken) throw new Error("theme \u001b]52;c;eA==\u0007broke\nmore");
      return text;
    },
    bold: (text: string) => text,
  });
  const mounted = await mountReview({
    terminalRows: 30,
    theme,
    record: { ...record(), comments: [commentOn("kept", LOW_HUNK_1.id, 2, "Unsent.")] },
  });
  broken = true;
  let lines: string[] = [];
  assert.doesNotThrow(() => {
    lines = mounted.component.render(50);
  });
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0] ?? "") <= 50);
  const after = calls;
  for (let frame = 0; frame < 60; frame += 1) mounted.component.render(50);
  assert.equal(calls, after, "the view is not drawn again");
  await mounted.close();
  await settled();
  assert.equal(mounted.savedRecords.length, 1);
  assert.deepEqual(
    mounted.savedRecords[0]?.comments.map((entry) => entry.id),
    ["kept"],
  );
  const told = mounted.notifications.filter((note) => note.includes("could not be drawn"));
  assert.equal(told.length, 1);
  assert.match(told[0] ?? "", /were saved/);
  const toldText = told[0] ?? "";
  assert.equal(toldText.includes("\u0007") || toldText.includes("\u001b]"), false, "sanitised");
});

test("a key that throws in the review is shown and the review can still be left", async () => {
  let failNow = false;
  const mounted = await mountReview({
    terminalRows: 30,
    now: () => {
      if (failNow) throw new Error("clock broke");
      return NOW;
    },
  });
  mounted.component.handleInput?.("]");
  failNow = true;
  assert.doesNotThrow(() => mounted.component.handleInput?.("m"));
  failNow = false;
  // The clock also draws relative times, so it is mended before the next frame.
  assert.match(screenOf(mounted, 120), /That key failed: clock broke/);
  await mounted.close();
  assert.equal(mounted.savedRecords.length, 1);
});

/* ------------------------------------------ a comment stays with its text */

const R2_PATH = "src/r2.ts";

function r2Diff(insertAbove: boolean, bChanged = false, bLines = ["+added B"]): string {
  const a = insertAbove
    ? ["@@ -2,3 +2,4 @@", " line 2", "-line 3", "+line 3 edited", "+inserted above", " line 4"]
    : ["@@ -2,3 +2,3 @@", " line 2", "-line 3", "+line 3 edited", " line 4"];
  const shift = insertAbove ? 1 : 0;
  const added = bLines.filter((line) => line.startsWith("+")).length;
  const removed = bLines.filter((line) => line.startsWith("-")).length;
  const b = [
    `@@ -18,${6 + removed} +${18 + shift},${6 + added} @@`,
    " line 18",
    " line 19",
    " line 20",
    ...bLines.map((line) => (bChanged && line.startsWith("+") ? `${line} (edited)` : line)),
    " line 21",
    " line 22",
    " line 23",
  ];
  return [
    `diff --git a/${R2_PATH} b/${R2_PATH}`,
    `--- a/${R2_PATH}`,
    `+++ b/${R2_PATH}`,
    ...a,
    ...b,
    "",
  ].join("\n");
}

function r2Model(insertAbove: boolean, bChanged = false, bLines?: string[]): DiffModel {
  return parseGitDiff(
    r2Diff(insertAbove, bChanged, bLines),
    "base-sha",
    insertAbove ? "head-2" : "head-1",
  );
}

function r2Comment(
  model: DiffModel,
  side: "LEFT" | "RIGHT",
  line: number,
  startLine?: number,
): ReviewComment {
  const hunk = model.files[0]?.hunks[1];
  assert.ok(hunk);
  const comment: ReviewComment = {
    id: "r2",
    path: R2_PATH,
    side,
    line,
    body: "About this line.",
    anchor: buildCommentAnchor(hunk, side, line, startLine),
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (startLine !== undefined) comment.startLine = startLine;
  return comment;
}

function r2Record(model: DiffModel, comment: ReviewComment): ReviewRecord {
  return {
    ...record(),
    target: { kind: "branch", base: "HEAD" },
    baseSha: model.baseSha,
    headSha: model.headSha,
    comments: [comment],
  };
}

/** The diff row directly above the comment's block, as drawn. */
function rowAbove(mounted: MountedReview, width = 140): string {
  const rows = mounted.component.render(width).map(stripTerminalSequences);
  const at = rows.findIndex((row) => row.includes("About this line."));
  return at > 0 ? (rows[at - 1] ?? "") : "";
}

async function expandR2(mounted: MountedReview): Promise<void> {
  // The only file opens expanded; draw once so its body is read.
  mounted.component.render(140);
  await settled();
}

test("after a refresh moves the hunk, the comment stays under its text and the record names the new line", async () => {
  const first = r2Model(false);
  const moved = r2Model(true);
  assert.equal(first.files[0]?.hunks[1]?.id, moved.files[0]?.hunks[1]?.id, "same content hash");
  const mounted = await mountReview({
    terminalRows: 60,
    model: first,
    record: r2Record(first, r2Comment(first, "RIGHT", 21)),
    reload: async () => moved,
  });
  await expandR2(mounted);
  assert.match(rowAbove(mounted), /added B/);
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(rowAbove(mounted), /added B/, "still under its text");
  assert.doesNotMatch(screenOf(mounted, 140), /outdated/);
  await mounted.close();
  assert.equal(mounted.savedRecords.at(-1)?.comments[0]?.line, 22);
});

test("a resumed review whose hunk moved since places the comment by its text", async () => {
  const first = r2Model(false);
  const moved = r2Model(true);
  const mounted = await mountReview({
    terminalRows: 60,
    model: moved,
    record: r2Record(first, r2Comment(first, "RIGHT", 21)),
  });
  await expandR2(mounted);
  assert.match(rowAbove(mounted), /added B/);
  await mounted.close();
  assert.equal(mounted.savedRecords.at(-1)?.comments[0]?.line, 22);
});

test("a range comment moves as a whole; an old record without a position resolves by its snippet", async () => {
  const first = r2Model(false);
  const moved = r2Model(true);
  const comment = r2Comment(first, "RIGHT", 21, 20);
  const { position: _position, ...oldAnchor } = comment.anchor;
  const mounted = await mountReview({
    terminalRows: 60,
    model: moved,
    record: r2Record(first, { ...comment, anchor: oldAnchor }),
  });
  await expandR2(mounted);
  await mounted.close();
  const saved = mounted.savedRecords.at(-1)?.comments[0];
  assert.equal(saved?.startLine, 21);
  assert.equal(saved?.line, 22);
});

test("a comment on a deleted line (LEFT) follows its text when the new side moves", async () => {
  const lines = ["-line 20 removed", "+line 20 replaced"];
  const first = r2Model(false, false, lines);
  const moved = r2Model(true, false, lines);
  const hunk = first.files[0]?.hunks[1];
  assert.ok(hunk);
  const removed = hunk.lines.find((line) => line.kind === "del");
  assert.ok(removed?.oldLine !== undefined);
  const mounted = await mountReview({
    terminalRows: 60,
    model: first,
    record: r2Record(first, r2Comment(first, "LEFT", removed.oldLine)),
    reload: async () => moved,
  });
  await expandR2(mounted);
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(rowAbove(mounted), /line 20 removed/);
  await mounted.close();
  assert.equal(
    mounted.savedRecords.at(-1)?.comments[0]?.line,
    removed.oldLine,
    "the old side did not move",
  );
});

test("a comment whose text changed is drawn outdated, never under other text", async () => {
  const first = r2Model(false);
  const changed = r2Model(false, true);
  const mounted = await mountReview({
    terminalRows: 60,
    model: first,
    record: r2Record(first, r2Comment(first, "RIGHT", 21)),
    reload: async () => changed,
  });
  await expandR2(mounted);
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(screenOf(mounted, 140), /1 comments \(1 outdated\)/);
  assert.match(screenOf(mounted, 140), /outdated, was/);
  await mounted.close();
});

test("a refresh in which only the commented hunk moved names its new line", async () => {
  const only = (shift: number): DiffModel => {
    const full = r2Model(false);
    const moved = r2Model(shift > 0);
    const hunk = (shift > 0 ? moved : full).files[0]?.hunks[1];
    assert.ok(hunk);
    return { ...full, headSha: "same-head", files: [{ ...full.files[0]!, hunks: [hunk] }] };
  };
  const first = only(0);
  const moved = only(1);
  assert.equal(first.files[0]?.hunks[0]?.id, moved.files[0]?.hunks[0]?.id);
  const comment = r2Comment(r2Model(false), "RIGHT", 21);
  const mounted = await mountReview({
    terminalRows: 60,
    model: first,
    record: { ...r2Record(first, comment) },
    reload: async () => moved,
  });
  await expandR2(mounted);
  mounted.component.handleInput?.("r");
  await settled();
  assert.match(rowAbove(mounted), /added B/);
  await mounted.close();
  assert.equal(mounted.savedRecords.at(-1)?.comments[0]?.line, 22);
});

/* ----------------------- a comment on expanded context survives a resume */

function expandedContextComment(fixture: ExpansionReviewFixture, line: number): ReviewComment {
  const hunk = fixture.model.files[0]?.hunks[0];
  assert.ok(hunk);
  const above = Array.from({ length: 10 }, (_unused, index) => ({
    kind: "context" as const,
    oldLine: index + 1,
    newLine: index + 1,
    text: `base line ${index + 1}`,
  }));
  return {
    id: "ctx",
    path: "src/expand.ts",
    side: "RIGHT",
    line,
    body: "About this unchanged line.",
    anchor: buildCommentAnchor(hunkWithExpandedContext(hunk, { above, below: [] }), "RIGHT", line),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("resume: a comment on expanded context re-expands that context and sits under its line", async () => {
  const fixture = expansionReviewFixture();
  const mounted = await mountReview({
    terminalRows: 60,
    ...fixture,
    record: { ...fixture.record, comments: [expandedContextComment(fixture, 5)] },
  });
  mounted.component.render(120);
  await settleInput();
  await settleInput();
  const rows = mounted.component.render(120).map(stripTerminalSequences);
  const at = rows.findIndex((row) => row.includes("About this unchanged line."));
  assert.ok(at > 0, "drawn inline");
  assert.match(rows[at - 1] ?? "", /\bbase line 5\b/);
  assert.doesNotMatch(rows.join("\n"), /outdated/);
  await mounted.close();
  assert.equal(mounted.savedRecords.at(-1)?.comments[0]?.line, 5);
});

test("resume: a comment on expanded context whose text is gone is outdated, and keeps no expansion", async () => {
  const fixture = expansionReviewFixture();
  const changed: ExecRunner = async () => ({
    stdout: `${Array.from({ length: 40 }, (_unused, index) => `other line ${index + 1}`).join("\n")}\n`,
    stderr: "",
    code: 0,
  });
  const mounted = await mountReview({
    terminalRows: 60,
    ...fixture,
    execRunner: changed,
    record: { ...fixture.record, comments: [expandedContextComment(fixture, 5)] },
  });
  mounted.component.render(120);
  await settleInput();
  await settleInput();
  const screen = mounted.component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(screen, /outdated, was src\/expand\.ts:5\) About this unchanged line\./);
  assert.doesNotMatch(screen, /other line/);
  await mounted.close();
});

test("refresh: when a hunk moved, context read for its old place is dropped and the comment's context is read again", async () => {
  const fixture = expansionReviewFixture();
  const moved = expansionReviewFixture({ oldStart: 13 });
  const mounted = await mountReview({
    terminalRows: 70,
    ...fixture,
    record: { ...fixture.record, comments: [expandedContextComment(fixture, 5)] },
    reload: async () => moved.model,
  });
  mounted.component.render(120);
  await settleInput();
  await settleInput();
  mounted.component.handleInput?.("r");
  await settleInput();
  await settleInput();
  await settleInput();
  const rows = mounted.component.render(120).map(stripTerminalSequences);
  const hunkTop = rows.findIndex((row) => /│ {3}base line 13\b/.test(row));
  assert.ok(hunkTop > 0);
  assert.match(
    rows[hunkTop - 1] ?? "",
    /\bbase line 12\b/,
    "context is read for where the hunk is now",
  );
  const at = rows.findIndex((row) => row.includes("About this unchanged line."));
  assert.match(rows[at - 1] ?? "", /\bbase line 5\b/);
  await mounted.close();
});

/* ------------------------------------------------- Ctrl+C and the mouse */

/** The copy key as a terminal sends it: Cmd+C (Kitty protocol) on macOS, Ctrl+C elsewhere. */
const COPY = COPY_KEY.key === "super+c" ? "\u001b[99;9u" : "\u0003";
const ESCAPE = "\u001b";

/** A left-button mouse event on column `x` of the first drawn row showing `text`. */
function mouseOn(
  mounted: MountedReview,
  text: string | number,
  type: TuiMouseEvent["type"] = "click",
  x = 20,
  width = 100,
): TuiMouseEvent {
  const rows = mounted.component.render(width).map(stripTerminalSequences);
  const y = isNumber(text) ? text : rows.findIndex((row) => row.includes(text));
  assert.ok(y >= 0, `no row shows ${text}`);
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

const statusOf = (mounted: MountedReview, width = 100) =>
  mounted.component
    .render(width)
    .map(stripTerminalSequences)
    .find((row) => row.includes(" files · ")) ?? "";

test("the copy key copies the selected lines as code and a folded hunk as a diff", async () => {
  const copied: string[] = [];
  const mounted = await mountReview({
    terminalRows: 30,
    ...mixedReviewFixture(),
    copyText: async (text) => {
      copied.push(text);
    },
  });
  mounted.component.render(100);
  for (let step = 0; step < 4; step += 1) mounted.component.handleInput?.("j");
  mounted.component.handleInput?.(COPY);
  await settleInput();
  assert.deepEqual(copied, ["const extra = 3;"], "one line, without its + marker");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Copied 1 line\./,
  );
  mounted.component.handleInput?.(SHIFT_DOWN);
  mounted.component.handleInput?.(SHIFT_DOWN);
  mounted.component.handleInput?.(COPY);
  await settleInput();
  assert.equal(copied.at(-1), "const extra = 3;\nconst after = 4;\nconst tail = 5;");
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Copied 3 lines\./,
  );

  // Folded, the hunk is one stop: the whole hunk is copied, as a diff.
  mounted.component.handleInput?.(" ");
  mounted.component.handleInput?.(COPY);
  await settleInput();
  assert.equal(
    copied.at(-1),
    [
      "@@ -10,5 +10,6 @@ function mixed",
      " const before = 1;",
      " const guard = 0;",
      "-const removed = 2;",
      "+const added = 2;",
      "+const extra = 3;",
      " const after = 4;",
      " const tail = 5;",
    ].join("\n"),
  );
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Copied the hunk as a diff \(7 lines\)/,
  );

  // On the file's row there is no text to copy.
  mounted.component.handleInput?.("g");
  const before = copied.length;
  mounted.component.handleInput?.(COPY);
  await settleInput();
  assert.equal(copied.length, before);
  assert.match(
    mounted.component.render(100).map(stripTerminalSequences).join("\n"),
    /Nothing to copy on a file's row/,
  );
  await mounted.close();
});

test("the copy key says so when the clipboard fails or is not wired, and the review stays", async () => {
  const failing = await mountReview({
    terminalRows: 30,
    ...mixedReviewFixture(),
    copyText: async () => {
      throw new Error("no display");
    },
  });
  failing.component.render(100);
  failing.component.handleInput?.("j");
  failing.component.handleInput?.(COPY);
  await settleInput();
  assert.match(
    failing.component.render(100).map(stripTerminalSequences).join("\n"),
    /Cannot copy to the clipboard: no display/,
  );
  await failing.close();

  const none = await mountReview({ terminalRows: 30, ...mixedReviewFixture() });
  none.component.render(100);
  none.component.handleInput?.("j");
  none.component.handleInput?.(COPY);
  assert.match(
    none.component.render(100).map(stripTerminalSequences).join("\n"),
    /Copying is not available here/,
  );
  await none.close();
});

test("mouse: a press puts the cursor on a line, drags select lines of one side, and a file row opens or closes", async () => {
  const mounted = await mountReview({ terminalRows: 30, ...mixedReviewFixture() });
  const mouse = (event: TuiMouseEvent) => mounted.component.handleMouse?.(event);

  assert.deepEqual(mouse(mouseOn(mounted, "const added = 2;", "press")), {
    handled: true,
    capture: true,
    render: true,
  });
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:12 RIGHT/);
  mouse(mouseOn(mounted, "const tail = 5;", "drag"));
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:12-15 RIGHT/);
  // Upwards the removed line has no number on this side: the selection stops below it.
  mouse(mouseOn(mounted, "const before = 1;", "drag"));
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:12 RIGHT/, "a range never mixes sides");
  // Past the last drawn row the drag is read as one row below the diff.
  mouse(mouseOn(mounted, 29, "drag"));
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:12-15 RIGHT/);
  assert.deepEqual(mouse(mouseOn(mounted, 29, "release")), { handled: true });
  assert.equal(mouse(mouseOn(mounted, "const before = 1;", "drag")), undefined, "released");
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:12-15 RIGHT/);

  // An unfolded hunk's header is not a stop of the review's cursor: its first line is.
  assert.deepEqual(mouse(mouseOn(mounted, "@@ -10,5 +10,6 @@", "press")), {
    handled: true,
    render: false,
  });
  mouse(mouseOn(mounted, "@@ -10,5 +10,6 @@"));
  assert.match(statusOf(mounted), /Target src\/mixed\.ts:10 RIGHT/);

  // A file's row closes and opens the file.
  mouse(mouseOn(mounted, "M src/mixed.ts"));
  assert.doesNotMatch(mounted.component.render(100).join("\n"), /const added = 2;/);
  mouse(mouseOn(mounted, "M src/mixed.ts"));
  assert.match(mounted.component.render(100).join("\n"), /const added = 2;/);
  await mounted.close();
});

test("mouse: every left press on the diff is taken so Pi selects and copies nothing there; the rest is Pi's", async () => {
  const mounted = await mountReview({ terminalRows: 30, ...mixedReviewFixture() });
  const mouse = (event: TuiMouseEvent) => mounted.component.handleMouse?.(event);
  const taken = { handled: true, render: false };

  assert.deepEqual(mouse(mouseOn(mounted, "j/k line", "press")), taken, "the view's header");
  assert.deepEqual(mouse(mouseOn(mounted, "M src/mixed.ts", "press")), taken, "a file row");
  assert.deepEqual(mouse(mouseOn(mounted, 20, "press")), taken, "empty rows under the diff");
  assert.equal(mouse(mouseOn(mounted, 0, "press")), undefined, "the review's title row");
  assert.equal(mouse(mouseOn(mounted, "Input inactive", "press")), undefined, "the input");
  assert.equal(mouse(mouseOn(mounted, 29, "press")), undefined, "the key rows");
  assert.equal(
    mouse({ ...mouseOn(mounted, "const added = 2;", "press"), button: "right" }),
    undefined,
    "another button",
  );
  assert.equal(mouse({ ...mouseOn(mounted, 20), type: "wheel" }), undefined);

  // While a comment is being written the diff takes the press and keeps the cursor.
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("c");
  assert.deepEqual(mouse(mouseOn(mounted, "const tail = 5;", "press")), taken);
  assert.deepEqual(mouse(mouseOn(mounted, "const tail = 5;")), taken);
  mounted.component.handleInput?.(ESCAPE);
  assert.match(
    statusOf(mounted),
    /Target src\/mixed\.ts:12 LEFT/,
    "the cursor is where the keys left it",
  );
  await mounted.close();
});

test("mouse: with the chat beside the diff, a press on the diff focuses the review and the chat's columns are Pi's", async () => {
  const mounted = await mountReview({
    terminalRows: 30,
    ...mixedReviewFixture(),
    createReviewChat: () => new FakeReviewChat(),
  });
  const width = REVIEW_CHAT_SPLIT_MIN_WIDTH;
  const mouse = (event: TuiMouseEvent) => mounted.component.handleMouse?.(event);
  mounted.component.handleInput?.("j");
  mounted.component.handleInput?.("a");
  assert.match(
    mounted.component.render(width).map(stripTerminalSequences)[0] ?? "",
    /Chat \[FOCUSED\]/,
  );

  assert.equal(
    mouse(mouseOn(mounted, "const added = 2;", "press", width - 10, width)),
    undefined,
    "right of the diff",
  );
  assert.equal(mouse(mouseOn(mounted, "const added = 2;", "press", 20, width))?.capture, true);
  assert.match(
    mounted.component.render(width).map(stripTerminalSequences)[0] ?? "",
    /Review \[FOCUSED\] · Chat open/,
  );
  assert.match(statusOf(mounted, width), /Target src\/mixed\.ts:12 RIGHT/);

  // Below the split width the chat replaces the diff: nothing there is the review's.
  mounted.component.handleInput?.("\t");
  assert.equal(mouse(mouseOn(mounted, 6, "press", 20, width - 1)), undefined);
  mounted.component.handleInput?.(SHIFT_TAB);
  await mounted.close();
});
