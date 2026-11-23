import * as asyncHooks from "node:async_hooks";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";
import { createNdjsonLogger, type NdjsonLogger } from "./ndjson-logger.ts";

const DEBUG_HANDLES_ENABLED = process.env.CHOCO_PI_LSP_DEBUG_HANDLES === "1";

const DEBUG_HANDLES_LOG_FILE = path.join(getGlobalPiLensDir(), "debug-handles.log");

export const TRACKER_MAX_ENTRIES = 500;

export const TRACKER_PROTECTED_COUNT = 100;

const TRACKED_TYPE_RE =
  /^(Timeout|Immediate|TCPWRAP|TCPSOCKETWRAP|TCPCONNECTWRAP|PIPEWRAP|PIPECONNECTWRAP|UDPWRAP|UDPSENDWRAP|TTYWRAP|ProcessWrap|Signal)/;

interface TrackedResource {
  type: string;
  stack: string;
}

function trimStack(raw: string | undefined): string {
  if (!raw) return "";
  const lines = raw.split("\n").slice(1);
  const callerLines = lines.filter(
    (line) => !line.includes("debug-handles.js") && !line.includes("debug-handles.ts"),
  );
  return callerLines.slice(0, 8).join("\n").slice(0, 2000);
}

let trackedEvictedCount = 0;

export function _evictedCountForTest(): number {
  return trackedEvictedCount;
}

function recordTrackedInit(map: Map<number, TrackedResource>, asyncId: number, type: string): void {
  if (!TRACKED_TYPE_RE.test(type)) return;
  if (map.size >= TRACKER_MAX_ENTRIES) {
    let index = 0;
    let evictKey: number | undefined;
    for (const key of map.keys()) {
      if (index >= TRACKER_PROTECTED_COUNT) {
        evictKey = key;
        break;
      }
      index++;
    }
    if (evictKey !== undefined) {
      map.delete(evictKey);
      trackedEvictedCount++;
    }
  }
  map.set(asyncId, { type, stack: trimStack(new Error().stack) });
}

function installHandleTracker(): Map<number, TrackedResource> {
  const map = new Map<number, TrackedResource>();
  const hook = asyncHooks.createHook({
    init(asyncId: number, type: string) {
      recordTrackedInit(map, asyncId, type);
    },
    destroy(asyncId: number) {
      map.delete(asyncId);
    },
  });
  hook.enable();
  return map;
}

const trackedResources: Map<number, TrackedResource> | null = DEBUG_HANDLES_ENABLED
  ? installHandleTracker()
  : null;

const writer: NdjsonLogger | null = DEBUG_HANDLES_ENABLED
  ? createNdjsonLogger({
      filePath: DEBUG_HANDLES_LOG_FILE,
      maxBytes: getMaxLogSizeMB() * 1024 * 1024,
    })
  : null;

export function isDebugHandlesEnabled(): boolean {
  return DEBUG_HANDLES_ENABLED;
}

export function getDebugHandlesLogPath(): string {
  return DEBUG_HANDLES_LOG_FILE;
}

export function flushDebugHandlesLog(): Promise<void> {
  return writer ? writer.flush() : Promise.resolve();
}

function safeGetActiveResourcesInfo(): string[] {
  try {
    const fn = process.getActiveResourcesInfo;
    return fn instanceof Function ? fn.call(process) : [];
  } catch {
    return [];
  }
}

interface CreationSiteSummary {
  type: string;
  count: number;
  sampleStack: string;
}

function summarizeCreationSites(map: Map<number, TrackedResource>): CreationSiteSummary[] {
  const byType = new Map<string, CreationSiteSummary>();
  for (const { type, stack } of map.values()) {
    const existing = byType.get(type);
    if (existing) {
      existing.count++;
    } else {
      byType.set(type, { type, count: 1, sampleStack: stack });
    }
  }
  return [...byType.values()];
}

export interface DebugHandlesLogEntry {
  ts: string;
  label: string;
  total: number;
  counts: Record<string, number>;
  creationSites?: CreationSiteSummary[];
  evictedCount?: number;
}

export function dumpActiveHandles(label: string): void {
  if (!DEBUG_HANDLES_ENABLED || !writer) return;
  const resources = safeGetActiveResourcesInfo();
  const counts: Record<string, number> = {};
  for (const type of resources) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const entry: DebugHandlesLogEntry = {
    ts: new Date().toISOString(),
    label,
    total: resources.length,
    counts,
  };
  if (trackedResources) {
    entry.creationSites = summarizeCreationSites(trackedResources);
    entry.evictedCount = trackedEvictedCount;
  }
  writer.log(entry);
}

export function _trackedResourceCountForTest(): number {
  return trackedResources?.size ?? 0;
}

export function _isTrackedForTest(asyncId: number): boolean {
  return trackedResources?.has(asyncId) ?? false;
}

export function _simulateTrackedInitForTest(asyncId: number, type: string): void {
  if (!trackedResources) return;
  recordTrackedInit(trackedResources, asyncId, type);
}
