/**
 * The full-screen review (`/review-assist`): the shared changes view
 * (`lib/changes/view/changes-view.ts`, the same view `/diff` docks beside the
 * transcript) with a line cursor, mounted in a host that fills the terminal
 * and adds the review's footer, comment editor and side chat.
 *
 * The view reads a store that lives as long as the review: static for pull
 * requests and commit ranges, re-read on `r` and after the side chat's tool
 * calls for targets that end at the working tree.
 */
import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isJsonRecord, isString, type RuntimeValue } from "../../lib/runtime-values.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
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
  type TuiMouseEvent,
  type TuiMouseEventResult,
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
import {
  collapseHunkContext,
  EXPANSION_LIMIT,
  EXPANSION_STEP,
  expandHunkContext,
  hunkWithExpandedContext,
  type HunkExpansion,
} from "../core/expand.ts";
import { assessDiff, type DiffAssessment } from "../core/heuristics.ts";
import { renderReviewMarkdown } from "../core/markdown-export.ts";
import { locateComment, revealedContextFits, type CommentLocation } from "../core/anchor.ts";
import { markHunksReviewed } from "../core/store.ts";
import {
  sanitizeTerminalLines,
  sanitizeTerminalText as safe,
} from "../../lib/changes/terminal-text.ts";
import { renderDiffFile, type DiffStyler } from "../../lib/changes/render/diff-render.ts";
import { createHighlight } from "../../lib/changes/render/highlight.ts";
import type { DiffSource, FileSummary, SnapshotBaseline } from "../../lib/changes/git/model.ts";
import { BODY_INDENT, type BodyAnnotation } from "../../lib/changes/view/body-block.ts";
import {
  ChangesView,
  HIDDEN_CONTENTS,
  type AskTarget,
  type FileBodyRenderer,
  type PaneActions,
  type RowDetail,
} from "../../lib/changes/view/changes-view.ts";
import { clipboardText } from "../../lib/changes/references.ts";
import { actionFor } from "../../lib/changes/view/keys.ts";
import { changedLineMatches } from "../../lib/changes/view/line-cursor.ts";
import { plural, type PaneStyler, type RowBadge } from "../../lib/changes/view/rows.ts";
import type { PaneScroller } from "../../lib/changes/view/surface.ts";
import type { FindingsSummary } from "../../lib/changes/findings.ts";
import {
  createModelStore,
  type ModelStoreOptions,
  type RevealedFile,
} from "../../lib/changes/model-store.ts";
import { isSensitivePath } from "../../lib/changes/sensitive.ts";
import type {
  DiffHunk,
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
} from "../core/types.ts";
import { ReviewInput } from "./review-input.ts";
import {
  REVIEW_HELP_LINES,
  REVIEW_KEY_HINT,
  REVIEW_KEYS,
  SPLIT_TOGGLE_KEY,
} from "./review-keys.ts";
import { createZentuiFrameAdapter, type ZentuiLoader } from "./zentui-frame.ts";
import { commitComment, type CommentDraft, type DiffViewMode } from "./view-state.ts";

export type { RevealedFile } from "../../lib/changes/model-store.ts";

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
  /** Puts text on the system clipboard; omitted means the review cannot copy. */
  copyText?(text: string): Promise<void>;
  createCommentId?: () => string;
  createReviewChat?: typeof createDefaultReviewChat;
  execRunner?: ExecRunner;
  zentuiLoader?: ZentuiLoader;
  /** Markdown theme for agent replies; defaults to the main Pi transcript theme. */
  markdownTheme?: MarkdownTheme;
  /** Models offered by `/model` argument completion, as `provider/id` strings. */
  listChatModels?: () => Promise<string[]>;
};

/** Recorded reviewer findings and the last change time of each listed file. */
export type ReviewFindings = {
  recorded: FindingsSummary;
  changeTimes: ReadonlyMap<string, number | null>;
};

export type OpenReviewViewOptions = ReviewViewDependencies & {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
  config: ResolvedReviewConfig;
  reviewRoot: string;
  /**
   * Reads a hidden sensitive file's contents after the user presses `v` on
   * it. Without it the file stays hidden.
   */
  revealFile?: RevealFile;
  /**
   * Re-reads the target, for `r` and after the side chat's tool calls. Only
   * targets that end at the working tree pass it; the others cannot change.
   */
  reload?: () => Promise<DiffModel>;
  /** Recorded reviewer findings for `f`/`F`, read on open and after each refresh. */
  loadFindings?: (paths: readonly string[]) => Promise<ReviewFindings>;
  /** For a session target: where its changes start, as `/diff` names it. */
  sessionBaseline?: SnapshotBaseline;
  /**
   * Whether the reviewed changes end at the working tree, so Finish places an
   * instruction to address the comments in the prompt editor. Defaults to
   * what the target implies (see `targetIncludesWorkingTree`).
   */
  includesWorkingTree?: boolean;
  /** Tests only: shorter limits than FINISH_WAIT_MS and LEAVE_SAVE_MS. */
  limits?: { finishWaitMs?: number; leaveSaveMs?: number };
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
  /**
   * Finish only: the context the reader revealed around hunks, by hunk id, so
   * a pull-request submission locates comments written on it the way the
   * view did.
   */
  expandedContext?: ReadonlyMap<string, HunkExpansion>;
};

/** The longest Finish waits for work that can move comments (refresh, context read, reveal). */
export const FINISH_WAIT_MS = 10_000;
/** The longest q's save may take before the review stays open and says so. */
export const LEAVE_SAVE_MS = 5_000;

/** A step in flight that can move where comments are; `settled` is false when it failed. */
type CoordinateWork = {
  label: string;
  affects: (comment: ReviewComment) => boolean;
  settled: Promise<boolean>;
};

export type RevealFile = (path: string) => Promise<RevealedFile>;

/** The changes view's own words on a hidden sensitive file, repeated where `e` refuses one. */
export const HIDDEN_FILE_HINT = HIDDEN_CONTENTS;

/**
 * True for targets whose head is the working tree: a whole session, a
 * session turn with no later turn, and a branch review without a target. The
 * caller knows which turn is last; without it a session turn counts.
 */
export function targetIncludesWorkingTree(target: ReviewRecord["target"]): boolean {
  if (target.kind === "branch") return target.target === undefined;
  return target.kind === "session" || target.kind === "session-turn";
}

/**
 * The instruction Finish places in the prompt editor for a review of the
 * working tree. It is never sent: the user reads it and presses Enter.
 */
export function composeSessionReviewInstruction(
  record: ReviewRecord,
  markdown: string,
  includesWorkingTree = targetIncludesWorkingTree(record.target),
): string | undefined {
  // A pull request's comments go to GitHub, not to the agent.
  if (record.target.kind === "pr") return undefined;
  // Every other target's comments reach the editor. Only a comparison that ends
  // at the working tree can be "addressed" as is; an earlier turn or a fixed
  // range is described as what it is.
  const lead = includesWorkingTree
    ? "Please address the following human code review. Resolve each comment, preserve unrelated behavior, and report any comment you cannot address."
    : "The following human code review refers to an earlier comparison, not the working tree; its lines may not match the files as they are now. Read each comment against that comparison before acting on it.";
  return [lead, "", markdown.trimEnd()].join("\n");
}

/** What the view's header names for a review target (the review's own title line names it in full). */
function sourceOfTarget(target: ReviewRecord["target"]): DiffSource {
  switch (target.kind) {
    case "session":
      return { kind: "session" };
    case "session-turn":
      return { kind: "since-checkpoint", checkpointId: "", label: `turn ${target.turnIndex}` };
    case "branch":
      return target.target === undefined
        ? { kind: "branch-base", base: target.base }
        : {
            kind: "range",
            base: target.base,
            head: target.target,
            label: `${target.base}…${target.target}`,
          };
    case "pr":
      return { kind: "range", base: "", head: "", label: `pull request #${target.number}` };
  }
}

/** The pane's outdated-note line, for a review comment: `✎ (outdated, was path:line) text`. */
function outdatedCommentLines(
  comment: ReviewComment,
  withPath: boolean,
  width: number,
  styler: Pick<DiffStyler, "fg">,
): string[] {
  const range = rangeLabel(comment);
  const was = withPath
    ? `${range.includes("-") ? "lines" : "line"} ${range}`
    : `${comment.path}:${range}`;
  const head = withPath ? `✎ ${comment.path} (outdated, was ${was})` : `✎ (outdated, was ${was})`;
  const text = safe(`${head} ${comment.body.split("\n")[0] ?? ""}`);
  return [truncateToWidth(`${BODY_INDENT}  ${styler.fg("dim", text)}`, width, "…")];
}

function commentBlock(
  comment: ReviewComment,
  width: number,
  styler: Pick<DiffStyler, "fg">,
): string[] {
  const bar = styler.fg("accent", " ▎ ");
  const label = `● ${rangeLabel(comment)} `;
  const labelWidth = visibleWidth(label);
  const bodyWidth = Math.max(1, width - 3 - labelWidth);
  return wrapPlainText(sanitizeTerminalLines(comment.body), bodyWidth).map((line, index) =>
    index === 0
      ? `${bar}${styler.fg("accent", label)}${styler.fg("muted", line)}`
      : `${bar}${" ".repeat(labelWidth)}${styler.fg("muted", line)}`,
  );
}

