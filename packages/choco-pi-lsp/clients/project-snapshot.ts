import { assignOptionalProperties } from "./optional-properties.ts";
import {
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspBoundaryValue,
} from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "./atomic-write.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "./idle-timer-release.ts";
import { readJsonCache } from "./json-cache-read.ts";
import { logLatency } from "./latency-logger.ts";
import { normalizeMapKey } from "./path-utils.ts";
import type {
  ProjectSnapshotPersistWorkerRequest,
  ProjectSnapshotPersistWorkerResult,
} from "./project-snapshot-persist-worker.ts";
import type { ProjectLanguageProfile } from "./language-policy.ts";
import { detectProjectConventions, type ProjectConventions } from "./project-conventions.ts";
import type { RuleScanResult } from "./rules-scanner.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import type { StartupScanContext } from "./startup-scan.ts";
import {
  deserializeWordIndex,
  serializeWordIndex,
  type SerializedWordIndex,
} from "./word-index.ts";

type ReadSnapshotBodyResultContract = {
  snapshot: ProjectSnapshot | null;
  rawBytes: number;
};

export const PROJECT_SNAPSHOT_VERSION = 2;

export interface ProjectSnapshotFile {
  path: string;
  mtimeMs: number;
  size: number;
  hash?: string;
  language?: string;
  lineCount?: number;
  imports?: string[];
  symbolCount?: number;
  lastSeq: number;
}

export interface ProjectSnapshotSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface SnapshotSequenceIndex {
  projectSeq: number;
  fileSeqByPath: Array<[filePath: string, fileSeq: number]>;
}

export interface ProjectSnapshot {
  version: typeof PROJECT_SNAPSHOT_VERSION;
  projectRoot: string;
  generatedAt: string;
  seq: number;
  files: Record<string, ProjectSnapshotFile>;
  symbols: Record<string, ProjectSnapshotSymbol[]>;
  reverseDeps: Record<string, string[]>;
  cachedExports: Array<[name: string, filePath: string]>;
  sequenceIndex?: SnapshotSequenceIndex;
  wordIndex?: SerializedWordIndex;
  projectRulesScan?: RuleScanResult;
  startupScan?: StartupScanContext;
  languageProfile?: ProjectLanguageProfile;
  conventions?: ProjectConventions;
}

function parseSequenceIndex(value: LspBoundaryValue): SnapshotSequenceIndex | undefined {
  if (!value || !isObjectRecord(value)) return undefined;

  // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
  const index = value as Partial<SnapshotSequenceIndex>;

  if (!isFiniteNumber(index.projectSeq)) return undefined;
  if (!Array.isArray(index.fileSeqByPath)) return undefined;
  const fileSeqByPath = index.fileSeqByPath.filter(
    (entry): entry is [string, number] =>
      Array.isArray(entry) && isString(entry[0]) && isFiniteNumber(entry[1]),
  );
  return { projectSeq: index.projectSeq, fileSeqByPath };
}

export function getProjectSnapshotPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json.gz");
}

export function getProjectSnapshotLegacyPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json");
}

export function getProjectSnapshotMetaPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.meta.json");
}

export function isProjectSnapshotFresh(
  snapshot: ProjectSnapshot | null | undefined,
  currentProjectSeq: number,
): snapshot is ProjectSnapshot {
  return (
    !!snapshot &&
    snapshot.version === PROJECT_SNAPSHOT_VERSION &&
    snapshot.seq === currentProjectSeq
  );
}

