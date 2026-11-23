import {
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";
import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import * as nodeFs from "node:fs";
import {
  hostWouldApplyOldText,
  normalizeForGuardMatch,
  normalizeToLF,
  stripBom,
} from "./host-edit-normalize.ts";
import type { PartiallyApplicableEdit } from "./partial-edit-apply.ts";
import {
  boundedIndexesForCount,
  createReadGuardEditBatchSummary,
  logReadGuardEvent,
  type EditBatchRejection,
  type ReadGuardEditBatchSummary,
} from "./read-guard-logger.ts";
import { isToolCallEventType } from "./tool-event.ts";

export interface GuardLineResult {
  touchedLines: [number, number] | undefined;
  editRanges?: [number, number][];
  preflightError?: string;
  partiallyApplicable?: PartiallyApplicableEdit[];
  editBatchSummary?: ReadGuardEditBatchSummary;
  contentMatchValidated?: boolean;
}

const recentOldTextFailures = new Map<string, { count: number; lastTs: number }>();
const REPEAT_FAILURE_TTL_MS = 300_000;
const MAX_FAILURE_TRACKER_SIZE = 200;

function trackOldTextFailure(filePath: string, preview: string): number {
  const key = `${filePath}::${preview}`;
  const now = Date.now();
  const prev = recentOldTextFailures.get(key);
  const count = prev && now - prev.lastTs < REPEAT_FAILURE_TTL_MS ? prev.count + 1 : 1;
  if (recentOldTextFailures.size >= MAX_FAILURE_TRACKER_SIZE) {
    const oldest = recentOldTextFailures.keys().next().value;
    if (oldest !== undefined) recentOldTextFailures.delete(oldest);
  }
  recentOldTextFailures.set(key, { count, lastTs: now });
  return count;
}

function findFirstLineOfOldText(content: string, oldText: string): number | undefined {
  const firstLine = oldText.replace(/\r\n/g, "\n").split("\n")[0].trim();
  if (firstLine.length < 5) return undefined;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === firstLine) return i + 1;
  }
  return undefined;
}

function tokenizeForSimilarity(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokenizeForSimilarity(a));
  const tb = new Set(tokenizeForSimilarity(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection);
}

