import * as path from "node:path";
import { isExcludedDirName } from "./file-utils.ts";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";

export function parseUntrackedIgnoredOutput(stdout: string, cwd: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const rel = line.trim();
    if (!rel) continue;
    const dirSegments = rel.split("/").slice(0, -1);
    if (dirSegments.some((segment) => isExcludedDirName(segment))) continue;
    ids.add(normalizeMapKey(path.join(cwd, rel)));
  }
  return ids;
}

async function fetchUntrackedIgnoredIds(cwd: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const result = await safeSpawnAsync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard"],
      { cwd, timeout: 10_000, resourceLabel: "git-tracked-ignore" },
    );
    if (result.error || result.status !== 0) return undefined;
    return parseUntrackedIgnoredOutput(result.stdout, cwd);
  } catch {
    return undefined;
  }
}

interface CacheEntry {
  promise: Promise<ReadonlySet<string> | undefined>;
  fetchedAtMs: number;
}

const CACHE_TTL_MS = 30_000;
const _cache = new Map<string, CacheEntry>();

export function collectUntrackedIgnoredIds(cwd: string): Promise<ReadonlySet<string> | undefined> {
  const key = normalizeMapKey(cwd);
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.promise;
  const promise = fetchUntrackedIgnoredIds(cwd);
  _cache.set(key, { promise, fetchedAtMs: now });
  return promise;
}

export function _resetUntrackedIgnoredCacheForTests(): void {
  _cache.clear();
}

export function parseTrackedFilesOutput(stdout: string, cwd: string): Set<string> {
  const ids = new Set<string>();
  const base = normalizeMapKey(cwd);
  for (const line of stdout.split(/\r?\n/)) {
    const rel = line.trim();
    if (!rel) continue;
    const dirSegments = rel.split("/").slice(0, -1);
    if (dirSegments.some((segment) => isExcludedDirName(segment))) continue;
    ids.add(normalizeEphemeralMapKey(path.join(base, rel)));
  }
  return ids;
}

async function fetchTrackedFiles(cwd: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const result = await safeSpawnAsync("git", ["ls-files"], {
      cwd,
      timeout: 10_000,
      resourceLabel: "git-tracked-ignore",
    });
    if (result.error || result.status !== 0) return undefined;
    return parseTrackedFilesOutput(result.stdout, cwd);
  } catch {
    return undefined;
  }
}

const _trackedCache = new Map<string, CacheEntry>();
const _trackedSnapshot = new Map<string, ReadonlySet<string> | undefined>();

export function collectTrackedFiles(cwd: string): Promise<ReadonlySet<string> | undefined> {
  const key = normalizeEphemeralMapKey(cwd);
  const now = Date.now();
  for (const [snapshotKey, entry] of _trackedCache) {
    if (now - entry.fetchedAtMs >= CACHE_TTL_MS) _trackedSnapshot.delete(snapshotKey);
  }
  const cached = _trackedCache.get(key);
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.promise;
  const promise = fetchTrackedFiles(cwd).then((result) => {
    _trackedSnapshot.set(key, result);
    return result;
  });
  _trackedCache.set(key, { promise, fetchedAtMs: now });
  return promise;
}

export function getTrackedFilesSnapshot(cwd: string): ReadonlySet<string> | undefined {
  return _trackedSnapshot.get(normalizeEphemeralMapKey(cwd));
}

export function _resetTrackedFilesCacheForTests(): void {
  _trackedCache.clear();
  _trackedSnapshot.clear();
}
