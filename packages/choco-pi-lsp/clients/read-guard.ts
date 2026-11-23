import { assignOptionalProperties } from "./optional-properties.ts";
import { isString, type LspDictionaryValue } from "./runtime-guards.ts";
import * as fs from "node:fs";
import { createFileTime, type FileTime } from "./file-time.ts";
import { hashDiagnosticContent } from "./lsp/diagnostic-binding.ts";
import { normalizeEphemeralMapKey, normalizeFilePath } from "./path-utils.ts";
import { logReadGuardEvent } from "./read-guard-logger.ts";

type CurrentLinesMatchReadSnapshotResultContract = {
  checked: boolean;
  matches: boolean;
  missingLines: number[];
  mismatchedLines: number[];
};
type GetSummaryResultContract = {
  totalEdits: number;
  totalBlocks: number;
  byReason: Record<string, number>;
  byFile: Record<string, { edits: number; blocks: number }>;
  lspExpansionsHelped: number;
};
type ImportStateResultContract = {
  imported: number;
  dropped: number;
};
type ValidateRangeSnapshotResultContract = {
  status: "match" | "mismatch" | "unavailable";
  matchingReadIndex: number;
  missingLines: number[];
  mismatchedLines: number[];
  candidateReadCount: number;
  checkedCandidateCount: number;
  unavailableCandidateCount: number;
  shouldBlock: boolean;
};
type CheckCoverageResultContract = { covered: boolean; viaSymbol: boolean };

export interface ReadRecord {
  filePath: string;
  requestedOffset: number;
  requestedLimit: number;
  effectiveOffset: number;
  effectiveLimit: number;
  expandedByLsp: boolean;
  enclosingSymbol?: {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
  };
  lineHashes?: Record<number, string>;
  contentBinding?: ReadContentBinding;
  turnIndex: number;
  writeIndex: number;
  timestamp: number;
  source?: string;
}

export interface ReadContentBinding {
  hash: string;
  fullFile: boolean;
  offset: number;
  limit: number;
}

export interface EditRecord {
  filePath: string;
  tool: "write" | "edit";
  touchedLines: [start: number, end: number];
  precedingReads: ReadRecord[];
  verdict: "allowed" | "blocked" | "warned";
  reason?: string;
  timestamp: number;
}

export interface ReadGuardVerdict {
  action: "allow" | "block" | "warn";
  reason?: string;
  details?: {
    editRange: [number, number];
    readRanges: Array<{ start: number; end: number }>;
    symbolRanges: Array<{ name: string; start: number; end: number }>;
    snapshot?: {
      status: "match" | "mismatch" | "unavailable";
      mismatchedLines: number[];
      missingLines: number[];
    };
    relocation?: {
      from: [number, number];
      to: [number, number];
    };
  };
  relocation?: {
    from: [number, number];
    to: [number, number];
  };
}

export interface ReadGuardConfig {
  enabled: boolean;
  mode: "block" | "warn" | "off";
  contextLines: number;
  exemptions: Array<{
    pattern: string;
    mode: "allow" | "warn" | "block";
  }>;
}

export interface PersistedReadGuardState {
  version: number;
  reads: Array<[string, ReadRecord[]]>;
}

export const READ_GUARD_STATE_VERSION = 1;

const DEFAULT_CONFIG: ReadGuardConfig = {
  enabled: true,
  mode: "block",
  contextLines: 3,
  exemptions: [
    { pattern: "*.md", mode: "warn" },
    { pattern: "*.txt", mode: "allow" },
    { pattern: "*.log", mode: "allow" },
  ],
};

const OWN_EDIT_STALE_GRACE_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_OWN_EDIT_GRACE_MS ?? "120000", 10) || 120000,
);

const READ_HASH_MAX_LINES = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_HASH_MAX_LINES ?? "3000", 10) || 3000,
);

const READ_BINDING_MAX_BYTES = 4 * 1024 * 1024;
const READ_GUARD_MAX_FILES = 256;
const READ_GUARD_MAX_UNCONSUMED_FILES = 4096;
const READ_GUARD_IDLE_EVICT_MS_DEFAULT = 30 * 60_000;

export function captureReadContentBinding(
  filePath: string,
  offset: number,
  limit: number,
): ReadContentBinding | undefined {
  try {
    if (fs.statSync(filePath).size > READ_BINDING_MAX_BYTES) return undefined;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = splitLinesThrough(content, READ_HASH_MAX_LINES + 1);
    if (lines.length <= READ_HASH_MAX_LINES) {
      return {
        hash: hashDiagnosticContent(content),
        fullFile: true,
        offset: 1,
        limit: lines.length,
      };
    }
    const scopedOffset = Math.max(1, offset);
    const scopedLimit = Math.min(Math.max(0, limit), READ_HASH_MAX_LINES);
    if (scopedLimit === 0) return undefined;
    const rangeLines = splitLinesThrough(content, scopedOffset - 1 + scopedLimit);
    const scopedContent = rangeLines
      .slice(scopedOffset - 1, scopedOffset - 1 + scopedLimit)
      .join("\n");
    return {
      hash: hashDiagnosticContent(scopedContent),
      fullFile: false,
      offset: scopedOffset,
      limit: scopedLimit,
    };
  } catch {
    return undefined;
  }
}