function findSimilarLines(
  content: string,
  target: string,
  options: { nearLine?: number; window?: number; max?: number; minScore?: number } = {},
): Array<{ line: number; score: number }> {
  const { nearLine, window = 60, max = 3, minScore = 0.5 } = options;
  const needle = target.trim();
  if (needle.length < 4) return [];
  const lines = content.split("\n");
  const start = nearLine ? Math.max(0, nearLine - 1 - window) : 0;
  const end = nearLine ? Math.min(lines.length, nearLine - 1 + window) : lines.length;
  const scored: Array<{ line: number; score: number }> = [];
  for (let i = start; i < end; i += 1) {
    const text = lines[i];
    if (text.trim() === "") continue;
    const score = tokenSimilarity(needle, text);
    if (score >= minScore) scored.push({ line: i + 1, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

function formatSimilarLines(suggestions: Array<{ line: number }>, rawLineAligned: string): string {
  const rawLines = rawLineAligned.split("\n");
  const pad = (n: number) => String(n).padStart(4, " ");
  const rows = suggestions.map(
    ({ line }) => `      ${pad(line)} │ ${(rawLines[line - 1] ?? "").trimEnd()}`,
  );
  return `\n\nDid you mean one of these current lines?\n${rows.join("\n")}`;
}

export function countFileLines(filePath: string): number {
  try {
    const content = nodeFs.readFileSync(filePath, "utf-8");
    if (content.length === 0) return 1;
    return content.split(/\r?\n/).length;
  } catch {
    return 1;
  }
}

function normalizeContent(text: string): string {
  return normalizeForGuardMatch(text);
}

function lineNumberAt(content: string, index: number): number {
  return content.substring(0, index).split("\n").length;
}

function parseHashlineAnchor(anchor: LspBoundaryValue): number | undefined {
  if (!isString(anchor)) return undefined;
  const trimmed = anchor.trim();
  const separator = trimmed.indexOf(":");
  const lineText = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (!/^\d+$/.test(lineText)) return undefined;
  const line = Number(lineText);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function combineRanges(ranges: [number, number][]): GuardLineResult {
  const starts = ranges.map(([start]) => start);
  const ends = ranges.map(([, end]) => end);
  return {
    touchedLines: [Math.min(...starts), Math.max(...ends)],
    editRanges: ranges.length > 1 ? ranges : undefined,
  };
}

function getHashlineOperations(input: Record<string, LspDictionaryValue>): unknown[] {
  if (Array.isArray(input.operations)) return input.operations;
  if (Array.isArray(input.ops)) return input.ops;
  if (input.set_line || input.replace_lines || input.replace_symbol) return [input];
  return [];
}

function resolveHashlineEditInput(
  input: Record<string, LspDictionaryValue>,
  filePath: string | undefined,
  sessionId: string | undefined,
  correlationId?: string,
): GuardLineResult | undefined {
  const operations = getHashlineOperations(input);
  if (operations.length === 0) return undefined;
  const ranges: [number, number][] = [];
  const errors: string[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const op = operations[index] as Record<string, LspDictionaryValue>;
    if (op.set_line) {
      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const payload = op.set_line as Record<string, LspDictionaryValue>;
      const line = parseHashlineAnchor(payload.anchor);
      if (!line) {
        errors.push(`operation[${index}].set_line.anchor is malformed`);
        continue;
      }
      ranges.push([line, line]);
      continue;
    }
    if (op.replace_lines) {
      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const payload = op.replace_lines as Record<string, LspDictionaryValue>;
      const start = parseHashlineAnchor(payload.start_anchor);
      const end = parseHashlineAnchor(payload.end_anchor);
      if (!start || !end) {
        errors.push(`operation[${index}].replace_lines anchors are malformed`);
        continue;
      }
      if (start > end) {
        errors.push(`operation[${index}].replace_lines range is inverted`);
        continue;
      }
      ranges.push([start, end]);
      continue;
    }
    if (op.replace_symbol) {
      errors.push(
        `operation[${index}].replace_symbol cannot be resolved safely yet; use line anchors or a native ranged edit`,
      );
      continue;
    }
    errors.push(`operation[${index}] is not a recognized hashline edit`);
  }

  if (errors.length > 0) {
    const editBatchSummary = createReadGuardEditBatchSummary({
      requestedIndexes: boundedIndexesForCount(operations.length),
      requestedTotal: operations.length,
      rejectedReasons: boundedIndexesForCount(operations.length).map((index) => ({
        index,
        code: "preflight_blocked" as const,
      })),
      rejectedTotal: operations.length,
      durationMs: 0,
      terminalStatus: "blocked",
    });
    if (filePath) {
      logReadGuardEvent({
        event: "edit_preflight_blocked",
        correlationId,
        sessionId,
        filePath,
        metadata: {
          tool: "edit",
          source: "hashline_edit",
          reasonKind: "unsupported_hashline_edit_target",
          operationCount: operations.length,
          errorCount: errors.length,
          errors: errors.slice(0, 10),
        },
      });
      logReadGuardEvent({
        event: "edit_batch_summary",
        correlationId,
        filePath,
        metadata: { tool: "edit", editBatchSummary },
      });
    }
    const target = filePath ? `\`${filePath}\`` : "the file";
    const retryHint = `Re-read ${target} to get current #line anchors, then retry using set_line / replace_lines with those anchors — or use a native ranged edit.`;
    return {
      touchedLines: undefined,
      preflightError: `🔴 BLOCKED — Unsupported hashline edit target\n\n${errors.join("\n")}\n\n${retryHint}`,
      editBatchSummary,
    };
  }
  if (ranges.length === 0) return undefined;
  const result = combineRanges(ranges);
  if (filePath) {
    logReadGuardEvent({
      event: "touched_lines_detected",
      correlationId,
      sessionId,
      filePath,
      metadata: {
        tool: "edit",
        source:
          ranges.length === 1 && ranges[0][0] === ranges[0][1]
            ? "hashline_set_line"
            : "hashline_replace_lines",
        touchedLines: result.touchedLines,
        editRanges: result.editRanges,
        operationCount: operations.length,
      },
    });
  }
  return result;
}

function findOccurrenceLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let pos = 0;
  while (pos < content.length) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    lines.push(lineNumberAt(content, idx));
    pos = idx + needle.length;
  }
  return lines;
}

function formatOccurrenceContext(
  content: string,
  occurrenceLines: number[],
  matchSpanLines: number,
  maxOccurrences = 5,
): string {
  const fileLines = content.split("\n");
  const shown = occurrenceLines.slice(0, maxOccurrences);
  const extra = occurrenceLines.length - shown.length;
  const pad = (n: number) => String(n).padStart(4, " ");
  const blocks = shown.map((startLine) => {
    const endLine = startLine + matchSpanLines - 1;
    const before = startLine > 1 ? fileLines[startLine - 2] : undefined;
    const after = endLine < fileLines.length ? fileLines[endLine] : undefined;
    const lines: string[] = [`  • Line ${startLine}:`];
    if (before !== undefined) lines.push(`      ${pad(startLine - 1)} │ ${before}`);
    if (matchSpanLines === 1) {
      lines.push(`      ${pad(startLine)} │ ${fileLines[startLine - 1] ?? ""}  ← match`);
    } else {
      lines.push(`      ${pad(startLine)} │ ${fileLines[startLine - 1] ?? ""}  ← match start`);
      if (matchSpanLines > 2) {
        lines.push(
          `      ${pad(0)} │ … (${matchSpanLines - 2} more line${matchSpanLines - 2 === 1 ? "" : "s"})`,
        );
      }
      lines.push(`      ${pad(endLine)} │ ${fileLines[endLine - 1] ?? ""}  ← match end`);
    }
    if (after !== undefined) lines.push(`      ${pad(endLine + 1)} │ ${after}`);
    return lines.join("\n");
  });
  const tail = extra > 0 ? `\n  • … and ${extra} more occurrence${extra === 1 ? "" : "s"}` : "";
  return blocks.join("\n") + tail;
}

function countRawOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (pos < content.length) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

function exactOldTextForApply(
  rawContentLf: string,
  oldText: string,
  candidate: string,
): string | undefined {
  const oldTextLf = oldText.replace(/\r\n/g, "\n");
  if (countRawOccurrences(rawContentLf, oldTextLf) === 1) return oldTextLf;
  if (candidate !== oldTextLf && countRawOccurrences(rawContentLf, candidate) === 1) {
    return candidate;
  }
  return undefined;
}

function resolveOldTextEdits(
  edits: Array<{ oldText?: string; newText?: string; originalIndex?: number }>,
  filePath: string,
  sessionId: string | undefined,
  correlationId?: string,
): GuardLineResult {
  const startedAt = Date.now();
  const requestedIndexes: number[] = [];
  const logBatchEvent = (entry: Parameters<typeof logReadGuardEvent>[0]): void =>
    logReadGuardEvent({ ...entry, correlationId });
  let rawContent: string;
  try {
    rawContent = nodeFs.readFileSync(filePath, "utf-8");
  } catch {
    const editBatchSummary = createReadGuardEditBatchSummary({
      requestedIndexes: edits.map((edit, index) => edit.originalIndex ?? index),
      rejectedReasons: edits.map((edit, index) => ({
        index: edit.originalIndex ?? index,
        code: "preflight_blocked" as const,
      })),
    });
    logBatchEvent({
      event: "touched_lines_missing",
      sessionId,
      filePath,
      metadata: {
        tool: "edit",
        source: "edits_without_ranges",
        editCount: edits.length,
      },
    });
    logBatchEvent({
      event: "edit_batch_summary",
      filePath,
      metadata: { tool: "edit", editBatchSummary },
    });
    return { touchedLines: undefined, editBatchSummary };
  }

  const rawContentLf = rawContent.replace(/\r\n/g, "\n");
  const content = normalizeContent(rawContent);
  const errors: string[] = [];
  const failureKinds: string[] = [];
  const failedEditIndexes: number[] = [];
  const failedOldTextPreviews: string[] = [];
  const rejectedReasons: EditBatchRejection[] = [];
  const resolvedIndexes: number[] = [];
  const resolvedRanges: [number, number][] = [];
  const passedEdits: Array<{
    oldText: string;
    newText: string | undefined;
    originalIndex: number;
  }> = [];
  let maxFailCount = 0;

  for (let i = 0; i < edits.length; i++) {
    const oldText = edits[i].oldText;
    const editIndex = edits[i].originalIndex ?? i;
    if (requestedIndexes.length < 100) requestedIndexes.push(editIndex);
    if (!oldText) continue;

    let needle = normalizeContent(oldText);
    let occurrenceLines = findOccurrenceLines(content, needle);

    if (occurrenceLines.length === 0) {
      const corrected = tryCorrectIndentationMismatchFromContent(oldText, rawContentLf);
      if (corrected !== undefined) {
        needle = normalizeContent(corrected);
        occurrenceLines = findOccurrenceLines(content, needle);
        if (occurrenceLines.length > 0) {
          logBatchEvent({
            event: "oldtext_indent_corrected",
            sessionId,
            filePath,
            metadata: {
              tool: "edit",
              source: "edits_without_ranges",
              editIndex,
            },
          });
        }
      }
    }

    if (occurrenceLines.length === 0) {
      const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
      failureKinds.push("oldtext_not_found");
      if (failedEditIndexes.length < 100) {
        failedEditIndexes.push(editIndex);
        failedOldTextPreviews.push(preview);
      }
      if (rejectedReasons.length < 100) {
        rejectedReasons.push({ index: editIndex, code: "oldtext_not_found" });
      }
      const failCount = trackOldTextFailure(filePath, preview);
      if (failCount > maxFailCount) maxFailCount = failCount;
      let errorMsg = `edits[${editIndex}].oldText ("${preview}") was not found in the current file content.`;
      const quoteSwapCandidates: string[] = [];
      if (needle.includes('"')) quoteSwapCandidates.push(needle.replace(/"/g, "'"));
      if (needle.includes("'")) quoteSwapCandidates.push(needle.replace(/'/g, '"'));
      const quoteHit = quoteSwapCandidates.find(
        (s) => s !== needle && findOccurrenceLines(content, s).length === 1,
      );
      if (quoteHit !== undefined) {
        errorMsg += ` The file uses a different quote style — your oldText has ${needle.includes('"') ? "double" : "single"} quotes but the file has ${needle.includes('"') ? "single" : "double"} quotes. Fix the quote style in both oldText and newText before retrying.`;
      } else {
        const lineHint = findFirstLineOfOldText(content, oldText);
        const offsetHint =
          lineHint !== undefined ? `\`offset=${Math.max(1, lineHint - 2)} limit=20\`` : undefined;
        if (lineHint !== undefined) {
          if (failCount >= 2) {
            errorMsg +=
              ` This is attempt #${failCount} — the first line of your oldText appears near line ${lineHint}` +
              ` but the surrounding content no longer matches. This is a content-drift failure,` +
              ` not an indentation issue (indentation autopatch already ran and did not fix it).` +
              ` Re-read ${offsetHint} and rebuild oldText verbatim from the current file.`;
          } else {
            errorMsg +=
              ` The first line of your oldText appears near line ${lineHint} but the rest doesn't match.` +
              ` The file has likely changed since your last read — this is a content-drift issue, not indentation.` +
              ` Re-read ${offsetHint} and rebuild oldText from the verbatim file content.`;
          }
        } else {
          if (failCount >= 2) {
            errorMsg +=
              ` This is attempt #${failCount} — this text does not appear anywhere in the file,` +
              ` even ignoring whitespace differences. Do NOT retry from memory.` +
              ` Re-read the relevant section before rebuilding your edit.`;
          } else {
            errorMsg +=
              ` This text does not appear anywhere in the file, even ignoring indentation differences —` +
              ` the file has likely changed significantly. Re-read the relevant section before retrying.`;
          }
        }
      }
      if (!errorMsg.includes("quote style")) {
        const similarLines = findSimilarLines(
          content,
          oldText.replace(/\r\n/g, "\n").split("\n")[0],
          { nearLine: findFirstLineOfOldText(content, oldText) },
        );
        if (similarLines.length > 0) {
          errorMsg += formatSimilarLines(similarLines, normalizeToLF(stripBom(rawContent).text));
        }
      }
      errors.push(errorMsg);
      const hostMatch = hostWouldApplyOldText(rawContent, oldText);
      logBatchEvent({
        event: "oldtext_not_found",
        sessionId,
        filePath,
        metadata: {
          tool: "edit",
          source: "edits_without_ranges",
          editIndex,
          oldTextPreview: preview,
          repeatFailureCount: failCount,
          hostWouldApply: hostMatch.wouldApply,
          hostOccurrences: hostMatch.occurrences,
          hostUsedFuzzyMatch: hostMatch.usedFuzzyMatch,
        },
      });
    } else if (occurrenceLines.length === 1) {
      const startLine = occurrenceLines[0];
      const endLine = startLine + needle.split("\n").length - 1;
      resolvedRanges.push([startLine, endLine]);
      if (resolvedIndexes.length < 100) resolvedIndexes.push(editIndex);
      const applyOldText = exactOldTextForApply(rawContentLf, oldText, needle);
      if (applyOldText !== undefined) {
        passedEdits.push({
          oldText: applyOldText,
          newText: edits[i].newText,
          originalIndex: editIndex,
        });
      }
      logBatchEvent({
        event: "oldtext_resolved",
        sessionId,
        filePath,
        metadata: {
          tool: "edit",
          source: "edits_without_ranges",
          editIndex,
          touchedLines: [startLine, endLine],
        },
      });
    } else {
      const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
      failureKinds.push("oldtext_duplicate");
      if (failedEditIndexes.length < 100) {
        failedEditIndexes.push(editIndex);
        failedOldTextPreviews.push(preview);
      }
      if (rejectedReasons.length < 100) {
        rejectedReasons.push({ index: editIndex, code: "oldtext_duplicate" });
      }
      const matchSpanLines = needle.split("\n").length;
      const contextBlock = formatOccurrenceContext(content, occurrenceLines, matchSpanLines);
      errors.push(
        `edits[${editIndex}].oldText ("${preview}") appears ${occurrenceLines.length} times:\n${contextBlock}\nPick the location you want and extend your oldText with the unique line above or below it (shown as context).`,
      );
      logBatchEvent({
        event: "oldtext_duplicate",
        sessionId,
        filePath,
        metadata: {
          tool: "edit",
          source: "edits_without_ranges",
          editIndex,
          occurrenceLines: occurrenceLines.slice(0, 100),
          occurrenceCount: occurrenceLines.length,
          oldTextPreview: preview,
        },
      });
    }
  }

  const oldTextEditCount = edits.filter((edit) => !!edit.oldText).length;
  if (errors.length > 0 || resolvedRanges.length !== oldTextEditCount) {
    const failureDetails =
      errors.length > 0
        ? errors
        : [
            "One or more edit targets could not be resolved to exact lines. Re-read the relevant section and retry with the exact content as it appears in the file.",
          ];
    const uniqueFailureKinds = [...new Set(failureKinds)];
    const editBatchSummary = createReadGuardEditBatchSummary({
      requestedIndexes,
      requestedTotal: edits.length,
      resolvedIndexes,
      resolvedTotal: resolvedRanges.length,
      rejectedReasons,
      rejectedTotal: Math.max(0, oldTextEditCount - resolvedRanges.length),
      durationMs: Date.now() - startedAt,
      terminalStatus: "blocked",
    });
    logBatchEvent({
      event: "edit_preflight_blocked",
      correlationId,
      sessionId,
      filePath,
      metadata: {
        tool: "edit",
        source: "edits_without_ranges",
        reasonKind:
          uniqueFailureKinds.length === 1 ? uniqueFailureKinds[0] : "oldtext_resolution_failed",
        failureKinds: uniqueFailureKinds,
        editCount: edits.length,
        oldTextEditCount,
        resolvedOldTextEditCount: resolvedRanges.length,
        unresolvedOldTextEditCount: oldTextEditCount - resolvedRanges.length,
        failedEditIndexes,
        oldTextPreviews: failedOldTextPreviews.slice(0, 5),
        errorCount: errors.length,
      },
    });
    const appliedNote =
      passedEdits.length > 0
        ? `\n\n${passedEdits.map((e) => `edits[${e.originalIndex}]`).join(", ")} ${passedEdits.length === 1 ? "was" : "were"} applied — do NOT re-submit ${passedEdits.length === 1 ? "it" : "them"}.`
        : "";
    const header =
      maxFailCount >= 2
        ? `🛑 RE-READ REQUIRED — You have submitted this oldText before and it still does not match.\n\nDo NOT retry from memory. Re-read \`${filePath}\` to get the current content, then rebuild your edit from the verbatim file text.`
        : `🔄 RETRYABLE — Edit target not found`;
    logBatchEvent({
      event: "edit_batch_summary",
      correlationId,
      filePath,
      metadata: { tool: "edit", editBatchSummary },
    });
    return {
      touchedLines: undefined,
      preflightError: `${header}\n\n${failureDetails.join("\n\n")}${appliedNote}`,
      partiallyApplicable: passedEdits.length > 0 ? passedEdits : undefined,
      editBatchSummary,
    };
  }

  if (resolvedRanges.length === 0) {
    const editBatchSummary = createReadGuardEditBatchSummary({
      requestedIndexes,
      requestedTotal: edits.length,
      rejectedTotal: oldTextEditCount,
      terminalStatus: "blocked",
    });
    logBatchEvent({
      event: "touched_lines_missing",
      sessionId,
      filePath,
      metadata: {
        tool: "edit",
        source: "edits_without_ranges",
        editCount: edits.length,
      },
    });
    logBatchEvent({
      event: "edit_batch_summary",
      filePath,
      metadata: { tool: "edit", editBatchSummary },
    });
    return { touchedLines: undefined, editBatchSummary };
  }

  const starts = resolvedRanges.map(([s]) => s);
  const ends = resolvedRanges.map(([, e]) => e);
  const touchedLines: [number, number] = [Math.min(...starts), Math.max(...ends)];
  const editRanges = resolvedRanges.length > 1 ? resolvedRanges : undefined;
  logBatchEvent({
    event: "touched_lines_detected",
    sessionId,
    filePath,
    metadata: {
      tool: "edit",
      source: "oldtext_resolved",
      touchedLines,
      resolvedEditCount: resolvedRanges.length,
      totalEditCount: edits.length,
    },
  });
  const editBatchSummary = createReadGuardEditBatchSummary({
    requestedIndexes,
    requestedTotal: edits.length,
    resolvedIndexes,
    resolvedTotal: resolvedRanges.length,
    durationMs: Date.now() - startedAt,
    terminalStatus: "success",
  });
  return {
    touchedLines,
    editRanges,
    contentMatchValidated: true,
    editBatchSummary,
  };
}

export function stripOldTextTrailingWhitespace(value: string): string {
  const lines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function tryCorrectIndentationMismatchFromContent(
  oldText: string,
  content: string,
): string | undefined {
  const normalized = oldText.replace(/\r\n/g, "\n");
  if (content.includes(normalized)) return undefined;

  const conversions = [
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^\t+/, (m) => "  ".repeat(m.length)))
        .join("\n"),
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^\t+/, (m) => "    ".repeat(m.length)))
        .join("\n"),
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^( {2})+/, (m) => "\t".repeat(m.length / 2)))
        .join("\n"),
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^( {4})+/, (m) => "\t".repeat(m.length / 4)))
        .join("\n"),
  ];

  for (const convert of conversions) {
    const candidate = convert(normalized);
    if (candidate !== normalized && content.includes(candidate)) return candidate;
  }

  const indentationInsensitiveCandidate = findIndentationInsensitiveCandidate(content, normalized);
  if (indentationInsensitiveCandidate !== undefined) {
    return indentationInsensitiveCandidate;
  }

  const blankLineCandidate = findBlankLineInsensitiveCandidate(content, normalized);
  if (blankLineCandidate !== undefined) {
    return blankLineCandidate;
  }

  const whitespaceCandidate = findWhitespaceInsensitiveCandidate(content, normalized);
  if (whitespaceCandidate !== undefined) {
    return whitespaceCandidate;
  }

  const unicodeCandidate = findUnicodePunctuationInsensitiveCandidate(content, normalized);
  if (unicodeCandidate !== undefined) {
    return unicodeCandidate;
  }

  return undefined;
}

