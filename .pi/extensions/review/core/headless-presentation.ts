import { isSensitiveFile } from "../../lib/changes/sensitive.ts";
import type { DiffAssessment } from "./heuristics.ts";
import type { DiffFile, DiffModel, ReviewRecord, ReviewTarget } from "./types.ts";

export const MAX_HEADLESS_REVIEW_FILES = 50;
export const MAX_HEADLESS_DIFF_UNIT_BYTES = 32 * 1024;
export const MAX_HEADLESS_PRESENTATION_BYTES = 256 * 1024;
export const MAX_HEADLESS_RISKS = 100;
export const MAX_HEADLESS_SAVED_REVIEWS = 50;

const MAX_PATH_BYTES = 4 * 1024;
const MAX_LABEL_BYTES = 8 * 1024;
const MAX_RENDER_LINES = 4_000;
/** Appended to a bounded label or text that was cut; the Markdown renderer recognises it. */
export const TRUNCATION_INDICATOR = "\n…[truncated]";
const encoder = new TextEncoder();

type TruncatedText = { text: string; truncated: boolean };

export type HeadlessReviewLocation = { path: string; line: number; column?: number };
export type HeadlessReviewDiffUnit = {
  path: string;
  oldText: string;
  newText: string;
  truncated?: boolean;
};
/** One file's hunks as unified diff text (`@@` headers, then ` `/`+`/`-` lines). */
export type HeadlessReviewUnifiedDiff = {
  path: string;
  diff: string;
  /** Length of the file's whole unified diff in UTF-16 code units, before any bound. */
  chars: number;
  /** `diff` is not the whole diff: cut by the per-file bound, or emptied by the total bound. */
  truncated?: boolean;
};
/**
 * `plain`: per-file old and new text, the shape of an ACP `Diff`, for print
 * mode and other RPC clients. `markdown`: unified diffs for a person reading
 * an editor that renders Markdown (the choco-pi ACP adapter in Zed).
 */
export type HeadlessReviewFormat = "plain" | "markdown";
export type HeadlessReviewPresentation = {
  title: string;
  summary: string;
  locations: HeadlessReviewLocation[];
  diffUnits: HeadlessReviewDiffUnit[];
  risks: string[];
  savedReviews: string[];
  limitations: string[];
  truncated: boolean;
  /** Present for the `markdown` format only, which leaves `diffUnits` empty. */
  unifiedDiffs?: HeadlessReviewUnifiedDiff[];
};

export type HeadlessReviewPresentationInput = {
  target: ReviewTarget;
  model: DiffModel;
  assessments: DiffAssessment;
  savedReviews: readonly ReviewRecord[];
  format?: HeadlessReviewFormat;
};

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateText(value: string, limit: number): TruncatedText {
  if (bytes(value) <= limit) return { text: value, truncated: false };
  const indicatorBytes = bytes(TRUNCATION_INDICATOR);
  const contentLimit = Math.max(0, limit - indicatorBytes);
  let text = "";
  let used = 0;
  for (const character of value) {
    const characterBytes = bytes(character);
    if (used + characterBytes > contentLimit) break;
    text += character;
    used += characterBytes;
  }
  return { text: `${text}${TRUNCATION_INDICATOR}`, truncated: true };
}

/**
 * How a review target is named to the user, everywhere it is named (the
 * editor summary, the resume picker and its completions, saved-review lists).
 */
export function describeReviewTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "session":
      return `session ${target.sessionId}`;
    case "session-turn":
      return `session ${target.sessionId}, turn ${target.turnIndex}`;
    case "branch":
      // Without a named head the diff runs to the working tree, uncommitted edits included
      // (core/git.ts resolveBranchTarget), so the title names the working tree, as the TUI header does.
      if (target.target !== undefined) return `${target.base}…${target.target}`;
      return target.base === "HEAD"
        ? "uncommitted changes (HEAD → working tree)"
        : `${target.base} → working tree`;
    case "pr":
      return `pull request #${target.number}`;
    default:
      throw new Error("Unsupported review target.");
  }
}

function firstChangedLine(file: DiffFile): number {
  const hunk = file.hunks[0];
  if (!hunk) return 1;
  if (hunk.newLines > 0 && hunk.newStart > 0) return hunk.newStart;
  if (hunk.oldLines > 0 && hunk.oldStart > 0) return hunk.oldStart;
  return 1;
}

