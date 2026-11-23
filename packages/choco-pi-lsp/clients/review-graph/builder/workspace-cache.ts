import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "../../idle-timer-release.ts";
import { KIND_EXTENSIONS } from "../../file-kinds.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import type { TreeSitterSymbolExtractor } from "../../tree-sitter-symbol-extractor.ts";
import type { ReviewGraph } from "../types.ts";
import { reviewGraphBuilderState } from "./state.ts";

export const REVIEW_GRAPH_VERSION = "v8";
export const MAIN_KINDS = new Set([
  "jsts",
  "python",
  "go",
  "rust",
  "ruby",
  "cxx",
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

export const MAIN_KIND_EXTENSIONS: string[] = Array.from(MAIN_KINDS).flatMap(
  // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
  (kind) => KIND_EXTENSIONS[kind as keyof typeof KIND_EXTENSIONS] ?? [],
);
export const REVIEW_GRAPH_SOURCE_EXTENSIONS: readonly string[] = MAIN_KIND_EXTENSIONS;
export const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
export const extractorCache = new Map<string, TreeSitterSymbolExtractor | null>();

export const _buildCache = new Map<string, Promise<ReviewGraph>>();
interface WorkspaceGraphCacheEntry {
  signature: string;
  fileSignatures: Map<string, string>;
  fileHashes?: Map<string, string>;
  graph: ReviewGraph;
  builtAtProjectSeq?: number;
  lastFullVerifyMs?: number;
  fastPathSinceVerify?: number;
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
