import { type Static, Type } from "typebox";
import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import type { TreeSitterParseCacheStats } from "./tree-sitter-client.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";

const LspDictionaryValueSchema = Type.Unknown();
type LspDictionaryValue = Static<typeof LspDictionaryValueSchema>;

function assignOptionalProperties<T extends object, U extends object, C>(
  target: T,
  include: C,
  createProperties: (included: NonNullable<C>) => U,
): T & Partial<U>;
function assignOptionalProperties<T extends object, U extends object, C>(
  target: T,
  include: C,
  createProperties: (included: NonNullable<C>) => U,
) {
  return include ? Object.assign(target, createProperties(include)) : target;
}

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
    // #1333: free-form operational text that used to be a raw console.error
    // (or a verbose-gated one) from the tree-sitter stack. `reason` carries
    // the message, `metadata.subsystem` the emitting module.
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

/**
 * The tree-sitter stack's terminal-safe diagnostic sink (#1333).
 *
 * pi owns the terminal, so nothing under `clients/` may `console.error`. The
 * tree-sitter subsystem already owns `tree-sitter.log`, so its diagnostics stay
 * there rather than moving to the generic `extension.log` — one log per
 * subsystem, per the AGENTS.md logger invariant.
 *
 * `filePath` is optional because several of these fire process-wide (WASM
 * abort, grammar fetch, rule compile) with no file in hand.
 */
export function logTreeSitterDiagnostic(entry: {
  /** Emitting module, e.g. `tree-sitter-client`, `symbol-extractor`. */
  subsystem: string;
  message: string;
  /** `debug` is what the previously verbose-gated loggers write at. */
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

/** Resolve once all enqueued tree-sitter writes are on disk (tests/shutdown). */
export function flushTreeSitterLog(): Promise<void> {
  return writer.flush();
}
