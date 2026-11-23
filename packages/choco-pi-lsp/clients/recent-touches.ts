import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./atomic-write.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { normalizeFilePath } from "./path-utils.ts";

export const RECENT_TOUCHES_MAX_ENTRIES = 50;
export const RECENT_TOUCHES_FRESHNESS_MS = 15 * 60 * 1000;

export type RecentTouchReason = "autofix" | "format";

export interface RecentTouchEntry {
  path: string;
  reason: RecentTouchReason;
  ts: number;
  pid: number;
  sessionId?: string;
}

interface RecentTouchesFile {
  entries: RecentTouchEntry[];
}

function recentTouchesPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "recent-touches.json");
}

let _enabledCache: boolean | undefined;

export function isRecentTouchesEnabled(): boolean {
  if (_enabledCache === undefined) {
    _enabledCache = process.env.CHOCO_PI_LSP_AGENT_NUDGE !== "0";
  }
  return _enabledCache;
}

export function _resetRecentTouchesForTests(): void {
  _enabledCache = undefined;
  _lastSeenMtimeMs = undefined;
  _lastConsumedCursor.clear();
}

async function readRecentTouchesAsync(cwd: string): Promise<RecentTouchesFile> {
  try {
    const raw = await fs.promises.readFile(recentTouchesPath(cwd), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
      return parsed as RecentTouchesFile;
    }
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeRecentTouchesAsync(cwd: string, file: RecentTouchesFile): Promise<void> {
  const dir = getProjectDataDir(cwd);
  const target = recentTouchesPath(cwd);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    return;
  }
  await writeFileAtomicAsync(target, JSON.stringify(file));
}

export interface AppendRecentTouchesArgs {
  cwd: string;
  reason: RecentTouchReason;
  paths: string[];
  sessionId?: string;
}

export async function appendRecentTouches(args: AppendRecentTouchesArgs): Promise<void> {
  if (!isRecentTouchesEnabled()) return;
  if (args.paths.length === 0) return;
  const now = Date.now();
  const pid = process.pid;
  const newEntries: RecentTouchEntry[] = args.paths.map((p) => ({
    path: normalizeFilePath(p),
    reason: args.reason,
    ts: now,
    pid,
    sessionId: args.sessionId,
  }));
  const file = await readRecentTouchesAsync(args.cwd);
  const merged = [...file.entries, ...newEntries];
  const capped =
    merged.length > RECENT_TOUCHES_MAX_ENTRIES
      ? merged.slice(merged.length - RECENT_TOUCHES_MAX_ENTRIES)
      : merged;
  await writeRecentTouchesAsync(args.cwd, { entries: capped });
}

function passesForeignEntryFilter(
  entry: RecentTouchEntry,
  selfPid: number,
  now: number,
  freshnessMs: number,
): boolean {
  if (entry.pid === selfPid) return false;
  if (now - entry.ts > freshnessMs) return false;
  try {
    return fs.existsSync(entry.path);
  } catch {
    return false;
  }
}

export interface ReadCrossProcessTouchesForSessionStartArgs {
  cwd: string;
  selfPid?: number;
  now?: number;
  freshnessMs?: number;
}

export async function readCrossProcessTouchesForSessionStart(
  args: ReadCrossProcessTouchesForSessionStartArgs,
): Promise<RecentTouchEntry[]> {
  if (!isRecentTouchesEnabled()) return [];
  try {
    const selfPid = args.selfPid ?? process.pid;
    const now = args.now ?? Date.now();
    const freshnessMs = args.freshnessMs ?? RECENT_TOUCHES_FRESHNESS_MS;
    const file = await readRecentTouchesAsync(args.cwd);
    return file.entries.filter((e) => passesForeignEntryFilter(e, selfPid, now, freshnessMs));
  } catch {
    return [];
  }
}

let _lastSeenMtimeMs: number | undefined;
const _lastConsumedCursor = new Map<string, number>();

export interface ReadCrossProcessTouchesForTurnStartArgs {
  cwd: string;
  selfPid?: number;
  now?: number;
  freshnessMs?: number;
}

export async function readCrossProcessTouchesForTurnStart(
  args: ReadCrossProcessTouchesForTurnStartArgs,
): Promise<RecentTouchEntry[]> {
  if (!isRecentTouchesEnabled()) return [];
  try {
    const target = recentTouchesPath(args.cwd);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(target)).mtimeMs;
    } catch {
      return [];
    }
    if (_lastSeenMtimeMs === mtimeMs) return [];
    _lastSeenMtimeMs = mtimeMs;

    const selfPid = args.selfPid ?? process.pid;
    const now = args.now ?? Date.now();
    const freshnessMs = args.freshnessMs ?? RECENT_TOUCHES_FRESHNESS_MS;
    const file = await readRecentTouchesAsync(args.cwd);
    const cursorKey = normalizeFilePath(args.cwd);
    const cursor = _lastConsumedCursor.get(cursorKey) ?? 0;
    const fresh = file.entries.filter(
      (e) => e.ts > cursor && passesForeignEntryFilter(e, selfPid, now, freshnessMs),
    );
    if (file.entries.length > 0) {
      const maxTs = Math.max(...file.entries.map((e) => e.ts));
      _lastConsumedCursor.set(cursorKey, Math.max(cursor, maxTs));
    }
    return fresh;
  } catch {
    return [];
  }
}