function parseSnapshot(value: LspBoundaryValue): ProjectSnapshot | null {
  if (!value || !isObjectRecord(value)) return null;

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const snapshot = value as Partial<ProjectSnapshot>;
  if (snapshot.version !== PROJECT_SNAPSHOT_VERSION) return null;

  if (!isString(snapshot.projectRoot)) return null;

  if (!isString(snapshot.generatedAt)) return null;

  if (!isFiniteNumber(snapshot.seq)) return null;
  if (!Array.isArray(snapshot.cachedExports)) return null;
  return {
    version: PROJECT_SNAPSHOT_VERSION,
    projectRoot: snapshot.projectRoot,
    generatedAt: snapshot.generatedAt,
    seq: snapshot.seq,
    files: snapshot.files ?? {},
    symbols: snapshot.symbols ?? {},
    reverseDeps: snapshot.reverseDeps ?? {},
    cachedExports: snapshot.cachedExports.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && isString(entry[0]) && isString(entry[1]),
    ),
    sequenceIndex: parseSequenceIndex(snapshot.sequenceIndex),
    wordIndex: snapshot.wordIndex,
    projectRulesScan: snapshot.projectRulesScan,
    startupScan: snapshot.startupScan,
    languageProfile: snapshot.languageProfile,
    conventions: snapshot.conventions,
  };
}

export interface ProjectSnapshotMeta {
  timestamp: string;
  version: number;
  seq: number;
  sequenceIndex?: SnapshotSequenceIndex;
}

function parseSnapshotMeta(value: LspBoundaryValue): ProjectSnapshotMeta | null {
  if (!value || !isObjectRecord(value)) return null;

  // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
  const meta = value as Partial<ProjectSnapshotMeta>;

  if (!isFiniteNumber(meta.version)) return null;

  if (!isFiniteNumber(meta.seq)) return null;
  return {
    timestamp: isString(meta.timestamp) ? meta.timestamp : "",
    version: meta.version,
    seq: meta.seq,
    sequenceIndex: parseSequenceIndex(meta.sequenceIndex),
  };
}

export function readProjectSnapshotMeta(cwd: string): ProjectSnapshotMeta | null {
  const meta = readJsonCache<ProjectSnapshotMeta>(
    getProjectSnapshotMetaPath(cwd),
    (parsed) => parseSnapshotMeta(parsed) ?? undefined,
  );
  return meta ?? null;
}

export function isProjectSnapshotMetaStale(
  meta: ProjectSnapshotMeta,
  currentProjectSeq: number,
): boolean {
  return meta.version !== PROJECT_SNAPSHOT_VERSION || meta.seq !== currentProjectSeq;
}

interface SnapshotParseCacheEntry {
  mtimeMs: number;
  size: number;
  snapshot: ProjectSnapshot | null;
}
const SNAPSHOT_PARSE_CACHE_MAX = 4;
const SNAPSHOT_PARSE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const snapshotParseCache = new Map<string, SnapshotParseCacheEntry>();

function withoutWordIndex(snapshot: ProjectSnapshot | null): ProjectSnapshot | null {
  if (!snapshot?.wordIndex) return snapshot;
  const { wordIndex: _releasedPostings, ...stripped } = snapshot;
  return stripped;
}

function cacheParsedSnapshot(snapshotPath: string, entry: SnapshotParseCacheEntry): void {
  snapshotParseCache.delete(snapshotPath);
  snapshotParseCache.set(snapshotPath, entry);
  while (snapshotParseCache.size > SNAPSHOT_PARSE_CACHE_MAX) {
    const oldest = snapshotParseCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotParseCache.delete(oldest);
  }
}

interface AuthoritativeSnapshotEntry {
  snapshot: ProjectSnapshot;
  knownMtime: number;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}
const authoritativeSnapshots = new Map<string, AuthoritativeSnapshotEntry>();
const PROJECT_SNAPSHOT_MAX_WARM_ROOTS = 8;
const PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function projectSnapshotIdleEvictMs(): number {
  const value = Number.parseInt(process.env.CHOCO_PI_LSP_PROJECT_SNAPSHOT_IDLE_EVICT_MS ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT;
}

function clearAuthoritativeSnapshotTimer(entry: AuthoritativeSnapshotEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

registerIdleTimerRelease(() => {
  for (const entry of authoritativeSnapshots.values()) clearAuthoritativeSnapshotTimer(entry);
});

function deleteAuthoritativeSnapshot(key: string): void {
  const entry = authoritativeSnapshots.get(key);
  if (entry) clearAuthoritativeSnapshotTimer(entry);
  authoritativeSnapshots.delete(key);
}

function scheduleAuthoritativeSnapshotEviction(
  key: string,
  entry: AuthoritativeSnapshotEntry,
): void {
  clearAuthoritativeSnapshotTimer(entry);
  if (idleEvictionTimersSuspended()) return;
  const generation = entry.lastUsedAt;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (authoritativeSnapshots.get(key) !== entry || entry.lastUsedAt !== generation) return;
    deleteAuthoritativeSnapshot(key);
  }, projectSnapshotIdleEvictMs());
  entry.idleTimer.unref?.();
}

