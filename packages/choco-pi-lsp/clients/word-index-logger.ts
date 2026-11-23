import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";

const WORD_INDEX_LOG_FILE = path.join(getGlobalPiLensDir(), "word-index.log");

const writer = createNdjsonLogger({
  filePath: WORD_INDEX_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export type WordIndexLogPhase =
  | "full_rebuild"
  | "incremental_refresh"
  | "incremental_fallback"
  | "cold_build"
  | "cold_build_refused"
  | "cold_build_failed"
  | "warm_cache_evicted"
  | "persist_succeeded"
  | "persist_failed";

export interface WordIndexLogEntry {
  ts?: string;
  phase: WordIndexLogPhase;
  cwd: string;
  trigger?: string;
  durationMs?: number;
  phaseDurationsMs?: {
    snapshotLoadMs?: number;
    deserializeMs?: number;
    sourceWalkMs?: number;
    statWalkMs?: number;
    refreshReadsMs?: number;
    snapshotSaveSyncMs?: number;
  };
  indexedFileCount?: number;
  truncated?: boolean;
  tokens?: number;
  refreshed?: number;
  dropped?: number;
  skipped?: number;
  reused?: number;
  reason?: string;
  error?: string;
}

export function logWordIndex(entry: WordIndexLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getWordIndexLogPath(): string {
  return WORD_INDEX_LOG_FILE;
}

export function flushWordIndexLog(): Promise<void> {
  return writer.flush();
}
