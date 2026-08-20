import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "./atomic-write.js";
import { getProjectDataDir } from "./file-utils.js";
import { readJsonCache } from "./json-cache-read.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import type {
	ProjectSnapshotPersistWorkerRequest,
	ProjectSnapshotPersistWorkerResult,
} from "./project-snapshot-persist-worker.js";
import type { ProjectLanguageProfile } from "./language-policy.js";
import {
	detectProjectConventions,
	type ProjectConventions,
} from "./project-conventions.js";
import type { RuleScanResult } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { StartupScanContext } from "./startup-scan.js";
import {
	deserializeWordIndex,
	serializeWordIndex,
	type SerializedWordIndex,
} from "./word-index.js";

// v2: added `wordIndex` (identifier inverted index + BM25, #162). Bumping the
// version invalidates pre-v2 snapshots so they rebuild with the new field.
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

/**
 * The derived project-changes sequence index as of `ProjectSnapshot.seq`
 * (#1019). Persisting it lets session-start BOUND the change-log replay: hydrate
 * this (O(files)) then fold only entries with `seq > snapshot.seq`
 * (O(changes-since-snapshot)) instead of replaying the entire append-only log.
 * `projectSeq` is invariably `=== snapshot.seq` (both come from the same
 * `runtime.projectSeq` moment); `fileSeqByPath` uses the same
 * `normalizeMapKey(path.resolve())` keys as the change-log replay, so no
 * re-normalization (and no per-key `realpath` syscall) is needed on hydrate.
 */
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

function parseSequenceIndex(value: unknown): SnapshotSequenceIndex | undefined {
	if (!value || typeof value !== "object") return undefined;
	const index = value as Partial<SnapshotSequenceIndex>;
	if (typeof index.projectSeq !== "number") return undefined;
	if (!Array.isArray(index.fileSeqByPath)) return undefined;
	const fileSeqByPath = index.fileSeqByPath.filter(
		(entry): entry is [string, number] =>
			Array.isArray(entry) &&
			typeof entry[0] === "string" &&
			typeof entry[1] === "number",
	);
	return { projectSeq: index.projectSeq, fileSeqByPath };
}

// #958 item 2: the canonical snapshot body is now streamed gzip
// (`project-snapshot.json.gz`), written by a worker thread off the save path
// (see the persist plumbing below). The previous uncompressed
// `project-snapshot.json` remains readable for ONE compatibility release so an
// upgrading user doesn't lose their snapshot — see loadSnapshotBody's legacy
// fallback. gzip measured 5-10x on top of the #957 compaction win (the
// review-graph's own measurement was 60MB → 1.4MB).
export function getProjectSnapshotPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json.gz");
}

/**
 * Pre-#958 uncompressed body path. Read as a one-release fallback when no
 * `.json.gz` is present; deleted whenever a fresh gz body is promoted so the
 * two never coexist.
 */
export function getProjectSnapshotLegacyPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json");
}

export function getProjectSnapshotMetaPath(cwd: string): string {
	return path.join(
		getProjectDataDir(cwd),
		"cache",
		"project-snapshot.meta.json",
	);
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

function parseSnapshot(value: unknown): ProjectSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const snapshot = value as Partial<ProjectSnapshot>;
	if (snapshot.version !== PROJECT_SNAPSHOT_VERSION) return null;
	if (typeof snapshot.projectRoot !== "string") return null;
	if (typeof snapshot.generatedAt !== "string") return null;
	if (typeof snapshot.seq !== "number") return null;
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
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				typeof entry[1] === "string",
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
	/**
	 * The derived sequence index as of `seq` (#1019), MIRRORED here from the
	 * snapshot body so session-start can bound the change-log replay WITHOUT
	 * parsing the (40-112MB) body — which would forfeit the #947 skip-stale
	 * optimization. Absent on legacy metas (pre-#1019) → callers full-replay.
	 */
	sequenceIndex?: SnapshotSequenceIndex;
}

