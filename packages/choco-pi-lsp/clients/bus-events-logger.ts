import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";
import { logLatency } from "./latency-logger.ts";

const BUS_EVENTS_LOG_FILE = path.join(getGlobalPiLensDir(), "bus-events.log");

const writer = createNdjsonLogger({
  filePath: BUS_EVENTS_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export type BusEventName =
  | "pilens:files:touched"
  | "pilens:diagnostics"
  | "pilens:diagnostic:disposition"
  | "pilens:format:queued"
  | "pilens:format:start"
  | "pilens:autofix:start"
  | "choco-pi-lsp/analysis-complete"
  | "choco-pi-lsp/findings"
  | "choco-pi-lsp/turn-findings";

export type BusEventOutcome =
  | "emitted"
  | "skipped_unwired"
  | "skipped_disabled"
  | "skipped_stale_session"
  | "emit_failed";

export interface BusEventLogEntry {
  ts: string;
  event: BusEventName;
  outcome: BusEventOutcome;
  level?: "info";
  cwd: string;
  fileCount?: number;
  reason?: string;
  seq?: number;
  error?: string;
  ctxSource?: "own" | "global-fallback" | "unwired";
}

type BusEventRollupOutcome = "emitted" | "skipped_stale_session" | "emit_failed";
const eventRollupCounts = new Map<BusEventName, Record<BusEventRollupOutcome, number>>();

function bumpRollupCount(event: BusEventName, outcome: BusEventRollupOutcome): void {
  const existing = eventRollupCounts.get(event) ?? {
    emitted: 0,
    skipped_stale_session: 0,
    emit_failed: 0,
  };
  existing[outcome] += 1;
  eventRollupCounts.set(event, existing);
}

export function logBusEvent(entry: Omit<BusEventLogEntry, "ts">): void {
  if (
    entry.outcome === "emitted" ||
    entry.outcome === "skipped_stale_session" ||
    entry.outcome === "emit_failed"
  ) {
    bumpRollupCount(entry.event, entry.outcome);
  }
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getBusEventRollupCounts(): Record<string, Record<BusEventRollupOutcome, number>> {
  return Object.fromEntries(eventRollupCounts);
}

export function resetBusEventRollupCounts(): void {
  eventRollupCounts.clear();
}

export function emitBusEventRollupAtSessionEnd(cwd: string): void {
  for (const [event, counts] of eventRollupCounts) {
    logLatency({
      type: "phase",
      phase: "session_end_bus_rollup",
      filePath: cwd,
      durationMs: 0,
      metadata: { event, ...counts },
    });
  }
  resetBusEventRollupCounts();
}

export function getBusEventsLogPath(): string {
  return BUS_EVENTS_LOG_FILE;
}

export function flushBusEventsLog(): Promise<void> {
  return writer.flush();
}
