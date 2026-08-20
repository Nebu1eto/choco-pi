import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.js";
import { writeFileAtomic } from "../atomic-write.js";
import { readJsonCache } from "../json-cache-read.js";
import { createGenerationMap } from "../generation-guard.js";
import { normalizeMapKey } from "../path-utils.js";
import { loadReverseDependencyIndexFromSnapshot } from "../reverse-deps.js";
import { MTIME_DRIFT_TOLERANCE_MS } from "../blocker-freshness.js";
import type { LSPDiagnostic } from "./client.js";
import {
	createDiskBindingCache,
	type DiagnosticBinding,
} from "./diagnostic-binding.js";

/**
 * #671: per-file cache of the last CONFIRMED `runWorkspaceDiagnostics` sweep
 * result, so a repeat `lens_diagnostics mode=full` with no intervening edits
 * doesn't re-touch every file through the language server(s) again. Mirrors
 * `clients/project-diagnostics/cache.ts`'s load/save + mtime-staleness shape
 * (same `getProjectDataDir`-rooted `cache/` path, same version-guard +
 * fail-open-on-corrupt read), but keyed PER FILE with its own scan timestamp
 * rather than one global `scannedAt` — a workspace sweep can span many
 * seconds/minutes across thousands of files, each finishing at a different
 * time, so a single project-wide timestamp would either understate or
 * overstate every individual file's real staleness window.
 *
 * NEVER persist an inconclusive/timed-out `touchFile` result here — an
 * unconfirmed result read back as "cached clean" on a later sweep is exactly
 * the false-clean bug class #571/#630 already fixed for the live path; a
 * caching layer must not reintroduce that failure shape via a second
 * mechanism. Callers must only pass CONFIRMED results (see
 * `LSPWorkspaceDiagnosticResult.timedOut` in `./index.ts`) into
 * `WorkspaceDiagnosticsCacheEntry`.
 */
// v2 (#1095): entries may carry an optional `contentHash` fingerprint of the
// file bytes the cached diagnostics were computed against, so a `lookup` can
// surface a content `binding` (boundToCurrentDisk) beyond the mtime proxy.
// Legacy v1 entries are rejected by the version guard and re-scanned — a
// deliberately clean break so no entry lacking the field is ever served.
export const WORKSPACE_DIAGNOSTICS_CACHE_VERSION = 2;
const CACHE_FILE = "lsp-workspace-diagnostics.json";

export interface WorkspaceDiagnosticsCacheEntry {
	diagnostics: LSPDiagnostic[];
	count: number;
	/** The file's own mtime (ms since epoch) at the moment it was scanned. */
	mtimeMs: number;
	/**
	 * Wall-clock time (ms since epoch) this entry was written. The
	 * dependency-staleness check in `isEntryFresh` compares each import's
	 * CURRENT mtime against THIS timestamp, not against `mtimeMs` — a file's
	 * own bytes can be completely untouched while a dependency it imports
	 * changed after this entry was recorded (e.g. a callee's exported
	 * signature changed, breaking this file's call site with zero edits to
	 * this file itself).
	 */
	scannedAt: number;
	/**
	 * Fingerprint of what was actually asked for/covered when this entry was
	 * produced (see `buildScopeKey`) — e.g. `runWorkspaceDiagnostics` touches
	 * `clientScope: "all"` but excludes opengrep (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`,
	 * #584 — a separate CLI extractor covers it for that sweep), while
	 * `lsp_diagnostics`' batch/directory scan (`tools/lsp-diagnostics.ts`)
	 * touches with no exclusions and supports a `"primary"`-only scope. An
	 * entry produced under one scope must never be served to a lookup under a
	 * DIFFERENT scope — that would either silently drop diagnostics the
	 * caller asked for (entry missing a server the caller wants) or return
	 * extras the caller deliberately excluded (double-counting against a
	 * separately-run extractor). Both call sites share this one cache store
	 * (so a file swept by either tool benefits the other's NEXT sweep under
	 * the SAME scope), but only ever cross-serve entries recorded under an
	 * identical scope.
	 */
	scopeKey: string;
	/**
	 * #1095: sha256 of the file bytes (raw UTF-8) the cached diagnostics were
	 * computed against, when the recording call had the content in hand. Lets
	 * `lookup` surface a content `binding` — catching the case where a file's
	 * bytes changed but its mtime did not (the exact-mtime freshness gate would
	 * still consider such an entry fresh). Absent when the recorder had no
	 * content (e.g. the workspace pull sweep) → binding "unknown".
	 */
	contentHash?: string;
}

