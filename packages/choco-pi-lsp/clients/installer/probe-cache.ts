/**
 * Persistent tool probe cache: read, change tracking, debounced flush, and verification of cached paths.
 */
import { isRuntimeObject } from "../../tools/runtime-values.ts";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { BoundedLruCache } from "../bounded-cache.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { commitDurableStoreAsync } from "../durable-store.ts";
import { getGlobalPiLensDir } from "../file-utils.ts";
import { TRANSIENT_MAX_COOLDOWN_MS } from "../dispatch/runners/utils/availability-policy.ts";
import { lastManagedInstallVersion, resetPathWalkMemo } from "./command-probe.ts";
import {
  ensureInFlight,
  installAttempts,
  installFailureReasons,
  lastEnsureResolutionSource,
} from "./install-attempts.ts";
import { lastResolveTransient } from "./tool-resolution.ts";

// Session-lifetime cache: once a tool path is resolved, skip the process-spawn check on subsequent calls.
export const resolvedPathCache = new BoundedLruCache<string, string>(256);

// --- Persistent probe cache ---

interface ProbeCacheEntry {
  path: string;
  mtimeMs: number;
  cachedAt: number;
  /**
   * True when the `getToolPath` resolution that produced `path` saw a
   * transient probe failure (a stall, a kill, an unspawnable candidate) on
   * some tier before landing here — never a clean "not found" (#1569). Such
   * a selection may be a degraded fallback masking a preferred tier that was
   * merely unlucky at that moment, so it is not trusted for the full 24h
   * TTL: it ages out after `PROBE_CACHE_TRANSIENT_COOLDOWN_MS` instead, the
   * same window the live probe policy (`availability-policy.ts`) uses to
   * decide a transient verdict is worth re-checking. Absent/`false` means
   * every candidate along the way either succeeded or was cleanly missing.
   */
  transient?: boolean;
}

type ProbeCache = Record<string, ProbeCacheEntry>;

const PROBE_CACHE_PATH = path.join(getGlobalPiLensDir(), "probe-cache.json");
const PROBE_CACHE_LOCK_STALE_MS = 180_000;
const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a transient-tainted entry (see `ProbeCacheEntry.transient`) is
 * served before `getToolPath` is asked again, instead of the full 24h TTL
 * (#1569). Shares the shared probe policy's transient ceiling rather than
 * inventing a new number for the same "how long is a stall worth trusting"
 * question.
 */
const PROBE_CACHE_TRANSIENT_COOLDOWN_MS = TRANSIENT_MAX_COOLDOWN_MS;
const PROBE_CACHE_FLUSH_LOCK_WAIT_MS = 250;
const PROBE_CACHE_FLUSH_RETRY_DELAY_MS = 300;
const PROBE_CACHE_FLUSH_RETRY_MAX_DELAY_MS = 30_000;

export let _probeCache: ProbeCache | null = null;
let _probeCacheDirty = false;
let _probeCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _probeCacheWriteInFlight: Promise<ProbeCacheFlushResult> | null = null;
let _probeCacheRetryAttempt = 0;
let _probeCacheChangeGeneration = 0;
// Read-modify-write deltas let a long-lived process merge with entries another
// process discovered after this process's initial read. `null` is a deliberate
// deletion (TTL/stale-path eviction), not an absent map value.
const _probeCacheChanges = new Map<string, ProbeCacheEntry | null>();
const _probeCacheChangeVersions = new Map<string, number>();

export async function readProbeCache(): Promise<ProbeCache> {
  if (_probeCache !== null) return _probeCache;
  try {
    const raw = await fs.readFile(PROBE_CACHE_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || !isRuntimeObject(parsed) || Array.isArray(parsed)) {
      throw new Error("probe-cache root is not an object");
    }
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    _probeCache = parsed as ProbeCache;
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      logSessionStart(
        `auto-install probe-cache: read failed (${code ?? "invalid"}); treating cache as unavailable`,
      );
    }
    _probeCache = {};
  }
  return _probeCache;
}

export function markProbeCacheChange(toolId: string, entry: ProbeCacheEntry | null): void {
  _probeCacheChanges.set(toolId, entry);
  _probeCacheChangeVersions.set(toolId, ++_probeCacheChangeGeneration);
  _probeCacheDirty = true;
  scheduleProbeFlush();
}

function scheduleProbeFlush(delayMs = PROBE_CACHE_FLUSH_RETRY_DELAY_MS): void {
  if (_probeCacheFlushTimer !== null) return;
  _probeCacheFlushTimer = setTimeout(() => {
    void flushProbeCache();
  }, delayMs);
  _probeCacheFlushTimer.unref?.();
}

function scheduleProbeFlushRetry(): void {
  const delay = Math.min(
    PROBE_CACHE_FLUSH_RETRY_MAX_DELAY_MS,
    PROBE_CACHE_FLUSH_RETRY_DELAY_MS * 2 ** Math.min(_probeCacheRetryAttempt, 6),
  );
  _probeCacheRetryAttempt += 1;
  scheduleProbeFlush(delay);
}