export function tryCorrectIndentationMismatch(
  oldText: string,
  filePath: string,
): string | undefined {
  try {
    return tryCorrectIndentationMismatchFromContent(
      oldText,
      nodeFs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n"),
    );
  } catch {
    return undefined;
  }
}

function findIndentationInsensitiveCandidate(content: string, oldText: string): string | undefined {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const stripIndent = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
  const expected = oldLines.map(stripIndent);

  for (let start = 0; start <= contentLines.length - oldLines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (stripIndent(contentLines[start + offset] ?? "") !== expected[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const candidate = contentLines.slice(start, start + oldLines.length).join("\n");
      if (candidate !== oldText) return candidate;
    }
  }

  return undefined;
}

function findBlankLineInsensitiveCandidate(content: string, oldText: string): string | undefined {
  const stripIndent = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
  const isBlank = (line: string) => stripIndent(line) === "";

  const contentLines = content.split("\n");
  const oldNonBlank = oldText
    .split("\n")
    .map(stripIndent)
    .filter((line) => line !== "");
  if (oldNonBlank.length < 2) return undefined;

  const spans: Array<[number, number]> = [];
  for (let start = 0; start < contentLines.length; start += 1) {
    if (stripIndent(contentLines[start]) !== oldNonBlank[0]) continue;
    let contentIdx = start + 1;
    let oldIdx = 1;
    let end = start;
    let ok = true;
    while (oldIdx < oldNonBlank.length) {
      while (contentIdx < contentLines.length && isBlank(contentLines[contentIdx])) contentIdx += 1;
      if (
        contentIdx >= contentLines.length ||
        stripIndent(contentLines[contentIdx]) !== oldNonBlank[oldIdx]
      ) {
        ok = false;
        break;
      }
      end = contentIdx;
      oldIdx += 1;
      contentIdx += 1;
    }
    if (ok) spans.push([start, end]);
  }

  if (spans.length !== 1) return undefined;
  const [start, end] = spans[0];
  const candidate = contentLines.slice(start, end + 1).join("\n");
  return candidate === oldText ? undefined : candidate;
}

function findWhitespaceInsensitiveCandidate(content: string, oldText: string): string | undefined {
  const collapse = (line: string) => line.replace(/\s+/g, "");
  const isBlank = (line: string) => collapse(line) === "";

  const contentLines = content.split("\n");
  const oldSignature = oldText
    .split("\n")
    .map(collapse)
    .filter((line) => line !== "");
  if (oldSignature.length < 2) return undefined;

  const spans: Array<[number, number]> = [];
  for (let start = 0; start < contentLines.length; start += 1) {
    if (collapse(contentLines[start]) !== oldSignature[0]) continue;
    let contentIdx = start + 1;
    let sigIdx = 1;
    let end = start;
    let ok = true;
    while (sigIdx < oldSignature.length) {
      while (contentIdx < contentLines.length && isBlank(contentLines[contentIdx])) contentIdx += 1;
      if (
        contentIdx >= contentLines.length ||
        collapse(contentLines[contentIdx]) !== oldSignature[sigIdx]
      ) {
        ok = false;
        break;
      }
      end = contentIdx;
      sigIdx += 1;
      contentIdx += 1;
    }
    if (ok) spans.push([start, end]);
  }

  if (spans.length !== 1) return undefined;
  const [start, end] = spans[0];
  const candidate = contentLines.slice(start, end + 1).join("\n");
  return candidate === oldText ? undefined : candidate;
}

function normalizeUnicodePunctuation(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

function findUnicodePunctuationInsensitiveCandidate(
  content: string,
  oldText: string,
): string | undefined {
  const fold = (line: string) => normalizeUnicodePunctuation(line).replace(/\s+/g, "");
  const isBlank = (line: string) => fold(line) === "";

  const contentLines = content.split("\n");
  const oldSignature = oldText
    .split("\n")
    .map(fold)
    .filter((line) => line !== "");
  if (oldSignature.length < 2) return undefined;

  const spans: Array<[number, number]> = [];
  for (let start = 0; start < contentLines.length; start += 1) {
    if (fold(contentLines[start]) !== oldSignature[0]) continue;
    let contentIdx = start + 1;
    let sigIdx = 1;
    let end = start;
    let ok = true;
    while (sigIdx < oldSignature.length) {
      while (contentIdx < contentLines.length && isBlank(contentLines[contentIdx])) contentIdx += 1;
      if (
        contentIdx >= contentLines.length ||
        fold(contentLines[contentIdx]) !== oldSignature[sigIdx]
      ) {
        ok = false;
        break;
      }
      end = contentIdx;
      sigIdx += 1;
      contentIdx += 1;
    }
    if (ok) spans.push([start, end]);
  }

  if (spans.length !== 1) return undefined;
  const [start, end] = spans[0];
  const candidate = contentLines.slice(start, end + 1).join("\n");
  return candidate === oldText ? undefined : candidate;
}

export function relocateEditRange(
  input: LspBoundaryValue,
  from: [number, number],
  to: [number, number],
): boolean {
  const delta = to[0] - from[0];

  if (delta === 0 || !input || !isObjectRecord(input)) return false;

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const editInput = input as {
    oldRange?: { start?: { line?: number }; end?: { line?: number } };
    edits?: Array<{
      range?: { start?: { line?: number }; end?: { line?: number } };
    }>;
  };
  const matchesFrom = (start?: number, end?: number) => start === from[0] && end === from[1];
  let applied = false;

  const oldRange = editInput.oldRange;
  if (
    oldRange?.start?.line !== undefined &&
    oldRange.end?.line !== undefined &&
    matchesFrom(oldRange.start.line, oldRange.end.line)
  ) {
    oldRange.start.line += delta;
    oldRange.end.line += delta;
    applied = true;
  }

  if (Array.isArray(editInput.edits)) {
    for (const edit of editInput.edits) {
      const start = edit.range?.start?.line;
      const end = edit.range?.end?.line ?? start;
      if (start !== undefined && matchesFrom(start, end)) {
        edit.range!.start!.line = start + delta;
        if (edit.range?.end?.line !== undefined) {
          edit.range.end.line += delta;
        }
        applied = true;
      }
    }
  }

  return applied;
}

export function getTouchedLinesForGuard(
  event: LspBoundaryValue,
  filePath?: string,
  sessionId?: string,
  correlationId?: string,
): GuardLineResult {
  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if (isToolCallEventType("edit", event as any)) {
    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    const editInput = (event as { input?: unknown }).input as Partial<
      Pick<EditToolInput, "path">
    > & {
      oldRange?: { start: { line: number }; end: { line: number } };
      edits?: Array<
        Partial<EditToolInput["edits"][number]> & {
          range?: { start?: { line: number }; end?: { line: number } };
        }
      >;
      operations?: unknown[];
      ops?: unknown[];
      set_line?: unknown;
      replace_lines?: unknown;
      replace_symbol?: unknown;
    };
    const hashlineResult = resolveHashlineEditInput(
      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      editInput as Record<string, LspDictionaryValue>,
      filePath,
      sessionId,
      correlationId,
    );
    if (hashlineResult) return hashlineResult;
    if (editInput.oldRange) {
      const touchedLines: [number, number] = [
        editInput.oldRange.start.line,
        editInput.oldRange.end.line,
      ];
      if (filePath) {
        logReadGuardEvent({
          event: "touched_lines_detected",
          correlationId,
          sessionId,
          filePath,
          metadata: {
            tool: "edit",
            source: "oldRange",
            touchedLines,
          },
        });
      }
      return { touchedLines };
    }
    if (editInput.edits?.length) {
      const rangedEdits = editInput.edits
        .map((edit) => {
          const start = edit.range?.start?.line;
          const end = edit.range?.end?.line ?? start;

          if (!isFiniteNumber(start) || !isFiniteNumber(end)) {
            return null;
          }

          // SAFETY: The checked element count and construction order establish this fixed tuple representation.
          return [start, end] as [number, number];
        })
        .filter((range): range is [number, number] => range !== null);
      const unresolvedOldTextEdits = editInput.edits
        .map((edit, index) => ({ ...edit, originalIndex: index }))

        .filter((edit) => !isFiniteNumber(edit.range?.start?.line) && !!edit.oldText);
      if (rangedEdits.length === 0) {
        if (filePath) {
          return resolveOldTextEdits(editInput.edits, filePath, sessionId, correlationId);
        }
        return { touchedLines: undefined };
      }
      let oldTextTouchedLines: [number, number] | undefined;
      let oldTextEditRanges: [number, number][] | undefined;
      if (unresolvedOldTextEdits.length > 0 && filePath) {
        const resolved = resolveOldTextEdits(
          unresolvedOldTextEdits,
          filePath,
          sessionId,
          correlationId,
        );
        if (resolved.preflightError) {
          return resolved;
        }
        oldTextTouchedLines = resolved.touchedLines;
        oldTextEditRanges = resolved.editRanges;
      }
      const starts = rangedEdits.map(([start]) => start);
      const ends = rangedEdits.map(([, end]) => end);
      if (oldTextTouchedLines) {
        starts.push(oldTextTouchedLines[0]);
        ends.push(oldTextTouchedLines[1]);
      }
      const touchedLines: [number, number] = [Math.min(...starts), Math.max(...ends)];
      const allEditRanges = [...rangedEdits];
      if (oldTextEditRanges?.length) {
        allEditRanges.push(...oldTextEditRanges);
      } else if (oldTextTouchedLines) {
        allEditRanges.push(oldTextTouchedLines);
      }
      const editRanges = allEditRanges.length > 1 ? allEditRanges : undefined;
      if (filePath) {
        logReadGuardEvent({
          event: "touched_lines_detected",
          correlationId,
          sessionId,
          filePath,
          metadata: {
            tool: "edit",
            source: unresolvedOldTextEdits.length > 0 ? "edits_mixed" : "edits_ranges",
            touchedLines,
            rangedEditCount: rangedEdits.length,
            resolvedOldTextEditCount: unresolvedOldTextEdits.length,
            totalEditCount: editInput.edits.length,
          },
        });
      }
      return { touchedLines, editRanges };
    }
    if (filePath) {
      // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
      const topLevelKeys = Object.keys(editInput as Record<string, LspDictionaryValue>);
      logReadGuardEvent({
        event: "touched_lines_missing",
        correlationId,
        sessionId,
        filePath,
        metadata: {
          tool: "edit",
          source: "unknown_edit_schema",
          topLevelKeys,
          hasNativeOldRange: !!editInput.oldRange,
          hasNativeEdits: Array.isArray(editInput.edits),
          hasHashlineSetLine: !!editInput.set_line,
          hasHashlineReplaceLines: !!editInput.replace_lines,
          hasHashlineReplaceSymbol: !!editInput.replace_symbol,
          hasHashlineBatch: Array.isArray(editInput.operations) || Array.isArray(editInput.ops),
          strictModeWouldBlock: true,
        },
      });
    }
    return { touchedLines: undefined };
  }

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if (isToolCallEventType("write", event as any)) {
    const lineCount = filePath ? countFileLines(filePath) : 1;
    const touchedLines: [number, number] = [1, lineCount];
    if (filePath) {
      logReadGuardEvent({
        event: "touched_lines_detected",
        correlationId,
        sessionId,
        filePath,
        metadata: {
          tool: "write",
          source: "full_file_write",
          touchedLines,
          lineCount,
        },
      });
    }
    return { touchedLines };
  }

  return { touchedLines: undefined };
}
