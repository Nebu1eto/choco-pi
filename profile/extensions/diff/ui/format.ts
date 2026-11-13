/** Pure text formatting for the pane and the inline fallback list. */
import type {
  DiffSnapshot,
  DiffSource,
  DiffStoreState,
  FileSummary,
} from "../../lib/changes/git/model.ts";
import { markdownFailure, markdownName, markdownText } from "../../lib/changes/markdown.ts";
import {
  baselineText,
  emptyMessage,
  sourceLabel,
  totalsText,
} from "../../lib/changes/view/source-text.ts";
import { sanitizeTerminalText as safe } from "../../lib/changes/terminal-text.ts";
import { countsText, plural, statusLetter, terminalPath } from "../../lib/changes/view/rows.ts";

export {
  baselineText,
  emptyMessage,
  sourceLabel,
  totalsText,
} from "../../lib/changes/view/source-text.ts";

// The row widgets moved to the shared layer; pane code and its tests keep importing them from here.
export {
  bodyNotice,
  countsText,
  displayPath,
  fileRow,
  middleTruncate,
  plainPaneStyler,
  plural,
  statusLetter,
  terminalPath,
  type PaneColor,
  type PaneStyler,
  type RowBadge,
} from "../../lib/changes/view/rows.ts";

const INLINE_FILE_LIMIT = 30;

/** Compact plain-text list used when the pane cannot be shown. */
export function inlineList(state: DiffStoreState): string {
  if (state.kind === "idle") return "Diff: not loaded yet.";
  if (state.kind === "not-a-repository")
    return `Diff: ${safe(state.cwd)} is not inside a git repository.`;
  if (state.kind === "error") return `Diff failed: ${safe(state.message)}`;
  const snapshot = state.snapshot;
  const branch = snapshot.branch ? ` on ${safe(snapshot.branch)}` : "";
  const lines = [`${sourceLabel(snapshot.source)}${branch}: ${totalsText(snapshot)}`];
  const baseline = baselineText(snapshot);
  if (baseline !== undefined) lines.push(baseline);
  if (snapshot.files.length === 0) {
    lines.push(emptyMessage(snapshot));
    return lines.join("\n");
  }
  for (const file of snapshot.files.slice(0, INLINE_FILE_LIMIT)) {
    const counts = countsText(file);
    lines.push(`${statusLetter(file.status)} ${terminalPath(file)}${counts ? `  ${counts}` : ""}`);
  }
  const hidden = snapshot.files.length - INLINE_FILE_LIMIT;
  const more = Math.max(0, hidden) + snapshot.omittedFiles;
  if (more > 0) lines.push(`${plural(more, "more file")} not shown`);
  return lines.join("\n");
}

/** The source's name, with any untrusted part (a branch, a turn's label) as a code span. */
function sourceMarkdown(source: DiffSource): string {
  if (source.kind === "session") return "Session changes";
  if (source.kind === "uncommitted") return "Uncommitted changes";
  if (source.kind === "branch-base") return `Changes since ${markdownName(source.base)}`;
  return `Changes ${source.turnOnly ? "in" : "since"} ${markdownName(source.label)}`;
}

function emptyMarkdown(snapshot: DiffSnapshot): string {
  const source = snapshot.source;
  if (source.kind === "branch-base") return `No changes against ${markdownName(source.base)}`;
  if (source.kind === "since-checkpoint" || source.kind === "range") {
    return `No changes ${source.turnOnly ? "in" : "since"} ${markdownName(source.label)}`;
  }
  // Session and uncommitted sentences are ours (a session's reason is one of our constants).
  return markdownText(emptyMessage(snapshot));
}

function baselineMarkdown(snapshot: DiffSnapshot): string | undefined {
  if (snapshot.source.kind !== "session") return undefined;
  const baseline = snapshot.baseline;
  if (!baseline || baseline.kind === "none") {
    return markdownText("Baseline: none yet (no file checkpoint)");
  }
  return `Baseline: checkpoint before ${markdownName(baseline.label)}`;
}

function fileMarkdown(file: FileSummary): string {
  const path =
    file.oldPath && file.oldPath !== file.path
      ? `${markdownName(file.oldPath)} → ${markdownName(file.path)}`
      : markdownName(file.path);
  const counts = countsText(file);
  return `- ${markdownText(statusLetter(file.status))} ${path}${counts ? ` ${markdownText(counts)}` : ""}`;
}

/**
 * {@link inlineList} for an editor that renders notifications as Markdown (Zed
 * through the choco-pi ACP adapter): the same facts, with each untrusted name
 * sanitised once and written as a code span, our prose escaped, git's error in
 * a code block, and the files as a list so the lines do not run together.
 */
export function inlineMarkdown(state: DiffStoreState): string {
  if (state.kind === "idle") return "Diff: not loaded yet.";
  if (state.kind === "not-a-repository") {
    return `Diff: ${markdownName(state.cwd)} is not inside a git repository.`;
  }
  if (state.kind === "error") return markdownFailure("Diff failed:", state.message);
  const snapshot = state.snapshot;
  const branch = snapshot.branch ? ` on ${markdownName(snapshot.branch)}` : "";
  const blocks = [
    `${sourceMarkdown(snapshot.source)}${branch}: ${markdownText(totalsText(snapshot))}`,
  ];
  const baseline = baselineMarkdown(snapshot);
  if (baseline !== undefined) blocks.push(baseline);
  if (snapshot.files.length === 0) {
    blocks.push(emptyMarkdown(snapshot));
    return blocks.join("\n\n");
  }
  blocks.push(snapshot.files.slice(0, INLINE_FILE_LIMIT).map(fileMarkdown).join("\n"));
  const more = Math.max(0, snapshot.files.length - INLINE_FILE_LIMIT) + snapshot.omittedFiles;
  if (more > 0) blocks.push(markdownText(`${plural(more, "more file")} not shown`));
  return blocks.join("\n\n");
}