export type ProbeCacheFlushResult =
  | "idle"
  | "written"
  | "written-with-pending"
  | "deferred"
  | "failed";

type ProbeCacheFlushSnapshot = {
  changes: Map<string, ProbeCacheEntry | null>;
  versions: Map<string, number>;
};

function snapshotProbeCacheChanges(): ProbeCacheFlushSnapshot {
  return {
    changes: new Map(_probeCacheChanges),
    versions: new Map(_probeCacheChangeVersions),
  };
}

/**
 * Deserialize the on-disk probe-cache for the LOCKED write-side merge
 * (`writeProbeCache`'s `commitDurableStoreAsync` call). Unlike `readProbeCache`
 * (the ordinary session-lookup path, which already degrades a parse/shape
 * failure to `{}`), this used to THROW on a torn/corrupt file — which does
 * not crash the caller (`writeProbeCache` wraps the whole commit in try/catch
 * and retries), but it also means the corrupt file on disk is never repaired:
 * every retry re-reads the same torn bytes, re-throws, and gives up again,
 * forever (#1609 layer b). Degrading here too, exactly like `readProbeCache`,
 * lets the next successful flush's `merge` step overwrite the torn file with
 * a valid one instead of looping on it indefinitely.
 */
function deserializeProbeCache(contents: string | undefined): ProbeCache {
  if (contents === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || !isRuntimeObject(parsed) || Array.isArray(parsed)) {
      throw new Error("probe-cache root is not an object");
    }
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    return parsed as ProbeCache;
  } catch (err) {
    logSessionStart(
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      `auto-install probe-cache: write-side read was corrupt (${(err as Error).message}); recovering as empty`,
    );
    return {};
  }
}

function applyProbeCacheChanges(
  disk: ProbeCache,
  changes: Map<string, ProbeCacheEntry | null>,
): void {
  for (const [toolId, entry] of changes) {
    if (entry === null) delete disk[toolId];
    else disk[toolId] = entry;
  }
}

/**
 * Install-lifetime ageing belongs to the authoritative merge, not only to the
 * lookup path: a sibling process may have left expired entries on disk since
 * this process loaded its in-memory snapshot. The async durable-store lock
 * supplies the probe cache's former quarantine/stale-owner recovery.
 */
function ageProbeCache(disk: ProbeCache): void {
  const now = Date.now();
  for (const [toolId, entry] of Object.entries(disk)) {
    const ttl = entry.transient ? PROBE_CACHE_TRANSIENT_COOLDOWN_MS : PROBE_CACHE_TTL_MS;
    if (!Number.isFinite(entry.cachedAt) || entry.cachedAt < now - ttl) {
      delete disk[toolId];
    }
  }
}

function publishProbeCacheWrite(
  disk: ProbeCache,
  snapshotVersions: Map<string, number>,
): ProbeCacheFlushResult {
  // Publish the sibling-process merge plus any updates that arrived during
  // the write. Only an unchanged snapshot entry is retired.
  const pendingAfterWrite = new Map(_probeCacheChanges);
  _probeCache = disk;
  for (const [toolId, entry] of pendingAfterWrite) {
    if (entry === null) delete _probeCache[toolId];
    else _probeCache[toolId] = entry;
  }
  for (const [toolId, version] of snapshotVersions) {
    if (_probeCacheChangeVersions.get(toolId) === version) {
      _probeCacheChanges.delete(toolId);
      _probeCacheChangeVersions.delete(toolId);
    }
  }
  _probeCacheDirty = _probeCacheChanges.size > 0;
  _probeCacheRetryAttempt = 0;
  return _probeCacheDirty ? "written-with-pending" : "written";
}

async function writeProbeCache(): Promise<ProbeCacheFlushResult> {
  try {
    // Snapshot versions before the awaited disk read/write. A new update for
    // the same tool may arrive while the atomic write is in flight; its newer
    // version must remain pending for the next flush.
    const { changes, versions } = snapshotProbeCacheChanges();
    let result: ProbeCacheFlushResult = "written";
    const committed = await commitDurableStoreAsync({
      path: PROBE_CACHE_PATH,
      deserialize: deserializeProbeCache,
      merge: (disk) => {
        ageProbeCache(disk);
        applyProbeCacheChanges(disk, changes);
        return disk;
      },
      serialize: (disk) => JSON.stringify(disk, null, 2),
      waitMs: PROBE_CACHE_FLUSH_LOCK_WAIT_MS,
      retryMs: 25,
      staleMs: PROBE_CACHE_LOCK_STALE_MS,
      timeoutMessage: "Timed out waiting for probe-cache lock",
      onContention: "skip-log",
      logContention: () => {
        logSessionStart(
          "auto-install probe-cache: flush deferred because another process owns the lock",
        );
      },
      afterWriteLocked: (disk) => {
        result = publishProbeCacheWrite(disk, versions);
      },
    });
    if (committed === undefined) {
      scheduleProbeFlushRetry();
      return "deferred";
    }
    return result;
  } catch (err) {
    // Keep dirty state so a later timer/explicit flush can retry. The error
    // is logged without paths, source, or command text; an unavailable cache
    // must never look like a clean empty cache to operators.
    logSessionStart(
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      `auto-install probe-cache: flush failed (${(err as NodeJS.ErrnoException | undefined)?.code ?? "write error"}); pending update retained`,
    );
    scheduleProbeFlushRetry();
    return "failed";
  }
}