function parseSnapshotMeta(value: unknown): ProjectSnapshotMeta | null {
	if (!value || typeof value !== "object") return null;
	const meta = value as Partial<ProjectSnapshotMeta>;
	if (typeof meta.version !== "number") return null;
	if (typeof meta.seq !== "number") return null;
	return {
		timestamp: typeof meta.timestamp === "string" ? meta.timestamp : "",
		version: meta.version,
		seq: meta.seq,
		sequenceIndex: parseSequenceIndex(meta.sequenceIndex),
	};
}

/**
 * Read the tiny meta sidecar (`project-snapshot.meta.json`) WITHOUT parsing
 * the (potentially 40-112MB) snapshot body. Written on every save; absent on
 * legacy installs — callers must treat a `null` return as "no opinion" and
 * fall through to parsing the body. #947.
 */
export function readProjectSnapshotMeta(
	cwd: string,
): ProjectSnapshotMeta | null {
	const meta = readJsonCache<ProjectSnapshotMeta>(
		getProjectSnapshotMetaPath(cwd),
		(parsed) => parseSnapshotMeta(parsed) ?? undefined,
	);
	return meta ?? null;
}

/**
 * Cheap staleness verdict from the meta sidecar alone. When this returns
 * true, the snapshot body CANNOT be fresh (isProjectSnapshotFresh would
 * reject it on the same two fields), so the expensive body parse can be
 * skipped entirely. #947.
 */
export function isProjectSnapshotMetaStale(
	meta: ProjectSnapshotMeta,
	currentProjectSeq: number,
): boolean {
	return (
		meta.version !== PROJECT_SNAPSHOT_VERSION || meta.seq !== currentProjectSeq
	);
}

/**
 * In-process parse cache for the snapshot body, keyed by file path and
 * validated by mtime+size. The body is large (40-112MB observed) and several
 * session-start/background consumers parse it seconds after we ourselves
 * wrote it — `saveRuntimeProjectSnapshot` alone re-parsed the file it had
 * just written 2-3x per session (~300-600ms of event-loop blocks). A hit
 * returns the already-parsed object; any external write changes the mtime
 * and forces a re-parse. #947. This tier serves READER processes (module_report,
 * mcp/analyze) that never write; the writer process's read-your-writes is
 * served by the authoritative map below.
 */
interface SnapshotParseCacheEntry {
	mtimeMs: number;
	/**
	 * On-disk file size in bytes at cache time. FAT/exFAT round `mtime` to a 2s
	 * bucket, so two writes inside the same bucket can report an IDENTICAL
	 * `mtimeMs` even though the body changed — mtime alone would then serve a
	 * stale cached parse for a file that was, in fact, just rewritten. `size`
	 * is a free, defensive tiebreaker: a same-bucket rewrite that also keeps
	 * the exact same byte length still slips through, but that residual case is
	 * the same fail-open/self-healing posture as the rest of this cache. NOTE
	 * (#958): for the gz body this is the COMPRESSED file size; the
	 * cache-eligibility gate below uses the UNCOMPRESSED byte length instead,
	 * because that is what actually bounds resident heap.
	 */
	size: number;
	snapshot: ProjectSnapshot | null;
}
const SNAPSHOT_PARSE_CACHE_MAX = 4;
// #957 review: the cache exists to avoid re-parsing NORMAL snapshots within a
// session. A 112MB-class body parses to hundreds of MB of heap — pinning that
// for process lifetime inverts the win, so oversized bodies are simply never
// cached (they re-parse per read, exactly the pre-#947 behavior). Measured
// against the UNCOMPRESSED body size, never the (much smaller) gz file size.
const SNAPSHOT_PARSE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const snapshotParseCache = new Map<string, SnapshotParseCacheEntry>();

function withoutWordIndex(snapshot: ProjectSnapshot | null): ProjectSnapshot | null {
	if (!snapshot?.wordIndex) return snapshot;
	const { wordIndex: _releasedPostings, ...stripped } = snapshot;
	return stripped;
}

function cacheParsedSnapshot(
	snapshotPath: string,
	entry: SnapshotParseCacheEntry,
): void {
	// Refresh recency (Map preserves insertion order).
	snapshotParseCache.delete(snapshotPath);
	snapshotParseCache.set(snapshotPath, entry);
	while (snapshotParseCache.size > SNAPSHOT_PARSE_CACHE_MAX) {
		const oldest = snapshotParseCache.keys().next().value;
		if (oldest === undefined) break;
		snapshotParseCache.delete(oldest);
	}
}

