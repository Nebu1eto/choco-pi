import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type MarkdownTheme,
  type OverlayHandle,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import {
  createReviewChat as createDefaultReviewChat,
  REVIEW_CHAT_THINKING_LEVELS,
  type ReviewChat,
  type ReviewChatContext,
  type ReviewChatToolCall,
} from "../core/ask.ts";
import type { PullRequestMetadata } from "../core/pr.ts";
import { launchEditor, launchEditorProject, type SpawnEditor } from "../core/editor-launch.ts";
import { collapseHunkContext, expandHunkContext, hunkWithExpandedContext } from "../core/expand.ts";
import type { DiffAssessment } from "../core/heuristics.ts";
import { renderReviewMarkdown } from "../core/markdown-export.ts";
import {
  effectiveDiffMode,
  renderDiffFile,
  renderDiffFileHeader,
  type DiffStyler,
} from "../core/render/diff-render.ts";
import { createHighlight } from "../core/render/highlight.ts";
import type {
  DiffFile,
  DiffHunk,
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
} from "../core/types.ts";
import { ReviewInput } from "./review-input.ts";
import { createZentuiFrameAdapter, type ZentuiLoader } from "./zentui-frame.ts";
import {
  beginCommentDraft,
  commitCommentDraft,
  createReviewViewState,
  currentCommentPosition,
  currentDisplayHunk,
  currentFile,
  currentHunk,
  discardCommentDraft,
  extendSelection,
  fileFoldReason,
  hunkExpansion,
  hunkFoldReason,
  markCurrentHunkReviewed,
  moveFile,
  moveHunk,
  moveLine,
  moveSearchMatch,
  saveAndClose,
  selectedLineIndexes,
  setHunkExpansion,
  setSearchQuery,
  toggleCurrentFold,
  toggleDiffMode,
  updateCommentDraft,
  type ReviewViewState,
} from "./view-state.ts";

export type ReviewViewHost = Pick<
  ExtensionUIContext,
  "custom" | "input" | "notify" | "select" | "setEditorText"
>;

export type ReviewViewDependencies = {
  host: ReviewViewHost;
  store: ReviewStore;
  styler: DiffStyler;
  spawnEditor?: SpawnEditor;
  now?: () => string;
  createCommentId?: () => string;
  createReviewChat?: typeof createDefaultReviewChat;
  execRunner?: ExecRunner;
  zentuiLoader?: ZentuiLoader;
  /** Markdown theme for agent replies; defaults to the main Pi transcript theme. */
  markdownTheme?: MarkdownTheme;
  /** Models offered by `/model` argument completion, as `provider/id` strings. */
  listChatModels?: () => Promise<string[]>;
};

export type OpenReviewViewOptions = ReviewViewDependencies & {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
  config: ResolvedReviewConfig;
  reviewRoot: string;
  pullRequest?: PullRequestMetadata;
  /** Model for the side chat's own session, as `provider/id`; the caller passes the main session's current model. */
  chatModel?: string;
  /** Thinking level for the side chat's session; the caller passes the main session's current level. */
  chatThinkingLevel?: string;
};

export type ReviewViewResult = {
  action: "save" | "finish";
  record: ReviewRecord;
  /** Present for Finish; callers may export it without recomputing. */
  markdown?: string;
  /** Present only for session targets. It has been placed in Pi's input editor, not sent. */
  agentInstruction?: string;
};

export function composeSessionReviewInstruction(
  record: ReviewRecord,
  markdown: string,
): string | undefined {
  if (record.target.kind !== "session" && record.target.kind !== "session-turn") return undefined;
  return [
    "Please address the following human code review. Resolve each comment, preserve unrelated behavior, and report any comment you cannot address.",
    "",
    markdown.trimEnd(),
  ].join("\n");
}

function assessmentForFile(state: ReviewViewState, path: string) {
  return state.assessments.files.find((assessment) => assessment.path === path);
}

function fileListLines(state: ReviewViewState, width: number, theme: Theme): string[] {
  if (state.fileOrder.length === 0) return [theme.fg("dim", "No changed files")];
  const count = Math.min(5, state.fileOrder.length);
  const start = Math.max(
    0,
    Math.min(state.fileIndex - Math.floor(count / 2), state.fileOrder.length - count),
  );
  const lines: string[] = [];
  if (start > 0)
    lines.push(theme.fg("dim", `  ↑ ${start} higher-risk file${start === 1 ? "" : "s"}`));
  for (let index = start; index < start + count; index += 1) {
    const path = state.fileOrder[index]!;
    const file = state.model.files.find((candidate) => candidate.path === path);
    const assessment = assessmentForFile(state, path);
    const selected = index === state.fileIndex;
    const folded = state.fileFolds.has(path);
    const marker = selected ? theme.fg("accent", "❯") : " ";
    const fold = folded ? "▸" : "▾";
    const score = assessment?.riskScore ?? 0;
    const reason = assessment?.reasons.length
      ? assessment.reasons.join("; ")
      : "No elevated risk signals";
    const counts = `${theme.fg("toolDiffAdded", `+${file?.additions ?? 0}`)} ${theme.fg("toolDiffRemoved", `-${file?.deletions ?? 0}`)}`;
    const badge =
      score > 0
        ? `${theme.fg(score >= 30 ? "error" : "warning", `▲${score}`)} ${theme.fg("muted", reason)}`
        : theme.fg("dim", reason);
    const name = selected ? theme.bold(path) : path;
    const label = `${marker} ${theme.fg("dim", fold)} ${name}  ${counts}  ${badge}`;
    lines.push(truncateToWidth(label, width, "…"));
    if (folded) {
      lines.push(
        truncateToWidth(theme.fg("dim", `    Hidden: ${fileFoldReason(state, path)}`), width, "…"),
      );
    }
  }
  const remaining = state.fileOrder.length - (start + count);
  if (remaining > 0)
    lines.push(theme.fg("dim", `  ↓ ${remaining} lower-risk file${remaining === 1 ? "" : "s"}`));
  return lines;
}

type DiffBody = { lines: string[]; selectedLine: number };
type ReviewPaneFocus = "review" | "chat";

/**
 * One header plus status, inactive-input, and two context-sensitive keymap rows.
 * An active editor reserves its own rows at render time, as does an open
 * completion list; zentui's frame replaces the editor's rule rows rather than
 * adding any, so this baseline is unchanged.
 */
