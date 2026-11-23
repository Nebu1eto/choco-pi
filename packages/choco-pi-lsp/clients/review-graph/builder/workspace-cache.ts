/**
 * Review-graph constants, the per-workspace warm graph cache, and its idle eviction.
 */
import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "../../idle-timer-release.ts";
import { KIND_EXTENSIONS } from "../../file-kinds.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import type { TreeSitterSymbolExtractor } from "../../tree-sitter-symbol-extractor.ts";
import type { ReviewGraph } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";

// v3 (#260): test files are no longer indexed. Bumping the version makes
// loadPersistedGraph reject any v2 snapshot (which still contains test-file
// nodes/edges) → a clean tests-free rebuild on first load after upgrade, for
// every project, without anyone deleting the cache by hand.
// v4 (#655, narrow first slice): symbol-node IDs changed shape from
// `<file>:<name>` to `<file>:<name>:<kind>:<startLine>` (see symbol-id.ts) to
// stop overloads/same-named methods/nested functions from colliding onto one
// node. A v3 snapshot's nodes/edges still use the old ID shape throughout, so
// it must be rejected rather than merged with newly-built v4 IDs — same
// safe-rebuild mechanism as the v2→v3 bump above.
// v5 (#694): import resolution now prefers a `.ts`/`.tsx`/`.mts`/`.cts` source
// twin over a compiled `.js`/`.mjs`/`.cjs` sibling (jsTsCandidatePaths), and
// node creation is gated against untracked-AND-gitignored targets (see
// git-tracked-ignore.ts). A v4 snapshot from a compile-in-place project has
// cross-file import edges materialized on the compiled artifact nodes
// throughout (up to 100% of them, per #694's measurement) — merging that with
// newly-built v5 edges would leave the graph in mixed, partially-corrected
// state. Same safe-rebuild mechanism as the v2→v3/v3→v4 bumps above.
// v6 (#703): `getProjectIgnoreMatcher` is now tracked-aware — a TRACKED file
// that merely matches a `.gitignore`/global pattern (e.g.
// `clients/test-runner-client.ts` vs. `.gitignore`'s `test-*.ts`) is no
// longer dropped from the walk. A v5 snapshot built before this fix is
// missing those nodes entirely (never walked, never parsed) and instead has
// phantom compiled-artifact nodes standing in for them (0 symbols, importer
// edges materialized on the wrong node) — merging that with newly-walked v6
// nodes would leave the phantom AND the real node coexisting. Same
// safe-rebuild mechanism as the v2→v3/v3→v4/v4→v5 bumps above.
// v7 (#939): the canonical snapshot is streamed gzip. A v7 payload in the
// legacy uncompressed filename remains readable for one compatibility release.
// v8 (#1070): call/reference evidence now records call-like vs type-only
// references and tree-sitter query coverage, so call-graph consumers cannot
// mistake incomplete extraction for a clean zero.
export const REVIEW_GRAPH_VERSION = "v8";
export const MAIN_KINDS = new Set([
  "jsts",
  "python",
  "go",
  "rust",
  "ruby",
  "cxx",
  // Languages added in #152: WASMs + symbol queries now available
  "java",
  "kotlin",
  "dart",
  "elixir",
  "csharp",
  "php",
  "swift",
  "lua",
  "ocaml",
  "zig",
  "shell",
]);

// File extensions for the kinds the graph actually ingests. Scoping the source
// walk to these means the maxGraphFiles cap counts only graph-relevant files —
// so a repo heavy in JSON/YAML/Markdown doesn't trip the cap on files the graph
// would have filtered out anyway (the cap is on the walk, not on noise). #250.
export const MAIN_KIND_EXTENSIONS: string[] = Array.from(MAIN_KINDS).flatMap(
  // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
  (kind) => KIND_EXTENSIONS[kind as keyof typeof KIND_EXTENSIONS] ?? [],
);
/** The bounded, source-filtered extension set shared by graph cache readers. */
export const REVIEW_GRAPH_SOURCE_EXTENSIONS: readonly string[] = MAIN_KIND_EXTENSIONS;
export const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
export const extractorCache = new Map<string, TreeSitterSymbolExtractor | null>();

