import * as fs from "node:fs";
import { logLatency } from "./latency-logger.ts";
import { toProjectRelativePath } from "./path-utils.ts";
import { STALE_LINE_MARKER } from "./stale-marker.ts";

export const PAST_EOF_STALE_MARKER = `${STALE_LINE_MARKER} — line past EOF`;

const MAX_LOGGED_PAST_EOF_LINES = 3;

const MAX_GATE_BYTES = 4 * 1024 * 1024;

const NEWLINE_SCAN_CHUNK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;

interface LineCountCacheEntry {
  mtimeMs: number;
  size: number;
  lineCount: number;
}

export type LineCountCache = Map<string, LineCountCacheEntry>;

export function createLineCountCache(): LineCountCache {
  return new Map();
}

const MAX_SHARED_CACHE_ENTRIES = 512;
const sharedLineCountCache: LineCountCache = new Map();

function rememberInSharedCache(
  cache: LineCountCache,
  filePath: string,
  entry: LineCountCacheEntry,
): void {
  if (
    cache === sharedLineCountCache &&
    cache.size >= MAX_SHARED_CACHE_ENTRIES &&
    !cache.has(filePath)
  ) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(filePath, entry);
}

export function _resetSharedLineCountCacheForTests(): void {
  sharedLineCountCache.clear();
}

export function _seedSharedLineCountCacheForTests(
  filePath: string,
  entry: LineCountCacheEntry,
): void {
  sharedLineCountCache.set(filePath, entry);
}

function countNewlinesChunked(filePath: string, sizeBytes: number): number {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(NEWLINE_SCAN_CHUNK_BYTES, sizeBytes) || 1);
    let newlineCount = 0;
    let position = 0;
    while (position < sizeBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === NEWLINE_BYTE) newlineCount++;
      }
      position += bytesRead;
    }
    return newlineCount;
  } finally {
    fs.closeSync(fd);
  }
}

export function getCachedLineCount(
  filePath: string,
  cache: LineCountCache = sharedLineCountCache,
): number | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.lineCount;
  }
  if (stat.size > MAX_GATE_BYTES) return undefined;
  let newlineCount: number;
  try {
    newlineCount = countNewlinesChunked(filePath, stat.size);
  } catch {
    return undefined;
  }
  const lineCount = newlineCount + 1;
  rememberInSharedCache(cache, filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lineCount,
  });
  return lineCount;
}

export interface PastEofDiagnosticLike {
  line?: number;
  stale?: boolean;
  staleReason?: string;
}

export interface PastEofGateResult<T> {
  diagnostics: T[];
  demotedCount: number;
}

export function demotePastEofDiagnostics<T extends PastEofDiagnosticLike>(args: {
  store: string;
  cwd: string;
  filePath: string;
  diagnostics: readonly T[];
  lineCountCache?: LineCountCache;
  resync?: (filePath: string) => void;
}): PastEofGateResult<T> {
  const { diagnostics } = args;
  if (diagnostics.length === 0) {
    return { diagnostics: [], demotedCount: 0 };
  }
  const lineCount = getCachedLineCount(args.filePath, args.lineCountCache ?? sharedLineCountCache);
  if (lineCount === undefined) {
    return { diagnostics: [...diagnostics], demotedCount: 0 };
  }
  const risingEdgeLines: number[] = [];
  const out = diagnostics.map((d) => {
    if (d.stale && d.staleReason !== undefined && d.staleReason !== "past-eof") return d;
    const isPastEof = d.line !== undefined && d.line > lineCount;
    if (isPastEof === !!d.stale) return d;
    if (isPastEof && d.line !== undefined) risingEdgeLines.push(d.line);
    return { ...d, stale: isPastEof, staleReason: isPastEof ? "past-eof" : undefined };
  });
  if (risingEdgeLines.length === 0) {
    return { diagnostics: out, demotedCount: 0 };
  }
  logLatency({
    type: "phase",
    phase: "diagnostic_past_eof",
    filePath: args.cwd,
    durationMs: 0,
    metadata: {
      store: args.store,
      file: toProjectRelativePath(args.filePath, args.cwd),
      actualLineCount: lineCount,
      demotedCount: risingEdgeLines.length,
      sampleCitedLines: risingEdgeLines.slice(0, MAX_LOGGED_PAST_EOF_LINES),
    },
  });
  if (args.resync) {
    try {
      args.resync(args.filePath);
    } catch {}
  }
  return { diagnostics: out, demotedCount: risingEdgeLines.length };
}

export function resyncDocumentOnPastEof(filePath: string): void {
  void (async () => {
    try {
      const [{ getLSPService }, content] = await Promise.all([
        import("./lsp/index.ts"),
        fs.promises.readFile(filePath, "utf-8"),
      ]);
      await getLSPService().openFile(filePath, content, {
        preserveDiagnostics: false,
      });
    } catch {}
  })();
}
