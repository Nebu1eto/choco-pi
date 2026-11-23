import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";
import { createNdjsonLogger, type NdjsonLogger } from "./ndjson-logger.ts";

const DEBUG_HEAP_ENABLED = process.env.CHOCO_PI_LSP_DEBUG_HEAP === "1";

export const SNAPSHOT_RETENTION = 3;

const SNAPSHOT_PREFIX = "heap-";
const SNAPSHOT_SUFFIX = ".heapsnapshot";

const HEAP_SNAPSHOT_LOG_FILE = path.join(getGlobalPiLensDir(), "heap-snapshots.log");

const writer: NdjsonLogger | null = DEBUG_HEAP_ENABLED
  ? createNdjsonLogger({
      filePath: HEAP_SNAPSHOT_LOG_FILE,
      maxBytes: getMaxLogSizeMB() * 1024 * 1024,
    })
  : null;

export function isDebugHeapEnabled(): boolean {
  return DEBUG_HEAP_ENABLED;
}

export function getHeapSnapshotLogPath(): string {
  return HEAP_SNAPSHOT_LOG_FILE;
}

export function flushHeapSnapshotLog(): Promise<void> {
  return writer ? writer.flush() : Promise.resolve();
}

export function snapshotFileName(pid: number, isoTs: string): string {
  return `${SNAPSHOT_PREFIX}${pid}-${isoTs.replace(/[:.]/g, "-")}${SNAPSHOT_SUFFIX}`;
}

export function pruneOldSnapshots(dir: string, keep: number = SNAPSHOT_RETENTION): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const snapshots = names
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .map((name) => {
      const full = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {}
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  for (const stale of snapshots.slice(Math.max(0, keep))) {
    try {
      fs.rmSync(stale.full, { force: true });
      removed.push(stale.full);
    } catch {}
  }
  return removed;
}

export interface HeapSnapshotResult {
  path: string;
  rssBytes: number;
  durationMs: number;
}

export function writeHeapSnapshotNow(label: string): HeapSnapshotResult | null {
  if (!DEBUG_HEAP_ENABLED) return null;
  const dir = getGlobalPiLensDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const ts = new Date().toISOString();
  const target = path.join(dir, snapshotFileName(process.pid, ts));
  const rssBytes = process.memoryUsage().rss;
  const start = Date.now();
  let written: string;
  try {
    written = v8.writeHeapSnapshot(target);
  } catch {
    return null;
  }
  const durationMs = Date.now() - start;
  pruneOldSnapshots(dir);
  writer?.log({ ts, label, path: written, pid: process.pid, rssBytes, durationMs });
  return { path: written, rssBytes, durationMs };
}