export function _currentContentMatchesBindingForTests(
  filePath: string,
  binding: ReadContentBinding,
): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const boundContent = binding.fullFile
      ? content
      : splitLines(content)
          .slice(binding.offset - 1, binding.offset - 1 + binding.limit)
          .join("\n");
    return hashDiagnosticContent(boundContent) === binding.hash;
  } catch {
    return false;
  }
}

const currentContentMatchesBinding = _currentContentMatchesBindingForTests;

const RELOCATION_WINDOW_MIN = Math.max(
  1,
  Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_RELOCATION_WINDOW_MIN ?? "40", 10) || 40,
);
const RELOCATION_WINDOW_PER_EDIT = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_RELOCATION_WINDOW_PER_EDIT ?? "20", 10) || 20,
);
const RELOCATION_WINDOW_MAX = Math.max(
  RELOCATION_WINDOW_MIN,
  Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_RELOCATION_WINDOW_MAX ?? "400", 10) || 400,
);

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function splitLinesThrough(text: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const lines: string[] = [];
  let start = 0;
  while (lines.length < maxLines) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push(text.slice(start));
      break;
    }
    const end = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push(text.slice(start, end));
    start = newline + 1;
    if (start === text.length && lines.length < maxLines) {
      lines.push("");
      break;
    }
  }
  return lines;
}