function reconstructSide(
  file: DiffFile,
  side: "old" | "new",
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === "old" ? line.kind !== "add" : line.kind !== "del") lines.push(line.text);
    }
  }
  const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return truncateText(text, MAX_HEADLESS_DIFF_UNIT_BYTES);
}

const LINE_PREFIX = { context: " ", add: "+", del: "-" } as const;

/**
 * The file's hunks as unified diff text, cut at a whole line within the unit
 * bound, and the length in UTF-16 code units the whole diff would have had.
 */
function unifiedDiff(file: DiffFile): TruncatedText & { chars: number } {
  const kept: string[] = [];
  let used = 0;
  let chars = 0;
  let lineCount = 0;
  let truncated = false;
  for (const hunk of file.hunks) {
    const lines = [
      hunk.header,
      ...hunk.lines.map((line) => `${LINE_PREFIX[line.kind]}${line.text}`),
    ];
    for (const line of lines) {
      chars += line.length;
      lineCount += 1;
      if (truncated) continue;
      const size = bytes(line) + 1;
      if (used + size > MAX_HEADLESS_DIFF_UNIT_BYTES) {
        truncated = true;
        continue;
      }
      kept.push(line);
      used += size;
    }
  }
  return { text: kept.join("\n"), truncated, chars: chars + Math.max(0, lineCount - 1) };
}

function renderRisk(path: string, score: number, reasons: readonly string[]): string {
  return `${path} — risk ${score}: ${reasons.join("; ")}`;
}

type ReadLimitations = { lines: string[]; truncated: boolean };

/** One limitation line per file a read limit kept out, then the omitted-file count. */
function readLimitations(model: DiffModel): ReadLimitations {
  const notices = model.notices ?? [];
  let truncated = notices.length > MAX_HEADLESS_REVIEW_FILES;
  const lines = notices.slice(0, MAX_HEADLESS_REVIEW_FILES).map((notice) => {
    const bounded = truncateText(`${notice.path}: ${notice.message}`, MAX_LABEL_BYTES);
    truncated ||= bounded.truncated;
    return bounded.text;
  });
  if (notices.length > MAX_HEADLESS_REVIEW_FILES) {
    lines.push(
      `${notices.length - MAX_HEADLESS_REVIEW_FILES} more files were not shown by read limits.`,
    );
  }
  const omitted = model.omittedFiles ?? 0;
  if (omitted > 0) {
    lines.push(
      `${omitted} more changed file${omitted === 1 ? " was" : "s were"} not listed: over the review's file limit.`,
    );
  }
  return { lines, truncated };
}

function renderSavedReview(record: ReviewRecord): string {
  const reviewed = record.cursor.reviewedHunkIds.length;
  const comments = record.comments.length;
  return `${describeReviewTarget(record.target)} — ${reviewed} reviewed, ${comments} comment${comments === 1 ? "" : "s"}${record.verdict ? `, verdict ${record.verdict}` : ""} — updated ${record.updatedAt}`;
}

/** A sensitive file, or one the reader left hidden: listed by name, its text never sent. */
function isHiddenInModel(model: DiffModel, file: DiffFile): boolean {
  return isSensitiveFile(file) || (model.hidden?.includes(file.path) ?? false);
}

/**
 * A hidden file's name for the reader: both sides of a rename or copy, so the
 * reader sees which side made it sensitive. Raw text; each renderer sanitises
 * the limitation line it ends up in once.
 */
function hiddenName(file: DiffFile): string {
  return file.oldPath !== undefined && file.oldPath !== file.path
    ? `${file.oldPath} → ${file.path}`
    : file.path;
}

function hiddenLimitation(
  paths: readonly string[],
): { line: string; truncated: boolean } | undefined {
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, MAX_HEADLESS_REVIEW_FILES);
  const rest = paths.length - shown.length;
  const bounded = truncateText(
    `Sensitive files listed by name only; their contents were not shown: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`,
    MAX_LABEL_BYTES,
  );
  return { line: bounded.text, truncated: bounded.truncated };
}