/** The row a comment sits under: its line on its side, or undefined when no longer displayed. */
function commentLineIndex(hunk: DiffHunk, comment: Pick<ReviewComment, "side" | "line">): number {
  return hunk.lines.findIndex((line) =>
    comment.side === "LEFT"
      ? line.kind !== "add" && line.oldLine === comment.line
      : line.kind !== "del" && line.newLine === comment.line,
  );
}

/**
 * A tool call's arguments or output with every string terminal-safe, for
 * display only: the chat's agent and the repository control these strings.
 * Tabs and line breaks stay, as the tool renderers lay them out.
 */

function terminalSafeValue(value: RuntimeValue): RuntimeValue {
  if (isString(value)) {
    return value
      .split("\t")
      .map((part) => sanitizeTerminalLines(part))
      .join("\t");
  }
  if (Array.isArray(value)) return value.map((item: RuntimeValue) => terminalSafeValue(item));
  if (isJsonRecord(value)) {
    const safeRecord: Record<string, RuntimeValue> = {};
    for (const [key, item] of Object.entries(value)) safeRecord[key] = terminalSafeValue(item);
    return safeRecord;
  }
  return value;
}
type ReviewPaneFocus = "review" | "chat";
type ToolExecutionDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

function withBuiltInRenderers(
  name: string,
  definition: ToolExecutionDefinition,
  cwd: string,
  cache: Map<string, ToolExecutionDefinition>,
): ToolExecutionDefinition {
  let builtIn = cache.get(name);
  if (!cache.has(name)) {
    try {
      switch (name) {
        case "read":
          builtIn = createReadToolDefinition(cwd);
          break;
        case "bash":
          builtIn = createBashToolDefinition(cwd);
          break;
        case "powershell":
          builtIn = createPowerShellToolDefinition(cwd);
          break;
        case "edit":
          builtIn = createEditToolDefinition(cwd);
          break;
        case "write":
          builtIn = createWriteToolDefinition(cwd);
          break;
        case "grep":
          builtIn = createGrepToolDefinition(cwd);
          break;
        case "find":
          builtIn = createFindToolDefinition(cwd);
          break;
        case "ls":
          builtIn = createLsToolDefinition(cwd);
          break;
        default:
          builtIn = undefined;
      }
    } catch {
      builtIn = undefined;
    }
    cache.set(name, builtIn);
  }

  if (!definition) return builtIn;
  if (!builtIn) return definition;
  return {
    ...definition,
    renderCall: definition.renderCall ?? builtIn.renderCall,
    renderResult: definition.renderResult ?? builtIn.renderResult,
  };
}

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

export type ReviewViewHeights = {
  bodyHeight: number;
  overlayMaxHeight: "100%";
  reservedRows: number;
};

export function reviewViewHeights(terminalRows: number): ReviewViewHeights {
  const rows = Math.max(0, terminalRows);
  const reservedRows = Math.min(REVIEW_CHROME_ROWS, rows);
  return {
    bodyHeight: rows - reservedRows,
    overlayMaxHeight: "100%",
    reservedRows,
  };
}

