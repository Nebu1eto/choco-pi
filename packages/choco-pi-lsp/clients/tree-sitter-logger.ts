import { assignOptionalProperties } from "./optional-properties.ts";
import { type LspDictionaryValue } from "./runtime-guards.ts";
import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import type { TreeSitterParseCacheStats } from "./tree-sitter-client.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";

const TREE_SITTER_LOG_DIR = getGlobalPiLensDir();
const TREE_SITTER_LOG_FILE = path.join(TREE_SITTER_LOG_DIR, "tree-sitter.log");

const writer = createNdjsonLogger({
  filePath: TREE_SITTER_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface TreeSitterLogEntry {
  ts?: string;
  phase:
    | "runner_start"
    | "runner_skip"
    | "queries_loaded"
    | "query_error"
    | "runtime_abort"
    | "runner_complete"
    | "entity_diff"
    | "blast_radius"
    | "cache_stats"
    | "diagnostic";
  filePath: string;
  languageId?: string;
  queryId?: string;
  status?: string;
  durationMs?: number;
  diagnostics?: number;
  blocking?: number;
  queryCount?: number;
  effectiveQueryCount?: number;
  cacheHit?: boolean;
  reason?: string;
  error?: string;

  metadata?: Record<string, LspDictionaryValue>;
}

const CACHE_COUNTER_KEYS = [
  "lookups",
  "hits",
  "misses",
  "coldMisses",
  "capacityMisses",
  "contentChangedMisses",
  "mtimeMisses",
  "statFailedMisses",
  "sets",
  "replacements",
  "evictions",
  "clears",
  "ghostHistoryDrops",
  "parserInvocations",
  "parserDurationMs",
  "parserFailures",
] as const satisfies readonly (keyof TreeSitterParseCacheStats)[];

export function logTreeSitter(entry: TreeSitterLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function logTreeSitterCacheStats(options: {
  scope: string;
  filePath: string;
  fileCount: number;
  durationMs: number;
  stats: TreeSitterParseCacheStats;
}): void {
  // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
  const delta = Object.fromEntries(
    CACHE_COUNTER_KEYS.map((key) => [key, options.stats[key]]),
  ) as Record<(typeof CACHE_COUNTER_KEYS)[number], number>;
  logTreeSitter({
    phase: "cache_stats",
    filePath: options.filePath,
    durationMs: options.durationMs,
    metadata: {
      scope: options.scope,
      fileCount: options.fileCount,
      hitRate: delta.lookups > 0 ? delta.hits / delta.lookups : null,
      delta,
      resident: {
        size: options.stats.size,
        maxSize: options.stats.maxSize,
        totalBytes: options.stats.totalBytes,
        totalLines: options.stats.totalLines,
      },
    },
  });
}

export function logTreeSitterDiagnostic(entry: {
  subsystem: string;
  message: string;
  level?: "error" | "warn" | "debug";
  filePath?: string;
  languageId?: string;

  metadata?: Record<string, LspDictionaryValue>;
}): void {
  const status: "error" | "warn" | "debug" = entry.level ?? "error";
  logTreeSitter(
    Object.assign(
      assignOptionalProperties(
        { phase: "diagnostic" as const, filePath: entry.filePath ?? "<tree-sitter>" },
        entry.languageId,
        (languageId) => ({ languageId }),
      ),
      {
        status,
        reason: entry.message,
        metadata: { subsystem: entry.subsystem, ...entry.metadata },
      },
    ),
  );
}

export function getTreeSitterLogPath(): string {
  return TREE_SITTER_LOG_FILE;
}

export function flushTreeSitterLog(): Promise<void> {
  return writer.flush();
}