export const REVIEW_CHROME_ROWS = 5;
/** At narrower widths the focused pane replaces the other instead of squeezing both. */
export const REVIEW_CHAT_SPLIT_MIN_WIDTH = 120;
/**
 * Layout width for collapsed tool previews. A collapsed tool call must stay
 * concise in the narrow chat pane, so its lines are laid out wide and then
 * cut to the pane instead of wrapping a long source line across dozens of
 * rows. 512 columns exceeds every per-line cap the read-only tools emit.
 */
export const COLLAPSED_TOOL_RENDER_WIDTH = 512;

export function reviewViewHeights(terminalRows: number): {
  bodyHeight: number;
  overlayMaxHeight: "100%";
  reservedRows: number;
} {
  const rows = Math.max(0, terminalRows);
  const reservedRows = Math.min(REVIEW_CHROME_ROWS, rows);
  return {
    bodyHeight: rows - reservedRows,
    overlayMaxHeight: "100%",
    reservedRows,
  };
}

function oneHunkFile(file: DiffFile, hunk: DiffHunk): DiffFile {
  return { ...file, hunks: [hunk] };
}

function splitRowForLine(hunk: DiffHunk, lineIndex: number): number {
  let index = 0;
  let row = 0;
  while (index < hunk.lines.length) {
    if (hunk.lines[index]?.kind === "context") {
      if (index === lineIndex) return row;
      index += 1;
      row += 1;
      continue;
    }
    if (hunk.lines[index]?.kind === "del") {
      const deleted: number[] = [];
      const added: number[] = [];
      while (hunk.lines[index]?.kind === "del") deleted.push(index++);
      while (hunk.lines[index]?.kind === "add") added.push(index++);
      const pair = Math.max(deleted.indexOf(lineIndex), added.indexOf(lineIndex));
      if (pair >= 0) return row + pair;
      row += Math.max(deleted.length, added.length);
      continue;
    }
    if (index === lineIndex) return row;
    index += 1;
    row += 1;
  }
  return 0;
}

function renderedRowForLine(
  hunk: DiffHunk,
  lineIndex: number,
  mode: ReviewViewState["mode"],
  width: number,
): number {
  return effectiveDiffMode({ mode, width, highlight: () => [], fold: () => false }) === "split"
    ? splitRowForLine(hunk, lineIndex)
    : lineIndex;
}

function commentsForHunk(state: ReviewViewState, hunkId: string): ReviewComment[] {
  return state.record.comments.filter((comment) => comment.anchor.hunkHash === hunkId);
}

/**
 * Rendered row a committed comment sits under. A comment on a line that is
 * not currently displayed — its expanded context was collapsed again — falls
 * back to the hunk header, where its own line label still locates it.
 */
function commentRowForHunk(
  hunk: DiffHunk,
  comment: ReviewComment,
  mode: ReviewViewState["mode"],
  width: number,
): number {
  const lineIndex = hunk.lines.findIndex((line) =>
    comment.side === "LEFT"
      ? line.kind !== "add" && line.oldLine === comment.line
      : line.kind !== "del" && line.newLine === comment.line,
  );
  return lineIndex < 0 ? 0 : 1 + renderedRowForLine(hunk, lineIndex, mode, width);
}

function commentBlock(comment: ReviewComment, width: number, styler: DiffStyler): string[] {
  const bar = styler.fg("accent", " ▎ ");
  const label = `● ${rangeLabel(comment)} `;
  const labelWidth = visibleWidth(label);
  const bodyWidth = Math.max(1, width - 3 - labelWidth);
  return wrapPlainText(comment.body, bodyWidth).map((line, index) =>
    index === 0
      ? `${bar}${styler.fg("accent", label)}${styler.fg("muted", line)}`
      : `${bar}${" ".repeat(labelWidth)}${styler.fg("muted", line)}`,
  );
}

function diffBody(
  state: ReviewViewState,
  width: number,
  styler: DiffStyler,
  config: ResolvedReviewConfig,
): DiffBody {
  const file = currentFile(state);
  if (!file) return { lines: [styler.fg("dim", "No reviewable diff")], selectedLine: 0 };
  if (state.fileFolds.has(file.path)) {
    return {
      lines: [
        truncateToWidth(renderDiffFileHeader(file, styler), Math.max(1, width), "…"),
        styler.fg("dim", `… File hidden: ${fileFoldReason(state, file.path)}`),
      ],
      selectedLine: 1,
    };
  }

  const diffLines = file.hunks.reduce(
    (total, hunk) =>
      total + hunkWithExpandedContext(hunk, state.expandedContext.get(hunk.id)).lines.length,
    0,
  );
  const highlight = createHighlight({
    config: config.highlight,
    filePath: file.path,
    diffLines,
  });
  const renderOptions = {
    mode: state.mode,
    width,
    highlight,
    fold: (hunkId: string) => state.hunkFolds.has(hunkId),
    foldReason: (hunkId: string) => {
      const reason = hunkFoldReason(state, hunkId);
      const count = commentsForHunk(state, hunkId).length;
      if (count === 0) return reason;
      const suffix = `${count} comment${count === 1 ? "" : "s"} inside`;
      return reason ? `${reason} · ${suffix}` : suffix;
    },
  };
  const header = renderDiffFile({ ...file, hunks: [] }, renderOptions, styler)[0] ?? file.path;
  const lines = [header];
  let selectedLine = 0;
  const selected = currentHunk(state)?.id;
  for (const originalHunk of file.hunks) {
    const hunk = hunkWithExpandedContext(originalHunk, state.expandedContext.get(originalHunk.id));
    const start = lines.length;
    const rendered = renderDiffFile(oneHunkFile(file, hunk), renderOptions, styler).slice(1);
    let selectedRow: number | undefined;
    if (hunk.id === selected) {
      selectedRow =
        state.lineIndex === undefined
          ? 0
          : 1 + renderedRowForLine(hunk, state.lineIndex, state.mode, width);
      // A selection must read as one block, so every covered row is inverted,
      // not just its ends. Split mode can map two lines onto one rendered row,
      // and inverting that row twice would cancel the highlight out.
      const selectedRows = new Set(
        selectedLineIndexes(state).map(
          (lineIndex) => 1 + renderedRowForLine(hunk, lineIndex, state.mode, width),
        ),
      );
      if (selectedRows.size === 0) selectedRows.add(selectedRow);
      for (const row of selectedRows) {
        if (rendered[row]) rendered[row] = styler.inverse(rendered[row]);
      }
    }
    // Committed comments render beneath their anchored rows, GitHub-style,
    // so a written remark stays visible instead of surviving only as a
    // count in the footer. A folded hunk keeps them summarized in its
    // placeholder rather than leaking bodies below the fold.
    if (!state.hunkFolds.has(originalHunk.id)) {
      // A reviewed hunk that the reviewer re-expanded keeps its verdict in
      // sight on the hunk header.
      if (state.record.cursor.reviewedHunkIds.includes(originalHunk.id) && rendered[0]) {
        rendered[0] = `${rendered[0]} ${styler.fg("toolDiffAdded", "✓ reviewed")}`;
      }
      const anchored = commentsForHunk(state, originalHunk.id)
        .map((comment) => ({ comment, row: commentRowForHunk(hunk, comment, state.mode, width) }))
        .sort((first, second) => first.row - second.row);
      let inserted = 0;
      let shift = 0;
      for (const { comment, row } of anchored) {
        const block = commentBlock(comment, width, styler);
        rendered.splice(row + 1 + inserted, 0, ...block);
        if (selectedRow !== undefined && row < selectedRow) shift += block.length;
        inserted += block.length;
      }
      if (selectedRow !== undefined) selectedRow += shift;
    }
    if (selectedRow !== undefined) selectedLine = start + selectedRow;
    lines.push(...rendered);
  }
  return { lines, selectedLine };
}