/** `startLine` is absent for a single line, so the label never fakes a range. */
function rangeLabel(position: { line: number; startLine?: number }): string {
  return position.startLine === undefined
    ? `${position.line}`
    : `${position.startLine}-${position.line}`;
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
      ? `#${options.pullRequest.number} ${safe(options.pullRequest.title)}`
      : `Pull request #${target.number}`;
  }
  if (target.kind === "branch") {
    return `Branch ${safe(target.base)} → ${target.target === undefined ? "working tree" : safe(target.target)}`;
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
    ...(pullRequest
      ? [{ kind: "base" as const, text: `base ${safe(pullRequest.baseRefName)}` }]
      : []),
    ...(pullRequest?.author
      ? [{ kind: "author" as const, text: `@${safe(pullRequest.author.login)}` }]
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

type ChatBody = { lines: string[]; offset: number };

function chatBodyLines(
  chat: ReviewChat,
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
  markdownTheme: MarkdownTheme,
  renderTool: (entry: ReviewChatToolCall, width: number) => string[],
  scrollOffset: number,
): ChatBody {
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
      const wrapped = wrapPlainText(
        sanitizeTerminalLines(message.text),
        Math.max(1, messageWidth - 2),
      );
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
    // Model output: its control characters are drawn as glyphs, never sent to the terminal.
    content.push(
      ...new Markdown(sanitizeTerminalLines(message.text), 0, 0, markdownTheme).render(
        messageWidth,
      ),
    );
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

/** The first line of a thrown value's message, safe to draw. */
function failureLine(error: RuntimeValue): string {
  const raw = error instanceof Error ? error.message : String(error);
  return safe((raw.split(/\r?\n/u)[0] ?? "").trim() || "unknown error");
}

export async function openReviewView(
  options: OpenReviewViewOptions,
): Promise<ReviewViewResult | undefined> {
  const now = options.now ?? (() => new Date().toISOString());
  const createCommentId = options.createCommentId ?? randomUUID;
  const createChat = options.createReviewChat ?? createDefaultReviewChat;
  const markdownTheme = options.markdownTheme ?? getMarkdownTheme();
  const frameAdapter = await createZentuiFrameAdapter(options.zentuiLoader);
  const config = options.config;
  let record = options.record;
  let assessments = options.assessments;
  let mode: DiffViewMode = "unified";
  let commentDraft: CommentDraft | undefined;
  /** Display-only context around hunks, keyed by the stable hunk id. */
  const expansions = new Map<string, HunkExpansion>();
  // Messages can embed repository text (paths, git errors) and chat errors.
  // The review covers the whole screen, so Pi's own notifications are drawn
  // behind it: while the view is open every message goes to its message line
  // (which keeps it until another replaces it). Errors are also sent to Pi's
  // notifications, so they can still be read after the review closes.
  // Many callers report from work nothing awaits (refreshes, chat commands,
  // key actions), so this never throws: a stale context after the session
  // ended is silent, and any other host failure leaves the message line as
  // the only copy.
  let repaint: () => void = () => {};
  const notify = (message: string, type?: Parameters<ReviewViewHost["notify"]>[1]): void => {
    const open = view !== undefined && !closed;
    if (open) {
      view?.setMessage(message, type === "error" || type === "warning" ? type : "muted");
      repaint();
      if (type !== "error") return;
    }
    try {
      options.host.notify(safe(message), type);
    } catch {
      // A stale context (the session ended) stays silent. Any other host failure has
      // no other place to go: while the view is open its message line holds the text.
    }
  };
  let terminalRows = 24;
  let chat: ReviewChat | undefined;
  let unsubscribeChat: (() => void) | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let view: ChangesView | undefined;
  // Handle for the review's own overlay, captured when Pi shows it. Needed so a
  // host prompt can be made visible; absent in hosts that ignore `onHandle`.
  let overlayHandle: OverlayHandle | undefined;
  /** Set when the view closes; results that arrive later (a reveal, a refresh, a context read) are dropped. */
  let closed = false;
  const storeOptions: ModelStoreOptions = {
    model: options.model,
    source: sourceOfTarget(record.target),
    repoRoot: options.reviewRoot,
  };
  /**
   * Work in flight that can move where comments are: a refresh (r, or after a
   * chat tool call), a reveal of a hidden file, a context read for comments
   * on revealed context. Finish waits for it; q's save marks what it affects
   * as unconfirmed. Each is bounded by the git runner's own limit (30 s per
   * command); Finish waits at most FINISH_WAIT_MS for all of it.
   */
  const coordinateWork = new Set<CoordinateWork>();
  const finishWaitMs = options.limits?.finishWaitMs ?? FINISH_WAIT_MS;
  const leaveSaveMs = options.limits?.leaveSaveMs ?? LEAVE_SAVE_MS;
  /** Set by the view: run after a tracked step settles, so the record follows it. */
  let afterWork: (() => void) | undefined;
  /**
   * Reads that failed, by kind ("refresh", "context", "reveal:<path>"), with
   * the comments they could have moved. Those comments stay unconfirmed in
   * every follow, save and Finish until a later read of the same kind succeeds.
   */
  const failedReads = new Map<string, (comment: ReviewComment) => boolean>();
  function trackWork<T>(
    kind: string,
    label: string,
    affects: (comment: ReviewComment) => boolean,
    work: Promise<T>,
  ): Promise<T> {
    void work.then(
      () => failedReads.delete(kind),
      () => failedReads.set(kind, affects),
    );
    const entry: CoordinateWork = {
      label,
      affects,
      settled: work.then(
        () => true,
        () => false,
      ),
    };
    coordinateWork.add(entry);
    void entry.settled.then(() => {
      coordinateWork.delete(entry);
      // After the store's own continuation (it applies a reveal after this promise).
      setImmediate(() => afterWork?.());
    });
    return work;
  }
  const revealFile = options.revealFile;
  if (revealFile) {
    storeOptions.reveal = (path) =>
      trackWork(
        `reveal:${path}`,
        `reading ${path}`,
        (comment) => comment.path === path,
        revealFile(path),
      );
  }
  const reload = options.reload;
  if (reload) {
    storeOptions.reload = () =>
      trackWork("refresh", "reading the changes again", () => true, reload());
  }
  if (options.sessionBaseline) storeOptions.baseline = options.sessionBaseline;
  const store = createModelStore(storeOptions);

  try {
    return await options.host.custom<ReviewViewResult | undefined>(
      (tui, theme, _keybindings, done) => {
        terminalRows = tui.terminal.rows;
        let busy = false;
        /**
         * Leaving and finishing, as one explicit state machine (the table is
         * in tests/review-lifecycle.test.ts):
         *   open -> finishing (S) -> closed (its save done) | open (failed or cancelled prompt)
         *   open | finishing -> leaving (q: one save, bounded by LEAVE_SAVE_MS)
         *   leaving -> closed (save done, or q again) | open (save failed or too slow)
         *   any -> closed (render failure, session ended)
         * Every completion goes through `close`, which runs once. A Finish or a
         * save that started under an earlier token finds it no longer owns the
         * view after its await and does nothing: no editor text, no result that
         * makes the command submit, no second completion.
         */
        type Phase =
          | { kind: "open" }
          | { kind: "finishing"; token: number }
          | { kind: "leaving"; token: number; timer: ReturnType<typeof setTimeout> }
          | { kind: "closed" };
        let phase: Phase = { kind: "open" };
        let tokens = 0;
        function close(result: ReviewViewResult): boolean {
          if (phase.kind === "closed" || closed) return false;
          if (phase.kind === "leaving") clearTimeout(phase.timer);
          phase = { kind: "closed" };
          done(result);
          return true;
        }
        /** True while the Finish or leave started with `token` still owns the view. */
        const owns = (token: number) =>
          !closed &&
          (phase.kind === "finishing" || phase.kind === "leaving") &&
          phase.token === token;
        /**
         * The record whose save on leaving failed. Leaving closes without
         * saving only while `record` is still that very object: any change
         * since (a comment, a mark, a verdict or body, a refresh that
         * re-follows comments) makes a new record, and leaving then tries to
         * save again under the same bounded rule. "Leave again to close without
         * saving" covers only what the failed save held; nothing later is lost.
         */
        let saveFailedFor: ReviewRecord | undefined;

        /** Pi's notifications, for what must outlive the view. Never throws; silent when stale. */
        function hostNotice(text: string, type: "warning" | "error"): void {
          try {
            options.host.notify(safe(text), type);
          } catch {
            // A stale context: the session ended, there is nobody to tell.
          }
        }
        let chatOpen = false;
        let focus: ReviewPaneFocus = "review";
        let lastBodyHeight = reviewViewHeights(terminalRows).bodyHeight;
        let scrollTop = 0;
        /**
         * Where the diff was last drawn: the rows of the view's header and body
         * and its columns. Undefined while the chat is drawn in its place.
         */
        let diffArea: { headerTop: number; top: number; rows: number; width: number } | undefined;
        /** A press on a line started a selection; drags extend it until the release. */
        let selecting = false;
        let lastRevision = -1;
        const seenHunks = new Set<string>();
        const seenFiles = new Set<string>();
        const seenTools = new Set<string>();

        // Rows use the theme; diff text keeps the caller's styler for inversion and backgrounds.
        const diffStyler = options.styler;
        const styler: PaneStyler = {
          fg: (color, text) => theme.fg(color, text),
          bold: (text) => theme.bold(text),
          inverse: (text) => diffStyler.inverse(text),
        };
        if (diffStyler.bg) styler.bg = diffStyler.bg.bind(diffStyler);
        if (diffStyler.getFgAnsi) styler.getFgAnsi = diffStyler.getFgAnsi.bind(diffStyler);
        if (diffStyler.getBgAnsi) styler.getBgAnsi = diffStyler.getBgAnsi.bind(diffStyler);
        if (diffStyler.getColorMode) styler.getColorMode = diffStyler.getColorMode.bind(diffStyler);

        const renderFileBody: FileBodyRenderer = (file, width, bodyStyler, layout) =>
          renderDiffFile(
            file,
            {
              mode: layout?.mode ?? "unified",
              width,
              highlight: createHighlight({
                config: config.highlight,
                filePath: file.path,
                diffLines: file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
              }),
              fold: (hunkId) => layout?.fold(hunkId) ?? false,
              foldReason: (hunkId) => layout?.foldReason(hunkId),
            },
            bodyStyler,
          ).slice(1);

        const assessmentOf = (path: string) =>
          assessments.files.find((assessment) => assessment.path === path);
        const commentsOn = (hunkId: string) =>
          record.comments.filter((comment) => comment.anchor.hunkHash === hunkId);

        /** A hunk as the reader sees it, with the context revealed around it. */
        const shownHunk = (hunk: DiffHunk) => {
          const expansion = expansions.get(hunk.id);
          return expansion ? hunkWithExpandedContext(hunk, expansion) : hunk;
        };

        /**
         * Where a comment is now: `locateComment` (core/anchor.ts), the one
         * decision the pull-request plan also makes, on the model shown and
         * with the context revealed. Nothing here trusts a stored line.
         */
        function locationOf(comment: ReviewComment): CommentLocation {
          return locateComment(comment, store.model(), { shown: shownHunk });
        }

        function placementOf(comment: ReviewComment) {
          const location = locationOf(comment);
          return location.status === "placed" ? location : undefined;
        }

        /**
         * The only writer of where the record says comments are. Each comment
         * takes what `locationOf` says now: placed, its current hunk,
         * position and lines; outdated, its last lines, marked `outdated`; a
         * withheld file, unchanged. Comments in `unconfirmed` (work that could
         * move them has not finished) keep their lines and are marked so,
         * never presented as current. Run on open, after each refresh, after
         * a reveal or a context read lands, and before every save.
         */
        function followComments(given: ReadonlySet<string> = new Set()): void {
          // A failed read leaves its comments uncertain until one succeeds.
          const unconfirmed = new Set(given);
          for (const affects of failedReads.values()) {
            for (const comment of record.comments)
              if (affects(comment)) unconfirmed.add(comment.id);
          }
          let changed = false;
          const comments = record.comments.map((comment): ReviewComment => {
            const { stale: _stale, ...current } = comment;
            let next: ReviewComment;
            if (unconfirmed.has(comment.id)) {
              next = { ...current, stale: "unconfirmed" };
            } else {
              const location = locationOf(comment);
              if (location.status === "hidden") return comment;
              if (location.status === "outdated") {
                next = { ...current, stale: "outdated" };
              } else {
                const { startLine: _startLine, ...rest } = current;
                next = {
                  ...rest,
                  line: location.line,
                  ...propertiesWhen(!(comment.startLine === undefined), () => ({
                    startLine: location.startLine,
                  })),
                  anchor: {
                    ...comment.anchor,
                    hunkHash: location.hunkId,
                    position: location.position,
                  },
                };
              }
            }
            if (JSON.stringify(next) === JSON.stringify(comment)) return comment;
            changed = true;
            return next;
          });
          if (changed) record = { ...record, comments };
        }

        function riskOrder(files: readonly FileSummary[]): readonly FileSummary[] {
          const rank = new Map(assessments.reviewOrder.map((path, index) => [path, index]));
          return files
            .map((file, index) => ({ file, rank: rank.get(file.path) ?? rank.size + index }))
            .sort((left, right) => left.rank - right.rank)
            .map((entry) => entry.file);
        }

        function riskBadges(path: string): RowBadge[] {
          const score = assessmentOf(path)?.riskScore ?? 0;
          return score > 0 ? [{ text: `▲${score}`, color: score >= 30 ? "error" : "warning" }] : [];
        }

        function foldReason(hunkId: string): string {
          const reason = record.cursor.reviewedHunkIds.includes(hunkId)
            ? "Already reviewed in this review"
            : (assessments.hunks.find((hunk) => hunk.hunkId === hunkId)?.reason ??
              "Folded by reviewer");
          const count = commentsOn(hunkId).length;
          if (count === 0) return reason;
          return `${reason} · ${count} comment${count === 1 ? "" : "s"} inside`;
        }

        /** True while a listed file's contents are hidden as sensitive. */
        function isHidden(path: string): boolean {
          const summary = changes.files().find((file) => file.path === path);
          return summary !== undefined && !changes.canShowContents(summary);
        }

        function rowDetails(path: string, expanded: boolean): RowDetail[] {
          const details: RowDetail[] = [];
          const assessment = assessmentOf(path);
          if (assessment && assessment.riskScore > 0 && assessment.reasons.length > 0) {
            details.push({ text: assessment.reasons.join("; "), color: "muted" });
          }
          if (!expanded && assessment?.collapsed) {
            details.push({
              text: `Hidden: ${assessment.collapseReason ?? "folded by the review's rules"} · ⏎ shows it`,
              color: "dim",
            });
          }
          // A read limit or error kept the body out; say so on the row, as the body does.
          const notice = store.model().notices?.find((entry) => entry.path === path)?.message;
          if (notice !== undefined) details.push({ text: notice, color: "warning" });
          if (isHidden(path)) {
            const count = record.comments.filter((comment) => comment.path === path).length;
            if (count > 0) {
              details.push({
                text: `${count} comment${count === 1 ? "" : "s"} on this file, shown with its contents.`,
                color: "dim",
              });
            }
          }
          return details;
        }

        function annotations(
          path: string,
          hunks: readonly DiffHunk[],
          width: number,
        ): BodyAnnotation[] {
          const placed: BodyAnnotation[] = [];
          for (const hunk of hunks) {
            for (const comment of record.comments) {
              if (comment.path !== path) continue;
              // Placed by its text, in whichever hunk holds it now; a comment
              // whose text is gone is drawn outdated below.
              const at = placementOf(comment);
              if (!at || at.hunkId !== hunk.id) continue;
              const lineIndex = commentLineIndex(hunk, { side: comment.side, line: at.line });
              placed.push({
                hunkId: hunk.id,
                // A line no longer displayed (its context collapsed) falls back to the header.
                place: lineIndex < 0 ? "header" : { afterLine: lineIndex },
                lines: commentBlock(comment, width, styler),
              });
            }
          }
          return placed;
        }

        /** Comments whose text is no longer in their listed file (hunk gone, or text not found in it). */
        function fileTrailer(path: string, _hunks: readonly DiffHunk[], width: number): string[] {
          return record.comments
            .filter((comment) => comment.path === path && locationOf(comment).status === "outdated")
            .flatMap((comment) => outdatedCommentLines(comment, false, width, styler));
        }

        /** Comments on files that left the diff, under the pane's heading. */
        function trailer(width: number): string[] {
          const listed = new Set(changes.files().map((file) => file.path));
          const gone = record.comments.filter((comment) => !listed.has(comment.path));
          if (gone.length === 0) return [];
          return [
            "",
            styler.fg("dim", "Not in this diff:"),
            ...gone.flatMap((comment) => outdatedCommentLines(comment, true, width, styler)),
          ];
        }

        /** The copy key: the selected lines as code, or a folded hunk as a diff. */
        function copySelection(target: AskTarget): void {
          const hunk = target.hunk;
          if (!hunk) {
            notify("Nothing to copy on a file's row: move to a line first.", "info");
            return;
          }
          const write = options.copyText;
          if (!write) {
            notify("Copying is not available here.", "warning");
            return;
          }
          const lines = target.lines;
          const text = clipboardText(hunk, lines);
          const copied = lines
            ? `Copied ${plural(lines.last - lines.first + 1, "line")}.`
            : `Copied the hunk as a diff (${plural(hunk.lines.length, "line")}).`;
          void (async () => {
            await write(text);
            if (!closed) notify(copied, "info");
          })().catch((error: RuntimeValue) =>
            notify(`Cannot copy to the clipboard: ${failureLine(error)}`, "warning"),
          );
        }

        const actions: PaneActions = {
          unfocus: () => leave(),
          close: () => leave(),
          resizeBy: () => {},
          refresh: () => {
            void refresh("manual");
          },
          requestRender: () => tui.requestRender(),
          isToggleKey: () => false,
          isFocusKey: () => false,
          copy: copySelection,
        };

        const changes = new ChangesView({
          store,
          styler,
          actions,
          renderFileBody,
          keyHint: REVIEW_KEY_HINT,
          helpLines: REVIEW_HELP_LINES,
          keepMessages: true,
          keys: REVIEW_KEYS,
          title: "Review",
          cursor: "line",
          fileOrder: riskOrder,
          rowBadges: riskBadges,
          foldReason,
          reviewedHunks: () => new Set(record.cursor.reviewedHunkIds),
          mode: () => mode,
          search: (query) => changedLineMatches(store.model().files, query),
          expandContext: (hunk) => hunkWithExpandedContext(hunk, expansions.get(hunk.id)),
          annotations,
          fileTrailer,
          rowDetails,
          trailer,
        });
        view = changes;
        repaint = () => tui.requestRender();
        const scroller: PaneScroller = {
          top: () => scrollTop,
          viewportHeight: () => lastBodyHeight,
          scrollTo: (top) => {
            scrollTop = Math.max(0, top);
          },
          scrollBy: (lines) => {
            scrollTop = Math.max(0, scrollTop + lines);
          },
        };
        changes.attachScroller(scroller);

        /** Fold reviewed and rule-folded hunks the first time each is seen; refreshes keep the reviewer's choices. */
        function seedFolds(): void {
          const reviewed = new Set(record.cursor.reviewedHunkIds);
          const collapsed = new Set(
            assessments.hunks.filter((hunk) => hunk.collapsed).map((hunk) => hunk.hunkId),
          );
          for (const file of store.model().files) {
            for (const hunk of file.hunks) {
              if (seenHunks.has(hunk.id)) continue;
              seenHunks.add(hunk.id);
              if (reviewed.has(hunk.id) || collapsed.has(hunk.id)) changes.setFolded(hunk.id, true);
            }
          }
          for (const file of store.model().files) {
            if (seenFiles.has(file.path)) continue;
            seenFiles.add(file.path);
            if (!assessmentOf(file.path)?.collapsed) changes.expand(file.path);
          }
        }

        function applyStoreState(): void {
          const state = store.getState();
          const revision = state.kind === "ready" ? state.snapshot.revision : lastRevision;
          if (revision !== lastRevision && lastRevision >= 0) {
            assessments = assessDiff(store.model(), config);
          }
          changes.setState(state);
          if (revision !== lastRevision) {
            lastRevision = revision;
            seedFolds();
            changes.invalidate();
          }
        }

        /** The first unreviewed hunk in risk order, as the review always opened. */
        function placeInitialCursor(): void {
          const reviewed = new Set(record.cursor.reviewedHunkIds);
          const model = store.model();
          const located = changes.files().flatMap((summary) =>
            (model.files.find((file) => file.path === summary.path)?.hunks ?? []).map((hunk) => ({
              path: summary.path,
              hunk,
            })),
          );
          const target = located.find((entry) => !reviewed.has(entry.hunk.id)) ?? located[0];
          if (!target) {
            const first = changes.files()[0];
            if (first) changes.setCursor({ path: first.path });
            return;
          }
          if (!changes.expanded.has(target.path)) {
            changes.setCursor({ path: target.path });
            return;
          }
          const folded = changes.foldedHunks.has(target.hunk.id);
          changes.setCursor(
            folded || target.hunk.lines.length === 0
              ? { path: target.path, hunkId: target.hunk.id }
              : { path: target.path, hunkId: target.hunk.id, lineIndex: 0 },
          );
        }

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
              ...propertiesWhen(info.description, () => ({ description: info.description })),
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
        // Pi 0.85 moved the built-in renderer fallback from the component to callers.
        const builtInToolDefinitions = new Map<string, ToolExecutionDefinition>();
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
            let registeredDefinition: ToolExecutionDefinition;
            try {
              // SAFETY: ReviewChat exposes the host definition consumed by ToolExecutionComponent.
              registeredDefinition = chat?.toolDefinition(
                entry.toolName,
              ) as ToolExecutionDefinition;
            } catch {
              registeredDefinition = undefined;
            }
            const definition = withBuiltInRenderers(
              entry.toolName,
              registeredDefinition,
              options.reviewRoot,
              builtInToolDefinitions,
            );
            const component = new ToolExecutionComponent(
              entry.toolName,
              entry.toolCallId,
              terminalSafeValue(entry.args),
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
          // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
          const result = entry.result as { content?: unknown; details?: unknown } | undefined;
          if (
            result &&
            Array.isArray(result.content) &&
            (view.result !== entry.result || view.done !== entry.done)
          ) {
            view.component.updateResult(
              {
                content: result.content.map((item) =>
                  isJsonRecord(item) && isString(item.text)
                    ? { ...item, text: terminalSafeValue(item.text) }
                    : item,
                ),
                // Pi's renderers draw details as given (an edit's diff, paths), so they are
                // made terminal-safe here too.
                details: terminalSafeValue(result.details),
                isError: entry.isError === true,
              },
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

        function stopComment(): void {
          commentInput.focused = false;
          commentDraft = undefined;
          tui.requestRender();
        }

        /** A hunk as displayed now (revealed context included), from the current model. */
        function displayHunk(path: string, hunkId: string): DiffHunk | undefined {
          const hunk = store
            .model()
            .files.find((file) => file.path === path)
            ?.hunks.find((candidate) => candidate.id === hunkId);
          return hunk ? hunkWithExpandedContext(hunk, expansions.get(hunk.id)) : undefined;
        }

        function submitComment(body: string): void {
          // Recall before the outcome is decided: a comment refused for being
          // empty is dropped by the history itself, and one that lands is worth
          // recalling when the next hunk needs the same remark.
          commentInput.remember(body);
          if (!commentDraft) return;
          commentDraft = { ...commentDraft, body };
          if (body.trim().length === 0) {
            tui.requestRender();
            return;
          }
          const draft = commentDraft;
          const hunk = displayHunk(draft.position.path, draft.position.hunkId);
          if (!hunk) {
            notify(
              "The comment's hunk is no longer in this review; the comment was not added.",
              "warning",
            );
            return;
          }
          record = commitComment(record, draft, hunk, { id: createCommentId(), timestamp: now() });
          commentDraft = undefined;
          commentInput.focused = false;
          changes.invalidate();
          tui.requestRender();
        }

        commentInput.onSubmit = submitComment;

        function setFocus(next: ReviewPaneFocus): void {
          focus = next;
          chatInput.focused = next === "chat";
          tui.requestRender();
        }

        /** A side-chat tool call that finished may have edited files: read the changes again. */
        function watchToolCalls(): void {
          const current = chat;
          if (!current || closed) return;
          let finished = false;
          for (const message of current.messages) {
            if (message.role !== "tool" || !message.done || seenTools.has(message.toolCallId))
              continue;
            seenTools.add(message.toolCallId);
            finished = true;
          }
          if (finished && store.canRefresh) void refresh("tool");
        }

        function openChat(): void {
          try {
            if (!chat) {
              chat = createChat({
                cwd: options.reviewRoot,
                // Read at every tool call: a file revealed with v is allowed from then on.
                hiddenPaths: () => hiddenPaths(),
                ...propertiesWhen(options.chatModel, () => ({ model: options.chatModel })),
                ...propertiesWhen(options.chatThinkingLevel, () => ({
                  thinkingLevel: options.chatThinkingLevel,
                })),
              });
              unsubscribeChat = chat.onUpdate(() => {
                watchToolCalls();
                tui.requestRender();
              });
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
            notify(error instanceof Error ? error.message : String(error), "error");
          }
        }

        /** What the side chat may know: the selected line and its hunk, never the diff itself. */
        function chatContext(): ReviewChatContext | undefined {
          const position = changes.commentPosition();
          const current = changes.currentDisplayHunk();
          const focused = current?.hunk.lines[changes.cursorLine ?? -1];
          if (!position || !current || !focused) return undefined;
          const hidden = hiddenPaths();
          return {
            path: position.path,
            side: position.side,
            line: position.line,
            focusedLineText: focused.text,
            hunkHeader: current.hunk.header,
            reviewRoot: options.reviewRoot,
            ...propertiesWhen(hidden.length, () => ({ hiddenPaths: hidden })),
          };
        }

        /** Sensitive files whose contents are hidden now. */
        function hiddenPaths(): string[] {
          return changes
            .files()
            .filter((file) => !changes.canShowContents(file))
            .map((file) => file.path);
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
              if (closed) return;
              notify(
                "Chat session resources reloaded: extensions, skills, prompts, and context files.",
                "info",
              );
              return;
            }
            if (kind === "model") {
              if (!argument) {
                notify(
                  `Chat model: ${chat.status.model ?? "Pi default"} · effort ${chat.status.thinkingLevel ?? "default"}`,
                  "info",
                );
                return;
              }
              const applied = await chat.setModel(argument);
              if (closed) return;
              notify(`Chat model set to ${applied}.`, "info");
              return;
            }
            if (!argument) {
              notify(
                `Chat effort: ${chat.status.thinkingLevel ?? "default"} · levels: off, minimal, low, medium, high, xhigh, max`,
                "info",
              );
              return;
            }
            const applied = await chat.setThinkingLevel(argument);
            if (closed) return;
            notify(`Chat effort set to ${applied}.`, "info");
          } catch (error) {
            if (closed) return;
            notify(error instanceof Error ? error.message : String(error), "error");
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
              leave();
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
              notify(`/${name} is not available in the review chat.`, "warning");
              tui.requestRender();
              return;
            }
            chatInput.setText("");
            tui.requestRender();
            void chat.runCommand(prompt, options.reviewRoot).catch((error: RuntimeValue) => {
              notify(error instanceof Error ? error.message : String(error), "error");
              tui.requestRender();
            });
            return;
          }
          if (chat.pending) return;
          const context = chatContext();
          if (!context) {
            notify("Select an expanded diff line before asking the agent.", "warning");
            return;
          }
          chatScrollOffset = 0;
          chatInput.setText("");
          tui.requestRender();
          try {
            void chat.ask(prompt, context).catch((error: RuntimeValue) => {
              notify(error instanceof Error ? error.message : String(error), "error");
              tui.requestRender();
            });
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
          }
        }

        chatInput.onSubmit = submitChat;

        async function guarded(action: () => Promise<void>): Promise<void> {
          if (busy) return;
          busy = true;
          try {
            await action();
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
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
          const current = changes.currentHunk();
          if (!current || !changes.commentPosition()) {
            notify("Select an expanded hunk line before expanding context.", "warning");
            return;
          }
          const model = store.model();
          const file = model.files.find((entry) => entry.path === current.file.path);
          if (!file) return;
          const hunk = current.hunk;
          const expansion = expansions.get(hunk.id) ?? { above: [], below: [] };
          const expandEdge = (edge: "above" | "below") =>
            expandHunkContext({
              cwd: options.reviewRoot,
              model,
              file,
              hunk,
              edge,
              expansion,
              expandedContext: expansions,
              runner: options.execRunner,
            });
          const [above, below] = await Promise.all([expandEdge("above"), expandEdge("below")]);
          if (closed) return;
          if (above.addedLines + below.addedLines === 0) {
            notify("No more unchanged context to expand.", "info");
            return;
          }
          setExpansion(hunk.id, { above: above.expansion.above, below: below.expansion.below });
        }

        /** Replace one hunk's context; the cursor stays on its line and a selection collapses. */
        function setExpansion(hunkId: string, next: HunkExpansion): void {
          const before = expansions.get(hunkId)?.above.length ?? 0;
          if (next.above.length === 0 && next.below.length === 0) expansions.delete(hunkId);
          else expansions.set(hunkId, next);
          changes.contextChanged(hunkId, next.above.length - before);
        }

        /** Bumped by each restore; an older restore stops after its next await. */
        let contextRestore = 0;

        /**
         * Revealed context is read for a hunk's place: a hunk id names content,
         * not place, so after a refresh a hunk that moved (or left) loses the
         * context read for where it was, which would show other lines under
         * the old numbers. `restoreCommentContext` reads again what comments need.
         */
        function dropMovedContext(): void {
          const hunks = new Map(
            store
              .model()
              .files.flatMap((file) => file.hunks)
              .map((hunk) => [hunk.id, hunk]),
          );
          for (const [hunkId, expansion] of expansions) {
            const hunk = hunks.get(hunkId);
            if (!hunk || !revealedContextFits(hunk, expansion)) {
              setExpansion(hunkId, { above: [], below: [] });
            }
          }
        }

        /**
         * A comment written on expanded context (`+`) is not in its hunk as
         * read, so after a resume or a refresh it would be outdated though
         * nothing changed. Expand that hunk the way `+` does, step by step up
         * to `EXPANSION_LIMIT`, until the comment's text is found; keep the
         * expansion only then. A comment whose text is not found within the
         * limit (its text is gone) stays outdated, and its hunk keeps the
         * context it had. A failed read leaves it outdated too: that is what
         * the reader can verify.
         */
        function restoreCommentContext(): void {
          const started = (contextRestore += 1);
          const model = store.model();
          const targets = new Set(
            record.comments
              .filter((comment) => {
                if (placementOf(comment)) return false;
                const file = model.files.find((entry) => entry.path === comment.path);
                return (
                  file !== undefined &&
                  !isHidden(file.path) &&
                  file.hunks.some((hunk) => hunk.id === comment.anchor.hunkHash)
                );
              })
              .map((comment) => comment.id),
          );
          if (targets.size === 0) return;
          void trackWork(
            "context",
            "reading context for comments",
            (comment) => targets.has(comment.id),
            readCommentContext(started, model, targets),
          ).catch(() => {
            // Reported as unconfirmed by a Finish waiting for it; nothing else to do.
          });
        }

        async function readCommentContext(
          started: number,
          model: DiffModel,
          targets: ReadonlySet<string>,
        ): Promise<void> {
          const current = () => !closed && started === contextRestore && store.model() === model;
          let restored = false;
          for (const comment of record.comments) {
            if (!targets.has(comment.id)) continue;
            const file = model.files.find((entry) => entry.path === comment.path);
            const hunk = file?.hunks.find((entry) => entry.id === comment.anchor.hunkHash);
            if (!file || !hunk || isHidden(file.path)) continue;
            const before = expansions.get(hunk.id);
            let expansion = before ?? { above: [], below: [] };
            for (let step = 0; step < EXPANSION_LIMIT / EXPANSION_STEP; step += 1) {
              const edge = (side: "above" | "below") =>
                expandHunkContext({
                  cwd: options.reviewRoot,
                  model,
                  file,
                  hunk,
                  edge: side,
                  expansion,
                  expandedContext: expansions,
                  runner: options.execRunner,
                });
              let read: [Awaited<ReturnType<typeof edge>>, Awaited<ReturnType<typeof edge>>];
              try {
                read = await Promise.all([edge("above"), edge("below")]);
              } catch {
                break;
              }
              if (!current()) return;
              // The user changed this hunk's context meanwhile: theirs stands.
              if (expansions.get(hunk.id) !== before) break;
              const [above, below] = read;
              if (above.addedLines + below.addedLines === 0) break;
              expansion = { above: above.expansion.above, below: below.expansion.below };
              const trial = hunkWithExpandedContext(hunk, expansion);
              const found = locateComment(comment, model, {
                shown: (candidate) => (candidate.id === hunk.id ? trial : shownHunk(candidate)),
              });
              if (found.status === "placed" && found.hunkId === hunk.id) {
                setExpansion(hunk.id, expansion);
                restored = true;
                break;
              }
            }
          }
          if (!restored || !current()) return;
          followComments();
          tui.requestRender();
        }

        function collapseContext(): void {
          const current = changes.currentHunk();
          if (!current || !changes.commentPosition()) {
            notify("Select an expanded hunk line before collapsing context.", "warning");
            return;
          }
          const expansion = expansions.get(current.hunk.id) ?? { above: [], below: [] };
          if (expansion.above.length === 0 && expansion.below.length === 0) {
            notify("No expanded context to collapse.", "info");
            return;
          }
          setExpansion(
            current.hunk.id,
            collapseHunkContext(collapseHunkContext(expansion, "above"), "below"),
          );
        }

        /** Sensitive paths whose comments must not quote source lines. */
        function hiddenCommentPaths(): string[] {
          const listed = new Set(changes.files().map((file) => file.path));
          const paths = new Set(hiddenPaths());
          for (const comment of record.comments) {
            if (!listed.has(comment.path) && isSensitivePath(comment.path)) paths.add(comment.path);
          }
          return [...paths];
        }

        /**
         * The record as it is exported: every comment where `locateComment`
         * finds it now, and `unconfirmed` ones (work that could move them did
         * not finish) marked so rather than presented as current.
         */
        function prepareRecord(unconfirmed: ReadonlySet<string>): ReviewRecord {
          followComments(unconfirmed);
          record = { ...record, updatedAt: now() };
          return record;
        }

        /** Comments that pending coordinate work could still move. */
        function pendingComments(extra: readonly CoordinateWork[] = []): Set<string> {
          const open = [...coordinateWork, ...extra];
          return new Set(
            record.comments
              .filter((entry) => open.some((work) => work.affects(entry)))
              .map((entry) => entry.id),
          );
        }

        /**
         * Finish waits for the work that can move comments (a refresh, a
         * context read, a reveal), at most FINISH_WAIT_MS in all, saying so on
         * the message line; q cancels the wait. Work that started meanwhile
         * (a refresh starts a context read) is waited for too. Undefined when
         * the Finish no longer owns the view; else the comments to export as
         * unconfirmed (work still pending at the limit, or failed).
         */
        async function settleCoordinateWork(token: number): Promise<Set<string> | undefined> {
          const deadline = Date.now() + finishWaitMs;
          const failed: CoordinateWork[] = [];
          while (coordinateWork.size > 0) {
            const pending = [...coordinateWork];
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const labels = [...new Set(pending.map((work) => work.label))].join(", ");
            notify(
              `Finishing: waiting for ${labels} (at most ${Math.ceil(remaining / 1000)} s; q cancels).`,
              "info",
            );
            tui.requestRender();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const outcome = await Promise.race([
              Promise.all(
                pending.map((work) =>
                  work.settled.then((ok) => {
                    if (!ok) failed.push(work);
                  }),
                ),
              ).then(() => "settled" as const),
              new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), remaining);
              }),
            ]);
            clearTimeout(timer);
            if (!owns(token)) return undefined;
            // Let what the settled work does next run (the store's update, a follow-up read).
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (!owns(token)) return undefined;
            if (outcome === "timeout") break;
          }
          return pendingComments(failed);
        }

        /**
         * q, Esc and the chat's /quit. From open or finishing: one save of the
         * record as it stands (a pending Finish is cancelled), at most
         * LEAVE_SAVE_MS; the message line says that q again leaves without
         * saving. While that save runs: q closes at once. A save that fails or
         * takes too long keeps the review open and says so; leaving again then
         * closes without saving, so a store that keeps failing can never keep
         * the user in the review.
         */
        function leave(): void {
          if (closed || phase.kind === "closed") return;
          if (phase.kind === "leaving") {
            close({ action: "save", record });
            hostNotice(
              "The review was closed without waiting for its save. If that save finishes, the review is saved; otherwise it is as it was last saved.",
              "warning",
            );
            return;
          }
          if (saveFailedFor !== undefined && saveFailedFor === record) {
            close({ action: "save", record });
            hostNotice(
              "The review was closed without saving; it is as it was last saved.",
              "warning",
            );
            return;
          }
          saveFailedFor = undefined;
          const token = (tokens += 1);
          const kept = prepareRecord(pendingComments());
          const timer = setTimeout(
            () =>
              leaveSaveFailed(
                token,
                new Error(`Saving the review took longer than ${leaveSaveMs / 1000} s.`),
                kept,
              ),
            leaveSaveMs,
          );
          phase = { kind: "leaving", token, timer };
          notify("Saving the review… q again leaves without saving.", "info");
          tui.requestRender();
          // Started now, in this key's turn; a store that throws at once counts as failing.
          let saving: Promise<void>;
          try {
            saving = Promise.resolve(options.store.save(kept));
          } catch (error) {
            saving = Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          void saving.then(
            () => {
              if (owns(token)) close({ action: "save", record: kept });
            },
            (error: RuntimeValue) => leaveSaveFailed(token, error, kept),
          );
        }

        function leaveSaveFailed(token: number, error: RuntimeValue, kept: ReviewRecord): void {
          if (!owns(token) || phase.kind !== "leaving") return;
          clearTimeout(phase.timer);
          phase = { kind: "open" };
          saveFailedFor = kept;
          notify(
            `${error instanceof Error ? error.message : String(error)} Leave again to close without saving; after any change, leaving tries to save again.`,
            "error",
          );
          tui.requestRender();
        }

        async function finish(): Promise<void> {
          if (closed || phase.kind !== "open") return;
          const token = (tokens += 1);
          phase = { kind: "finishing", token };
          let outcome: { verdict: ReviewRecord["verdict"]; body: string } | undefined;
          try {
            if (record.target.kind === "pr") {
              const choices = [
                "Comment",
                "Approve",
                "Request changes",
                "Pending draft to inspect on GitHub",
              ] as const;
              const selected = await withHostPrompt(() =>
                options.host.select("Pull request outcome", [...choices]),
              );
              if (selected === undefined || !owns(token)) return;
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
                  record.body ?? "",
                ),
              );
              if (body === undefined || !owns(token)) return;
              outcome = { verdict, body: body.trim() };
            }
            const unconfirmed = await settleCoordinateWork(token);
            if (unconfirmed === undefined || !owns(token)) return;
            // Committed: the chosen outcome enters the record only now, so a
            // Finish cancelled before its save leaves the verdict and body as
            // they were. From here on the user has confirmed them; if this save
            // fails they stay, and the next save (q or S) writes them.
            if (outcome) {
              const { verdict: _verdict, body: _body, ...rest } = record;
              const chosen = outcome;
              record = {
                ...rest,
                ...propertiesWhen(!(chosen.verdict === undefined), () => ({
                  verdict: chosen.verdict,
                })),
                ...propertiesWhen(chosen.body, () => ({ body: chosen.body })),
              };
            }
            const kept = prepareRecord(unconfirmed);
            await options.store.save(kept);
            if (!owns(token)) return;
            const markdown = renderReviewMarkdown(kept, { hiddenPaths: hiddenCommentPaths() });
            const agentInstruction = composeSessionReviewInstruction(
              kept,
              markdown,
              options.includesWorkingTree ?? targetIncludesWorkingTree(kept.target),
            );
            const finished = close({
              action: "finish",
              record: kept,
              markdown,
              ...propertiesWhen(agentInstruction, () => ({ agentInstruction })),
              ...propertiesWhen(expansions.size, () => ({ expandedContext: new Map(expansions) })),
            });
            if (finished && agentInstruction) options.host.setEditorText(agentInstruction);
          } catch (error) {
            // A Finish that a q cancelled stays silent, whatever its save does.
            if (owns(token)) throw error;
          } finally {
            if (owns(token)) phase = { kind: "open" };
          }
        }

        async function search(): Promise<void> {
          const query = await withHostPrompt(() =>
            options.host.input("Search changed lines", changes.searchState?.query ?? ""),
          );
          if (query === undefined || closed) return;
          changes.setSearch(query);
          const found = changes.searchState;
          if (found && found.matches.length === 0)
            notify(`No changed line contains “${query}”.`, "info");
        }

        function comment(): void {
          const position = changes.commentPosition();
          if (!position) {
            notify("Select an expanded diff line before commenting.", "warning");
            return;
          }
          commentDraft = { position, body: "" };
          commentInput.setText("");
          commentInput.focused = true;
          tui.requestRender();
        }

        function editorLine(): number {
          const position = changes.commentPosition();
          if (position) return position.line;
          const current = changes.currentHunk();
          if (!current) return 1;
          return current.file.status === "deleted" ? current.hunk.oldStart : current.hunk.newStart;
        }

        async function editCurrentHunk(): Promise<void> {
          const file = changes.selectedFile();
          if (!file) return;
          if (!changes.canShowContents(file)) {
            notify(HIDDEN_FILE_HINT, "warning");
            return;
          }
          await launchEditor(
            config.editor,
            {
              path: resolve(options.reviewRoot, file.path),
              line: editorLine(),
              column: 1,
              dir: options.reviewRoot,
            },
            tui,
            options.spawnEditor,
          );
        }

        function markReviewed(): void {
          const current = changes.currentHunk();
          if (!current) return;
          record = {
            ...markHunksReviewed(record, [current.hunk.id], store.model().headSha),
            updatedAt: now(),
          };
          changes.setFolded(current.hunk.id, true);
          changes.invalidate();
        }

        /** ←/→: the previous or next file, on its first line when it is open. */
        function moveFile(delta: number): void {
          const files = changes.files();
          const file =
            files[Math.max(0, Math.min(files.length - 1, changes.selectedIndex + delta))];
          if (!file) return;
          changes.setCursor({ path: file.path });
          if (changes.expanded.has(file.path) && (changes.displayHunks(file)?.length ?? 0) > 0) {
            changes.moveCursor(1);
          }
        }

        async function reloadFindings(): Promise<void> {
          const load = options.loadFindings;
          if (!load) return;
          try {
            const found = await load(changes.files().map((file) => file.path));
            if (closed) return;
            changes.setRecorded(found.recorded, found.changeTimes);
            tui.requestRender();
          } catch (error) {
            if (!closed)
              notify(
                `Review findings could not be read: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
          }
        }

        /**
         * Read the changes again (`r`, or after a side-chat tool call). Reviewed
         * marks, folds and comments key on content-hash hunk ids, so an
         * unchanged hunk keeps them across the refresh.
         */
        async function refresh(reason: "manual" | "tool"): Promise<void> {
          if (!store.canRefresh) {
            if (reason === "manual") {
              changes.setMessage(
                "This review's target cannot change, so there is nothing to refresh.",
              );
              tui.requestRender();
            }
            return;
          }
          try {
            const outcome = await store.refresh();
            if (closed || outcome === "stale") return;
            followComparison();
            if (reason === "manual") {
              changes.setMessage(
                outcome === "changed"
                  ? "Read the changes again."
                  : "Read the changes again; nothing changed.",
              );
            }
            await reloadFindings();
          } catch (error) {
            if (!closed) {
              notify(
                `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          } finally {
            if (!closed) tui.requestRender();
          }
        }

        /**
         * A refresh read the target again: the record names the comparison now
         * shown (base, head, and the head the cursor was last moved on), so a
         * saved review never describes one comparison while its comments and
         * marks were made on another. It is saved through the normal path (q,
         * Finish); comments and reviewed marks key on content-hash hunk ids and
         * stay. A pull request cannot refresh, and its record keeps the head
         * its comments were written on, which submission checks.
         */
        function followComparison(): void {
          dropMovedContext();
          followComments();
          restoreCommentContext();
          if (record.target.kind === "pr") return;
          const { baseSha, headSha } = store.model();
          if (record.baseSha === baseSha && record.headSha === headSha) return;
          record = {
            ...record,
            baseSha,
            headSha,
            cursor: { ...record.cursor, lastHeadSha: headSha },
          };
        }

        function outdatedCount(): number {
          return record.comments.filter((entry) => locationOf(entry).status === "outdated").length;
        }

        function statusLine(): string {
          const files = changes.files();
          const file = changes.selectedFile();
          const hunks = file ? (changes.visibleHunks(file) ?? []) : [];
          const at = hunks.findIndex((hunk) => hunk.id === changes.selectedHunk?.hunkId);
          const outdated = outdatedCount();
          const comments = record.comments.length;
          const parts = [
            `${file ? changes.selectedIndex + 1 : 0}/${files.length} files`,
            `${at + 1}/${hunks.length} hunks`,
            `${record.cursor.reviewedHunkIds.length} reviewed`,
            outdated > 0 ? `${comments} comments (${outdated} outdated)` : `${comments} comments`,
            mode,
          ];
          const found = changes.searchState;
          if (found) {
            parts.push(
              found.matches.length === 0
                ? `search “${safe(found.query)}”: no matches`
                : `search “${safe(found.query)}”: ${found.index + 1}/${found.matches.length}`,
            );
          }
          return theme.fg("muted", parts.join(" · "));
        }

        function commentTargetLine(): string {
          const position = commentDraft?.position ?? changes.commentPosition();
          if (!position) return theme.fg("dim", "No line selected · j/k or ↑/↓ line");
          return theme.fg(
            "dim",
            `Target ${safe(position.path)}:${rangeLabel(position)} ${position.side}`,
          );
        }

        // A resumed record's comments take the line numbers their text has now.
        followComments();
        restoreCommentContext();
        // A step that can move comments landed (a reveal, a context read, a refresh): follow it.
        afterWork = () => {
          if (closed) return;
          followComments();
          tui.requestRender();
        };
        applyStoreState();
        placeInitialCursor();
        unsubscribeStore = store.subscribe(() => {
          if (closed) return;
          applyStoreState();
          tui.requestRender();
        });
        void reloadFindings();

        /**
         * pi-tui calls render and handleInput with nothing around them, and Pi
         * exits on any throw that escapes (interactive mode's uncaughtCrash).
         * A full-screen view that cannot draw would also trap the user, so a
         * render failure closes the review at once (the terminal and the pane
         * underneath come back), saves the record as it stands through the
         * store, and says so in Pi's notifications. Later frames until the
         * overlay is gone draw one fallback line without calling the view.
         */
        let renderFailure: { error: RuntimeValue } | undefined;

        function renderFailed(error: RuntimeValue): void {
          if (renderFailure) return;
          renderFailure = { error };
          const reason = failureLine(error);
          // After this frame: closing inside pi-tui's render would re-enter it.
          // Nothing in this microtask may throw: nothing above it would catch.
          queueMicrotask(() => {
            if (closed || phase.kind === "closed") return;
            let updatedAt = record.updatedAt;
            try {
              updatedAt = now();
            } catch {
              // The clock is what failed: keep the last time.
            }
            const kept = { ...record, updatedAt };
            try {
              close({ action: "save", record: kept });
            } catch {
              // The host already tore the view down; the save below still runs.
            }
            void Promise.resolve()
              .then(() => options.store.save(kept))
              .then(
                () =>
                  hostNotice(
                    `The review could not be drawn (${reason}) and was closed. Your comments and reviewed marks were saved; /review-assist resume opens it again.`,
                    "warning",
                  ),
                (saveError: RuntimeValue) =>
                  hostNotice(
                    `The review could not be drawn (${reason}) and was closed, and saving it failed (${failureLine(saveError)}); the review is as it was last saved.`,
                    "error",
                  ),
              );
          });
        }

        function fallbackFrame(width: number): string[] {
          const reason = renderFailure ? failureLine(renderFailure.error) : "unknown error";
          return [
            truncateToWidth(
              `The review could not be drawn: ${reason}. Closing it.`,
              Math.max(1, width),
              "…",
            ),
          ];
        }

        const component = {
          render: (width: number) => {
            const contentWidth = Math.max(1, width);
            const splitChat = chatOpen && contentWidth >= REVIEW_CHAT_SPLIT_MIN_WIDTH;
            const chatWidth = splitChat
              ? Math.max(40, Math.floor(contentWidth * 0.4))
              : contentWidth;
            const diffWidth = splitChat ? contentWidth - chatWidth - 1 : contentWidth;
            const diffVisible = splitChat || focus === "review";
            terminalRows = tui.terminal.rows;
            const status = `${statusLine()} · ${commentTargetLine()}`;
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
                ...propertiesWhen(identifier && provider, () => ({ provider })),
                ...propertiesWhen(thinkingLevel, () => ({ thinkingLevel })),
              };
            })();
            const framedInput = (input: ReviewInput): string[] =>
              frameAdapter.frame({
                width: contentWidth,
                ...input.render(frameAdapter.editorWidth(contentWidth)),
                cwd: options.reviewRoot,
                uiTheme: theme,
                ...propertiesWhen(frameModel, () => ({ model: frameModel })),
              });
            if (commentDraft) {
              const draftPosition = commentDraft.position;
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
                theme.fg(
                  "dim",
                  "Input inactive · c writes a review comment · a asks in a side chat (the diff stays out of the main conversation)",
                ),
              ];
              hintLineOne = `Shift+↑/↓ select lines · ←/→ file · PgUp/PgDn page${chatOpen ? " · Tab focus chat · Ctrl+O tool output" : ""}`;
              hintLineTwo = `+/- context · c comment · a ask · / search · >/< match · ${SPLIT_TOGGLE_KEY} split · m reviewed · e/E editor · S finish · q save`;
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
            // The view's header holds the message line; when the chat replaces the diff
            // (narrow terminals), the message moves above the status line instead.
            const message = changes.message;
            const messageRows =
              !diffVisible && message
                ? [truncateToWidth(styler.fg(message.color, message.text), contentWidth)]
                : [];
            const footer = [
              ...messageRows,
              status,
              ...inputLines,
              hintOneRow,
              theme.fg("dim", hintLineTwo),
            ];
            // The shared view's header (totals, recorded findings, messages, keys or
            // help, rule) sits under the review's title; its own title line is the
            // review's first row instead.
            const viewHeader = diffVisible
              ? changes.renderHeader(diffWidth, focus === "review").slice(1)
              : [];
            const room = Math.max(0, terminalRows - 1 - footer.length);
            const headerRows = viewHeader.slice(0, room);
            lastBodyHeight = Math.max(0, room - headerRows.length);
            const titleRows = terminalRows > 0 ? 1 : 0;
            diffArea = diffVisible
              ? {
                  headerTop: titleRows,
                  top: titleRows + headerRows.length,
                  rows: lastBodyHeight,
                  width: diffWidth,
                }
              : undefined;
            const body = changes.renderBody(diffWidth, focus === "review");
            // The view keeps its cursor visible through the scroller; a resize or
            // a comment drawn above it can still move it, so check once more here.
            const cursorRow = changes.selectionRow();
            if (lastBodyHeight > 0) {
              if (cursorRow < scrollTop) scrollTop = cursorRow;
              else if (cursorRow >= scrollTop + lastBodyHeight) {
                scrollTop = cursorRow - lastBodyHeight + 1;
              }
            }
            scrollTop = Math.max(0, Math.min(Math.max(0, body.length - lastBodyHeight), scrollTop));
            const visibleDiff = body.slice(scrollTop, scrollTop + lastBodyHeight);
            const hiddenBelow = Math.max(0, body.length - (scrollTop + visibleDiff.length));
            while (visibleDiff.length < lastBodyHeight) visibleDiff.push("");

            let visibleBody = visibleDiff.map((line) => fullWidthLine(line, contentWidth));
            if (chatOpen && chat) {
              const chatBody = chatBodyLines(
                chat,
                chatWidth,
                lastBodyHeight + headerRows.length,
                focus === "chat",
                theme,
                markdownTheme,
                renderToolEntry,
                chatScrollOffset,
              );
              chatScrollOffset = chatBody.offset;
              const visibleChat = chatBody.lines;
              if (splitChat) {
                visibleBody = [...headerRows, ...visibleDiff].map(
                  (line, index) =>
                    `${fullWidthLine(line, diffWidth)}${theme.fg("dim", "│")}${fullWidthLine(visibleChat[index] ?? "", chatWidth)}`,
                );
              } else if (focus === "chat") {
                visibleBody = visibleChat.map((line) => fullWidthLine(line, contentWidth));
              }
            }
            const leading = chatOpen && chat && (splitChat || focus === "chat") ? [] : headerRows;

            const scroll =
              diffVisible && (scrollTop > 0 || hiddenBelow > 0)
                ? `↑${scrollTop} ↓${hiddenBelow}`
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
              ...propertiesWhen(scroll, () => ({ scroll })),
              now: now(),
            });
            const footerRows = footer.slice(0, Math.max(0, terminalRows - 1));
            return [
              ...(terminalRows > 0 ? [fullWidthLine(header, contentWidth)] : []),
              ...leading.map((line) => fullWidthLine(line, contentWidth)),
              ...visibleBody,
              ...footerRows.map((line) => fullWidthLine(line, contentWidth)),
            ];
          },
          invalidate: () => {
            changes.invalidate();
            commentInput.invalidate();
            chatInput.invalidate();
            for (const toolView of toolViews.values()) toolView.component.invalidate();
          },
          handleInput: (data: string) => {
            if (closed) return;
            // A focused input owns the keys the prompt gives it: ↑/↓ move
            // through the text and reach history at the edges, Tab completes a
            // path, and an open completion list takes Esc to dismiss itself
            // before the view reads Esc as leaving.
            if (commentDraft) {
              if (matchesKey(data, "escape") && !commentInput.isShowingAutocomplete())
                stopComment();
              else {
                commentInput.handleInput(data);
                if (commentDraft) commentDraft = { ...commentDraft, body: commentInput.getText() };
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
            // Leaving (and closing the key list) never waits for other work.
            if (actionFor(REVIEW_KEYS, data) === "back") {
              changes.handleKey(data);
              tui.requestRender();
              return;
            }
            if (busy) return;
            if (data === "c") comment();
            else if (data === "a") openChat();
            else if (data === "e") void guarded(editCurrentHunk);
            else if (data === "E")
              void guarded(() =>
                launchEditorProject(config.editor, options.reviewRoot, tui, options.spawnEditor),
              );
            else if (data === "m") markReviewed();
            else if (data === "S") void guarded(finish);
            else if (data === "/") void guarded(search);
            else if (data === ">") changes.moveSearchMatch(1);
            else if (data === "<") changes.moveSearchMatch(-1);
            else if (data === "+") void guarded(expandContext);
            else if (data === "-") collapseContext();
            else if (data === SPLIT_TOGGLE_KEY) {
              mode = mode === "unified" ? "split" : "unified";
              changes.invalidate();
            } else if (matchesKey(data, "right")) moveFile(1);
            else if (matchesKey(data, "left")) moveFile(-1);
            else if (data === "t") {
              notify("Type information from review is planned for a later phase.", "info");
            } else changes.handleKey(data);
            tui.requestRender();
          },
          /**
           * The mouse on the diff, as in the `/diff` pane: a press on a line
           * puts the cursor there and drags select lines; a click on a file
           * row opens or closes it. Every left press on the diff is taken,
           * because Pi starts its own text selection on a press nothing takes
           * and copies it on release. The chat, the input and the title row
           * are left to Pi.
           */
          handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
            const area = diffArea;
            if (closed || !area) return undefined;
            if (selecting && (event.type === "drag" || event.type === "release")) {
              if (event.type === "release") selecting = false;
              else {
                // At most one row past either edge, so the selection scrolls a row at a time.
                const visible = Math.max(-1, Math.min(area.rows, event.y - area.top));
                changes.pointer({ kind: "drag", row: scrollTop + visible });
              }
              return { handled: true, render: true };
            }
            if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
              return undefined;
            }
            const onDiff =
              event.x < area.width && event.y >= area.headerTop && event.y < area.top + area.rows;
            if (!onDiff) return undefined;
            const visible = event.y - area.top;
            const row = visible >= 0 ? scrollTop + visible : undefined;
            // A comment being written keeps its lines, and a running action its target.
            const usable = !commentDraft && !busy;
            if (event.type === "press") {
              const onLine =
                usable &&
                row !== undefined &&
                changes.pointer({ kind: "press", row, extend: event.shift });
              if (!onLine) return { handled: true, render: false };
              selecting = true;
              if (focus !== "review") setFocus("review");
              return { handled: true, capture: true, render: true };
            }
            if (!usable) return { handled: true, render: false };
            if (focus !== "review") setFocus("review");
            if (row !== undefined) changes.pointer({ kind: "click", row });
            return { handled: true, render: true };
          },
        };
        return {
          render: (width: number): string[] => {
            if (renderFailure) return fallbackFrame(width);
            try {
              return component.render(width);
            } catch (error) {
              renderFailed(error);
              return fallbackFrame(width);
            }
          },
          invalidate: () => {
            if (renderFailure) return;
            try {
              component.invalidate();
            } catch (error) {
              renderFailed(error);
            }
          },
          handleInput: (data: string) => {
            if (renderFailure || closed) return;
            // Closing: only leaving keys count. A change now would miss the copy
            // being saved and be reported as kept when it was not.
            if (phase.kind !== "open") {
              // A leaving key leaves, whatever has focus (the chat after /quit
              // too): the immediate escape must not depend on where focus is.
              if (actionFor(REVIEW_KEYS, data) === "back") {
                leave();
                return;
              }
              notify(
                phase.kind === "leaving"
                  ? "Saving the review… q again leaves without saving."
                  : "Finishing… q cancels.",
                "info",
              );
              try {
                tui.requestRender();
              } catch {
                // Drawn with the next frame.
              }
              return;
            }
            try {
              component.handleInput(data);
            } catch (error) {
              // The view stays: the failure is on its message line. If the key
              // was one that leaves, leave anyway, so a failing handler can
              // never keep the user in the review.
              if (actionFor(REVIEW_KEYS, data) === "back" && !commentDraft && focus === "review") {
                leave();
              }
              notify(`That key failed: ${failureLine(error)}`, "error");
              try {
                tui.requestRender();
              } catch {
                // Drawn with the next frame.
              }
            }
          },
          handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
            if (renderFailure || closed || phase.kind !== "open") return undefined;
            try {
              return component.handleMouse(event);
            } catch (error) {
              // The view stays, as for a key that fails.
              selecting = false;
              notify(`That click failed: ${failureLine(error)}`, "error");
              return { handled: true, render: true };
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
    closed = true;
    unsubscribeStore?.();
    view?.dispose();
    store.dispose();
    unsubscribeChat?.();
    chat?.dispose();
  }
}
