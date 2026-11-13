import { fenceFor } from "../../lib/changes/references.ts";
import { escapeForAgent } from "../../lib/changes/terminal-text.ts";
import type { ReviewComment, ReviewRecord } from "./types.ts";

const VERDICT_LABELS = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
} as const;

function location(comment: ReviewComment): string {
  const range =
    comment.startLine === undefined || comment.startLine === comment.line
      ? ""
      : ` (lines ${comment.startLine}-${comment.line})`;
  return `${escapeForAgent(comment.path)}:${comment.line}${range}`;
}

/**
 * Said after the location of a comment whose line is not current: its text
 * was not found, or work that could move it had not finished. The number is
 * then where it was, never presented as where it is.
 */
function staleNote(comment: ReviewComment): string {
  const where = comment.startLine === undefined ? "that line is" : "those lines are";
  if (comment.stale === "outdated") {
    return ` — outdated: its text was not found in this comparison; ${where} where it was`;
  }
  if (comment.stale === "unconfirmed") {
    return ` — not confirmed: the review was still reading changes when this was written; ${where} where it was last found`;
  }
  return "";
}

/** Multi-line text for the editor or a model: line breaks stay, every other control is escaped. */
function agentLines(text: string): string {
  return text
    .split("\n")
    .map((line) => escapeForAgent(line, true))
    .join("\n");
}

export type ReviewMarkdownOptions = {
  /**
   * Sensitive files whose contents are still hidden: their comments are
   * listed without the quoted source line, so no file content leaves.
   */
  hiddenPaths?: readonly string[];
};

/**
 * Render persisted review data without coupling it to a submission service.
 * The result goes into the prompt editor and to a model, so repository text
 * in it (paths, quoted lines) has its control characters escaped.
 */
export function renderReviewMarkdown(
  record: ReviewRecord,
  options: ReviewMarkdownOptions = {},
): string {
  const hidden = new Set(options.hiddenPaths ?? []);
  const lines: string[] = ["# Code review", ""];
  lines.push(`**Verdict:** ${record.verdict ? VERDICT_LABELS[record.verdict] : "Not set"}`, "");
  if (record.body) lines.push(record.body, "");

  lines.push("## Comments", "");
  if (record.comments.length === 0) {
    lines.push("No inline comments.", "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const byPath = new Map<string, ReviewComment[]>();
  for (const comment of record.comments) {
    const comments = byPath.get(comment.path) ?? [];
    comments.push(comment);
    byPath.set(comment.path, comments);
  }

  for (const [path, comments] of byPath) {
    lines.push(`### ${escapeForAgent(path)}`, "");
    if (hidden.has(path)) {
      lines.push(
        "Sensitive file: its contents stay hidden, so no source lines are quoted and the line numbers are as written, not checked against the file.",
        "",
      );
    }
    for (const comment of comments) {
      lines.push(
        `#### ${location(comment)} (${comment.side})${staleNote(comment)}`,
        "",
        agentLines(comment.body),
        "",
      );
      if (hidden.has(path)) continue;
      const snippet = agentLines(comment.anchor.snippet);
      const fence = fenceFor(snippet);
      lines.push(`${fence}text`, snippet, fence, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