function statusLine(state: ReviewViewState, theme: Theme): string {
  const file = currentFile(state);
  const hunk = currentHunk(state);
  const reviewed = state.record.cursor.reviewedHunkIds.length;
  const parts = [
    `${state.fileIndex + (file ? 1 : 0)}/${state.fileOrder.length} files`,
    file ? `${state.hunkIndex + (hunk ? 1 : 0)}/${file.hunks.length} hunks` : "0/0 hunks",
    `${reviewed} reviewed`,
    `${state.record.comments.length} comments`,
    state.mode,
  ];
  const search = state.search;
  if (search)
    parts.push(
      search.matches.length === 0
        ? `search “${search.query}”: no matches`
        : `search “${search.query}”: ${search.matchIndex + 1}/${search.matches.length}`,
    );
  return theme.fg("muted", parts.join(" · "));
}

/** `startLine` is absent for a single line, so the label never fakes a range. */
function rangeLabel(position: { line: number; startLine?: number }): string {
  return position.startLine === undefined
    ? `${position.line}`
    : `${position.startLine}-${position.line}`;
}

function commentTargetLine(state: ReviewViewState, theme: Theme): string {
  const position = state.commentDraft?.position ?? currentCommentPosition(state);
  if (!position) return theme.fg("dim", "No line selected · j/k or ↑/↓ line");
  return theme.fg("dim", `Target ${position.path}:${rangeLabel(position)} ${position.side}`);
}

function fullWidthLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Format a GitHub timestamp with a compact, deterministic relative time. */
export function formatRelativeTime(
  updatedAt: string | null | undefined,
  now: string,
): string | undefined {
  if (!updatedAt) return undefined;
  const updated = Date.parse(updatedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(updated) || !Number.isFinite(current)) return undefined;
  const elapsed = Math.max(0, current - updated);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / (7 * day))}w ago`;
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}mo ago`;
  return `${Math.floor(elapsed / (365 * day))}y ago`;
}

type HeaderPiece = {
  kind: "focus" | "scroll" | "base" | "author" | "updated";
  text: string;
};

function reviewIdentity(options: OpenReviewViewOptions): string {
  const target = options.record.target;
  if (target.kind === "pr") {
    return options.pullRequest
      ? `#${options.pullRequest.number} ${options.pullRequest.title}`
      : `Pull request #${target.number}`;
  }
  if (target.kind === "branch") {
    return `Branch ${target.base} → ${target.target ?? "working tree"}`;
  }
  if (target.kind === "session-turn") return `Session turn ${target.turnIndex}`;
  return "Session changes";
}

function reviewHeaderLine(options: {
  view: OpenReviewViewOptions;
  width: number;
  theme: Theme;
  focus: string;
  scroll?: string;
  now: string;
}): string {
  const title = options.theme.fg("accent", options.theme.bold(reviewIdentity(options.view)));
  const pullRequest = options.view.pullRequest;
  const relativeTime = formatRelativeTime(pullRequest?.updatedAt, options.now);
  let pieces: HeaderPiece[] = [
    { kind: "focus", text: options.focus },
    ...(options.scroll
      ? [{ kind: "scroll" as const, text: options.theme.fg("dim", options.scroll) }]
      : []),
    ...(pullRequest ? [{ kind: "base" as const, text: `base ${pullRequest.baseRefName}` }] : []),
    ...(pullRequest?.author
      ? [{ kind: "author" as const, text: `@${pullRequest.author.login}` }]
      : []),
    ...(relativeTime ? [{ kind: "updated" as const, text: relativeTime }] : []),
  ];
  const rightWidth = () => visibleWidth(pieces.map((piece) => piece.text).join(" · "));
  const requiredWidth = () => visibleWidth(title) + 2 + rightWidth();
  for (const kind of ["scroll", "updated", "author", "base"] as const) {
    if (requiredWidth() <= options.width) break;
    pieces = pieces.filter((piece) => piece.kind !== kind);
  }
  const right = pieces.map((piece) => piece.text).join(" · ");
  const leftWidth = Math.max(0, options.width - rightWidth() - 2);
  const left = leftWidth > 0 ? truncateToWidth(title, leftWidth, "…") : "";
  const gap = " ".repeat(Math.max(0, options.width - visibleWidth(left) - visibleWidth(right)));
  return `${left}${gap}${right}`;
}

function currentEditorLine(state: ReviewViewState): number {
  const position = currentCommentPosition(state);
  if (position) return position.line;
  const hunk = currentHunk(state);
  const file = currentFile(state);
  if (!hunk || !file) return 1;
  return file.kind === "deleted" ? hunk.oldStart : hunk.newStart;
}

