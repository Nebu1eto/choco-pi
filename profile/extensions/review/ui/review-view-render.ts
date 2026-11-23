/**
 * Drawing the full-screen review: one frame of title, diff and/or chat, the
 * status line, and the footer with the input and its keys.
 */
import { propertiesWhen } from "../../lib/runtime-values.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText as safe } from "../../lib/changes/terminal-text.ts";
import { renderDiffFile } from "../../lib/changes/render/diff-render.ts";
import { createHighlight } from "../../lib/changes/render/highlight.ts";
import type { FileBodyRenderer } from "../../lib/changes/view/changes-view.ts";
import type { ResolvedReviewConfig } from "../core/types.ts";
import type { ReviewInput } from "./review-input.ts";
import { SPLIT_TOGGLE_KEY } from "./review-keys.ts";
import { locationOf } from "./review-view-comments.ts";
import {
  chatBodyLines,
  fullWidthLine,
  rangeLabel,
  REVIEW_CHAT_SPLIT_MIN_WIDTH,
  reviewHeaderLine,
} from "./review-view-format.ts";
import type { ReviewContext } from "./review-view-state.ts";
import { renderToolEntry } from "./review-view-tools.ts";

/** Draws one file's diff body for the changes view, with the review's highlight limits. */
export function createFileBodyRenderer(config: ResolvedReviewConfig): FileBodyRenderer {
  return (file, width, bodyStyler, layout) =>
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
}

export function outdatedCount(ctx: ReviewContext): number {
  return ctx.record.comments.filter((entry) => locationOf(ctx, entry).status === "outdated").length;
}

export function statusLine(ctx: ReviewContext): string {
  const files = ctx.changes.files();
  const file = ctx.changes.selectedFile();
  const hunks = file ? (ctx.changes.visibleHunks(file) ?? []) : [];
  const at = hunks.findIndex((hunk) => hunk.id === ctx.changes.selectedHunk?.hunkId);
  const outdated = outdatedCount(ctx);
  const comments = ctx.record.comments.length;
  const parts = [
    `${file ? ctx.changes.selectedIndex + 1 : 0}/${files.length} files`,
    `${at + 1}/${hunks.length} hunks`,
    `${ctx.record.cursor.reviewedHunkIds.length} reviewed`,
    outdated > 0 ? `${comments} comments (${outdated} outdated)` : `${comments} comments`,
    ctx.mode,
  ];
  const found = ctx.changes.searchState;
  if (found) {
    parts.push(
      found.matches.length === 0
        ? `search “${safe(found.query)}”: no matches`
        : `search “${safe(found.query)}”: ${found.index + 1}/${found.matches.length}`,
    );
  }
  return ctx.theme.fg("muted", parts.join(" · "));
}

export function commentTargetLine(ctx: ReviewContext): string {
  const position = ctx.commentDraft?.position ?? ctx.changes.commentPosition();
  if (!position) return ctx.theme.fg("dim", "No line selected · j/k or ↑/↓ line");
  return ctx.theme.fg(
    "dim",
    `Target ${safe(position.path)}:${rangeLabel(position)} ${position.side}`,
  );
}