/** Await pending probe-cache persistence before a one-shot process exits. */
export async function flushProbeCache(): Promise<ProbeCacheFlushResult> {
  if (_probeCacheFlushTimer !== null) {
    clearTimeout(_probeCacheFlushTimer);
    _probeCacheFlushTimer = null;
  }
  // #946 review F4: if the 300ms timer's write already started, the dirty
  // flag is false but the write may still be in flight — an immediate
  // process.exit would truncate it. Always await the in-flight write.
  if (_probeCacheWriteInFlight) {
    await _probeCacheWriteInFlight;
    if (!_probeCacheDirty) return "written";
  }
  if (!_probeCacheDirty || _probeCache === null) return "idle";

  const write = writeProbeCache();
  _probeCacheWriteInFlight = write;
  try {
    return await write;
  } finally {
    if (_probeCacheWriteInFlight === write) _probeCacheWriteInFlight = null;
  }
}

function isAstGrepVersionOutput(output: string): boolean {
  return /\bast[- ]grep\b/i.test(output);
}

async function verifyAstGrepProbePath(binPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binPath, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath),
        timeout: 5000,
      });
    } catch {
      // SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
      // bug class, #533) — best-effort probe, resolve rather than reject.
      resolve(false);
      return;
    }
    let output = "";
    proc.stdout?.on("data", (data) => (output += data));
    proc.stderr?.on("data", (data) => (output += data));
    proc.on("exit", (code) => {
      resolve(code === 0 && isAstGrepVersionOutput(output));
    });
    proc.on("error", () => resolve(false));
  });
}

// Exported for testing only.
export async function checkProbeCache(toolId: string): Promise<string | undefined> {
  const cache = await readProbeCache();
  const entry = cache[toolId];
  if (!entry) return undefined;

  // A transient-tainted entry (#1569) is not trusted past the shorter
  // transient cooldown, even inside the 24h TTL — the selection it recorded
  // may be a degraded fallback that a since-recovered preferred tier should
  // now beat.
  const ttl = entry.transient ? PROBE_CACHE_TRANSIENT_COOLDOWN_MS : PROBE_CACHE_TTL_MS;
  if (Date.now() - entry.cachedAt > ttl) {
    logSessionStart(
      `auto-install probe-cache ${toolId}: miss (${entry.transient ? "transient cooldown" : "ttl"} expired)`,
    );
    delete cache[toolId];
    markProbeCacheChange(toolId, null);
    return undefined;
  }

  try {
    await fs.access(entry.path);
    const stat = await fs.stat(entry.path);
    if (stat.mtimeMs !== entry.mtimeMs) {
      logSessionStart(`auto-install probe-cache ${toolId}: miss (mtime changed)`);
      delete cache[toolId];
      markProbeCacheChange(toolId, null);
      return undefined;
    }
    if (toolId === "ast-grep" && !(await verifyAstGrepProbePath(entry.path))) {
      logSessionStart(`auto-install probe-cache ${toolId}: miss (not ast-grep: ${entry.path})`);
      delete cache[toolId];
      markProbeCacheChange(toolId, null);
      return undefined;
    }
    return entry.path;
  } catch {
    logSessionStart(`auto-install probe-cache ${toolId}: miss (gone: ${entry.path})`);
    delete cache[toolId];
    markProbeCacheChange(toolId, null);
    return undefined;
  }
}

// Exported for testing only.
export async function updateProbeCache(
  toolId: string,
  resolvedPath: string,
  transient = false,
): Promise<void> {
  try {
    const stat = await fs.stat(resolvedPath);
    const cache = await readProbeCache();
    const entry: ProbeCacheEntry = {
      path: resolvedPath,
      mtimeMs: stat.mtimeMs,
      cachedAt: Date.now(),
      ...(transient && { transient: true }),
    };
    cache[toolId] = entry;
    markProbeCacheChange(toolId, entry);
  } catch {
    // best-effort
  }
}

// Exported for testing only.
export function resetProbeCacheStateForTesting(): void {
  _probeCache = null;
  _probeCacheDirty = false;
  _probeCacheChanges.clear();
  _probeCacheChangeVersions.clear();
  _probeCacheChangeGeneration = 0;
  _probeCacheRetryAttempt = 0;
  resolvedPathCache.clear();
  ensureInFlight.clear();
  installFailureReasons.clear();
  installAttempts.clear();
  lastEnsureResolutionSource.clear();
  lastManagedInstallVersion.clear();
  lastResolveTransient.clear();
  resetPathWalkMemo();
  if (_probeCacheFlushTimer !== null) {
    clearTimeout(_probeCacheFlushTimer);
    _probeCacheFlushTimer = null;
  }
}