function currentReviewChatContext(
  state: ReviewViewState,
  reviewRoot: string,
): ReviewChatContext | undefined {
  const position = currentCommentPosition(state);
  const hunk = currentDisplayHunk(state);
  if (!position || !hunk) return undefined;
  const focusedLine = hunk.lines[state.lineIndex!];
  if (!focusedLine) return undefined;
  return {
    path: position.path,
    side: position.side,
    line: position.line,
    focusedLineText: focusedLine.text,
    hunkHeader: hunk.header,
    reviewRoot,
  };
}

function reviewEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const sourceLines = text.split("\n");
  const wrapped: string[] = [];
  for (const source of sourceLines) {
    if (source.length === 0) {
      wrapped.push("");
      continue;
    }
    let line = "";
    for (const character of source) {
      if (line.length > 0 && visibleWidth(`${line}${character}`) > width) {
        wrapped.push(line);
        line = character;
      } else line += character;
    }
    wrapped.push(line);
  }
  return wrapped;
}

function chatBodyLines(
  chat: ReviewChat,
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
  markdownTheme: MarkdownTheme,
  renderTool: (entry: ReviewChatToolCall, width: number) => string[],
  scrollOffset: number,
): { lines: string[]; offset: number } {
  let heading = focused
    ? theme.fg("accent", theme.bold("Agent chat [FOCUSED]"))
    : theme.bold("Agent chat");
  const messageWidth = Math.max(1, width - 2);
  // Agent replies go through the same Markdown renderer and theme as the
  // main Pi transcript, so headings, lists, code, and emphasis read the same
  // here as everywhere else. Questions stay plain text: they are shown as
  // typed, exactly like the main prompt's user messages.
  const content: string[] = [];
  for (const message of chat.messages) {
    if (content.length > 0) content.push("");
    if (message.role === "user") {
      const wrapped = wrapPlainText(message.text, Math.max(1, messageWidth - 2));
      content.push(
        ...wrapped.map((line, index) =>
          theme.fg("userMessageText", `${index === 0 ? "❯ " : "  "}${line}`),
        ),
      );
      continue;
    }
    if (message.role === "tool") {
      content.push(...renderTool(message, messageWidth));
      continue;
    }
    content.push(...new Markdown(message.text, 0, 0, markdownTheme).render(messageWidth));
  }
  if (content.length === 0) content.push(theme.fg("dim", "Ask about the selected diff line."));
  if (chat.pending) content.push(theme.fg("dim", "Agent is replying…"));
  // The pane scrolls: offset counts rows hidden below the viewport, so 0 is
  // the live tail and page keys walk back through the transcript.
  const visibleHeight = Math.max(0, height - 1);
  const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, content.length - visibleHeight)));
  if (offset > 0) heading += theme.fg("muted", ` · ↓${offset} below`);
  const end = content.length - offset;
  const visible = content.slice(Math.max(0, end - visibleHeight), end);
  const lines = [heading, ...visible];
  while (lines.length < height) lines.push("");
  return { lines: lines.slice(0, height), offset };
}

