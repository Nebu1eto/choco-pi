/**
 * Display summary of a structured reviewer or verifier block.
 *
 * The block is another model's output, so this module only ever summarises a
 * block the strict parser in verdict-blocks.ts accepted. Anything else is
 * reported as invalid with the parser's reason and shown as it is, never as
 * a clean result. Every string taken from a block is sanitised once, when the
 * summary is built; the two serialisations below only lay it out.
 *
 * One model, two serialisations:
 * - layoutSummary(): plain lines wrapped to a width, for the package cards that
 *   draw into a fixed number of columns and colour by line tone.
 * - summaryMarkdown(): an escaped Markdown list for transcript Markdown. Pi's
 *   Markdown renderer reflows paragraph text and strips leading indentation,
 *   so pre-wrapped lines would be reflowed again; a list item instead gets the
 *   renderer's own hanging indentation at the exact width it draws.
 * Meaning never depends on colour: severity, class and outcome are words.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./changes/terminal-text.ts";
import {
  parseReviewBlock,
  parseVerdictBlock,
  REVIEW_INFO,
  VERDICT_INFO,
  type ReviewBlock,
  type ReviewFinding,
  type VerdictBlock,
} from "./verdict-blocks.ts";

export type SummaryTone = "error" | "warning" | "success" | "muted" | "normal";

export interface SummaryEntry {
  /** Words that carry the meaning without colour, e.g. "HIGH finding" or "low CANDIDATE (unconfirmed)". */
  label: string;
  /** "path:line" for a finding, the id for a claim; sanitised. */
  location?: string;
  /** Invariant, note or missing item; sanitised. */
  text?: string;
  tone: SummaryTone;
}

export interface VerdictSummary {
  info: typeof REVIEW_INFO | typeof VERDICT_INFO;
  /** Verdict line: kind, verdict and counts. */
  headline: string;
  tone: SummaryTone;
  entries: SummaryEntry[];
  /** Shortened bundle digest or snapshot, sanitised. */
  footer: string;
}

export interface SummaryLine {
  text: string;
  tone: SummaryTone;
  role: "headline" | "entry" | "footer" | "notice";
}

export type BlockNotice = { info: string; reason: string };

/** What a message's structured blocks allow a display to show. */
export type VerdictTextAnalysis =
  /** No structured block: show the text unchanged. */
  | { state: "absent" }
  /** A structured fence is still open (streaming or truncated): show the text unchanged. */
  | { state: "unterminated" }
  /** The parser rejected a block: show the text unchanged after one notice per rejected block. */
  | { state: "invalid"; notices: BlockNotice[] }
  /** Every structured block parsed: summaries in message order, with each block's fence line range. */
  | { state: "parsed"; blocks: ParsedBlockDisplay[] };

export interface ParsedBlockDisplay {
  summary: VerdictSummary;
  /** Line index of the opening fence (after BOM removal and CRLF normalisation). */
  startLine: number;
  /** Line index of the closing fence. */
  endLine: number;
}