export interface WorkspaceDiagnosticsCache {
	version: number;
	entries: Record<string, WorkspaceDiagnosticsCacheEntry>;
}

function cachePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", CACHE_FILE);
}

// #1669 (review round): every cwd that has ever backed a
// `createWorkspaceDiagnosticsCacheContext` call in this process — the ONLY
// reliable record of which on-disk cache(s) are actually live. A
// `workspace/diagnostic/refresh` reaches us at the per-LSP-client layer
// (`client.ts`), which knows its own `state.root` — a per-SERVER identity
// root that `resolveServerRoot` (`index.ts`) routinely nests BELOW the real
// sweep cwd for a monorepo/multi-root project's nested-boundary-marker
// subproject — but has no way to know which cwd(s) `runWorkspaceDiagnostics`/
// `tools/lsp-diagnostics.ts` actually swept under. Clearing at `state.root`
// would miss the real cache file entirely and write a stray empty one at a
// fabricated path. Recording every real cwd here, at the one funnel both
// callers already share, lets a refresh invalidate every cache that could
// legitimately be affected without threading cwd knowledge into client.ts.
// Bounded defensively: a session touching more than this many distinct sweep
// roots is already pathological, and dropping new entries past the cap is
// safe (a "not yet registered" cwd's cache was never able to receive a
// pre-refresh entry in the first place).
//
// Known residual (#1707): a monorepo subproject this process has NOT swept
// yet, under a cwd DIFFERENT from `state.root`, is reachable by neither this
// registry nor the `state.root` fallback the refresh handler also applies
// (`client.ts`) — a refresh arriving before that subproject's first sweep
// clears nothing for it. Filed rather than silently claimed as solved; the
// real fix needs `LSPService` to tell a client its actual sweep cwd(s), not
// just its per-server root.
const MAX_REGISTERED_CWDS = 64;
const _registeredCwds = new Set<string>();

/** Drop every cache this process has ever swept under. Best-effort, matching
 *  `clearWorkspaceDiagnosticsCache`'s own fail-open posture. See the
 *  `_registeredCwds` doc comment above for the #1707 residual this does not
 *  cover. */
export function clearAllWorkspaceDiagnosticsCaches(): void {
	for (const cwd of _registeredCwds) {
		clearWorkspaceDiagnosticsCache(cwd);
	}
}

// #1669 (review round): per-cwd epoch, mirroring
// `clients/review-graph/builder.ts`'s workspace-cache epoch shape — AGENTS.md's
// canonical pattern for "a durable commit followed by an out-of-guard mirror
// refresh" (shape 12). A sweep's `createWorkspaceDiagnosticsCacheContext` loads
// the file ONCE and `persist()` blind-overwrites the whole map at the end; a
// refresh landing mid-sweep would otherwise be UNDONE the moment that sweep's
// own (now-stale) in-memory copy is written back. Capture the epoch at
// context-creation (read) time; refuse to publish if it advanced before
// `persist()` (write) time — the clear wins, and the next sweep starts clean.
// Per N4, `lookup()` also checks it on every call, so an in-flight sweep
// stops serving pre-refresh entries the moment its OWN epoch goes stale, not
// only at `persist()` time.
//
// #1669 review R2: this map is IN-MEMORY ONLY, deliberately — a round-3
// attempt to also persist it inside the cache file (a `generation` field)
// was reverted here: nothing actually READ that field to invalidate entries
// on load, so it was inert machinery (verified by the round-4 review:
// replacing the disk read with a constant left every test green). A cwd
// this process has never opened a context for — most concretely a monorepo
// subproject a sweep hasn't reached yet — still has no epoch here at all;
// see the `state.root` fallback's doc comment on `clearWorkspaceDiagnosticsCache`
// below and #1707 for that residual gap, tracked rather than silently
// claimed as solved.
//
// #1754: the per-cwd epochs are the shared `GenerationMap` primitive rather
// than a hand-rolled Map, so the capture-before-load/check-before-write shape
// here is the same code the dispatch-availability guards run, and a dropped
// write is visible in the degradation ledger instead of silent.
//
// Two properties this file relies on, both documented on the primitive:
//
// - The map issues stamps from ONE monotonic ticket counter, so a cwd dropped
//   at the retained-key bound reads 0 — a stamp no live handle holds — and its
//   outstanding contexts report stale. Fail-closed, which for this cache means
//   "recompute", the same outcome a real refresh produces. The pre-#1754 map
//   was unbounded; the bound is new and costs at most one extra sweep for a
//   cwd that fell off the end.
// - `normalizeMapKey` runs `realpathSync.native` on Windows. A handle re-runs
//   it only after the map has been invalidated, so an uninterrupted sweep pays
//   that syscall once at context creation rather than once per `lookup()`, and
//   an interrupted one pays it per check to stay correct if the cwd's realpath
//   answer moved.
const _cacheEpochs = createGenerationMap("workspace-diagnostics-cache", {
	normalizeKey: normalizeMapKey,
});