function enforceTotalBound(presentation: HeadlessReviewPresentation): void {
  let serializedBytes = bytes(JSON.stringify(presentation));
  if (serializedBytes <= MAX_HEADLESS_PRESENTATION_BYTES) return;

  if (!presentation.truncated) {
    presentation.truncated = true;
    serializedBytes += bytes("true") - bytes("false");
  }
  const diffUnitBytes = presentation.diffUnits.map((unit) => bytes(JSON.stringify(unit)));
  // Unified diffs are emptied from the last, never removed: each keeps its name and length.
  const unified = presentation.unifiedDiffs ?? [];
  for (let index = unified.length - 1; index >= 0; index -= 1) {
    if (serializedBytes <= MAX_HEADLESS_PRESENTATION_BYTES) return;
    const unit = unified[index];
    if (unit === undefined || unit.diff === "") continue;
    const before = bytes(JSON.stringify(unit));
    unit.diff = "";
    unit.truncated = true;
    serializedBytes -= before - bytes(JSON.stringify(unit));
  }
  const savedReviewBytes = presentation.savedReviews.map((review) => bytes(JSON.stringify(review)));
  const riskBytes = presentation.risks.map((risk) => bytes(JSON.stringify(risk)));
  const locationBytes = presentation.locations.map((location) => bytes(JSON.stringify(location)));

  while (serializedBytes > MAX_HEADLESS_PRESENTATION_BYTES) {
    if (presentation.diffUnits.length > 0) {
      const separatorBytes = presentation.diffUnits.length > 1 ? 1 : 0;
      presentation.diffUnits.pop();
      serializedBytes -= (diffUnitBytes.pop() ?? 0) + separatorBytes;
      continue;
    }
    if (presentation.savedReviews.length > 0) {
      const separatorBytes = presentation.savedReviews.length > 1 ? 1 : 0;
      presentation.savedReviews.pop();
      serializedBytes -= (savedReviewBytes.pop() ?? 0) + separatorBytes;
      continue;
    }
    if (presentation.risks.length > 0) {
      const separatorBytes = presentation.risks.length > 1 ? 1 : 0;
      presentation.risks.pop();
      serializedBytes -= (riskBytes.pop() ?? 0) + separatorBytes;
      continue;
    }
    if (presentation.locations.length > 0) {
      const separatorBytes = presentation.locations.length > 1 ? 1 : 0;
      presentation.locations.pop();
      serializedBytes -= (locationBytes.pop() ?? 0) + separatorBytes;
      continue;
    }
    break;
  }
}