function touchAuthoritativeSnapshot(key: string, entry: AuthoritativeSnapshotEntry): void {
  entry.lastUsedAt = Date.now();
  scheduleAuthoritativeSnapshotEviction(key, entry);
}

function enforceAuthoritativeSnapshotCap(): void {
  while (authoritativeSnapshots.size > PROJECT_SNAPSHOT_MAX_WARM_ROOTS) {
    const victim = [...authoritativeSnapshots.entries()].sort(
      ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
    )[0];
    if (!victim) return;
    clearAuthoritativeSnapshotTimer(victim[1]);
    deleteAuthoritativeSnapshot(victim[0]);
  }
}

export function _getAuthoritativeSnapshotCacheKeysForTests(): string[] {
  return [...authoritativeSnapshots.entries()]
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
    .map(([key]) => key);
}

export function _resetProjectSnapshotParseCacheForTests(): void {
  snapshotParseCache.clear();
  for (const entry of authoritativeSnapshots.values()) clearAuthoritativeSnapshotTimer(entry);
  authoritativeSnapshots.clear();
}

export function _projectSnapshotParseCacheRetainsWordIndexForTests(): boolean {
  return [...snapshotParseCache.values()].some((entry) => entry.snapshot?.wordIndex !== undefined);
}

function resolveSnapshotBodyPath(cwd: string): {
  path: string;
  gz: boolean;
  mtimeMs: number;
  size: number;
} | null {
  const gzPath = getProjectSnapshotPath(cwd);
  try {
    const stat = fs.statSync(gzPath);
    return { path: gzPath, gz: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {}
  const legacyPath = getProjectSnapshotLegacyPath(cwd);
  try {
    const stat = fs.statSync(legacyPath);
    return {
      path: legacyPath,
      gz: false,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

let _snapshotBodyReadCountForTests = 0;
export function getSnapshotBodyReadCountForTests(): number {
  return _snapshotBodyReadCountForTests;
}
export function resetSnapshotBodyReadCountForTests(): void {
  _snapshotBodyReadCountForTests = 0;
}

function readSnapshotBody(bodyPath: string, gz: boolean): ReadSnapshotBodyResultContract {
  _snapshotBodyReadCountForTests++;
  if (!gz) {
    const snapshot =
      readJsonCache<ProjectSnapshot>(bodyPath, (parsed) => parseSnapshot(parsed) ?? undefined) ??
      null;
    let rawBytes = 0;
    try {
      rawBytes = fs.statSync(bodyPath).size;
    } catch {}

    return { snapshot, rawBytes };
  }
  try {
    const json = gunzipSync(fs.readFileSync(bodyPath)).toString("utf-8");
    const snapshot = parseSnapshot(JSON.parse(json)) ?? null;

    return { snapshot, rawBytes: Buffer.byteLength(json) };
  } catch (err) {
    logLatency({
      type: "phase",
      phase: "project_snapshot_body_corrupt",
      filePath: bodyPath,
      durationMs: 0,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });

    return { snapshot: null, rawBytes: 0 };
  }
}

function loadProjectSnapshotInternal(
  cwd: string,
  requireWordIndex: boolean,
): ProjectSnapshot | null {
  const key = normalizeMapKey(cwd);
  const body = resolveSnapshotBodyPath(cwd);
  const authoritative = authoritativeSnapshots.get(key);
  if (authoritative) {
    const diskMtime = body ? body.mtimeMs : Number.NEGATIVE_INFINITY;
    if (diskMtime <= authoritative.knownMtime) {
      touchAuthoritativeSnapshot(key, authoritative);
      return authoritative.snapshot;
    }
    deleteAuthoritativeSnapshot(key);
  }
  if (!body) {
    snapshotParseCache.delete(getProjectSnapshotPath(cwd));
    return null;
  }
  const cacheKey = body.path;
  const cached = snapshotParseCache.get(cacheKey);
  if (cached && cached.mtimeMs === body.mtimeMs && cached.size === body.size) {
    if (!requireWordIndex || !cached.snapshot || cached.snapshot.wordIndex) {
      return cached.snapshot;
    }
  }
  const { snapshot, rawBytes } = readSnapshotBody(body.path, body.gz);
  const cacheSnapshot = withoutWordIndex(snapshot);
  if (rawBytes > 0 && (rawBytes <= SNAPSHOT_PARSE_CACHE_MAX_BYTES || snapshot?.wordIndex)) {
    cacheParsedSnapshot(cacheKey, {
      mtimeMs: body.mtimeMs,
      size: body.size,
      snapshot: cacheSnapshot,
    });
  } else {
    snapshotParseCache.delete(cacheKey);
  }
  return snapshot;
}

export function loadProjectSnapshot(cwd: string): ProjectSnapshot | null {
  return loadProjectSnapshotInternal(cwd, true);
}

export function loadProjectSnapshotWithoutWordIndex(cwd: string): ProjectSnapshot | null {
  return loadProjectSnapshotInternal(cwd, false);
}

interface PendingSnapshotBody {
  key: string;
  cwd: string;
  gzPath: string;
  legacyPath: string;
  stagePath: string;
  snapshot: ProjectSnapshot;
  generation: number;
}
const _snapshotGenerations = new Map<string, number>();
const _snapshotWorkerRequests = new Map<number, PendingSnapshotBody>();
let _snapshotPersistWorker: Worker | undefined;
const _retiredSnapshotPersistWorkers = new WeakSet<Worker>();
let _snapshotWorkerRequestId = 0;
let _snapshotWorkerDisabled = false;
let _snapshotGenerationGateEnabledForTests = true;
let _snapshotPromotionSeamForTests: (() => Promise<void>) | undefined;
let _lastSnapshotPersistErrorForTests: string | undefined;

function snapshotWorkerEnabled(): boolean {
  const raw = process.env.CHOCO_PI_LSP_SNAPSHOT_PERSIST_SYNC;
  return !(raw === "1" || raw === "true");
}

function recordSnapshotPersistFailure(cwd: string, error: string): void {
  _lastSnapshotPersistErrorForTests = error;
  deleteAuthoritativeSnapshot(normalizeMapKey(cwd));
  logLatency({
    type: "phase",
    phase: "project_snapshot_persist_failed",
    filePath: getProjectSnapshotPath(cwd),
    durationMs: 0,
    metadata: { error },
  });
}

function logSnapshotPersistSuccess(
  pending: PendingSnapshotBody,
  stats: {
    rawBytes: number;
    gzBytes: number;
    serializeMs: number;
    writeMs: number;
    offloaded: boolean;
  },
): void {
  logLatency({
    type: "phase",
    phase: "project_snapshot_persist",
    filePath: pending.gzPath,
    durationMs: stats.serializeMs + stats.writeMs,
    metadata: { seq: pending.snapshot.seq, ...stats },
  });
}

function reconcileAuthoritativeAfterWrite(pending: PendingSnapshotBody, rawBytes: number): void {
  const entry = authoritativeSnapshots.get(pending.key);
  if (!entry || entry.snapshot !== pending.snapshot) return;
  if (pending.snapshot.wordIndex) {
    try {
      const stat = fs.statSync(pending.gzPath);
      cacheParsedSnapshot(pending.gzPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        snapshot: withoutWordIndex(pending.snapshot),
      });
    } catch {}
    deleteAuthoritativeSnapshot(pending.key);
    logLatency({
      type: "phase",
      phase: "project_snapshot_word_index_released",
      filePath: pending.gzPath,
      durationMs: 0,
      metadata: { rawBytes },
    });
    return;
  }
  if (rawBytes > SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
    logLatency({
      type: "phase",
      phase: "project_snapshot_authoritative_dropped_oversized",
      filePath: pending.gzPath,
      durationMs: 0,
      metadata: { rawBytes, maxBytes: SNAPSHOT_PARSE_CACHE_MAX_BYTES },
    });
    deleteAuthoritativeSnapshot(pending.key);
    return;
  }
  try {
    entry.knownMtime = fs.statSync(pending.gzPath).mtimeMs;
  } catch {}
}

function writeSnapshotBodyOnMainThread(pending: PendingSnapshotBody, reason?: string): void {
  if (reason) {
    logLatency({
      type: "phase",
      phase: "project_snapshot_worker_fallback",
      filePath: pending.gzPath,
      durationMs: 0,
      metadata: {
        reason,
        seq: pending.snapshot.seq,
        degraded: reason !== "exit_hook",
      },
    });
  }
  try {
    const serializeStarted = performance.now();
    const json = JSON.stringify(pending.snapshot);
    const serializeMs = performance.now() - serializeStarted;
    const rawBytes = Buffer.byteLength(json);
    const writeStarted = performance.now();
    const gzip = gzipSync(json);
    fs.mkdirSync(path.dirname(pending.gzPath), { recursive: true });
    writeFileAtomic(pending.gzPath, gzip, { bestEffort: false });
    fs.rmSync(pending.legacyPath, { force: true });
    reconcileAuthoritativeAfterWrite(pending, rawBytes);
    logSnapshotPersistSuccess(pending, {
      rawBytes,
      gzBytes: gzip.byteLength,
      serializeMs,
      writeMs: performance.now() - writeStarted,
      offloaded: false,
    });
    if (reason) _lastSnapshotPersistErrorForTests = reason;
  } catch (err) {
    recordSnapshotPersistFailure(pending.cwd, err instanceof Error ? err.message : String(err));
  }
}

function dispatchMainThreadWriteThroughSeam(
  pending: PendingSnapshotBody,
  reason: string | undefined,
): void {
  if (_snapshotPromotionSeamForTests) {
    void _snapshotPromotionSeamForTests().then(() =>
      writeSnapshotBodyOnMainThread(pending, reason),
    );
    return;
  }
  writeSnapshotBodyOnMainThread(pending, reason);
}

function handleSnapshotWorkerResult(result: ProjectSnapshotPersistWorkerResult): void {
  const pending = _snapshotWorkerRequests.get(result.id);
  if (!pending) {
    fs.rm(result.stagePath, { force: true }, () => {});
    return;
  }
  _snapshotWorkerRequests.delete(result.id);
  if (
    result.error ||
    result.rawBytes === undefined ||
    result.gzBytes === undefined ||
    result.serializeMs === undefined ||
    result.writeMs === undefined
  ) {
    fs.rm(result.stagePath, { force: true }, () => {});
    dispatchMainThreadWriteThroughSeam(pending, result.error ?? "invalid worker result");
    return;
  }
  if (
    _snapshotGenerationGateEnabledForTests &&
    _snapshotGenerations.get(pending.key) !== result.generation
  ) {
    fs.rm(result.stagePath, { force: true }, () => {});
    return;
  }
  try {
    fs.renameSync(result.stagePath, pending.gzPath);
    fs.rmSync(pending.legacyPath, { force: true });
    reconcileAuthoritativeAfterWrite(pending, result.rawBytes);
    logSnapshotPersistSuccess(pending, {
      rawBytes: result.rawBytes,
      gzBytes: result.gzBytes,
      serializeMs: result.serializeMs,
      writeMs: result.writeMs,
      offloaded: true,
    });
  } catch (err) {
    fs.rm(result.stagePath, { force: true }, () => {});
    dispatchMainThreadWriteThroughSeam(pending, err instanceof Error ? err.message : String(err));
  }
}

function handleSnapshotWorkerDeath(reason: string): void {
  _snapshotPersistWorker = undefined;
  _snapshotWorkerDisabled = true;
  const requests = [..._snapshotWorkerRequests.values()];
  _snapshotWorkerRequests.clear();
  for (const pending of requests) dispatchMainThreadWriteThroughSeam(pending, reason);
}

function resolveSnapshotPersistWorkerPath(): string | undefined {
  const candidates = [
    new URL("./project-snapshot-persist-worker.js", import.meta.url),
    new URL("./clients/project-snapshot-persist-worker.js", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const resolved = fileURLToPath(url);
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }
  return undefined;
}

function getSnapshotPersistWorker(): Worker | undefined {
  if (_snapshotWorkerDisabled) return undefined;
  if (_snapshotPersistWorker) return _snapshotPersistWorker;
  try {
    const workerPath = resolveSnapshotPersistWorkerPath();
    if (workerPath === undefined) {
      handleSnapshotWorkerDeath("persist worker script not found in any layout");
      return undefined;
    }
    const worker = new Worker(workerPath);
    worker.on("message", (result: ProjectSnapshotPersistWorkerResult) => {
      if (_snapshotPromotionSeamForTests) {
        void _snapshotPromotionSeamForTests().then(() => {
          handleSnapshotWorkerResult(result);
          settleSnapshotPersistQueue();
        });
        return;
      }
      handleSnapshotWorkerResult(result);
      settleSnapshotPersistQueue();
    });
    worker.on("error", (err: Error) => {
      if (_retiredSnapshotPersistWorkers.has(worker)) return;
      handleSnapshotWorkerDeath(err.message);
      settleSnapshotPersistQueue();
    });
    worker.on("exit", (code) => {
      if (_retiredSnapshotPersistWorkers.has(worker)) return;
      if (_snapshotPersistWorker === worker) _snapshotPersistWorker = undefined;
      const stranded = [..._snapshotWorkerRequests.values()];
      if (stranded.length > 0) {
        _snapshotWorkerRequests.clear();
        for (const pending of stranded) {
          dispatchMainThreadWriteThroughSeam(pending, `persist worker exited with code ${code}`);
        }
      }
      if (code !== 0) _snapshotWorkerDisabled = true;
      settleSnapshotPersistQueue();
    });
    worker.unref();
    _snapshotPersistWorker = worker;
    return worker;
  } catch (err) {
    handleSnapshotWorkerDeath(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

const _sweptSnapshotStageDirs = new Set<string>();
function sweepStaleSnapshotStageFiles(cacheDir: string): void {
  if (_sweptSnapshotStageDirs.has(cacheDir)) return;
  _sweptSnapshotStageDirs.add(cacheDir);
  fs.readdir(cacheDir, (err, entries) => {
    if (err) return;
    const ownMarker = `.stage-${process.pid}-`;
    for (const entry of entries) {
      if (!entry.startsWith("project-snapshot.json.gz.stage-")) continue;
      if (entry.includes(ownMarker)) continue;
      fs.rm(path.join(cacheDir, entry), { force: true }, () => {});
    }
  });
}

let _snapshotExitHookRegistered = false;
function flushSnapshotPersistsAtExit(): void {
  _snapshotExitHookRegistered = false;
  const requests = [..._snapshotWorkerRequests.values()];
  _snapshotWorkerRequests.clear();
  for (const pending of requests) {
    if (_snapshotGenerations.get(pending.key) !== pending.generation) continue;
    writeSnapshotBodyOnMainThread(pending, "exit_hook");
  }
  void _snapshotPersistWorker?.terminate();
}

function registerSnapshotPersistExitHook(): void {
  if (_snapshotExitHookRegistered) return;
  _snapshotExitHookRegistered = true;
  process.once("exit", flushSnapshotPersistsAtExit);
}

function settleSnapshotPersistQueue(): void {
  if (_snapshotWorkerRequests.size > 0) return;
  if (_snapshotExitHookRegistered) {
    _snapshotExitHookRegistered = false;
    process.off("exit", flushSnapshotPersistsAtExit);
  }
  const worker = _snapshotPersistWorker;
  if (!worker) return;
  _snapshotPersistWorker = undefined;
  _retiredSnapshotPersistWorkers.add(worker);
  void worker.terminate();
}

export function saveProjectSnapshot(cwd: string, snapshot: ProjectSnapshot): void {
  const gzPath = getProjectSnapshotPath(cwd);
  const legacyPath = getProjectSnapshotLegacyPath(cwd);
  const metaPath = getProjectSnapshotMetaPath(cwd);
  const cacheDir = path.dirname(gzPath);
  const key = normalizeMapKey(cwd);
  fs.mkdirSync(cacheDir, { recursive: true });

  writeFileAtomic(
    metaPath,
    JSON.stringify(
      assignOptionalProperties(
        { timestamp: snapshot.generatedAt, version: snapshot.version, seq: snapshot.seq },
        snapshot.sequenceIndex,
        () => ({ sequenceIndex: snapshot.sequenceIndex }),
      ),
    ),
    { bestEffort: false },
  );

  const priorBody = resolveSnapshotBodyPath(cwd);
  const knownMtime = priorBody ? priorBody.mtimeMs : Number.NEGATIVE_INFINITY;
  const authoritativeEntry: AuthoritativeSnapshotEntry = {
    snapshot,
    knownMtime,
    lastUsedAt: Date.now(),
  };
  authoritativeSnapshots.set(key, authoritativeEntry);
  scheduleAuthoritativeSnapshotEviction(key, authoritativeEntry);
  enforceAuthoritativeSnapshotCap();
  snapshotParseCache.delete(gzPath);

  const generation = (_snapshotGenerations.get(key) ?? 0) + 1;
  _snapshotGenerations.set(key, generation);
  const stagePath = `${gzPath}.stage-${process.pid}-${generation}`;
  const pending: PendingSnapshotBody = {
    key,
    cwd,
    gzPath,
    legacyPath,
    stagePath,
    snapshot,
    generation,
  };
  sweepStaleSnapshotStageFiles(cacheDir);

  if (!snapshotWorkerEnabled()) {
    dispatchMainThreadWriteThroughSeam(pending, undefined);
    return;
  }
  const worker = getSnapshotPersistWorker();
  if (!worker) {
    dispatchMainThreadWriteThroughSeam(pending, "persist worker unavailable");
    return;
  }
  const id = ++_snapshotWorkerRequestId;
  _snapshotWorkerRequests.set(id, pending);
  registerSnapshotPersistExitHook();
  const request: ProjectSnapshotPersistWorkerRequest = {
    id,
    generation,
    stagePath,
    data: snapshot,
    testDelayMs:
      process.env.NODE_ENV === "test"
        ? Number(process.env.CHOCO_PI_LSP_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS) || undefined
        : undefined,
  };
  worker.postMessage(request);
}

export async function waitForProjectSnapshotPersistsForTests(): Promise<void> {
  for (let attempts = 0; attempts < 200 && _snapshotWorkerRequests.size > 0; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function flushProjectSnapshotPersistsForTests(): void {
  const requests = [..._snapshotWorkerRequests.values()];
  _snapshotWorkerRequests.clear();
  for (const pending of requests) {
    if (_snapshotGenerations.get(pending.key) !== pending.generation) continue;
    dispatchMainThreadWriteThroughSeam(pending, undefined);
  }
  settleSnapshotPersistQueue();
}

export async function terminateProjectSnapshotPersistWorkerForTests(): Promise<void> {
  const worker = _snapshotPersistWorker;
  if (worker) await worker.terminate();
}

export function getProjectSnapshotPersistLifetimeForTests() {
  return {
    workerAlive: _snapshotPersistWorker !== undefined,
    exitHookRegistered: _snapshotExitHookRegistered,
    inFlightRequests: _snapshotWorkerRequests.size,
  };
}

export function flushProjectSnapshotPersistsAtExitForTests(): void {
  if (_snapshotExitHookRegistered) process.off("exit", flushSnapshotPersistsAtExit);
  flushSnapshotPersistsAtExit();
}

export function resetProjectSnapshotPersistWorkerForTests(): void {
  _snapshotWorkerDisabled = false;
  _snapshotGenerationGateEnabledForTests = true;
  _snapshotPromotionSeamForTests = undefined;
  _snapshotWorkerRequests.clear();
  settleSnapshotPersistQueue();
  _snapshotGenerations.clear();
  _lastSnapshotPersistErrorForTests = undefined;
}

export function setProjectSnapshotGenerationGateForTests(enabled: boolean): void {
  _snapshotGenerationGateEnabledForTests = enabled;
}

export function setProjectSnapshotPromotionSeamForTests(
  seam: (() => Promise<void>) | undefined,
): void {
  _snapshotPromotionSeamForTests = seam;
}

export function getProjectSnapshotPersistErrorForTests(): string | undefined {
  return _lastSnapshotPersistErrorForTests;
}

export function buildProjectSnapshotFromRuntime(args: {
  cwd: string;
  runtime: RuntimeCoordinator;
  startupScan?: StartupScanContext;
  languageProfile?: ProjectLanguageProfile;
  conventions?: ProjectConventions;
}): ProjectSnapshot {
  return {
    version: PROJECT_SNAPSHOT_VERSION,
    projectRoot: normalizeMapKey(path.resolve(args.cwd)),
    generatedAt: new Date().toISOString(),
    seq: args.runtime.projectSeq,
    files: {},
    symbols: {},
    reverseDeps: {},
    cachedExports: [...args.runtime.cachedExports.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    ),
    sequenceIndex: {
      projectSeq: args.runtime.projectSeq,
      fileSeqByPath: args.runtime.getFileSeqEntries(),
    },
    wordIndex: args.runtime.wordIndex ? serializeWordIndex(args.runtime.wordIndex) : undefined,
    projectRulesScan: args.runtime.projectRulesScan,
    startupScan: args.startupScan,
    languageProfile: args.languageProfile,
    conventions: args.conventions,
  };
}

export function hydrateRuntimeFromProjectSnapshot(
  runtime: RuntimeCoordinator,
  snapshot: ProjectSnapshot,
): void {
  runtime.cachedExports.clear();
  for (const [name, filePath] of snapshot.cachedExports) {
    runtime.cachedExports.set(name, filePath);
  }
  if (snapshot.projectRulesScan) {
    runtime.projectRulesScan = snapshot.projectRulesScan;
  }
  runtime.wordIndex = deserializeWordIndex(snapshot.wordIndex);
}

export function saveRuntimeProjectSnapshot(args: {
  cwd: string;
  runtime: RuntimeCoordinator;
  startupScan?: StartupScanContext;
  languageProfile?: ProjectLanguageProfile;
  conventions?: ProjectConventions;
  dbg?: (msg: string) => void;
}): void {
  try {
    if (!isFiniteNumber(args.runtime.projectSeq)) return;
    const existing = loadProjectSnapshot(args.cwd);
    let conventions = args.conventions ?? existing?.conventions;
    if (!conventions) {
      try {
        conventions = detectProjectConventions(args.cwd);
      } catch (err) {
        args.dbg?.(`project_snapshot: convention detection failed: ${err}`);
      }
    }
    const snapshot = buildProjectSnapshotFromRuntime({
      ...args,
      startupScan: args.startupScan ?? existing?.startupScan,
      languageProfile: args.languageProfile ?? existing?.languageProfile,
      conventions,
    });
    if (existing) {
      snapshot.files = existing.files ?? {};
      snapshot.symbols = existing.symbols ?? {};
      snapshot.reverseDeps = existing.reverseDeps ?? {};
      if (!snapshot.wordIndex && existing.wordIndex && existing.seq === snapshot.seq) {
        snapshot.wordIndex = existing.wordIndex;
      }
    }
    saveProjectSnapshot(args.cwd, snapshot);
    args.dbg?.(
      `project_snapshot: saved seq=${snapshot.seq} exports=${snapshot.cachedExports.length}`,
    );
  } catch (err) {
    args.dbg?.(`project_snapshot: save failed: ${err}`);
  }
}