/** Fail-safe on any read/parse/shape problem: return `undefined` so the
 * caller treats a stale/missing/corrupt cache as "nothing cached" — every
 * file then falls through to a fresh touch, same fail-open posture as
 * `loadProjectDiagnosticsSnapshot`. */
export function loadWorkspaceDiagnosticsCache(
	cwd: string,
): WorkspaceDiagnosticsCache | undefined {
	return readJsonCache<WorkspaceDiagnosticsCache>(cachePath(cwd), (parsed) => {
		if (!parsed || typeof parsed !== "object") return undefined;
		const cache = parsed as WorkspaceDiagnosticsCache;
		if (cache.version !== WORKSPACE_DIAGNOSTICS_CACHE_VERSION) return undefined;
		if (!cache.entries || typeof cache.entries !== "object") return undefined;
		return cache;
	});
}

export function saveWorkspaceDiagnosticsCache(
	cwd: string,
	cache: WorkspaceDiagnosticsCache,
): void {
	const filePath = cachePath(cwd);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// bestEffort: false — persist()'s catch is the error policy here, and it
	// must observe the failure so `dirty` stays set and the next sweep retries.
	writeFileAtomic(filePath, JSON.stringify(cache, null, 2), {
		bestEffort: false,
	});
}

/**
 * Drop every entry from the persisted cache so the next sweep from either
 * call site (`runWorkspaceDiagnostics` or `tools/lsp-diagnostics.ts`) pays for
 * a fresh pull instead of replaying entries the server just told us to
 * distrust. Used by the `workspace/diagnostic/refresh` handler (#1669) — a
 * server-initiated signal (typically a project-wide config change) that
 * everything it has already reported may be stale, so this on-disk cache must
 * not survive it either.
 *
 * Best-effort, matching `persist()`'s fail-open policy: a write failure just
 * means the next sweep may reuse stale entries once more, never worth
 * crashing the caller (a live LSP request handler) over.
 */
export function clearWorkspaceDiagnosticsCache(cwd: string): void {
	const root = path.resolve(cwd);
	// Bump FIRST: any sweep context already loaded (whose own `persist()`
	// hasn't run yet) must observe an epoch mismatch regardless of exactly
	// when its write lands relative to this clear.
	_cacheEpochs.bump(root);
	try {
		saveWorkspaceDiagnosticsCache(root, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {},
		});
	} catch {
		// best-effort — see doc comment above.
	}
}

/**
 * True when `filePath`'s cached entry is still trustworthy enough to reuse
 * instead of paying for a fresh `touchFile`.
 *
 * Two invalidation layers:
 * 1. The file's OWN mtime must be unchanged since it was scanned (exact
 *    match against `entry.mtimeMs`) — any drift, or a stat failure
 *    (deleted/unreadable), invalidates.
 * 2. When a reverse-dependency index is available (`getImports` returns an
 *    array rather than `undefined`), every file THIS file imports must not
 *    have changed after `entry.scannedAt` either — this is the fix for the
 *    cross-file blind spot plain mtime-checking has: a TypeScript diagnostic
 *    on file A can change purely because a dependency B's exported shape
 *    changed, with zero edits to A's own bytes/mtime.
 *
 * `getImports` returning `undefined` means "no dependency graph available
 * for this project this session" (e.g. no cascade/session-start has built
 * `clients/reverse-deps.ts`'s persisted index yet). That is a real, expected
 * state (a cold session, or a project where the cascade path hasn't run) —
 * we fail OPEN per-file to mtime-only invalidation in that case rather than
 * refusing to use the cache at all, matching the same blind spot the
 * cheap-tier `project-diagnostics.json` cache already accepts today. Once a
 * reverse-deps index IS available, this function upgrades to using it
 * automatically — no separate cache format/version needed.
 *
 * #1708 sweep: the dependency check below compares a captured `scannedAt`
 * against each dependency's mtime, the same shape `findingPathFreshness`
 * under-tolerated. `MTIME_DRIFT_TOLERANCE_MS` (`blocker-freshness.ts`) keeps
 * it from over-invalidating on the same host mtime-vs-`Date.now()` skew
 * (#1491/#1498) rather than just a redundant re-touch.
 */