/**
 * Authoritative in-process "latest write" for a snapshot, keyed by canonical
 * cwd (#958 item 2). The body is now written by a worker thread AFTER
 * `saveProjectSnapshot` returns, so between a save and the worker's promotion
 * the on-disk gz still holds the PREVIOUS generation. Reading disk in that
 * window would serve stale data to the merge-write callers
 * (`saveRuntimeProjectSnapshot`, word-index, reverse-deps) that do
 * load→mutate→save and would silently drop each other's fields. Because every
 * write in a process funnels through `saveProjectSnapshot` — and each process
 * runs in its own worktree cwd, so there is effectively one writer per snapshot
 * — the in-memory object we just handed the worker IS the authoritative truth
 * for this process. `loadProjectSnapshot` consults it first and only falls
 * through to disk when the on-disk file has an mtime STRICTLY NEWER than the
 * one we last observed for our own write (an external writer we should honor).
 */
interface AuthoritativeSnapshotEntry {
	snapshot: ProjectSnapshot;
	/**
	 * The mtime of the body file as we last wrote/observed it. Set to the
	 * pre-write file's mtime at save time (or -Infinity when no file exists
	 * yet), then updated to the promoted file's mtime once the worker (or the
	 * sync fallback) lands the write. Load prefers this entry while the on-disk
	 * mtime is `<=` this value.
	 */
	knownMtime: number;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}
const authoritativeSnapshots = new Map<string, AuthoritativeSnapshotEntry>();
const PROJECT_SNAPSHOT_MAX_WARM_ROOTS = 8;
const PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function projectSnapshotIdleEvictMs(): number {
	const value = Number.parseInt(process.env.PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 ? value : PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT;
}

function clearAuthoritativeSnapshotTimer(entry: AuthoritativeSnapshotEntry): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
}

function deleteAuthoritativeSnapshot(key: string): void {
	const entry = authoritativeSnapshots.get(key);
	if (entry) clearAuthoritativeSnapshotTimer(entry);
	authoritativeSnapshots.delete(key);
}

function scheduleAuthoritativeSnapshotEviction(key: string, entry: AuthoritativeSnapshotEntry): void {
	clearAuthoritativeSnapshotTimer(entry);
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
		const victim = [...authoritativeSnapshots.entries()].sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
		if (!victim) return;
		clearAuthoritativeSnapshotTimer(victim[1]);
		deleteAuthoritativeSnapshot(victim[0]);
	}
}

/** Test-only cache keys, in LRU order from oldest to newest. */
export function _getAuthoritativeSnapshotCacheKeysForTests(): string[] {
	return [...authoritativeSnapshots.entries()]
		.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
		.map(([key]) => key);
}

/** Test hook: drop all cached parses + authoritative writes (per-worker isolation). */
export function _resetProjectSnapshotParseCacheForTests(): void {
	snapshotParseCache.clear();
	for (const entry of authoritativeSnapshots.values()) clearAuthoritativeSnapshotTimer(entry);
	authoritativeSnapshots.clear();
}

/** Test hook: prove the parse-cache tier never owns serialized postings. */
export function _projectSnapshotParseCacheRetainsWordIndexForTests(): boolean {
	return [...snapshotParseCache.values()].some(
		(entry) => entry.snapshot?.wordIndex !== undefined,
	);
}

/** Resolve which body file is currently on disk: gz canonical, else legacy. */
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
	} catch {
		/* fall through to the legacy uncompressed body */
	}
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

/**
 * Read + parse the body off disk, transparently gunzipping the `.json.gz`
 * canonical form and falling back to the pre-#958 uncompressed `.json` body
 * for one compatibility release. Returns the parsed snapshot (or null on any
 * failure) plus the UNCOMPRESSED byte length, so the caller can apply the
 * heap-bounded cache gate against the real body size rather than the gz size.
 */
