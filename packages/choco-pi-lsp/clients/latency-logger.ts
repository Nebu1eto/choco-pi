import { type LspDictionaryValue } from "./runtime-guards.ts";
import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
  filePath: LATENCY_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface LatencyEntry {
  type: "runner" | "tool_result" | "phase";
  ts?: string;
  pid?: number;
  startedAt?: string;
  toolName?: string;
  filePath: string;
  fullPath?: string;
  phase?: string;
  durationMs: number;
  totalDurationMs?: number;
  result?: string;
  runnerId?: string;
  status?: string;
  diagnosticCount?: number;
  semantic?: string;
  diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
  wallClockMs?: number;
  sumMs?: number;
  parallelGainMs?: number;

  metadata?: Record<string, LspDictionaryValue>;
}

export const RECENT_PHASE_CAP = 5;

let recentPhases: Array<{ phase: string; ts: string }> = [];

const LAST_PHASE_EXCLUDED = new Set([
  "loop_block",
  "lsp_typescript_project_identity",
  "advisory_provenance_decision",
  "authoritative_content_attachment_decision",
  "agent_end_deferred_mutation_drain",
  "agent_end_deferred_mutation_requeue",
  "session_end_bus_rollup",
  "lsp_aux_wait_outcome",
  "tool_set_mutation",
  "availability_decision",
  "finding_dead_path_drop",
  "finding_stale_line_demote",
  "lsp_scanner_coverage_gap",
  "lsp_notify_resync_deferred",
  "lsp_notify_write_late_landed",
]);

export function getLastLoggedPhase(): { phase: string; ts: string } | undefined {
  return recentPhases[0];
}

export function getRecentLoggedPhases(
  limit = RECENT_PHASE_CAP,
): Array<{ phase: string; ts: string }> {
  return recentPhases.slice(0, Math.min(limit, RECENT_PHASE_CAP));
}

export function _recentPhasesStorageLengthForTest(): number {
  return recentPhases.length;
}

export function _setRecentPhasesForTest(entries: Array<{ phase: string; ts: string }>): void {
  recentPhases = entries;
}

export function logLatency(entry: LatencyEntry): void {
  const ts = new Date().toISOString();
  if (entry.type === "phase" && entry.phase && !LAST_PHASE_EXCLUDED.has(entry.phase)) {
    recentPhases = [{ phase: entry.phase, ts }, ...recentPhases].slice(0, RECENT_PHASE_CAP);
  }
  if (isTestMode()) {
    return;
  }
  writer.log({ ...entry, ts, pid: process.pid });
}

export function getLatencyLogPath(): string {
  return LATENCY_LOG_FILE;
}

export function flushLatencyLog(): Promise<void> {
  return writer.flush();
}

export function clearLatencyLog(): void {
  writer.truncate();
}