export function isEntryFresh(
	filePath: string,
	entry: WorkspaceDiagnosticsCacheEntry,
	getImports: (filePath: string) => string[] | undefined,
): boolean {
	let ownMtime: number;
	try {
		ownMtime = fs.statSync(filePath).mtimeMs;
	} catch {
		return false; // deleted / unreadable
	}
	if (ownMtime !== entry.mtimeMs) return false;

	const imports = getImports(filePath);
	if (imports === undefined) return true; // no dep graph this session: mtime-only
	for (const dep of imports) {
		try {
			if (fs.statSync(dep).mtimeMs > entry.scannedAt + MTIME_DRIFT_TOLERANCE_MS) {
				return false;
			}
		} catch {
			return false; // dependency deleted/unreadable: fail closed
		}
	}
	return true;
}

/** Cache-map key helper — every read/write of `WorkspaceDiagnosticsCache.entries`
 * must go through this so `/`↔`\` and casing differences (#210's read-guard
 * bug class) can never produce a false cache miss OR a false cache hit. */
export function cacheKeyFor(filePath: string): string {
	return normalizeMapKey(filePath);
}

/**
 * Fingerprint identifying "what a touch actually covered" — see the
 * `scopeKey` doc on `WorkspaceDiagnosticsCacheEntry`. Both sweep call sites
 * (`runWorkspaceDiagnostics` and `tools/lsp-diagnostics.ts`'s batch/directory
 * scan) build this from the same two inputs (`touchFile`'s `clientScope` and
 * `excludeServerIds`) so an entry is only ever reused where its coverage is
 * IDENTICAL to what the new lookup is asking for.
 */
export function buildScopeKey(
	clientScope: "all" | "primary",
	excludeServerIds?: readonly string[],
): string {
	const excluded = excludeServerIds
		? [...excludeServerIds].sort((a, b) => a.localeCompare(b))
		: [];
	return `${clientScope}|${excluded.join(",")}`;
}

export interface WorkspaceDiagnosticsCacheLookup {
	diagnostics: LSPDiagnostic[];
	count: number;
	/**
	 * #1095: content binding of the cached entry — {version?, contentHash?,
	 * boundToCurrentDisk}. `boundToCurrentDisk` is verified lazily against
	 * current disk bytes: `false` when the recorded `contentHash` no longer
	 * matches disk (bytes changed without an mtime bump the freshness gate would
	 * catch), `"unknown"` when the entry has no `contentHash` (recorder had no
	 * content) or disk is unreadable. `version` is always absent here — the
	 * persisted cache binds by content fingerprint, not LSP document version.
	 */
	binding: DiagnosticBinding;
	/**
	 * Wall-clock time (ms) the cached diagnostics were originally scanned
	 * (`entry.scannedAt`). A cache HIT is a replay of an OLD observation, not a
	 * fresh one — callers reconciling this back into the footer widget must
	 * stamp `touchedAt` with THIS value, never `Date.now()`, or a repeat check
	 * that merely re-serves the cache would permanently disarm the widget's
	 * mtime-staleness gate (#1093 / #1092).
	 */
	scannedAt: number;
}

/**
 * Shared read/write handle over ONE project's workspace-diagnostics cache,
 * used by both `LSPService.runWorkspaceDiagnostics` and
 * `tools/lsp-diagnostics.ts`'s batch/directory sweep (`mapWithConcurrency`)
 * so a file swept by either tool can benefit the other's next sweep under
 * the same `scopeKey`, instead of each keeping (or worse, hand-duplicating)
 * its own cache.
 *
 * Loads the on-disk cache and the project's persisted reverse-dependency
 * index (if any — see `isEntryFresh`'s fail-open behavior when it's absent)
 * exactly ONCE per call site per sweep; `record` only mutates an in-memory
 * copy, and nothing is written back to disk until `persist()` is called
 * (typically once, after the sweep's per-file loop — including a
 * cancelled/partial one, so already-completed files' fresh results aren't
 * thrown away).
 */
