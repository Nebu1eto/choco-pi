import { isJsonRecord, isString, type RuntimeValue } from "../../lib/runtime-values.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { ReviewChat, ReviewChatToolCall } from "../core/ask.ts";
import {
  sanitizeTerminalLines,
  sanitizeTerminalText as safe,
} from "../../lib/changes/terminal-text.ts";
import type { DiffStyler } from "../../lib/changes/render/diff-render.ts";
import type { DiffSource } from "../../lib/changes/git/model.ts";
import { BODY_INDENT } from "../../lib/changes/view/body-block.ts";
import { HIDDEN_CONTENTS } from "../../lib/changes/view/changes-view.ts";
import type { DiffHunk, ReviewComment, ReviewRecord } from "../core/types.ts";
import type { OpenReviewViewOptions } from "./review-view-types.ts";

export const HIDDEN_FILE_HINT = HIDDEN_CONTENTS;

export function targetIncludesWorkingTree(target: ReviewRecord["target"]): boolean {
  if (target.kind === "branch") return target.target === undefined;
  return target.kind === "session" || target.kind === "session-turn";
}

export function composeSessionReviewInstruction(
  record: ReviewRecord,
  markdown: string,
  includesWorkingTree = targetIncludesWorkingTree(record.target),
): string | undefined {
  if (record.target.kind === "pr") return undefined;
  const lead = includesWorkingTree
    ? "Please address the following human code review. Resolve each comment, preserve unrelated behavior, and report any comment you cannot address."
    : "The following human code review refers to an earlier comparison, not the working tree; its lines may not match the files as they are now. Read each comment against that comparison before acting on it.";
  return [lead, "", markdown.trimEnd()].join("\n");
}

export function sourceOfTarget(target: ReviewRecord["target"]): DiffSource {
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

export function outdatedCommentLines(
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

export function commentBlock(
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

export function commentLineIndex(
  hunk: DiffHunk,
  comment: Pick<ReviewComment, "side" | "line">,
): number {
  return hunk.lines.findIndex((line) =>
    comment.side === "LEFT"
      ? line.kind !== "add" && line.oldLine === comment.line
      : line.kind !== "del" && line.newLine === comment.line,
  );
}

export function terminalSafeValue(value: RuntimeValue): RuntimeValue {
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

export const REVIEW_CHROME_ROWS = 5;
export const REVIEW_CHAT_SPLIT_MIN_WIDTH = 120;
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

export function rangeLabel(position: { line: number; startLine?: number }): string {
  return position.startLine === undefined
    ? `${position.line}`
    : `${position.startLine}-${position.line}`;
}
export function fullWidthLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

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

export function reviewHeaderLine(options: {
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

export function reviewEditorTheme(theme: Theme): EditorTheme {
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

export function wrapPlainText(text: string, width: number): string[] {
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

export function chatBodyLines(
  chat: ReviewChat,
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
  markdownTheme: MarkdownTheme,
  renderTool: (entry: ReviewChatToolCall, width: number) => readonly string[],
  scrollOffset: number,
): ChatBody {
  let heading = focused
    ? theme.fg("accent", theme.bold("Agent chat [FOCUSED]"))
    : theme.bold("Agent chat");
  const messageWidth = Math.max(1, width - 2);
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
    content.push(
      ...new Markdown(sanitizeTerminalLines(message.text), 0, 0, markdownTheme).render(
        messageWidth,
      ),
    );
  }
  if (content.length === 0) content.push(theme.fg("dim", "Ask about the selected diff line."));
  if (chat.pending) content.push(theme.fg("dim", "Agent is replying…"));
  const visibleHeight = Math.max(0, height - 1);
  const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, content.length - visibleHeight)));
  if (offset > 0) heading += theme.fg("muted", ` · ↓${offset} below`);
  const end = content.length - offset;
  const visible = content.slice(Math.max(0, end - visibleHeight), end);
  const lines = [heading, ...visible];
  while (lines.length < height) lines.push("");
  return { lines: lines.slice(0, height), offset };
}

export function failureLine(error: RuntimeValue): string {
  const raw = error instanceof Error ? error.message : String(error);
  return safe((raw.split(/\r?\n/u)[0] ?? "").trim() || "unknown error");
}