export async function openReviewView(
  options: OpenReviewViewOptions,
): Promise<ReviewViewResult | undefined> {
  const now = options.now ?? (() => new Date().toISOString());
  const createCommentId = options.createCommentId ?? randomUUID;
  const createChat = options.createReviewChat ?? createDefaultReviewChat;
  const markdownTheme = options.markdownTheme ?? getMarkdownTheme();
  const frameAdapter = await createZentuiFrameAdapter(options.zentuiLoader);
  let state = createReviewViewState(options);
  let terminalRows = 24;
  let chat: ReviewChat | undefined;
  let unsubscribeChat: (() => void) | undefined;
  // Handle for the review's own overlay, captured when Pi shows it. Needed so a
  // host prompt can be made visible; absent in hosts that ignore `onHandle`.
  let overlayHandle: OverlayHandle | undefined;

  try {
    return await options.host.custom<ReviewViewResult | undefined>(
      (tui, theme, _keybindings, done) => {
        terminalRows = tui.terminal.rows;
        let scrollOffset = 0;
        let followCursor = true;
        let busy = false;
        let chatOpen = false;
        let focus: ReviewPaneFocus = "review";
        let lastBodyHeight = reviewViewHeights(terminalRows).bodyHeight;
        const editorTheme = reviewEditorTheme(theme);
        // Two inputs, two providers, two histories. Both complete against the
        // review root rather than the process directory, because a pull request
        // review reads a checked-out worktree that is not the user's cwd.
        const commentInput = new ReviewInput(tui, editorTheme, { root: options.reviewRoot });
        // The chat input also completes its own runnable commands, exactly
        // like the main prompt: `/` opens the command menu, and arguments
        // complete from the live model catalog and Pi's thinking levels.
        const chatCommands: SlashCommand[] = [
          {
            name: "model",
            description: "Switch the chat's model",
            argumentHint: "<provider/model>",
            getArgumentCompletions: async (argumentPrefix) => {
              const models = (await options.listChatModels?.().catch(() => [])) ?? [];
              const needle = argumentPrefix.trim().toLowerCase();
              const matches = models.filter((model) => model.toLowerCase().includes(needle));
              return matches.length === 0
                ? null
                : matches.map((model) => ({ value: model, label: model }));
            },
          },
          {
            name: "effort",
            description: "Switch the chat's thinking level",
            argumentHint: "<level>",
            getArgumentCompletions: (argumentPrefix) => {
              const needle = argumentPrefix.trim().toLowerCase();
              const matches = REVIEW_CHAT_THINKING_LEVELS.filter((level) =>
                level.startsWith(needle),
              );
              return matches.length === 0
                ? null
                : matches.map((level) => ({ value: level, label: level }));
            },
          },
          {
            name: "reload",
            description: "Reload the chat session's extensions, skills, prompts, and context files",
          },
          {
            name: "quit",
            description: "Save the review and leave, like q",
          },
          {
            name: "exit",
            description: "Save the review and leave, like q",
          },
        ];
        const chatInput = new ReviewInput(tui, editorTheme, {
          root: options.reviewRoot,
          commands: chatCommands,
        });
        /**
         * Extend the command menu with everything the chat's session can
         * actually run. `chatCommands` is the same array the completion
         * provider reads, so appending here reaches the open menu too.
         */
        function refreshChatCommands(): void {
          if (!chat) return;
          const known = new Set(chatCommands.map((command) => command.name));
          for (const info of chat.commands()) {
            if (known.has(info.name)) continue;
            known.add(info.name);
            chatCommands.push({
              name: info.name,
              ...(info.description ? { description: info.description } : {}),
            });
          }
          tui.requestRender();
        }
        // Tool calls render through the exact component the main agent's
        // transcript uses, cached per call so a streaming result updates one
        // component instead of rebuilding it every frame.
        const toolViews = new Map<
          string,
          { component: ToolExecutionComponent; result?: unknown; done?: boolean }
        >();
        // Collapsed by default, exactly like the main transcript; Ctrl+O
        // flips every tool at once, matching the main agent's toggle.
        let toolsExpanded = false;
        // Rows of the chat transcript hidden below the viewport; 0 follows the tail.
        let chatScrollOffset = 0;
        function renderToolEntry(entry: ReviewChatToolCall, width: number): string[] {
          let view = toolViews.get(entry.toolCallId);
          if (!view) {
            // The session's registered definition carries the tool's own
            // renderers — exactly what the main transcript passes — so
            // extension and MCP tools render their concise titles instead
            // of the raw argument/output fallback.
            const definition = chat?.toolDefinition(entry.toolName) as
              | ConstructorParameters<typeof ToolExecutionComponent>[4]
              | undefined;
            const component = new ToolExecutionComponent(
              entry.toolName,
              entry.toolCallId,
              entry.args,
              undefined,
              definition,
              tui,
              options.reviewRoot,
            );
            component.setArgsComplete();
            component.markExecutionStarted();
            component.setExpanded(toolsExpanded);
            view = { component };
            toolViews.set(entry.toolCallId, view);
          }
          const result = entry.result as { content?: unknown; details?: unknown } | undefined;
          if (
            result &&
            Array.isArray(result.content) &&
            (view.result !== entry.result || view.done !== entry.done)
          ) {
            view.component.updateResult(
              { content: result.content, details: result.details, isError: entry.isError === true },
              !entry.done,
            );
            view.result = entry.result;
            view.done = entry.done;
          }
          // Expanded keeps the component's own wrapping at the pane width,
          // where full content is the point.
          if (toolsExpanded) return view.component.render(width);
          const wide = view.component.render(Math.max(width, COLLAPSED_TOOL_RENDER_WIDTH));
          // A failed tool keeps its message visible even collapsed; hiding
          // an error behind Ctrl+O would read as a hang.
          if (entry.isError === true) {
            return wide.map((line) => truncateToWidth(line, width, "…"));
          }
          // Collapsed to the maximum: the one-line call title, like a folded
          // row, with Ctrl+O holding everything else.
          const title = wide.find((line) => stripTerminalSequences(line).trim().length > 0);
          return title === undefined ? [] : [truncateToWidth(title, width, "…")];
        }
        function toggleToolExpansion(): void {
          toolsExpanded = !toolsExpanded;
          for (const view of toolViews.values()) view.component.setExpanded(toolsExpanded);
          tui.requestRender();
        }

        function changed(next: ReviewViewState, follow = true): void {
          state = next;
          followCursor = follow;
          tui.requestRender();
        }

        function stopComment(): void {
          commentInput.focused = false;
          changed(discardCommentDraft(state), false);
        }

        function submitComment(body: string): void {
          // Recall before the outcome is decided: a comment refused for being
          // empty is dropped by the history itself, and one that lands is worth
          // recalling when the next hunk needs the same remark.
          commentInput.remember(body);
          const withBody = updateCommentDraft(state, body);
          if (body.trim().length === 0) {
            changed(withBody, false);
            return;
          }
          commentInput.focused = false;
          changed(
            commitCommentDraft(withBody, {
              id: createCommentId(),
              timestamp: now(),
            }),
          );
        }

        commentInput.onSubmit = submitComment;

        function setFocus(next: ReviewPaneFocus): void {
          focus = next;
          chatInput.focused = next === "chat";
          followCursor = next === "review";
          tui.requestRender();
        }

        function openChat(): void {
          try {
            if (!chat) {
              chat = createChat({
                cwd: options.reviewRoot,
                ...(options.chatModel ? { model: options.chatModel } : {}),
                ...(options.chatThinkingLevel ? { thinkingLevel: options.chatThinkingLevel } : {}),
              });
              unsubscribeChat = chat.onUpdate(() => tui.requestRender());
              // Start the session now so the command menu, model status, and
              // first answer do not all wait for session creation later.
              void chat
                .prepare(options.reviewRoot)
                .then(() => refreshChatCommands())
                .catch(() => undefined);
            }
            chatOpen = true;
            setFocus("chat");
          } catch (error) {
            options.host.notify(error instanceof Error ? error.message : String(error), "error");
          }
        }

        function closeChat(): void {
          chatOpen = false;
          setFocus("review");
        }

        /** `/model` and `/effort` change the chat's own session, mirroring the main prompt's commands. */
        async function handleChatCommand(
          kind: "model" | "effort" | "reload",
          argument: string,
        ): Promise<void> {
          if (!chat) return;
          try {
            if (kind === "reload") {
              await chat.reload();
              options.host.notify(
                "Chat session resources reloaded: extensions, skills, prompts, and context files.",
                "info",
              );
              return;
            }
            if (kind === "model") {
              if (!argument) {
                options.host.notify(
                  `Chat model: ${chat.status.model ?? "Pi default"} · effort ${chat.status.thinkingLevel ?? "default"}`,
                  "info",
                );
                return;
              }
              const applied = await chat.setModel(argument);
              options.host.notify(`Chat model set to ${applied}.`, "info");
              return;
            }
            if (!argument) {
              options.host.notify(
                `Chat effort: ${chat.status.thinkingLevel ?? "default"} · levels: off, minimal, low, medium, high, xhigh, max`,
                "info",
              );
              return;
            }
            const applied = await chat.setThinkingLevel(argument);
            options.host.notify(`Chat effort set to ${applied}.`, "info");
          } catch (error) {
            options.host.notify(error instanceof Error ? error.message : String(error), "error");
          } finally {
            tui.requestRender();
          }
        }

        function submitChat(question: string): void {
          const prompt = question.trim();
          // pi-tui clears the editor before this runs, so a question the agent
          // cannot take yet would otherwise be lost. History is what gets it back.
          chatInput.remember(question);
          if (!chat || prompt.length === 0) return;
          // Commands need no diff context and may run while a reply streams;
          // only a real question waits for the previous turn.
          const command = prompt.match(/^\/(model|effort|reload|quit|exit)(?:\s+(.*))?$/);
          if (command) {
            chatInput.setText("");
            if (command[1] === "quit" || command[1] === "exit") {
              // Leaving from the chat behaves exactly like `q`: the review
              // record is saved and the view closes.
              void guarded(() => save("save"));
              return;
            }
            const kind =
              command[1] === "model" ? "model" : command[1] === "effort" ? "effort" : "reload";
            void handleChatCommand(kind, command[2]?.trim() ?? "");
            return;
          }
          // Every other slash command routes to the chat session's own command
          // surface: extension commands execute, skills and prompt templates
          // run as real turns — the same behavior as the main prompt.
          const sessionCommand = prompt.match(/^\/(\S+)(?:\s|$)/);
          if (sessionCommand) {
            const name = sessionCommand[1]!;
            if (!chat.commands().some((info) => info.name === name)) {
              // Leave the typo in the editor for correction.
              chatInput.setText(prompt);
              options.host.notify(`/${name} is not available in the review chat.`, "warning");
              tui.requestRender();
              return;
            }
            chatInput.setText("");
            tui.requestRender();
            void chat.runCommand(prompt, options.reviewRoot).catch((error: unknown) => {
              options.host.notify(error instanceof Error ? error.message : String(error), "error");
              tui.requestRender();
            });
            return;
          }
          if (chat.pending) return;
          const context = currentReviewChatContext(state, options.reviewRoot);
          if (!context) {
            options.host.notify("Select an expanded diff line before asking the agent.", "warning");
            return;
          }
          chatScrollOffset = 0;
          chatInput.setText("");
          tui.requestRender();
          try {
            void chat.ask(prompt, context).catch((error: unknown) => {
              options.host.notify(error instanceof Error ? error.message : String(error), "error");
              tui.requestRender();
            });
          } catch (error) {
            options.host.notify(error instanceof Error ? error.message : String(error), "error");
          }
        }

        chatInput.onSubmit = submitChat;

        async function guarded(action: () => Promise<void>): Promise<void> {
          if (busy) return;
          busy = true;
          try {
            await action();
          } catch (error) {
            options.host.notify(error instanceof Error ? error.message : String(error), "error");
          } finally {
            busy = false;
            tui.requestRender();
          }
        }

        /**
         * Run a host prompt that draws into the session's own editor row.
         *
         * The review is a focus-capturing overlay: while it is visible it covers
         * the editor row and holds the keyboard. A `select` or `input` opened from
         * inside it is mounted underneath, so it renders invisibly while taking
         * focus away from the review — the user sees a frozen review, every key
         * reaches a prompt that is not on screen, and the awaited promise never
         * settles. Hiding the overlay for the duration puts the prompt where it
         * can be seen and answered, and restores the review afterwards.
         */
        async function withHostPrompt<T>(prompt: () => Promise<T>): Promise<T> {
          overlayHandle?.setHidden(true);
          try {
            return await prompt();
          } finally {
            overlayHandle?.setHidden(false);
            tui.requestRender(true);
          }
        }

        async function expandContext(): Promise<void> {
          const file = currentFile(state);
          const hunk = currentHunk(state);
          if (!file || !hunk || !currentCommentPosition(state)) {
            options.host.notify(
              "Select an expanded hunk line before expanding context.",
              "warning",
            );
            return;
          }
          const expansion = hunkExpansion(state, hunk.id) ?? { above: [], below: [] };
          const expandEdge = (edge: "above" | "below") =>
            expandHunkContext({
              cwd: options.reviewRoot,
              model: state.model,
              file,
              hunk,
              edge,
              expansion,
              expandedContext: state.expandedContext,
              runner: options.execRunner,
            });
          const [above, below] = await Promise.all([expandEdge("above"), expandEdge("below")]);
          if (above.addedLines + below.addedLines === 0) {
            options.host.notify("No more unchanged context to expand.", "info");
            return;
          }
          changed(
            setHunkExpansion(state, hunk.id, {
              above: above.expansion.above,
              below: below.expansion.below,
            }),
          );
        }

        function collapseContext(): void {
          const hunk = currentHunk(state);
          if (!hunk || !currentCommentPosition(state)) {
            options.host.notify(
              "Select an expanded hunk line before collapsing context.",
              "warning",
            );
            return;
          }
          const expansion = hunkExpansion(state, hunk.id) ?? { above: [], below: [] };
          if (expansion.above.length === 0 && expansion.below.length === 0) {
            options.host.notify("No expanded context to collapse.", "info");
            return;
          }
          changed(
            setHunkExpansion(
              state,
              hunk.id,
              collapseHunkContext(collapseHunkContext(expansion, "above"), "below"),
            ),
          );
        }

        async function save(action: "save" | "finish"): Promise<void> {
          state = saveAndClose(state, action, now());
          await options.store.save(state.record);
          if (action === "save") {
            done({ action, record: state.record });
            return;
          }
          const markdown = renderReviewMarkdown(state.record);
          const agentInstruction = composeSessionReviewInstruction(state.record, markdown);
          if (agentInstruction) options.host.setEditorText(agentInstruction);
          done({
            action,
            record: state.record,
            markdown,
            ...(agentInstruction ? { agentInstruction } : {}),
          });
        }

        async function finish(): Promise<void> {
          if (state.record.target.kind === "pr") {
            const choices = [
              "Comment",
              "Approve",
              "Request changes",
              "Pending draft to inspect on GitHub",
            ] as const;
            const selected = await withHostPrompt(() =>
              options.host.select("Pull request outcome", [...choices]),
            );
            if (selected === undefined) return;
            const verdict =
              selected === choices[0]
                ? "comment"
                : selected === choices[1]
                  ? "approve"
                  : selected === choices[2]
                    ? "request-changes"
                    : undefined;
            const body = await withHostPrompt(() =>
              options.host.input(
                "Overall review summary (required for comment and request changes)",
                state.record.body ?? "",
              ),
            );
            if (body === undefined) return;
            const { verdict: _verdict, body: _body, ...record } = state.record;
            state = {
              ...state,
              record: {
                ...record,
                ...(verdict === undefined ? {} : { verdict }),
                ...(body.trim() ? { body: body.trim() } : {}),
                updatedAt: now(),
              },
            };
          }
          await save("finish");
        }

        async function search(): Promise<void> {
          const query = await withHostPrompt(() =>
            options.host.input("Search changed lines", state.search?.query ?? ""),
          );
          if (query === undefined) return;
          changed(setSearchQuery(state, query));
        }

        function comment(): void {
          const withDraft = beginCommentDraft(state);
          if (!withDraft.commentDraft) {
            options.host.notify("Select an expanded diff line before commenting.", "warning");
            return;
          }
          commentInput.setText("");
          commentInput.focused = true;
          changed(withDraft, false);
        }

        async function editCurrentHunk(): Promise<void> {
          const file = currentFile(state);
          if (!file) return;
          await launchEditor(
            options.config.editor,
            {
              path: resolve(options.reviewRoot, file.path),
              line: currentEditorLine(state),
              column: 1,
              dir: options.reviewRoot,
            },
            tui,
            options.spawnEditor,
          );
        }

        return {
          render: (width: number) => {
            const contentWidth = Math.max(1, width);
            const splitChat = chatOpen && contentWidth >= REVIEW_CHAT_SPLIT_MIN_WIDTH;
            const chatWidth = splitChat
              ? Math.max(40, Math.floor(contentWidth * 0.4))
              : contentWidth;
            const diffWidth = splitChat ? contentWidth - chatWidth - 1 : contentWidth;
            const files = fileListLines(state, diffWidth, theme);
            const diff = diffBody(state, diffWidth, options.styler, options.config);
            // A rule reads as structure where a blank row reads as accident.
            const rule = theme.fg("borderMuted", "─".repeat(Math.max(1, diffWidth)));
            const body = [...files, rule, ...diff.lines];
            const selectedLine = files.length + 1 + diff.selectedLine;
            terminalRows = tui.terminal.rows;
            const target = commentTargetLine(state, theme);
            const status = `${statusLine(state, theme)} · ${target}`;
            let inputLines: string[];
            let hintLineOne: string;
            let hintLineTwo: string;
            // zentui's frame names the model, provider, and effort under the
            // text, exactly as it does for the session prompt. The chat is
            // the session behind both boxes, so both name it.
            const frameModel = (() => {
              const model = chat?.status.model ?? options.chatModel;
              const thinkingLevel = chat?.status.thinkingLevel ?? options.chatThinkingLevel;
              if (!model && !thinkingLevel) return undefined;
              const [provider, ...rest] = (model ?? "").split("/");
              const identifier = rest.join("/");
              return {
                label: identifier || model || "",
                ...(identifier && provider ? { provider } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
              };
            })();
            const framedInput = (input: ReviewInput): string[] =>
              frameAdapter.frame({
                width: contentWidth,
                ...input.render(frameAdapter.editorWidth(contentWidth)),
                cwd: options.reviewRoot,
                uiTheme: theme,
                ...(frameModel ? { model: frameModel } : {}),
              });
            if (state.commentDraft) {
              const draftPosition = state.commentDraft.position;
              inputLines = framedInput(commentInput);
              hintLineOne = "Comment · Enter submit · Shift+Enter newline · Tab path · Esc cancel";
              hintLineTwo =
                draftPosition.startLine === undefined
                  ? "Comment attaches only to the selected visible line"
                  : `Comment attaches to selected lines ${rangeLabel(draftPosition)} on ${draftPosition.side}`;
            } else if (focus === "chat") {
              inputLines = framedInput(chatInput);
              hintLineOne =
                "Ask agent · Enter ask · Shift+Enter newline · Ctrl+O tool output · Shift+Tab review · Esc close chat";
              hintLineTwo =
                "Context: selected file, side, line, focused row, and current hunk only · /model /effort /reload act on the chat";
            } else {
              inputLines = [
                theme.fg("dim", "Input inactive · c writes a review comment · a asks the agent"),
              ];
              hintLineOne = `j/k or ↑/↓ line · Shift+↑/↓ select lines · [/] hunk · n/p or →/← file · PgUp/PgDn page${chatOpen ? " · Tab focus chat · Ctrl+O tool output" : ""}`;
              hintLineTwo =
                "+/- hunk context · Space fold · c comment · a ask · / search · N/P match · v mode · m reviewed · e/E editor · S finish · q save";
            }
            // Without zentui the input has no metadata row, so the keys row
            // carries the model and effort instead of dropping them.
            const chatModelStatus = (() => {
              if (frameAdapter.available || !chatOpen || !chat) return undefined;
              const text = [chat.status.model?.split("/").at(-1), chat.status.thinkingLevel]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return text || undefined;
            })();
            const hintOneRow = (() => {
              const left = theme.fg("dim", hintLineOne);
              if (!chatModelStatus) return left;
              const right = theme.fg("muted", chatModelStatus);
              const gap = contentWidth - visibleWidth(left) - visibleWidth(right);
              // A narrow terminal keeps the keys and drops the status.
              if (gap < 2) return left;
              return `${left}${" ".repeat(gap)}${right}`;
            })();
            const footer = [status, ...inputLines, hintOneRow, theme.fg("dim", hintLineTwo)];
            const reservedRows = Math.min(terminalRows, 1 + footer.length);
            lastBodyHeight = Math.max(0, terminalRows - reservedRows);
            const maximumOffset = Math.max(0, body.length - lastBodyHeight);
            if (followCursor && lastBodyHeight > 0) {
              if (selectedLine < scrollOffset) scrollOffset = selectedLine;
              else if (selectedLine >= scrollOffset + lastBodyHeight) {
                scrollOffset = selectedLine - lastBodyHeight + 1;
              }
              followCursor = false;
            }
            scrollOffset = Math.max(0, Math.min(maximumOffset, scrollOffset));
            const visibleDiff = body.slice(scrollOffset, scrollOffset + lastBodyHeight);
            const hiddenBelow = Math.max(0, body.length - (scrollOffset + visibleDiff.length));
            while (visibleDiff.length < lastBodyHeight) visibleDiff.push("");

            let visibleBody = visibleDiff.map((line) => fullWidthLine(line, contentWidth));
            if (chatOpen && chat) {
              const chatBody = chatBodyLines(
                chat,
                chatWidth,
                lastBodyHeight,
                focus === "chat",
                theme,
                markdownTheme,
                renderToolEntry,
                chatScrollOffset,
              );
              chatScrollOffset = chatBody.offset;
              const visibleChat = chatBody.lines;
              if (splitChat) {
                visibleBody = visibleDiff.map(
                  (line, index) =>
                    `${fullWidthLine(line, diffWidth)}${theme.fg("dim", "│")}${fullWidthLine(visibleChat[index] ?? "", chatWidth)}`,
                );
              } else if (focus === "chat") {
                visibleBody = visibleChat.map((line) => fullWidthLine(line, contentWidth));
              }
            }

            const diffVisible = splitChat || focus === "review";
            const scroll =
              diffVisible && (scrollOffset > 0 || hiddenBelow > 0)
                ? `↑${scrollOffset} ↓${hiddenBelow}`
                : undefined;
            const reviewFocus = focus === "review" ? "Review [FOCUSED]" : "Review";
            const chatFocus = !chatOpen
              ? ""
              : focus === "chat"
                ? " · Chat [FOCUSED]"
                : " · Chat open";
            const header = reviewHeaderLine({
              view: options,
              width: contentWidth,
              theme,
              focus: `${reviewFocus}${chatFocus}`,
              ...(scroll ? { scroll } : {}),
              now: now(),
            });
            const footerRows = footer.slice(0, Math.max(0, reservedRows - 1));
            return [
              ...(reservedRows > 0 ? [fullWidthLine(header, contentWidth)] : []),
              ...visibleBody,
              ...footerRows.map((line) => fullWidthLine(line, contentWidth)),
            ];
          },
          invalidate: () => {
            followCursor = true;
            commentInput.invalidate();
            chatInput.invalidate();
            for (const view of toolViews.values()) view.component.invalidate();
          },
          handleInput: (data: string) => {
            // A focused input owns the keys the prompt gives it: ↑/↓ move
            // through the text and reach history at the edges, Tab completes a
            // path, and an open completion list takes Esc to dismiss itself
            // before the view reads Esc as leaving.
            if (state.commentDraft) {
              if (matchesKey(data, "escape") && !commentInput.isShowingAutocomplete())
                stopComment();
              else {
                commentInput.handleInput(data);
                if (state.commentDraft) state = updateCommentDraft(state, commentInput.getText());
                tui.requestRender();
              }
              return;
            }
            // The main agent's Ctrl+O owns tool-output expansion, so the
            // review chat honors it from either pane whenever tools exist.
            if (matchesKey(data, "ctrl+o") && chatOpen) {
              toggleToolExpansion();
              return;
            }
            if (focus === "chat") {
              // Tab belongs to the editor here, so returning to the diff moves
              // to Shift+Tab rather than costing the chat its completions.
              if (matchesKey(data, "shift+tab")) setFocus("review");
              else if (matchesKey(data, "escape") && !chatInput.isShowingAutocomplete())
                closeChat();
              // The input has no use for page keys, so they scroll the
              // transcript pane instead, one viewport at a time.
              else if (matchesKey(data, "pageUp")) {
                chatScrollOffset += Math.max(1, lastBodyHeight - 2);
                tui.requestRender();
              } else if (matchesKey(data, "pageDown")) {
                chatScrollOffset = Math.max(0, chatScrollOffset - Math.max(1, lastBodyHeight - 2));
                tui.requestRender();
              } else {
                chatInput.handleInput(data);
                tui.requestRender();
              }
              return;
            }
            if ((matchesKey(data, "tab") || matchesKey(data, "shift+tab")) && chatOpen) {
              setFocus("chat");
              return;
            }
            if (busy) return;
            // Shift is read before plain movement: extending keeps the anchor,
            // while every plain move collapses the selection back to one line.
            if (matchesKey(data, "shift+down")) changed(extendSelection(state, 1));
            else if (matchesKey(data, "shift+up")) changed(extendSelection(state, -1));
            else if (data === "j" || matchesKey(data, "down")) changed(moveLine(state, 1));
            else if (data === "k" || matchesKey(data, "up")) changed(moveLine(state, -1));
            else if (data === "]") changed(moveHunk(state, 1));
            else if (data === "[") changed(moveHunk(state, -1));
            else if (data === "n" || matchesKey(data, "right")) changed(moveFile(state, 1));
            else if (data === "p" || matchesKey(data, "left")) changed(moveFile(state, -1));
            else if (data === "N") changed(moveSearchMatch(state, 1));
            else if (data === "P") changed(moveSearchMatch(state, -1));
            else if (data === "+") void guarded(expandContext);
            else if (data === "-") collapseContext();
            else if (matchesKey(data, "space")) changed(toggleCurrentFold(state));
            else if (data === "/") void guarded(search);
            else if (data === "c") comment();
            else if (data === "a") openChat();
            else if (data === "e") void guarded(editCurrentHunk);
            else if (data === "E")
              void guarded(() =>
                launchEditorProject(
                  options.config.editor,
                  options.reviewRoot,
                  tui,
                  options.spawnEditor,
                ),
              );
            else if (data === "v") changed(toggleDiffMode(state));
            else if (data === "m") changed(markCurrentHunkReviewed(state, now()));
            else if (data === "S") void guarded(finish);
            else if (data === "q") void guarded(() => save("save"));
            else if (matchesKey(data, "pageUp"))
              changed(moveLine(state, -Math.max(1, lastBodyHeight - 2)));
            else if (matchesKey(data, "pageDown"))
              changed(moveLine(state, Math.max(1, lastBodyHeight - 2)));
            else if (data === "t") {
              options.host.notify(
                "Type information from review is planned for a later phase.",
                "info",
              );
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({
          width: "100%",
          maxHeight: reviewViewHeights(terminalRows).overlayMaxHeight,
          margin: 0,
        }),
        onHandle: (handle) => {
          overlayHandle = handle;
        },
      },
    );
  } finally {
    unsubscribeChat?.();
    chat?.dispose();
  }
}