export interface WorkspaceDiagnosticsCacheContext {
	/** Fresh cached result for `filePath` under `scopeKey`, or `undefined`
	 * when there's no entry, the entry's scope doesn't match, or it fails the
	 * mtime/dependency freshness check. */
	lookup(
		filePath: string,
		scopeKey: string,
	): WorkspaceDiagnosticsCacheLookup | undefined;
	/**
	 * Record a CONFIRMED fresh result. NEVER call this with an
	 * inconclusive/timed-out/errored touch result — see the module doc
	 * comment. `mtimeMs` must be the file's mtime at (or as close as
	 * practical to) the moment it was actually scanned.
	 */
	record(
		filePath: string,
		scopeKey: string,
		diagnostics: LSPDiagnostic[],
		mtimeMs: number,
		/** #1095: sha256 of the raw-UTF-8 file bytes the diagnostics were computed
		 *  against, when the caller had content in hand. Omit when unavailable —
		 *  the entry's binding then reads "unknown". */
		contentHash?: string,
	): void;
	/** Best-effort disk write of everything recorded so far. Swallows any
	 * write failure — a failed cache write should never fail the sweep that
	 * produced the data. Safe to call more than once (subsequent calls are a
	 * cheap no-op once nothing new has been recorded). */
	persist(): void;
}

export function createWorkspaceDiagnosticsCacheContext(
	cwd: string,
): WorkspaceDiagnosticsCacheContext {
	const root = path.resolve(cwd);
	if (_registeredCwds.size < MAX_REGISTERED_CWDS || _registeredCwds.has(root)) {
		_registeredCwds.add(root);
	}
	// #1669: captured at load time — see the epoch doc comment above.
	const epoch = _cacheEpochs.capture(root);
	const existing = loadWorkspaceDiagnosticsCache(root);
	const entries: Record<string, WorkspaceDiagnosticsCacheEntry> = {
		...(existing?.entries ?? {}),
	};
	const reverseDepsIndex = loadReverseDependencyIndexFromSnapshot({
		cwd: root,
	});
	const getImports = (filePath: string): string[] | undefined => {
		if (!reverseDepsIndex) return undefined;
		return reverseDepsIndex.imports[cacheKeyFor(filePath)] ?? [];
	};
	// #1095: per-sweep disk-fingerprint memo (per file+mtime) for binding verify.
	const diskBindingCache = createDiskBindingCache();
	let dirty = false;

	return {
		lookup(filePath, scopeKey) {
			// #1669 review N4: the epoch guarded `persist()` but not `lookup()` —
			// an in-flight sweep kept REPLAYING disowned entries into its OWN
			// served results for the rest of its run even though the on-disk
			// cache was already correctly cleared (disk stayed clean, but the
			// user still saw stale results for the remainder of THIS sweep).
			// Check on every call, not just at load time: a refresh landing
			// mid-sweep must stop lookups from serving pre-refresh entries
			// immediately, not only prevent them from being written back.
			// `cacheEpoch` is in-memory only (see its doc comment) — this runs
			// per file, and a same-process clear always updates memory
			// synchronously, so this needs no disk read to be authoritative.
			if (!epoch.isCurrent()) return undefined;
			const entry = entries[cacheKeyFor(filePath)];
			if (!entry || entry.scopeKey !== scopeKey) return undefined;
			if (!isEntryFresh(filePath, entry, getImports)) return undefined;
			return {
				diagnostics: entry.diagnostics,
				count: entry.count,
				binding: {
					contentHash: entry.contentHash,
					boundToCurrentDisk: diskBindingCache.boundToCurrentDisk(filePath, {
						contentHash: entry.contentHash,
					}),
				},
				scannedAt: entry.scannedAt,
			};
		},
		record(filePath, scopeKey, diagnostics, mtimeMs, contentHash) {
			entries[cacheKeyFor(filePath)] = {
				diagnostics,
				count: diagnostics.length,
				mtimeMs,
				scannedAt: Date.now(),
				scopeKey,
				...(contentHash !== undefined && { contentHash }),
			};
			dirty = true;
		},
		persist() {
			if (!dirty) return;
			// #1669: a refresh invalidated this cwd's cache after we loaded it —
			// publishing this sweep's (now-stale-relative-to-the-refresh) in-memory
			// copy would resurrect exactly what the refresh cleared. Drop the
			// write; the next sweep loads clean and recomputes.
			const published = epoch.guardedWrite(root, () => {
				try {
					saveWorkspaceDiagnosticsCache(root, {
						version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
						entries,
					});
					return true;
				} catch {
					// Best-effort: a failed cache write just means the next sweep pays
					// the full cost again — never worth failing the sweep itself over.
					return false;
				}
			});
			// `undefined` means the guard dropped the write as stale: this
			// in-memory copy is worthless, so stop advertising it as pending.
			// `false` means the write itself failed, so `dirty` stays set and the
			// next sweep retries. Same three outcomes as the pre-#1754 guard.
			if (published !== false) dirty = false;
		},
	};
}