export function lineContentHash(line: string): string {
  const normalized = line.replace(/\s+/g, "");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash = Math.imul(hash ^ normalized.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readRangeCoversLine(read: ReadRecord, lineNo: number): boolean {
  return lineNo >= read.effectiveOffset && lineNo <= read.effectiveOffset + read.effectiveLimit - 1;
}

function readEffectiveRangeCoversRange(
  read: ReadRecord,
  [startLine, endLine]: [number, number],
): boolean {
  return readRangeCoversLine(read, startLine) && readRangeCoversLine(read, endLine);
}

function captureLineHashes(
  filePath: string,
  offset: number,
  limit: number,
): Record<number, string> | undefined {
  if (limit <= 0 || limit > READ_HASH_MAX_LINES) return undefined;
  try {
    const lines = splitLines(fs.readFileSync(filePath, "utf-8"));
    const hashes: Record<number, string> = {};
    const end = Math.min(lines.length, offset + limit - 1);
    for (let lineNo = Math.max(1, offset); lineNo <= end; lineNo++) {
      hashes[lineNo] = lineContentHash(lines[lineNo - 1] ?? "");
    }
    return Object.keys(hashes).length > 0 ? hashes : undefined;
  } catch {
    return undefined;
  }
}

export function currentLinesMatchReadSnapshot(
  filePath: string,
  read: ReadRecord,
  [startLine, endLine]: [number, number],
): CurrentLinesMatchReadSnapshotResultContract {
  const hashes = read.lineHashes ?? {};
  const missingLines: number[] = [];
  const mismatchedLines: number[] = [];
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    if (!readRangeCoversLine(read, lineNo) || hashes[lineNo] === undefined) {
      missingLines.push(lineNo);
    }
  }
  if (missingLines.length > 0) {
    return { checked: false, matches: false, missingLines, mismatchedLines };
  }

  let lines: string[];
  try {
    lines = splitLines(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {
      checked: true,
      matches: false,
      missingLines,
      mismatchedLines: [...Array(endLine - startLine + 1)].map((_, index) => startLine + index),
    };
  }

  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    if (lineNo < 1 || lineNo > lines.length) {
      mismatchedLines.push(lineNo);
      continue;
    }
    if (lineContentHash(lines[lineNo - 1] ?? "") !== hashes[lineNo]) {
      mismatchedLines.push(lineNo);
    }
  }

  return {
    checked: true,
    matches: mismatchedLines.length === 0,
    missingLines,
    mismatchedLines,
  };
}

export class ReadGuard {
  private readonly config: ReadGuardConfig;
  private readonly reads = new Map<string, ReadRecord[]>();
  private readonly edits = new Map<string, EditRecord[]>();
  private readonly fileLastUsed = new Map<string, number>();
  private readonly fileIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly consumedReadFiles = new Set<string>();
  private readonly fileTime: FileTime;
  private readonly exemptions = new Set<string>();
  private readonly pendingCreations = new Map<string, { turnIndex: number; writeIndex: number }>();
  private readonly writtenThisSession = new Set<string>();
  private readonly knownPathIndex = new Map<string, string>();
  private readonly sessionId: string;
  private readonly sessionStartMs: number;

  constructor(sessionId: string, config: Partial<ReadGuardConfig> = {}) {
    this.sessionId = sessionId;
    this.sessionStartMs = Date.now();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fileTime = createFileTime(sessionId);
  }

  private key(filePath: string): string {
    return normalizeFilePath(filePath);
  }

  private idleEvictMs(): number {
    const value = Number.parseInt(process.env.CHOCO_PI_LSP_READ_GUARD_IDLE_EVICT_MS ?? "", 10);
    return Number.isSafeInteger(value) && value > 0 ? value : READ_GUARD_IDLE_EVICT_MS_DEFAULT;
  }

  private clearFileTimer(filePath: string): void {
    const timer = this.fileIdleTimers.get(filePath);
    if (timer) clearTimeout(timer);
    this.fileIdleTimers.delete(filePath);
  }

  private evictFile(filePath: string): void {
    this.clearFileTimer(filePath);
    this.reads.delete(filePath);
    this.edits.delete(filePath);
    this.fileLastUsed.delete(filePath);
    this.consumedReadFiles.delete(filePath);
    this.writtenThisSession.delete(filePath);
    for (const [syntacticKey, stored] of this.knownPathIndex) {
      if (stored === filePath) this.knownPathIndex.delete(syntacticKey);
    }
  }

  private touchFile(filePath: string): void {
    const now = Date.now();
    this.fileLastUsed.set(filePath, now);
    this.clearFileTimer(filePath);
    if (this.reads.has(filePath) && !this.consumedReadFiles.has(filePath)) return;
    const stamp = now;
    const timer = setTimeout(() => {
      if (this.fileLastUsed.get(filePath) !== stamp) return;
      if (this.reads.has(filePath) && !this.consumedReadFiles.has(filePath)) return;
      this.evictFile(filePath);
    }, this.idleEvictMs());
    timer.unref?.();
    this.fileIdleTimers.set(filePath, timer);
  }

  private enforceFileCap(): void {
    while (this.reads.size > READ_GUARD_MAX_FILES) {
      const victim = [...this.reads.keys()]
        .filter((filePath) => this.consumedReadFiles.has(filePath))
        .sort((a, b) => (this.fileLastUsed.get(a) ?? 0) - (this.fileLastUsed.get(b) ?? 0))[0];
      if (!victim) break;
      this.evictFile(victim);
    }
    while (this.reads.size > READ_GUARD_MAX_UNCONSUMED_FILES) {
      const victim = [...this.reads.keys()]
        .filter((filePath) => !this.consumedReadFiles.has(filePath))
        .sort((a, b) => (this.fileLastUsed.get(a) ?? 0) - (this.fileLastUsed.get(b) ?? 0))[0];
      if (!victim) break;
      this.evictFile(victim);
    }
  }

  recordRead(record: ReadRecord): void {
    const filePath = this.key(record.filePath);
    this.knownPathIndex.set(normalizeEphemeralMapKey(record.filePath), filePath);
    const storedRecord: ReadRecord = {
      ...record,
      filePath,
      lineHashes:
        record.lineHashes ??
        captureLineHashes(filePath, record.effectiveOffset, record.effectiveLimit),
    };
    const arr = this.reads.get(storedRecord.filePath) ?? [];
    this.consumedReadFiles.delete(storedRecord.filePath);
    arr.push(storedRecord);
    this.reads.set(storedRecord.filePath, arr);
    this.touchFile(storedRecord.filePath);
    this.enforceFileCap();

    logReadGuardEvent({
      event: "read_recorded",
      sessionId: this.sessionId,
      filePath: storedRecord.filePath,
      requestedOffset: storedRecord.requestedOffset,
      requestedLimit: storedRecord.requestedLimit,
      effectiveOffset: storedRecord.effectiveOffset,
      effectiveLimit: storedRecord.effectiveLimit,
      symbol: storedRecord.enclosingSymbol?.name,
      symbolKind: storedRecord.enclosingSymbol?.kind,
      symbolStartLine: storedRecord.enclosingSymbol?.startLine,
      symbolEndLine: storedRecord.enclosingSymbol?.endLine,
      metadata: {
        expandedByLsp: storedRecord.expandedByLsp,
        turnIndex: storedRecord.turnIndex,
        writeIndex: storedRecord.writeIndex,
        readCountForFile: arr.length,
        hashLineCount: Object.keys(storedRecord.lineHashes ?? {}).length,
        ...(storedRecord.source !== undefined && {
          source: storedRecord.source,
        }),
      },
    });

    this.fileTime.read(storedRecord.filePath);
  }

  recordSymbolRead(
    filePath: string,
    symbol: { name: string; kind: string; startLine: number; endLine: number },
    turnIndex: number,
    writeIndex: number,
  ): void {
    const span = Math.max(1, symbol.endLine - symbol.startLine + 1);
    this.recordRead({
      filePath,
      requestedOffset: symbol.startLine,
      requestedLimit: span,
      effectiveOffset: symbol.startLine,
      effectiveLimit: span,
      expandedByLsp: false,
      enclosingSymbol: {
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
      },
      turnIndex,
      writeIndex,
      timestamp: Date.now(),
    });
  }

  checkEdit(
    filePath: string,
    touchedLines?: [number, number],
    editRanges?: [number, number][],
    options?: { skipSnapshotCheck?: boolean; oldTextResolved?: boolean },
  ): ReadGuardVerdict {
    filePath = this.key(filePath);
    if (this.reads.has(filePath) || this.edits.has(filePath)) this.touchFile(filePath);

    if (this.exemptions.has(filePath)) {
      this.exemptions.delete(filePath);
      const verdict = this.allow();
      this.recordVerdict(filePath, "edit", touchedLines, verdict, {
        reasonKind: "manual_exemption",
      });
      return verdict;
    }

    const exemptionMode = this.getExemptionMode(filePath);
    if (exemptionMode === "allow") {
      const verdict = this.allow();
      this.recordVerdict(filePath, "edit", touchedLines, verdict, {
        reasonKind: "pattern_exemption",
        exemptionMode,
      });
      return verdict;
    }

    const effectiveMode: "block" | "warn" | undefined =
      exemptionMode === "warn" ? "warn" : undefined;

    const fileReads = this.reads.get(filePath);
    if (!fileReads || fileReads.length === 0) {
      if (this.wasWrittenThisSession(filePath)) {
        this.injectCreationRead(filePath, 0, 0);
        const verdict = this.allow();
        this.recordVerdict(filePath, "edit", touchedLines, verdict, {
          reasonKind: "session_authored",
        });
        return verdict;
      }
      const verdict = this.blockOrWarn(
        "zero-read",
        `🔄 RETRYABLE — Edit without read\n\nYou are trying to edit \`${filePath}\` but have not read it in this conversation.\n\nRead the file first, then retry the edit: \`read path="${filePath}"\``,
        undefined,
        effectiveMode,
      );
      this.recordVerdict(filePath, "edit", touchedLines, verdict, {
        reasonKind: "zero_read",
      });
      return verdict;
    }

    const lastBoundRead = [...fileReads]
      .reverse()
      .find((read) => read.contentBinding !== undefined);
    if (
      lastBoundRead?.contentBinding &&
      !currentContentMatchesBinding(filePath, lastBoundRead.contentBinding)
    ) {
      const verdict = this.blockOrWarn(
        "file-modified",
        `🔄 RETRYABLE — File modified since read\n\nYou last read \`${filePath}\` at ${new Date(lastBoundRead.timestamp).toISOString()}.\nThe file content no longer matches the bridge-recorded read.\n\nYour mental model is out of sync with the actual file content.\nTo proceed:\n  1. Re-read the file: \`read path="${filePath}"\``,
        undefined,
        effectiveMode,
      );
      this.recordVerdict(filePath, "edit", touchedLines, verdict, {
        reasonKind: "file_modified",
        lastReadTimestamp: lastBoundRead.timestamp,
        contentBindingMismatch: true,
      });
      return verdict;
    }

    let ignoredOwnEditStaleness = false;
    let ignoredHashStaleness = false;
    if (this.fileTime.hasChanged(filePath)) {
      const lastRead = fileReads[fileReads.length - 1];
      if (this.canTreatStalenessAsOwnPriorEdit(filePath, lastRead.timestamp)) {
        ignoredOwnEditStaleness = true;
      } else if (this.canIgnoreStalenessByHashes(filePath, fileReads, touchedLines, editRanges)) {
        ignoredHashStaleness = true;
      } else {
        const verdict = this.blockOrWarn(
          "file-modified",
          `🔄 RETRYABLE — File modified since read\n\nYou last read \`${filePath}\` at ${new Date(lastRead.timestamp).toISOString()}.\nThe file has been modified on disk since then (auto-format, external tool, or previous edit).\n\nYour mental model is out of sync with the actual file content.\nTo proceed:\n  1. Re-read the file: \`read path="${filePath}"\``,
          undefined,
          effectiveMode,
        );
        this.recordVerdict(filePath, "edit", touchedLines, verdict, {
          reasonKind: "file_modified",
          lastReadTimestamp: lastRead.timestamp,
        });
        return verdict;
      }
    }

    if (!touchedLines) {
      const verdict = this.allow();
      this.recordVerdict(filePath, "edit", touchedLines, verdict, {
        reasonKind: "no_line_info",
      });
      return verdict;
    }

    const rangesToCheck: [number, number][] =
      editRanges && editRanges.length > 1 ? editRanges : [touchedLines];

    let viaSymbol = false;
    for (const range of rangesToCheck) {
      const snapshotValidation = this.validateRangeSnapshot(filePath, range);
      const coverage = this.checkCoverage(filePath, range);
      if (!coverage.covered) {
        const lastRead = fileReads[fileReads.length - 1];
        const [editStart, editEnd] = range;
        const lastReadEnd = lastRead.effectiveOffset + lastRead.effectiveLimit - 1;
        const outOfRangeMode = options?.oldTextResolved ? "warn" : effectiveMode;
        const verdict = this.blockOrWarn(
          "out-of-range",
          `🔄 RETRYABLE — Edit outside read range\n\nYou read \`${filePath}\` lines ${lastRead.effectiveOffset}-${lastReadEnd}${lastRead.enclosingSymbol ? ` (${lastRead.enclosingSymbol.kind} \`${lastRead.enclosingSymbol.name}\`)` : ""}, but your edit touches lines ${editStart}-${editEnd}.\n\nRead the relevant section first, then retry the edit:\n  \`read path="${filePath}" offset=${Math.max(1, editStart - 5)} limit=${Math.min(30, editEnd - editStart + 10)}\``,
          {
            editRange: range,
            readRanges: fileReads.map((r) => ({
              start: r.effectiveOffset,
              end: r.effectiveOffset + r.effectiveLimit - 1,
            })),
            symbolRanges: fileReads
              .filter((r) => r.enclosingSymbol)
              .map((r) => ({
                name: r.enclosingSymbol!.name,
                start: r.enclosingSymbol!.startLine,
                end: r.enclosingSymbol!.endLine,
              })),
          },
          outOfRangeMode,
        );
        this.recordVerdict(filePath, "edit", touchedLines, verdict, {
          reasonKind: "out_of_range",
          oldTextResolved: options?.oldTextResolved ?? false,
        });
        return verdict;
      }
      if (snapshotValidation.shouldBlock && !options?.skipSnapshotCheck) {
        const [editStart, editEnd] = range;
        const RANGE_STALE_GRACE_MS = 60_000;
        const lastRead = fileReads[fileReads.length - 1];
        const graceActive =
          ignoredOwnEditStaleness && Date.now() - lastRead.timestamp < RANGE_STALE_GRACE_MS;
        const relocation = this.findRelocation(filePath, fileReads, range);
        const relocationNote = relocation
          ? `\n\n📍 The content you read at lines ${relocation.from[0]}-${relocation.from[1]} now appears unchanged at lines ${relocation.to[0]}-${relocation.to[1]} — it shifted position. Re-target your edit to lines ${relocation.to[0]}-${relocation.to[1]}.`
          : "";
        const verdict = this.blockOrWarn(
          "range-stale",
          `🔄 RETRYABLE — Edit range changed since read\n\nYou are editing \`${filePath}\` lines ${editStart}-${editEnd}, but those lines no longer match the content you read earlier.${relocationNote}\n\nRe-read the relevant section, then retry the edit using the current line range/content:\n  \`read path="${filePath}" offset=${Math.max(1, editStart - 5)} limit=${Math.min(30, editEnd - editStart + 10)}\``,
          assignOptionalProperties(
            {
              editRange: range,
              readRanges: fileReads.map((r) => ({
                start: r.effectiveOffset,
                end: r.effectiveOffset + r.effectiveLimit - 1,
              })),
              symbolRanges: fileReads
                .filter((r) => r.enclosingSymbol)
                .map((r) => ({
                  name: r.enclosingSymbol!.name,
                  start: r.enclosingSymbol!.startLine,
                  end: r.enclosingSymbol!.endLine,
                })),
              snapshot: {
                status: snapshotValidation.status,
                mismatchedLines: snapshotValidation.mismatchedLines,
                missingLines: snapshotValidation.missingLines,
              },
            },
            relocation,
            () => ({ relocation }),
          ),
          graceActive ? "warn" : effectiveMode,
        );
        if (relocation && rangesToCheck.length === 1) {
          verdict.relocation = relocation;
        }
        this.recordVerdict(filePath, "edit", touchedLines, verdict, {
          reasonKind: "range_stale",
          range,
          mismatchedLines: snapshotValidation.mismatchedLines.slice(0, 20),
          graceActive,
          relocatedTo: relocation?.to ?? null,
          relocationAutoApplyOffered: !!verdict.relocation,
        });
        return verdict;
      }
      if (coverage.viaSymbol) viaSymbol = true;
    }

    const verdict = this.allow();
    this.recordVerdict(filePath, "edit", touchedLines, verdict, {
      reasonKind: viaSymbol ? "symbol_coverage" : "range_coverage",
      viaSymbol,
      ignoredOwnEditStaleness,
      ignoredHashStaleness,
    });
    return verdict;
  }

  isNewFile(filePath: string): boolean {
    try {
      return !fs.existsSync(filePath);
    } catch {
      return true;
    }
  }

  hasKnownPath(filePath: string): boolean {
    const stored = this.knownPathIndex.get(normalizeEphemeralMapKey(filePath));
    return stored !== undefined && (this.reads.has(stored) || this.writtenThisSession.has(stored));
  }

  forgetPath(filePath: string): void {
    const stored = this.knownPathIndex.get(normalizeEphemeralMapKey(filePath));
    this.evictFile(stored ?? this.key(filePath));
  }

  noteCreatedFile(filePath: string, turnIndex: number, writeIndex: number): void {
    this.pendingCreations.set(this.key(filePath), { turnIndex, writeIndex });
  }

  recordWritten(rawFilePath: string): void {
    const filePath = this.key(rawFilePath);
    this.knownPathIndex.set(normalizeEphemeralMapKey(rawFilePath), filePath);
    this.fileTime.read(filePath);
    this.writtenThisSession.add(filePath);
    if (this.reads.has(filePath)) this.consumedReadFiles.add(filePath);
    this.touchFile(filePath);
    this.enforceFileCap();
    const creation = this.pendingCreations.get(filePath);
    if (creation) {
      this.pendingCreations.delete(filePath);
      this.injectCreationRead(filePath, creation.turnIndex, creation.writeIndex);
    }
  }

  addExemption(filePath: string): void {
    this.exemptions.add(this.key(filePath));
    logReadGuardEvent({
      event: "exemption_added",
      sessionId: this.sessionId,
      filePath,
      metadata: {
        source: "lens-allow-edit",
      },
    });
  }

  getSummary(): GetSummaryResultContract {
    let totalEdits = 0;
    let totalBlocks = 0;
    let lspExpansionsHelped = 0;
    const byReason: Record<string, number> = {};
    const byFile: Record<string, { edits: number; blocks: number }> = {};

    for (const [filePath, records] of this.edits) {
      for (const record of records) {
        totalEdits++;
        byFile[filePath] = byFile[filePath] ?? { edits: 0, blocks: 0 };
        byFile[filePath].edits++;

        if (record.verdict === "blocked") {
          totalBlocks++;
          byFile[filePath].blocks++;
        }

        if (record.reason) {
          byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
        }

        if (record.precedingReads.some((r) => r.expandedByLsp) && record.verdict === "allowed") {
          lspExpansionsHelped++;
        }
      }
    }

    return {
      totalEdits,
      totalBlocks,
      byReason,
      byFile,
      lspExpansionsHelped,
    };
  }

  getReadHistory(filePath: string): ReadRecord[] {
    const key = this.key(filePath);
    if (this.reads.has(key)) this.touchFile(key);
    return this.reads.get(key) ?? [];
  }

  exportState(): PersistedReadGuardState {
    return {
      version: READ_GUARD_STATE_VERSION,
      reads: [...this.reads.entries()].map(([key, records]) => [
        key,
        records.map((record) => ({ ...record })),
      ]),
    };
  }

  importState(state: PersistedReadGuardState | undefined): ImportStateResultContract {
    const result = { imported: 0, dropped: 0 };

    if (!state || state.version !== READ_GUARD_STATE_VERSION) return result;

    if (!Array.isArray(state.reads)) return result;
    for (const entry of state.reads) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [rawPath, records] = entry;

      if (!isString(rawPath)) continue;
      if (!Array.isArray(records) || records.length === 0) continue;
      const filePath = this.key(rawPath);
      let lines: string[];
      try {
        lines = splitLines(fs.readFileSync(filePath, "utf-8"));
      } catch {
        result.dropped += records.length;
        continue;
      }
      for (const record of records) {
        const rehydrated: ReadRecord = { ...record, filePath };
        if (this.readHashesStillMatch(rehydrated, lines)) {
          this.recordRead(rehydrated);
          result.imported += 1;
        } else {
          result.dropped += 1;
        }
      }
    }

    return result;
  }

  getEditHistory(filePath: string): EditRecord[] {
    const key = this.key(filePath);
    if (this.edits.has(key)) this.touchFile(key);
    return this.edits.get(key) ?? [];
  }

  private injectCreationRead(filePath: string, turnIndex: number, writeIndex: number): void {
    let lineCount = 0;
    try {
      lineCount = splitLines(fs.readFileSync(filePath, "utf-8")).length;
    } catch {
      return;
    }
    if (lineCount === 0) return;
    this.recordRead({
      filePath,
      requestedOffset: 1,
      requestedLimit: lineCount,
      effectiveOffset: 1,
      effectiveLimit: lineCount,
      expandedByLsp: false,
      turnIndex,
      writeIndex,
      timestamp: Date.now(),
    });
  }

  private wasWrittenThisSession(filePath: string): boolean {
    if (this.writtenThisSession.has(filePath)) return true;
    try {
      return fs.statSync(filePath).mtimeMs >= this.sessionStartMs;
    } catch {
      return false;
    }
  }

  private canTreatStalenessAsOwnPriorEdit(filePath: string, lastReadTimestamp: number): boolean {
    const edits = this.edits.get(filePath) ?? [];
    const latest = edits.at(-1);
    if (!latest) return false;
    if (latest.verdict !== "allowed" && latest.verdict !== "warned") return false;
    if (latest.timestamp < lastReadTimestamp) return false;
    return Date.now() - latest.timestamp <= OWN_EDIT_STALE_GRACE_MS;
  }

  private canIgnoreStalenessByHashes(
    filePath: string,
    reads: ReadRecord[],
    touchedLines?: [number, number],
    editRanges?: [number, number][],
  ): boolean {
    let lines: string[];
    try {
      lines = splitLines(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return false;
    }

    const rangesToCheck: [number, number][] | undefined = touchedLines
      ? editRanges && editRanges.length > 1
        ? editRanges
        : [touchedLines]
      : undefined;

    if (!rangesToCheck) {
      const lastRead = reads.at(-1);
      return !!lastRead && this.readHashesStillMatch(lastRead, lines);
    }

    return rangesToCheck.every((range) =>
      reads.some(
        (read) =>
          this.readCoversRange(read, range) && this.readRangeHashesStillMatch(read, lines, range),
      ),
    );
  }

  private readCoversRange(read: ReadRecord, [editStart, editEnd]: [number, number]): boolean {
    const readStart = Math.max(1, read.effectiveOffset - this.config.contextLines);
    const readEnd = read.effectiveOffset + read.effectiveLimit - 1 + this.config.contextLines;
    if (editStart >= readStart && editEnd <= readEnd) return true;
    if (!read.enclosingSymbol) return false;
    return read.enclosingSymbol.startLine <= editStart && read.enclosingSymbol.endLine >= editEnd;
  }

  private validateRangeSnapshot(
    filePath: string,
    range: [number, number],
  ): ValidateRangeSnapshotResultContract {
    const reads = this.reads.get(filePath) ?? [];
    const candidates = reads.filter((read) => this.readCoversRange(read, range));
    let status: "match" | "mismatch" | "unavailable" = "unavailable";
    let matchingReadIndex = -1;
    let missingLines: number[] = [];
    let mismatchedLines: number[] = [];
    let checkedCandidateCount = 0;
    let unavailableCandidateCount = 0;
    let hashUnavailableCandidateCount = 0;
    let lastMismatchTimestamp = -Infinity;
    let lastUnavailableTimestamp = -Infinity;
    for (let i = 0; i < candidates.length; i += 1) {
      const validation = currentLinesMatchReadSnapshot(filePath, candidates[i], range);
      if (!validation.checked) {
        unavailableCandidateCount += 1;
        if (readEffectiveRangeCoversRange(candidates[i], range)) {
          hashUnavailableCandidateCount += 1;
        }
        if (status === "unavailable") {
          missingLines = validation.missingLines;
        }
        lastUnavailableTimestamp = Math.max(lastUnavailableTimestamp, candidates[i].timestamp);
        continue;
      }
      checkedCandidateCount += 1;
      if (validation.matches) {
        status = "match";
        matchingReadIndex = i;
        missingLines = [];
        mismatchedLines = [];
        break;
      }
      status = "mismatch";
      missingLines = [];
      mismatchedLines = validation.mismatchedLines;
      lastMismatchTimestamp = Math.max(lastMismatchTimestamp, candidates[i].timestamp);
    }

    const shouldBlock =
      status === "mismatch" &&
      lastUnavailableTimestamp <= lastMismatchTimestamp &&
      checkedCandidateCount > 0 &&
      hashUnavailableCandidateCount === 0;

    logReadGuardEvent({
      event: "range_snapshot_validation",
      sessionId: this.sessionId,
      filePath,
      metadata: {
        range,
        status,
        candidateReadCount: candidates.length,
        checkedCandidateCount,
        unavailableCandidateCount,
        hashUnavailableCandidateCount,
        matchingReadIndex,
        missingLineCount: missingLines.length,
        mismatchedLineCount: mismatchedLines.length,
        missingLines: missingLines.slice(0, 20),
        mismatchedLines: mismatchedLines.slice(0, 20),
        enforced: shouldBlock || status === "match",
      },
    });

    return {
      status,
      matchingReadIndex,
      missingLines,
      mismatchedLines,
      candidateReadCount: candidates.length,
      checkedCandidateCount,
      unavailableCandidateCount,
      shouldBlock,
    };
  }

  private readRangeHashesStillMatch(
    read: ReadRecord,
    lines: string[],
    [startLine, endLine]: [number, number],
  ): boolean {
    const hashes = read.lineHashes ?? {};
    for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
      if (!readRangeCoversLine(read, lineNo) || hashes[lineNo] === undefined) {
        return false;
      }
      if (lineNo < 1 || lineNo > lines.length) return false;
      if (lineContentHash(lines[lineNo - 1] ?? "") !== hashes[lineNo]) {
        return false;
      }
    }
    return true;
  }

  private findRelocation(
    filePath: string,
    reads: ReadRecord[],
    [startLine, endLine]: [number, number],
  ): { from: [number, number]; to: [number, number] } | undefined {
    const span = endLine - startLine + 1;
    if (span < 2) return undefined;

    let wanted: string[] | undefined;
    for (let i = reads.length - 1; i >= 0; i -= 1) {
      const hashes = reads[i].lineHashes;
      if (!hashes) continue;
      const seq: string[] = [];
      let complete = true;
      for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
        const h = hashes[lineNo];
        if (h === undefined) {
          complete = false;
          break;
        }
        seq.push(h);
      }
      if (complete) {
        wanted = seq;
        break;
      }
    }
    if (!wanted) return undefined;

    let lines: string[];
    try {
      lines = splitLines(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return undefined;
    }
    const currentHashes = lines.map((line) => lineContentHash(line));
    const lastStart = currentHashes.length - span;

    const matchStarts: number[] = [];
    for (let i = 0; i <= lastStart; i += 1) {
      let ok = true;
      for (let j = 0; j < span; j += 1) {
        if (currentHashes[i + j] !== wanted[j]) {
          ok = false;
          break;
        }
      }
      if (ok) matchStarts.push(i + 1);
    }

    let newStart: number | undefined;
    if (matchStarts.length === 1) {
      newStart = matchStarts[0];
    } else if (matchStarts.length > 1) {
      const appliedEdits = (this.edits.get(filePath) ?? []).filter(
        (record) => record.verdict !== "blocked",
      ).length;
      const window = Math.min(
        RELOCATION_WINDOW_MAX,
        Math.max(RELOCATION_WINDOW_MIN, appliedEdits * RELOCATION_WINDOW_PER_EDIT),
      );
      const lo = startLine - window;
      const hi = endLine + window;
      const local = matchStarts.filter((start) => start >= lo && start <= hi);
      if (local.length === 1) newStart = local[0];
    }

    if (newStart === undefined || newStart === startLine) return undefined;
    return { from: [startLine, endLine], to: [newStart, newStart + span - 1] };
  }

  private readHashesStillMatch(read: ReadRecord, lines: string[]): boolean {
    const entries = Object.entries(read.lineHashes ?? {});
    if (entries.length === 0) return false;
    for (const [lineText, expected] of entries) {
      const lineNo = Number(lineText);
      if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) {
        return false;
      }
      if (lineContentHash(lines[lineNo - 1] ?? "") !== expected) return false;
    }
    return true;
  }

  private checkCoverage(
    filePath: string,
    touchedLines: [number, number],
  ): CheckCoverageResultContract {
    const [editStart, editEnd] = touchedLines;

    const reads = this.reads.get(filePath) ?? [];

    for (const read of reads) {
      const readStart = Math.max(1, read.effectiveOffset - this.config.contextLines);
      const readEnd = read.effectiveOffset + read.effectiveLimit - 1 + this.config.contextLines;

      if (editStart >= readStart && editEnd <= readEnd) {
        return { covered: true, viaSymbol: false };
      }

      if (read.enclosingSymbol) {
        const symStart = read.enclosingSymbol.startLine;
        const symEnd = read.enclosingSymbol.endLine;
        if (symStart <= editStart && symEnd >= editEnd) {
          return { covered: true, viaSymbol: true };
        }
      }
    }

    const intervals = reads.map(
      (read) =>
        // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
        [
          Math.max(1, read.effectiveOffset - this.config.contextLines),
          read.effectiveOffset + read.effectiveLimit - 1 + this.config.contextLines,
        ] as [number, number],
    );

    intervals.sort((a, b) => a[0] - b[0]);

    const merged: Array<[number, number]> = [];
    for (const [s, e] of intervals) {
      if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }

    for (const [s, e] of merged) {
      if (editStart >= s && editEnd <= e) {
        return { covered: true, viaSymbol: false };
      }
    }

    return { covered: false, viaSymbol: false };
  }

  private getExemptionMode(filePath: string): "allow" | "warn" | "block" | null {
    for (const exemption of this.config.exemptions) {
      if (this.matchesPattern(filePath, exemption.pattern)) {
        return exemption.mode;
      }
    }
    return null;
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      return filePath.endsWith(suffix);
    }
    if (pattern.includes("*")) {
      const regex = new RegExp(
        `^${pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
      );
      return regex.test(filePath);
    }
    return filePath === pattern;
  }

  private blockOrWarn(
    _reason: string,
    message: string,
    details?: ReadGuardVerdict["details"],
    overrideMode?: "block" | "warn",
  ): ReadGuardVerdict {
    const mode = overrideMode ?? this.config.mode;
    if (mode === "warn") {
      return { action: "warn", reason: message, details };
    }
    return { action: "block", reason: message, details };
  }

  private allow(): ReadGuardVerdict {
    return { action: "allow" };
  }

  private recordEdit(
    filePath: string,
    tool: "write" | "edit",
    touchedLines: [number, number],
    verdict: ReadGuardVerdict,
  ): void {
    this.touchFile(filePath);
    const arr = this.edits.get(filePath) ?? [];
    arr.push({
      filePath,
      tool,
      touchedLines,
      precedingReads: this.reads.get(filePath) ?? [],
      verdict: mapVerdictAction(verdict.action),
      reason: verdict.reason,
      timestamp: Date.now(),
    });
    this.edits.set(filePath, arr);
  }

  private recordVerdict(
    filePath: string,
    tool: "write" | "edit",
    touchedLines: [number, number] | undefined,
    verdict: ReadGuardVerdict,

    metadata: Record<string, LspDictionaryValue> = {},
  ): void {
    const normalizedTouchedLines = touchedLines ?? [1, 1];
    this.recordEdit(filePath, tool, normalizedTouchedLines, verdict);
    const reads = this.reads.get(filePath) ?? [];
    logReadGuardEvent({
      event:
        verdict.action === "allow"
          ? "edit_allowed"
          : verdict.action === "warn"
            ? "edit_warned"
            : "edit_blocked",
      sessionId: this.sessionId,
      filePath,
      metadata: {
        tool,
        touchedLines: touchedLines ?? null,
        normalizedTouchedLines,
        readCount: reads.length,
        reads: reads.map((read) => ({
          requestedOffset: read.requestedOffset,
          requestedLimit: read.requestedLimit,
          effectiveOffset: read.effectiveOffset,
          effectiveLimit: read.effectiveLimit,
          expandedByLsp: read.expandedByLsp,
          enclosingSymbol: read.enclosingSymbol ?? null,
          timestamp: read.timestamp,
        })),
        verdictAction: verdict.action,
        details: verdict.details,
        ...metadata,
      },
    });
  }
}

function mapVerdictAction(action: ReadGuardVerdict["action"]): EditRecord["verdict"] {
  switch (action) {
    case "allow":
      return "allowed";
    case "block":
      return "blocked";
    case "warn":
      return "warned";
  }
}

export function createReadGuard(sessionId: string, config?: Partial<ReadGuardConfig>): ReadGuard {
  return new ReadGuard(sessionId, config);
}