/** Build a bounded, display-only representation of a local review. */
export function createHeadlessReviewPresentation(
  input: HeadlessReviewPresentationInput,
): HeadlessReviewPresentation {
  let truncated = input.model.files.length > MAX_HEADLESS_REVIEW_FILES;
  const files = input.model.files.slice(0, MAX_HEADLESS_REVIEW_FILES);
  const locations: HeadlessReviewLocation[] = [];
  const diffUnits: HeadlessReviewDiffUnit[] = [];
  const markdown = input.format === "markdown";
  const unifiedDiffs: HeadlessReviewUnifiedDiff[] = [];

  for (const file of files) {
    if (isHiddenInModel(input.model, file)) continue;
    const boundedPath = truncateText(file.path, MAX_PATH_BYTES);
    truncated ||= boundedPath.truncated;
    locations.push({ path: boundedPath.text, line: firstChangedLine(file) });
    if (markdown) {
      const diff = unifiedDiff(file);
      const unitTruncated = diff.truncated || boundedPath.truncated;
      truncated ||= unitTruncated;
      const unit: HeadlessReviewUnifiedDiff = {
        path: boundedPath.text,
        diff: diff.text,
        chars: diff.chars,
      };
      if (unitTruncated) unit.truncated = true;
      unifiedDiffs.push(unit);
      continue;
    }
    const oldSide = reconstructSide(file, "old");
    const newSide = reconstructSide(file, "new");
    const unitTruncated = oldSide.truncated || newSide.truncated || boundedPath.truncated;
    truncated ||= unitTruncated;
    const unit: HeadlessReviewDiffUnit = {
      path: boundedPath.text,
      oldText: oldSide.text,
      newText: newSide.text,
    };
    if (unitTruncated) unit.truncated = true;
    diffUnits.push(unit);
  }

  const additions = input.model.files.reduce((total, file) => total + file.additions, 0);
  const deletions = input.model.files.reduce((total, file) => total + file.deletions, 0);
  const hunks = input.model.files.reduce((total, file) => total + file.hunks.length, 0);
  const riskyFiles = input.assessments.files.filter((file) => file.riskScore > 0);
  const riskFindings = riskyFiles.reduce((total, file) => total + file.reasons.length, 0);

  const renderedRisks = riskyFiles.flatMap((file) =>
    file.reasons.length === 0 ? [] : [renderRisk(file.path, file.riskScore, file.reasons)],
  );
  if (renderedRisks.length > MAX_HEADLESS_RISKS) truncated = true;
  const risks = renderedRisks.slice(0, MAX_HEADLESS_RISKS).map((risk) => {
    const bounded = truncateText(risk, MAX_LABEL_BYTES);
    truncated ||= bounded.truncated;
    return bounded.text;
  });

  const orderedReviews = [...input.savedReviews].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  if (orderedReviews.length > MAX_HEADLESS_SAVED_REVIEWS) truncated = true;
  const savedReviews = orderedReviews.slice(0, MAX_HEADLESS_SAVED_REVIEWS).map((record) => {
    const bounded = truncateText(renderSavedReview(record), MAX_LABEL_BYTES);
    truncated ||= bounded.truncated;
    return bounded.text;
  });

  const title = truncateText(`Review: ${describeReviewTarget(input.target)}`, MAX_LABEL_BYTES);
  truncated ||= title.truncated;
  const limits = readLimitations(input.model);
  truncated ||= limits.truncated;
  const hidden = hiddenLimitation(
    input.model.files.filter((file) => isHiddenInModel(input.model, file)).map(hiddenName),
  );
  if (hidden) truncated ||= hidden.truncated;
  const presentation: HeadlessReviewPresentation = {
    title: title.text,
    summary: `${input.model.files.length} files, ${hunks} hunks, ${additions} insertions, ${deletions} deletions; ${riskyFiles.length} risky files, ${riskFindings} risk findings`,
    locations,
    diffUnits,
    risks,
    savedReviews,
    limitations: [
      "This headless review is read-only. Comment editing, approve/reject decisions, and pull-request submission remain TUI-only in this phase.",
      ...limits.lines,
      ...(hidden ? [hidden.line] : []),
    ],
    truncated,
  };
  if (markdown) presentation.unifiedDiffs = unifiedDiffs;
  enforceTotalBound(presentation);
  return presentation;
}

/** Render bounded lines suitable only for display surfaces such as `ctx.ui.notify`. */
export function renderHeadlessReview(presentation: HeadlessReviewPresentation): string[] {
  const lines = [presentation.title, presentation.summary];
  if (presentation.truncated) lines.push("Output was truncated by headless review bounds.");
  lines.push("", "Limitations:", ...presentation.limitations);
  lines.push("", "Changed locations:");
  for (const location of presentation.locations) lines.push(`- ${location.path}:${location.line}`);
  lines.push("", "Diff units:");
  for (const unit of presentation.diffUnits) {
    lines.push(`--- ${unit.path} (old)${unit.truncated ? " [truncated]" : ""}`);
    lines.push(...unit.oldText.split("\n"));
    lines.push(`+++ ${unit.path} (new)${unit.truncated ? " [truncated]" : ""}`);
    lines.push(...unit.newText.split("\n"));
  }
  lines.push(
    "",
    "Risks:",
    ...(presentation.risks.length > 0 ? presentation.risks : ["None detected."]),
  );
  lines.push(
    "",
    "Saved reviews:",
    ...(presentation.savedReviews.length > 0 ? presentation.savedReviews : ["None."]),
  );

  const rendered: string[] = [];
  let used = 0;
  let clipped = false;
  const renderedIndicator = "…[rendered output truncated by headless review bounds]";
  const contentByteLimit = MAX_HEADLESS_PRESENTATION_BYTES - bytes(renderedIndicator) - 1;
  for (const line of lines) {
    const lineBytes = bytes(line) + 1;
    if (rendered.length >= MAX_RENDER_LINES - 1 || used + lineBytes > contentByteLimit) {
      clipped = true;
      break;
    }
    rendered.push(line);
    used += lineBytes;
  }
  if (clipped) rendered.push(renderedIndicator);
  return rendered;
}