/** Messages longer than this are shown unchanged: the parse runs on every render. */
export const MAX_ANALYZED_CHARS = 256 * 1024;
const MENTION = /choco-pi-(?:review|verdict)/i;
const OPENING_FENCE = /^ {0,3}(\x60{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/;
const STRUCTURED: readonly string[] = [REVIEW_INFO, VERDICT_INFO];
const SEVERITY_ORDER: readonly ReviewFinding["severity"][] = ["critical", "high", "medium", "low"];
const DIGEST_CHARS = 24;

/** Display lines of a message, split the way the parser splits them. */
export function messageLines(text: string): string[] {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

type Fence = { info: string; closed: boolean; startLine: number; endLine: number };

/** The parser's top-level fence scan, kept here only to locate lines; validity is the parser's decision. */
function topLevelFences(lines: string[]): Fence[] {
  const fences: Fence[] = [];
  let open: { fence: string; info: string; startLine: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (open) {
      const closing = CLOSING_FENCE.exec(line);
      if (closing && closing[1][0] === open.fence[0] && closing[1].length >= open.fence.length) {
        fences.push({ info: open.info, closed: true, startLine: open.startLine, endLine: index });
        open = undefined;
      }
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    if (!opening) continue;
    const info = opening[2].trim();
    if (opening[1][0] === "\x60" && info.includes("\x60")) continue;
    open = { fence: opening[1], info, startLine: index };
  }
  if (open) {
    fences.push({
      info: open.info,
      closed: false,
      startLine: open.startLine,
      endLine: lines.length - 1,
    });
  }
  return fences;
}

function plural(count: number, noun: string): string {
  return count + " " + noun + (count === 1 ? "" : "s");
}

/** Code units of a field examined when shortening it; the field is untrusted and may be long. */
const SHORTEN_SCAN_UNITS = 4_096;

/**
 * At most `maximum` columns of `text`, cut between grapheme clusters and measured
 * as the summary's lines are, ending in "…" when anything was left out.
 */
function shorten(text: string, maximum: number): string {
  const scanned = text.length > SHORTEN_SCAN_UNITS ? text.slice(0, SHORTEN_SCAN_UNITS) : text;
  const clusters: Array<{ segment: string; width: number }> = [];
  let total = 0;
  for (const { segment } of SEGMENTER.segment(scanned)) {
    const width = visibleWidth(segment);
    clusters.push({ segment, width });
    total += width;
    if (total > maximum) break;
  }
  // Every cluster was read and fits: unchanged. A cap-cut last cluster is never complete, so drop it.
  if (total <= maximum && scanned === text) return text;
  if (scanned !== text && total <= maximum) clusters.pop();
  let kept = "";
  let width = 0;
  for (const cluster of clusters) {
    if (width + cluster.width > maximum - 1) break;
    kept += cluster.segment;
    width += cluster.width;
  }
  return kept + "\u2026";
}

function safe(text: string): string {
  return sanitizeTerminalText(text);
}

function location(finding: ReviewFinding): string {
  const path = safe(finding.path);
  if (finding.startLine === undefined) return path;
  if (finding.endLine === undefined || finding.endLine === finding.startLine) {
    return path + ":" + finding.startLine;
  }
  return path + ":" + finding.startLine + "-" + finding.endLine;
}

function severityCounts(findings: ReviewFinding[]): string {
  return SEVERITY_ORDER.map((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count > 0 ? count + " " + severity : "";
  })
    .filter((part) => part !== "")
    .join(", ");
}

function countPart(findings: ReviewFinding[], noun: string): string {
  if (findings.length === 0) return "no " + noun + "s";
  return plural(findings.length, noun) + " (" + severityCounts(findings) + ")";
}

function severityTone(severity: ReviewFinding["severity"]): SummaryTone {
  return severity === "critical" || severity === "high"
    ? "error"
    : severity === "medium"
      ? "warning"
      : "muted";
}

function findingEntry(finding: ReviewFinding): SummaryEntry {
  const candidate = finding.class === "candidate";
  return {
    label: candidate
      ? finding.severity + " CANDIDATE (unconfirmed)"
      : finding.severity.toUpperCase() + " finding",
    location: location(finding),
    text: safe(finding.invariant),
    tone: candidate ? "muted" : severityTone(finding.severity),
  };
}

/** Findings first, then candidates; each by severity, in block order within a severity. */
function orderedFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const rank = (finding: ReviewFinding) =>
    (finding.class === "candidate" ? SEVERITY_ORDER.length : 0) +
    SEVERITY_ORDER.indexOf(finding.severity);
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => rank(left.finding) - rank(right.finding) || left.index - right.index)
    .map((entry) => entry.finding);
}

export function summarizeReview(block: ReviewBlock): VerdictSummary {
  const findings = block.findings.filter((finding) => finding.class === "finding");
  const candidates = block.findings.filter((finding) => finding.class === "candidate");
  const counts =
    block.findings.length === 0
      ? "no findings, no candidates"
      : countPart(findings, "finding") + "; " + countPart(candidates, "candidate");
  const missing = block.incomplete?.missing ?? [];
  const entries: SummaryEntry[] = [
    ...(Array.isArray(missing) ? missing : [missing]).map((item): SummaryEntry => ({
      label: "MISSING",
      text: safe(item),
      tone: "warning",
    })),
    ...orderedFindings(block.findings).map(findingEntry),
  ];
  const tone: SummaryTone =
    block.verdict === "NO_FINDINGS"
      ? "success"
      : block.verdict === "INCOMPLETE"
        ? "warning"
        : findings.some((finding) => severityTone(finding.severity) === "error")
          ? "error"
          : "warning";
  return {
    info: REVIEW_INFO,
    headline: "Review " + block.verdict + ": " + counts,
    tone,
    entries,
    footer: "bundle " + shorten(safe(block.bundleDigest), DIGEST_CHARS),
  };
}

function outcomeCounts<Outcome extends string>(
  order: readonly Outcome[],
  values: Outcome[],
): string {
  return order
    .map((outcome) => {
      const count = values.filter((value) => value === outcome).length;
      return count > 0 ? count + " " + outcome : "";
    })
    .filter((part) => part !== "")
    .join(", ");
}

function snapshotFooter(block: VerdictBlock): string {
  const parts = [
    "task " + safe(block.workTask),
    "snapshot " +
      shorten(safe(block.snapshot.head), 12) +
      (block.snapshot.clean ? " clean" : " dirty"),
  ];
  if (block.snapshot.diffDigest !== undefined) {
    parts.push("diff " + shorten(safe(block.snapshot.diffDigest), DIGEST_CHARS));
  }
  return parts.join(" \u00b7 ");
}

export function summarizeVerdict(block: VerdictBlock): VerdictSummary {
  const claims = block.claims;
  return {
    info: VERDICT_INFO,
    headline:
      "Verification claims: " +
      plural(claims.length, "claim") +
      ", " +
      outcomeCounts(
        ["CONFIRMED", "REFUTED", "UNPROVEN"] as const,
        claims.map((claim) => claim.outcome),
      ),
    tone: claims.some((claim) => claim.outcome === "REFUTED")
      ? "error"
      : claims.some((claim) => claim.outcome === "UNPROVEN")
        ? "warning"
        : "success",
    entries: claims.map((claim) => {
      const entry: SummaryEntry = {
        label: claim.outcome,
        location: safe(claim.id),
        tone:
          claim.outcome === "CONFIRMED"
            ? "success"
            : claim.outcome === "REFUTED"
              ? "error"
              : "warning",
      };
      if (claim.note !== undefined && claim.note !== "") entry.text = safe(claim.note);
      return entry;
    }),
    footer: snapshotFooter(block),
  };
}

/**
 * Decides what a display may show for a message. Cheap when no block is named; a
 * message over MAX_ANALYZED_CHARS is reported absent, so it is shown unchanged.
 */
export function analyzeVerdictText(text: string): VerdictTextAnalysis {
  if (text.length > MAX_ANALYZED_CHARS || !MENTION.test(text)) return { state: "absent" };
  const lines = messageLines(text);
  const fences = topLevelFences(lines);
  if (fences.some((fence) => !fence.closed && STRUCTURED.includes(fence.info))) {
    return { state: "unterminated" };
  }
  const review = parseReviewBlock(text);
  const verdict = parseVerdictBlock(text);
  const notices: BlockNotice[] = [];
  if (review.status === "invalid") notices.push({ info: REVIEW_INFO, reason: safe(review.reason) });
  if (verdict.status === "invalid")
    notices.push({ info: VERDICT_INFO, reason: safe(verdict.reason) });
  if (notices.length > 0) return { state: "invalid", notices };
  const blocks: ParsedBlockDisplay[] = [];
  for (const [info, summary] of [
    [REVIEW_INFO, review.status === "parsed" ? summarizeReview(review.value) : undefined],
    [VERDICT_INFO, verdict.status === "parsed" ? summarizeVerdict(verdict.value) : undefined],
  ] as const) {
    if (summary === undefined) continue;
    const fence = fences.find((candidate) => candidate.closed && candidate.info === info);
    // A parsed block is always a closed top-level fence; failing to find it is shown as invalid, not clean.
    if (!fence)
      return { state: "invalid", notices: [{ info, reason: "the block could not be located" }] };
    blocks.push({ summary, startLine: fence.startLine, endLine: fence.endLine });
  }
  if (blocks.length === 0) return { state: "absent" };
  blocks.sort((left, right) => left.startLine - right.startLine);
  return { state: "parsed", blocks };
}

/** One line naming the rejected block and the parser's (already sanitised) reason. */
export function noticeText(notice: BlockNotice): string {
  return "Invalid " + notice.info + " block, not summarised: " + notice.reason;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Words between single-space clusters. A space that carries a combining mark is one
 * cluster and stays inside its word, so no word (and no wrapped line) begins with a mark.
 */
function words(text: string): string[] {
  const found: string[] = [];
  let current = "";
  for (const { segment } of SEGMENTER.segment(text)) {
    if (segment === " ") {
      found.push(current);
      current = "";
    } else current += segment;
  }
  found.push(current);
  return found;
}

/** Splits one word into pieces no wider than width (a grapheme wider than width stands alone). */
function breakWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const { segment } of SEGMENTER.segment(word)) {
    const segmentWidth = visibleWidth(segment);
    if (current !== "" && currentWidth + segmentWidth > width) {
      pieces.push(current);
      current = "";
      currentWidth = 0;
    }
    current += segment;
    currentWidth += segmentWidth;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Greedy word wrap; continuation lines carry the indent. Input holds no control characters. */
export function wrapText(text: string, width: number, indent: string): string[] {
  const usable = Math.max(1, width);
  const hanging = visibleWidth(indent) < usable - 4 ? indent : "";
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  const limit = () => (lines.length === 0 ? usable : usable - visibleWidth(hanging));
  const push = () => {
    lines.push(lines.length === 0 ? line : hanging + line);
    line = "";
    lineWidth = 0;
  };
  for (const word of words(text)) {
    if (word === "") continue;
    const wordWidth = visibleWidth(word);
    const gap = line === "" ? 0 : 1;
    if (lineWidth + gap + wordWidth <= limit()) {
      line += (gap ? " " : "") + word;
      lineWidth += gap + wordWidth;
      continue;
    }
    if (line !== "") push();
    if (wordWidth <= limit()) {
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    for (const piece of breakWord(word, limit())) {
      if (line !== "") push();
      line = piece;
      lineWidth = visibleWidth(piece);
    }
  }
  if (line !== "" || lines.length === 0) push();
  return lines;
}

export function entryText(entry: SummaryEntry): string {
  return [entry.label, entry.location, entry.text]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" \u00b7 ");
}

export interface LayoutOptions {
  /** Show at most this many entries, then one line counting the rest. */
  maxEntries?: number;
}

function hiddenLine(hidden: number): string {
  return (
    "+ " + hidden + (hidden === 1 ? " more entry" : " more entries") + "; expand for the raw block"
  );
}

/** Plain lines, none wider than the given width in columns. */
export function layoutSummary(
  summary: VerdictSummary,
  width: number,
  options: LayoutOptions = {},
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const add = (text: string, tone: SummaryTone, role: SummaryLine["role"], indent: string) => {
    for (const line of wrapText(text, width, indent)) lines.push({ text: line, tone, role });
  };
  add(summary.headline, summary.tone, "headline", "  ");
  const shown =
    options.maxEntries === undefined
      ? summary.entries
      : summary.entries.slice(0, options.maxEntries);
  for (const entry of shown) add("- " + entryText(entry), entry.tone, "entry", "    ");
  const hidden = summary.entries.length - shown.length;
  if (hidden > 0) add(hiddenLine(hidden), "muted", "footer", "  ");
  add(summary.footer, "muted", "footer", "  ");
  return lines;
}

/** Plain notice lines for a rejected block, none wider than the given width. */
export function layoutNotice(notice: BlockNotice, width: number): SummaryLine[] {
  return wrapText(noticeText(notice), width, "  ").map((text) => ({
    text,
    tone: "error",
    role: "notice",
  }));
}

/**
 * Escapes text for inline Markdown so it renders literally. Every ASCII punctuation character is
 * backslash-escaped except "(", ")" and "[": Pi's Markdown reads a backslash before "(" or "[" as a LaTeX
 * delimiter, and with every "]" escaped no link, image or reference can form.
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[!-'*-/:-@\\\]-\x60{-~]/g, (character) => "\\" + character);
}

/** The summary as Markdown: a bold verdict line, one list item per entry, and the footer. */
export function summaryMarkdown(summary: VerdictSummary): string {
  const parts = ["**" + escapeMarkdownInline(summary.headline) + "**"];
  if (summary.entries.length > 0) {
    parts.push(
      summary.entries.map((entry) => "- " + escapeMarkdownInline(entryText(entry))).join("\n"),
    );
  }
  parts.push(escapeMarkdownInline(summary.footer));
  return parts.join("\n\n");
}

/** One notice as a Markdown paragraph. */
export function noticeMarkdown(notice: BlockNotice): string {
  return "**" + escapeMarkdownInline(noticeText(notice)) + "**";
}