// Test-observable count of ACTUAL disk body reads (both gz and legacy), so the
// #947 meta-gate tests can assert "body parsed / not parsed" independently of
// the compression format — the pre-#958 tests keyed this off a readJsonCache
// spy, which the gz path (gunzip + JSON.parse) legitimately bypasses.
let _snapshotBodyReadCountForTests = 0;
export function getSnapshotBodyReadCountForTests(): number {
	return _snapshotBodyReadCountForTests;
}
export function resetSnapshotBodyReadCountForTests(): void {
	_snapshotBodyReadCountForTests = 0;
}

function readSnapshotBody(
	bodyPath: string,
	gz: boolean,
): {
	snapshot: ProjectSnapshot | null;
	rawBytes: number;
} {
	_snapshotBodyReadCountForTests++;
	if (!gz) {
		const snapshot =
			readJsonCache<ProjectSnapshot>(
				bodyPath,
				(parsed) => parseSnapshot(parsed) ?? undefined,
			) ?? null;
		let rawBytes = 0;
		try {
			rawBytes = fs.statSync(bodyPath).size;
		} catch {
			/* best-effort */
		}
		return { snapshot, rawBytes };
	}
	try {
		const json = gunzipSync(fs.readFileSync(bodyPath)).toString("utf-8");
		const snapshot = parseSnapshot(JSON.parse(json)) ?? null;
		return { snapshot, rawBytes: Buffer.byteLength(json) };
	} catch (err) {
		// Corrupt / truncated gz, or a parse failure: fail open exactly like
		// readJsonCache does — a null return rebuilds the snapshot. Log it so a
		// corrupt body is diagnosable rather than indistinguishable from "no
		// snapshot yet" (both return a null snapshot here).
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
	// Authoritative in-process write wins while our own (possibly still
	// in-flight) write has not been superseded on disk by a newer external
	// mtime. `body === null` means nothing is on disk yet — our just-scheduled
	// write is the only truth, so serve it.
	const authoritative = authoritativeSnapshots.get(key);
	if (authoritative) {
		const diskMtime = body ? body.mtimeMs : Number.NEGATIVE_INFINITY;
		if (diskMtime <= authoritative.knownMtime) {
			touchAuthoritativeSnapshot(key, authoritative);
			return authoritative.snapshot;
		}
		// An external writer moved past our write — honor disk and stop
		// serving the now-stale in-memory object.
		deleteAuthoritativeSnapshot(key);
	}
	if (!body) {
		snapshotParseCache.delete(getProjectSnapshotPath(cwd));
		return null;
	}
	const cacheKey = body.path;
	const cached = snapshotParseCache.get(cacheKey);
	// Both mtime AND size must match (see the `size` field doc on
	// SnapshotParseCacheEntry for why: coarse FAT/exFAT mtime resolution can
	// otherwise alias a just-rewritten file onto a stale cache entry).
	if (cached && cached.mtimeMs === body.mtimeMs && cached.size === body.size) {
		if (!requireWordIndex || !cached.snapshot || cached.snapshot.wordIndex) {
			return cached.snapshot;
		}
	}
	const { snapshot, rawBytes } = readSnapshotBody(body.path, body.gz);
	// Serialized postings expand into a much larger object graph. Cache only a
	// shallow postings-stripped body: metadata/report consumers stay warm while
	// the live warm WordIndex remains the sole retained postings graph (#1370).
	const cacheSnapshot = withoutWordIndex(snapshot);
	if (
		rawBytes > 0 &&
		(rawBytes <= SNAPSHOT_PARSE_CACHE_MAX_BYTES || snapshot?.wordIndex)
	) {
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

/** Load the canonical body, including serialized postings when present. */
export function loadProjectSnapshot(cwd: string): ProjectSnapshot | null {
	return loadProjectSnapshotInternal(cwd, true);
}

/**
 * Load snapshot metadata without retaining or re-reading serialized postings.
 * After publication this is served by the postings-stripped parse cache.
 */
export function loadProjectSnapshotWithoutWordIndex(
	cwd: string,
): ProjectSnapshot | null {
	return loadProjectSnapshotInternal(cwd, false);
}

// --- Worker-thread body persist (gzip off the save path, #958 item 2) --------
//
// Mirrors clients/review-graph/persist-worker.ts's parent plumbing: a monotonic
// per-cwd `generation`, a worker that stringifies+gzips a per-generation stage
// file, and generation-gated promotion (rename stage → canonical) so a slow
// write for generation N can never clobber a newer generation N+1 already on
// disk. When the worker is unavailable/dies, the pending body falls back to a
// synchronous main-thread gzip write (the degraded path only — the #950 review
// measured a naïve sync gzip as the DEFAULT save path regressing host memory by
// +656MB, which is exactly why the worker exists).

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
let _snapshotWorkerRequestId = 0;
let _snapshotWorkerDisabled = false;
let _snapshotGenerationGateEnabledForTests = true;
let _snapshotPromotionSeamForTests: (() => Promise<void>) | undefined;
let _lastSnapshotPersistErrorForTests: string | undefined;

function snapshotWorkerEnabled(): boolean {
	// The synchronous fallback writer is a legitimate degraded mode (hosts that
	// can't spawn a worker); tests also force it so a save→load is fully
	// synchronous. Production defaults to the worker.
	const raw = process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	return !(raw === "1" || raw === "true");
}

function recordSnapshotPersistFailure(cwd: string, error: string): void {
	// Honesty (#533): a failed async body write must be surfaced, never left to
	// masquerade as a saved snapshot. The meta gate is already self-healing (an
	// old body under a newer-seq meta is rejected on the body's own embedded
	// seq), and dropping the authoritative entry means the next load reflects
	// what is ACTUALLY on disk rather than the object we failed to persist.
	_lastSnapshotPersistErrorForTests = error;
	deleteAuthoritativeSnapshot(normalizeMapKey(cwd));
	logLatency({
		type: "phase",
		phase: "project_snapshot_persist_failed",
		filePath: getProjectSnapshotPath(cwd),
		durationMs: 0,
		metadata: { error },
	});
	// #1333: the logLatency call above already carries this failure to
	// latency.log — the console.error was a duplicate RAW write into pi's frame.
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

/**
 * Reconcile the authoritative in-process entry with a body that just landed on
 * disk: update its `knownMtime` so a subsequent load keeps serving our own
 * object without re-parsing, and DROP oversized bodies (their post-promotion
 * disk read is the pre-#947 behavior — we won't pin hundreds of MB of heap).
 */
function reconcileAuthoritativeAfterWrite(
	pending: PendingSnapshotBody,
	rawBytes: number,
): void {
	const entry = authoritativeSnapshots.get(pending.key);
	// Only reconcile the entry that still belongs to THIS (latest) generation —
	// a superseding save already replaced it with a newer object.
	if (!entry || entry.snapshot !== pending.snapshot) return;
	// The worker needs the serialized snapshot until promotion completes, but
	// retaining it afterward duplicates the mutable warm index's postings. A
	// shared reference is unsafe: ProjectSnapshot stores serialized arrays while
	// WordIndex owns mutable Map/PathKeyedMap state. Drop the authoritative copy
	// after publication; later merge-writers rehydrate the canonical disk body.
	if (pending.snapshot.wordIndex) {
		try {
			const stat = fs.statSync(pending.gzPath);
			cacheParsedSnapshot(pending.gzPath, {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				snapshot: withoutWordIndex(pending.snapshot),
			});
		} catch {
			// A cache miss is safe: the first metadata consumer reconstructs it.
		}
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
		// Benign but invisible otherwise: the next load will re-parse this body
		// from disk instead of serving the in-process object.
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
	} catch {
		// If we can't stat our own write, leave knownMtime as-is; the worst case
		// is one extra disk re-parse on the next load.
	}
}

function writeSnapshotBodyOnMainThread(
	pending: PendingSnapshotBody,
	reason?: string,
): void {
	if (reason) {
		// We took the synchronous main-thread gzip path (the +656MB-risk path,
		// #950) instead of the worker. Surface it rather than burying it in an
		// `offloaded:false` success line below. `degraded` distinguishes a REAL
		// degradation (worker died/unavailable/promote-failed) from the benign
		// `exit_hook` teardown flush, so an operator triaging worker health isn't
		// misled by normal process-exit flushes.
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
		recordSnapshotPersistFailure(
			pending.cwd,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * The ForTests promotion seam covers worker-message and every main-thread
 * fallback promotion. It stays sync and seam-free in production, identical to
 * calling the writer directly. The process-exit hook is deliberately the sole
 * direct write because an exit handler cannot await this asynchronous seam.
 */
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

function handleSnapshotWorkerResult(
	result: ProjectSnapshotPersistWorkerResult,
): void {
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
		dispatchMainThreadWriteThroughSeam(
			pending,
			result.error ?? "invalid worker result",
		);
		return;
	}
	// Generation gate: a newer save already superseded this one — discard the
	// stale stage file rather than promote it over the fresher body.
	if (
		_snapshotGenerationGateEnabledForTests &&
		_snapshotGenerations.get(pending.key) !== result.generation
	) {
		// The stale stage is part of the promotion transaction: remove it before
		// returning so a superseded save cannot leave an orphan behind.
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
		dispatchMainThreadWriteThroughSeam(
			pending,
			err instanceof Error ? err.message : String(err),
		);
	}
}

function handleSnapshotWorkerDeath(reason: string): void {
	_snapshotPersistWorker = undefined;
	_snapshotWorkerDisabled = true;
	const requests = [..._snapshotWorkerRequests.values()];
	_snapshotWorkerRequests.clear();
	for (const pending of requests)
		dispatchMainThreadWriteThroughSeam(pending, reason);
}

function resolveSnapshotPersistWorkerPath(): string | undefined {
	// esbuild does NOT rewrite new URL(...) asset refs, so from the bundled
	// dist/index.js a sibling ./project-snapshot-persist-worker.js resolves
	// beside the BUNDLE where nothing exists. Try the compiled-sibling layout
	// first (source checkout / unbundled dist/clients tree), then the dist-tree
	// path relative to the bundle entry — same shape as the review graph's
	// resolvePersistWorkerPath (#950 review F1).
	const candidates = [
		new URL("./project-snapshot-persist-worker.js", import.meta.url),
		new URL("./clients/project-snapshot-persist-worker.js", import.meta.url),
	];
	for (const url of candidates) {
		try {
			const resolved = fileURLToPath(url);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* try next layout */
		}
	}
	return undefined;
}

function getSnapshotPersistWorker(): Worker | undefined {
	if (_snapshotWorkerDisabled) return undefined;
	if (_snapshotPersistWorker) return _snapshotPersistWorker;
	try {
		const workerPath = resolveSnapshotPersistWorkerPath();
		if (workerPath === undefined) {
			handleSnapshotWorkerDeath(
				"persist worker script not found in any layout",
			);
			return undefined;
		}
		const worker = new Worker(workerPath);
		// The ForTests promotion seam wraps ONLY when set — the production path
		// binds the sync handler directly, so scheduling is byte-identical when
		// no test seam is installed (the async-handler variant of this shifted
		// promotion timing under full-suite load and flaked the round-trip test).
		worker.on("message", (result: ProjectSnapshotPersistWorkerResult) => {
			if (_snapshotPromotionSeamForTests) {
				void _snapshotPromotionSeamForTests().then(() =>
					handleSnapshotWorkerResult(result),
				);
				return;
			}
			handleSnapshotWorkerResult(result);
		});
		worker.on("error", (err: Error) => handleSnapshotWorkerDeath(err.message));
		worker.on("exit", (code) => {
			if (_snapshotPersistWorker === worker) _snapshotPersistWorker = undefined;
			// Any body still queued when the worker exits was abandoned mid-flight
			// (a crash, a `terminate()`, or host recycling) — it will never be
			// promoted by this worker, so fall it back to the sync writer rather
			// than let it vanish (honesty, #533). `terminate()` can report a 0
			// exit code on some platforms, so this cannot key off `code !== 0`.
			const stranded = [..._snapshotWorkerRequests.values()];
			if (stranded.length > 0) {
				_snapshotWorkerRequests.clear();
				for (const pending of stranded) {
					dispatchMainThreadWriteThroughSeam(
						pending,
						`persist worker exited with code ${code}`,
					);
				}
			}
			// Only an ABNORMAL exit disables respawning; a clean idle exit (nothing
			// stranded) just drops the reference so the next persist respawns.
			if (code !== 0) _snapshotWorkerDisabled = true;
		});
		// #1148: adding a message listener refs the Worker's public MessagePort.
		// Unref only after every listener is installed so it stays background-only.
		worker.unref();
		_snapshotPersistWorker = worker;
		return worker;
	} catch (err) {
		handleSnapshotWorkerDeath(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

// #950 review F3: a process that dies between a worker's staged write and its
// promotion leaves project-snapshot.json.gz.stage-<pid>-<gen> (and the worker's
// .tmp-<pid>) behind forever. Sweep leftovers from PRIOR processes once per
// cache dir; our own live stage files carry this pid and are skipped.
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

// Flush any in-flight worker writes synchronously at process teardown so a body
// whose worker hasn't promoted yet isn't lost. Sync writes only (no child
// spawn — the teardown libuv hazard); best-effort.
let _snapshotExitHookInstalled = false;
function ensureSnapshotPersistExitHook(): void {
	if (_snapshotExitHookInstalled) return;
	_snapshotExitHookInstalled = true;
	process.once("exit", () => {
		const requests = [..._snapshotWorkerRequests.values()];
		_snapshotWorkerRequests.clear();
		for (const pending of requests) {
			// Only the newest generation per key still matters; older ones are
			// superseded and their stage files are swept on next launch.
			if (_snapshotGenerations.get(pending.key) !== pending.generation)
				continue;
			writeSnapshotBodyOnMainThread(pending, "exit_hook");
		}
		void _snapshotPersistWorker?.terminate();
	});
}

export function saveProjectSnapshot(
	cwd: string,
	snapshot: ProjectSnapshot,
): void {
	const gzPath = getProjectSnapshotPath(cwd);
	const legacyPath = getProjectSnapshotLegacyPath(cwd);
	const metaPath = getProjectSnapshotMetaPath(cwd);
	const cacheDir = path.dirname(gzPath);
	const key = normalizeMapKey(cwd);
	fs.mkdirSync(cacheDir, { recursive: true });

	// #958: meta is written FIRST, body SECOND — the reverse of the original
	// order. A crash/failure between the two writes can now only produce
	// "meta already claims the new seq, body hasn't caught up yet" (the meta
	// races ahead). The meta-first gate (isProjectSnapshotMetaStale) reads
	// that as *fresh* and falls through to parsing the body, whose own
	// embedded `seq` is still the old one, so `isProjectSnapshotFresh`
	// correctly rejects it as stale on the body's own merits — one wasted
	// parse, self-healing, no data lost. The OLD body-then-meta order could
	// instead leave an old-seq meta sitting over a freshly written body,
	// which the meta-first gate discards WITHOUT ever reading it — throwing
	// away a genuinely fresh snapshot. That direction is not recoverable
	// until the next save, so it's the one this reorder eliminates.
	//
	// The meta write is still SYNCHRONOUS (it is tiny) and uses
	// `bestEffort: false`: if it fails, the body persist below is skipped
	// entirely — the save is simply lost this round (fail-open, caught by
	// `saveRuntimeProjectSnapshot`'s own try/catch) rather than leaving a
	// stale meta in place while the body writer stampedes ahead.
	writeFileAtomic(
		metaPath,
		JSON.stringify({
			timestamp: snapshot.generatedAt,
			version: snapshot.version,
			seq: snapshot.seq,
			// #1019: mirror the derived sequence index (kept consistent with `seq`
			// because both are stamped from the same runtime moment) so the
			// interactive path can hydrate it from the tiny sidecar. Omitted when
			// absent so a non-runtime side-write (word-index/reverse-deps) that
			// carried no index doesn't stamp an empty one.
			...(snapshot.sequenceIndex
				? { sequenceIndex: snapshot.sequenceIndex }
				: {}),
		}),
		{ bestEffort: false },
	);

	// Record the authoritative in-process write BEFORE handing the body off, so
	// a merge-read between now and the worker's promotion sees our own object
	// (the on-disk body still holds the previous generation until promotion). The
	// pre-write mtime is our baseline: while disk stays at it (or below), our
	// object wins; a promotion or an external write moves past it. Baseline off
	// the CURRENTLY-RESOLVED body — which is the legacy uncompressed
	// `project-snapshot.json` in the one-release upgrade window before the first
	// gz promotion — not gz-only: statting only gzPath there would leave the
	// baseline at -Infinity, so the load gate (which resolves the legacy body's
	// real, positive mtime) would reject our own fresh write and serve the stale
	// legacy body to a merge-consumer, silently dropping this snapshot's fields.
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
	// A stale disk-parse-cache entry for this path must not out-vote the fresh
	// authoritative write once the latter is dropped (oversized bodies).
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
	ensureSnapshotPersistExitHook();

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
	const request: ProjectSnapshotPersistWorkerRequest = {
		id,
		generation,
		stagePath,
		data: snapshot,
		testDelayMs:
			process.env.NODE_ENV === "test"
				? Number(process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS) ||
					undefined
				: undefined,
	};
	worker.postMessage(request);
}

// --- Test hooks for the worker persist path ---------------------------------

/** Test-only: wait until worker requests have either landed or degraded. */
export async function waitForProjectSnapshotPersistsForTests(): Promise<void> {
	for (
		let attempts = 0;
		attempts < 200 && _snapshotWorkerRequests.size > 0;
		attempts++
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Test-only: force any in-flight worker body write to the sync main-thread path. */
export function flushProjectSnapshotPersistsForTests(): void {
	const requests = [..._snapshotWorkerRequests.values()];
	_snapshotWorkerRequests.clear();
	for (const pending of requests) {
		if (_snapshotGenerations.get(pending.key) !== pending.generation) continue;
		dispatchMainThreadWriteThroughSeam(pending, undefined);
	}
}

/** Test-only: exercise the degraded worker-death path. */
export async function terminateProjectSnapshotPersistWorkerForTests(): Promise<void> {
	const worker = _snapshotPersistWorker;
	if (worker) await worker.terminate();
}

/** Test-only: restore worker creation + clear generation state after a deliberate death. */
export function resetProjectSnapshotPersistWorkerForTests(): void {
	_snapshotWorkerDisabled = false;
	_snapshotGenerationGateEnabledForTests = true;
	_snapshotPromotionSeamForTests = undefined;
	_snapshotPersistWorker = undefined;
	_snapshotWorkerRequests.clear();
	_snapshotGenerations.clear();
	_lastSnapshotPersistErrorForTests = undefined;
}

/** Test-only mutation switch for proving the supersession invariant. */
export function setProjectSnapshotGenerationGateForTests(
	enabled: boolean,
): void {
	_snapshotGenerationGateEnabledForTests = enabled;
}

/** Test-only seam immediately before generation-gated promotion. */
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
		// #1019: capture the runtime's live sequence index AT this seq. The runtime
		// is seeded from the change log at session start and bumped in lockstep with
		// every append, so `getFileSeqEntries()` IS the fold of the log up to
		// `projectSeq` — and its keys are already `normalizeMapKey(path.resolve())`,
		// the exact form the change-log replay produces.
		sequenceIndex: {
			projectSeq: args.runtime.projectSeq,
			fileSeqByPath: args.runtime.getFileSeqEntries(),
		},
		wordIndex: args.runtime.wordIndex
			? serializeWordIndex(args.runtime.wordIndex)
			: undefined,
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
		if (typeof args.runtime.projectSeq !== "number") return;
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
			// The word index is built by its own session task, which may not have
			// finished when another task triggers a save — keep the prior index
			// rather than clobbering it with undefined. #348: only carry it forward
			// when `existing` was built AT THIS SAME seq — otherwise a stale
			// snapshot's leftover index (already correctly rejected as stale by
			// isProjectSnapshotFresh on load, seq mismatch) would get silently
			// re-stamped with the CURRENT seq by this save, "laundering" a stale
			// index into looking fresh before the word-index task even runs.
			if (
				!snapshot.wordIndex &&
				existing.wordIndex &&
				existing.seq === snapshot.seq
			) {
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