/** One frame of the review: title, the changes view or chat (or both), and the footer. */
export function renderReviewFrame(ctx: ReviewContext, width: number): string[] {
  const contentWidth = Math.max(1, width);
  const splitChat = ctx.chatOpen && contentWidth >= REVIEW_CHAT_SPLIT_MIN_WIDTH;
  const chatWidth = splitChat ? Math.max(40, Math.floor(contentWidth * 0.4)) : contentWidth;
  const diffWidth = splitChat ? contentWidth - chatWidth - 1 : contentWidth;
  const diffVisible = splitChat || ctx.focus === "review";
  ctx.terminalRows = ctx.tui.terminal.rows;
  const status = `${statusLine(ctx)} · ${commentTargetLine(ctx)}`;
  let inputLines: string[];
  let hintLineOne: string;
  let hintLineTwo: string;
  // zentui's frame names the model, provider, and effort under the
  // text, exactly as it does for the session prompt. The chat is
  // the session behind both boxes, so both name it.
  const frameModel = (() => {
    const model = ctx.chat?.status.model ?? ctx.options.chatModel;
    const thinkingLevel = ctx.chat?.status.thinkingLevel ?? ctx.options.chatThinkingLevel;
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
    ctx.frameAdapter.frame({
      width: contentWidth,
      ...input.render(ctx.frameAdapter.editorWidth(contentWidth)),
      cwd: ctx.options.reviewRoot,
      uiTheme: ctx.theme,
      ...propertiesWhen(frameModel, () => ({ model: frameModel })),
    });
  if (ctx.commentDraft) {
    const draftPosition = ctx.commentDraft.position;
    inputLines = framedInput(ctx.commentInput);
    hintLineOne = "Comment · Enter submit · Shift+Enter newline · Tab path · Esc cancel";
    hintLineTwo =
      draftPosition.startLine === undefined
        ? "Comment attaches only to the selected visible line"
        : `Comment attaches to selected lines ${rangeLabel(draftPosition)} on ${draftPosition.side}`;
  } else if (ctx.focus === "chat") {
    inputLines = framedInput(ctx.chatInput);
    hintLineOne =
      "Ask agent · Enter ask · Shift+Enter newline · Ctrl+O tool output · Shift+Tab review · Esc close chat";
    hintLineTwo =
      "Context: selected file, side, line, focused row, and current hunk only · /model /effort /reload act on the chat";
  } else {
    inputLines = [
      ctx.theme.fg(
        "dim",
        "Input inactive · c writes a review comment · a asks in a side chat (the diff stays out of the main conversation)",
      ),
    ];
    hintLineOne = `Shift+↑/↓ select lines · ←/→ file · PgUp/PgDn page${ctx.chatOpen ? " · Tab focus chat · Ctrl+O tool output" : ""}`;
    hintLineTwo = `+/- context · c comment · a ask · / search · >/< match · ${SPLIT_TOGGLE_KEY} split · m reviewed · e/E editor · S finish · q save`;
  }
  // Without zentui the input has no metadata row, so the keys row
  // carries the model and effort instead of dropping them.
  const chatModelStatus = (() => {
    if (ctx.frameAdapter.available || !ctx.chatOpen || !ctx.chat) return undefined;
    const text = [ctx.chat.status.model?.split("/").at(-1), ctx.chat.status.thinkingLevel]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    return text || undefined;
  })();
  const hintOneRow = (() => {
    const left = ctx.theme.fg("dim", hintLineOne);
    if (!chatModelStatus) return left;
    const right = ctx.theme.fg("muted", chatModelStatus);
    const gap = contentWidth - visibleWidth(left) - visibleWidth(right);
    // A narrow terminal keeps the keys and drops the status.
    if (gap < 2) return left;
    return `${left}${" ".repeat(gap)}${right}`;
  })();
  // The view's header holds the message line; when the chat replaces the diff
  // (narrow terminals), the message moves above the status line instead.
  const message = ctx.changes.message;
  const messageRows =
    !diffVisible && message
      ? [truncateToWidth(ctx.styler.fg(message.color, message.text), contentWidth)]
      : [];
  const footer = [
    ...messageRows,
    status,
    ...inputLines,
    hintOneRow,
    ctx.theme.fg("dim", hintLineTwo),
  ];
  // The shared view's header (totals, recorded findings, messages, keys or
  // help, rule) sits under the review's title; its own title line is the
  // review's first row instead.
  const viewHeader = diffVisible
    ? ctx.changes.renderHeader(diffWidth, ctx.focus === "review").slice(1)
    : [];
  const room = Math.max(0, ctx.terminalRows - 1 - footer.length);
  const headerRows = viewHeader.slice(0, room);
  ctx.lastBodyHeight = Math.max(0, room - headerRows.length);
  const titleRows = ctx.terminalRows > 0 ? 1 : 0;
  ctx.diffArea = diffVisible
    ? {
        headerTop: titleRows,
        top: titleRows + headerRows.length,
        rows: ctx.lastBodyHeight,
        width: diffWidth,
      }
    : undefined;
  const body = ctx.changes.renderBody(diffWidth, ctx.focus === "review");
  // The view keeps its cursor visible through the scroller; a resize or
  // a comment drawn above it can still move it, so check once more here.
  const cursorRow = ctx.changes.selectionRow();
  if (ctx.lastBodyHeight > 0) {
    // The rows pinned at the top cover the rows under them: keep the cursor below them.
    const covered = ctx.changes.pinnedRowCount(ctx.scrollTop, ctx.lastBodyHeight);
    if (cursorRow < ctx.scrollTop + covered) {
      ctx.scrollTop = ctx.changes.topShowing(cursorRow, ctx.lastBodyHeight);
    } else if (cursorRow >= ctx.scrollTop + ctx.lastBodyHeight) {
      ctx.scrollTop = cursorRow - ctx.lastBodyHeight + 1;
    }
  }
  ctx.scrollTop = Math.max(
    0,
    Math.min(Math.max(0, body.length - ctx.lastBodyHeight), ctx.scrollTop),
  );
  const visibleDiff = body.slice(ctx.scrollTop, ctx.scrollTop + ctx.lastBodyHeight);
  // The open file's row and its hunk's header stay at the top while the rows under them scroll.
  if (ctx.scrollTop > 0) {
    ctx.changes.stickyRows(ctx.scrollTop, ctx.lastBodyHeight).forEach((row, index) => {
      if (index < visibleDiff.length) visibleDiff[index] = row;
    });
  }
  const hiddenBelow = Math.max(0, body.length - (ctx.scrollTop + visibleDiff.length));
  while (visibleDiff.length < ctx.lastBodyHeight) visibleDiff.push("");

  let visibleBody = visibleDiff.map((line) => fullWidthLine(line, contentWidth));
  if (ctx.chatOpen && ctx.chat) {
    const chatBody = chatBodyLines(
      ctx.chat,
      chatWidth,
      ctx.lastBodyHeight + headerRows.length,
      ctx.focus === "chat",
      ctx.theme,
      ctx.markdownTheme,
      (entry, toolWidth) => renderToolEntry(ctx, entry, toolWidth),
      ctx.chatScrollOffset,
    );
    ctx.chatScrollOffset = chatBody.offset;
    const visibleChat = chatBody.lines;
    if (splitChat) {
      visibleBody = [...headerRows, ...visibleDiff].map(
        (line, index) =>
          `${fullWidthLine(line, diffWidth)}${ctx.theme.fg("dim", "│")}${fullWidthLine(visibleChat[index] ?? "", chatWidth)}`,
      );
    } else if (ctx.focus === "chat") {
      visibleBody = visibleChat.map((line) => fullWidthLine(line, contentWidth));
    }
  }
  const leading = ctx.chatOpen && ctx.chat && (splitChat || ctx.focus === "chat") ? [] : headerRows;

  const scroll =
    diffVisible && (ctx.scrollTop > 0 || hiddenBelow > 0)
      ? `↑${ctx.scrollTop} ↓${hiddenBelow}`
      : undefined;
  const reviewFocus = ctx.focus === "review" ? "Review [FOCUSED]" : "Review";
  const chatFocus = !ctx.chatOpen
    ? ""
    : ctx.focus === "chat"
      ? " · Chat [FOCUSED]"
      : " · Chat open";
  const header = reviewHeaderLine({
    view: ctx.options,
    width: contentWidth,
    theme: ctx.theme,
    focus: `${reviewFocus}${chatFocus}`,
    ...propertiesWhen(scroll, () => ({ scroll })),
    now: ctx.now(),
  });
  const footerRows = footer.slice(0, Math.max(0, ctx.terminalRows - 1));
  return [
    ...(ctx.terminalRows > 0 ? [fullWidthLine(header, contentWidth)] : []),
    ...leading.map((line) => fullWidthLine(line, contentWidth)),
    ...visibleBody,
    ...footerRows.map((line) => fullWidthLine(line, contentWidth)),
  ];
}