// Per-invocation Promise cache: deduplicates concurrent buildOrUpdateGraph calls
// for the same (cwd, changedFiles). Cleared at the start of each pipeline
// invocation. A separate workspace cache below preserves the expensive parsed
// graph across invocations when source file mtimes/sizes have not changed.
export const _buildCache = new Map<string, Promise<ReviewGraph>>();
interface WorkspaceGraphCacheEntry {
  signature: string;
  fileSignatures: Map<string, string>;
  fileHashes?: Map<string, string>;
  graph: ReviewGraph;
  /**
   * The RuntimeCoordinator projectSeq at the time this entry was built (#451).
   * Only set on entries built in-process with a seqHint present. An entry
   * hydrated from the disk snapshot has none ⇒ no seq fast path for it until a
   * seq-hinted build records one.
   */
  builtAtProjectSeq?: number;
  /** Wall-clock of the last full walk+stat verify — bounds staleness vs external edits (#451). */
  lastFullVerifyMs?: number;
  /** Count of consecutive seq fast-path builds since the last full verify (#451). */
  fastPathSinceVerify?: number;
  /** #459: generation of this entry's graph content — see ReviewGraph.buildGeneration. */
  buildGeneration?: number;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}
export const _workspaceGraphCache = new Map<string, WorkspaceGraphCacheEntry>();
const REVIEW_GRAPH_MAX_WARM_WORKSPACES = 8;
const REVIEW_GRAPH_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;
export const _workspaceCacheEpochs = new Map<string, number>();

export function workspaceCacheEpoch(key: string): number {
  return reviewGraphBuilderState._workspaceCacheEpoch + (_workspaceCacheEpochs.get(key) ?? 0);
}

function reviewGraphIdleEvictMs(): number {
  const value = Number.parseInt(process.env.CHOCO_PI_LSP_REVIEW_GRAPH_IDLE_EVICT_MS ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : REVIEW_GRAPH_IDLE_EVICT_MS_DEFAULT;
}

export function clearWorkspaceGraphTimer(entry: {
  idleTimer?: ReturnType<typeof setTimeout>;
}): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

// Primary session_shutdown releases idle handles (entries stay warm; the next
// use re-arms) so a shut-down module graph is not pinned for the idle window.
registerIdleTimerRelease(() => {
  for (const entry of _workspaceGraphCache.values()) clearWorkspaceGraphTimer(entry);
});

function evictWorkspaceGraph(key: string, entry: WorkspaceGraphCacheEntry): void {
  if (_workspaceGraphCache.get(key) !== entry) return;
  clearWorkspaceGraphTimer(entry);
  for (const buildKey of _buildCache.keys()) {
    const separator = buildKey.indexOf("|");
    if (separator >= 0 && normalizeMapKey(buildKey.slice(0, separator)) === key) {
      _buildCache.delete(buildKey);
    }
  }
  _workspaceCacheEpochs.set(key, (_workspaceCacheEpochs.get(key) ?? 0) + 1);
  _workspaceGraphCache.delete(key);
}

function scheduleWorkspaceGraphEviction(key: string, entry: WorkspaceGraphCacheEntry): void {
  clearWorkspaceGraphTimer(entry);
  if (idleEvictionTimersSuspended()) return;
  const epoch = workspaceCacheEpoch(key);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (_workspaceGraphCache.get(key) !== entry || workspaceCacheEpoch(key) !== epoch) return;
    evictWorkspaceGraph(key, entry);
  }, reviewGraphIdleEvictMs());
  entry.idleTimer.unref?.();
}

export function touchWorkspaceGraph(key: string): void {
  const entry = _workspaceGraphCache.get(key);
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  scheduleWorkspaceGraphEviction(key, entry);
}

export function setWorkspaceGraph(
  key: string,
  entry: Omit<WorkspaceGraphCacheEntry, "lastUsedAt" | "idleTimer">,
  epoch?: number,
): boolean {
  if (epoch !== undefined && workspaceCacheEpoch(key) !== epoch) return false;
  const resident: WorkspaceGraphCacheEntry = { ...entry, lastUsedAt: Date.now() };
  _workspaceGraphCache.set(key, resident);
  scheduleWorkspaceGraphEviction(key, resident);
  while (_workspaceGraphCache.size > REVIEW_GRAPH_MAX_WARM_WORKSPACES) {
    const victim = [..._workspaceGraphCache.entries()].sort(
      ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
    )[0];
    if (!victim) break;
    evictWorkspaceGraph(victim[0], victim[1]);
  }
  return true;
}
