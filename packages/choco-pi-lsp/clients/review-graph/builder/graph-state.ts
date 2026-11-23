/**
 * Cached-graph lookup, empty/cloned graph construction, source signatures and signature diffs, and node/edge indexes.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { FactStore } from "../../dispatch/fact-store.ts";
import type { DispatchContext } from "../../dispatch/types.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import type { ReviewGraph, ReviewGraphEdge, ReviewGraphNode } from "../types.ts";
import { loadPersistedGraph } from "./persist-load.ts";
import { getReviewGraphSizeSkipVerdict } from "./source-files.ts";
import {
  REVIEW_GRAPH_VERSION,
  _workspaceGraphCache,
  setWorkspaceGraph,
  touchWorkspaceGraph,
} from "./workspace-cache.ts";

/**
 * Read-only access to the already-built review graph for `cwd` — NEVER builds.
 * Returns a query-ready clone of the in-memory cached graph if one exists, else
 * undefined. For read-substitute callers (module_report, #256) that must not
 * trigger a synchronous full rebuild on the agent's call path: a full build
 * re-runs every fact provider (TS-compiler ASTs for jsts, tree-sitter for the
 * rest), and two of those racing OOM'd pi. Callers degrade to outline-only when
 * this returns undefined; the live edit pipeline keeps the cache warm so in pi it
 * is almost always present (possibly a few edits stale, which is fine for a
 * navigation read).
 */
// Stored snapshots are cloned with EMPTY index maps (see cloneGraph). Build them
// once, in place, so the read accessor can hand back the cached object directly
// instead of clone+reindex on every call (#260: module_report was burning
// 200-425ms each over a 13.5MB graph). The snapshot is never mutated after
// caching — a new build replaces the map entry rather than editing in place — so
// the populated indexes stay valid and the object is safe to share read-only.
function ensureIndexed(graph: ReviewGraph): void {
  if (graph.edges.length > 0 && graph.edgesByFrom.size === 0) {
    rebuildIndexes(graph);
  }
}

/**
 * READ-ONLY accessor. Returns the cached graph as a SHARED, already-indexed
 * object — callers (module_report's outline + blast radius) must not mutate it. No clone,
 * no per-call reindex.
 */
export function getCachedReviewGraph(cwd: string): ReviewGraph | undefined {
  const key = normalizeMapKey(cwd);
  // #782: a fresh size-skip verdict means the LAST build attempt found the
  // repo over the file cap — any graph cached/persisted from before that
  // (necessarily built over a smaller file set, since the too_many_files
  // branch never populates either cache tier) would silently under-report
  // fan-in/blastRadius as if the repo were still that small. Stop serving it
  // while the verdict is fresh rather than let it look current; it comes back
  // automatically the moment the verdict expires (repo shrunk, or the cap was
  // raised) and a build succeeds again.
  if (getReviewGraphSizeSkipVerdict(cwd)) return undefined;
  const cached = _workspaceGraphCache.get(key);
  if (cached) {
    touchWorkspaceGraph(key);
    ensureIndexed(cached.graph);
    return cached.graph;
  }
  // Tier 3: the persisted disk snapshot. This is the cross-PROCESS path — the
  // edit pipeline (one process) persists the graph; a separate module_report
  // process reads it here instead of seeing an empty in-memory cache (the
  // "graph: cold" symptom). Possibly a few edits stale, which is fine for a
  // navigation read. Warm the in-memory cache so repeat reads in this process
  // skip the disk read. loadPersistedGraph already rebuilt the indexes.
  // #300: this read is BLIND — nothing downstream content-verifies it, so a
  // stamped snapshot from a different HEAD/worktree must be dropped here.
  const disk = loadPersistedGraph(cwd, {
    verifyGitStamp: true,
    allowPartial: true,
  });
  if (!disk) return undefined;
  setWorkspaceGraph(key, {
    signature: disk.signature,
    fileSignatures: disk.fileSignatures,
    fileHashes: disk.fileHashes,
    graph: disk.graph,
  });
  return disk.graph;
}

export function makeCtx(filePath: string, cwd: string, facts: FactStore): DispatchContext {
  return {
    filePath,
    cwd,
    kind: detectFileKind(filePath),
    fileRole: detectFileRole(filePath),
    pi: { getFlag: () => undefined },
    autofix: false,
    deltaMode: false,
    facts,
    blockingOnly: false,
    modifiedRanges: undefined,
    hasTool: async () => false,
    log: () => {},
  };
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createEmptyGraph(): ReviewGraph {
  return {
    version: REVIEW_GRAPH_VERSION,
    builtAt: new Date().toISOString(),
    nodes: new Map(),
    edges: [],
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(),
  };
}

export function cloneGraph(graph: ReviewGraph): ReviewGraph {
  return {
    version: graph.version,
    builtAt: graph.builtAt,
    nodes: new Map(graph.nodes),
    // Edges are immutable values: update paths replace/filter entries rather
    // than mutating them, so copying the array is sufficient isolation.
    edges: [...graph.edges],
    edgesByFrom: new Map(),
    edgesByTo: new Map(),
    fileNodes: new Map(),
    symbolNodesByFile: new Map(),
    changedSymbolsByFile: new Map(graph.changedSymbolsByFile),
    // Carry the partial-coverage marker so a clone can never silently pose as
    // a complete graph (#936 review). The build path additionally refuses a
    // partial base outright; this keeps any other cloner honest.
    persistCoverage: graph.persistCoverage,
  };
}

/** Refresh the content timestamp only when an incremental path changed graph data. */
export function refreshGraphBuiltAt(graph: ReviewGraph): void {
  graph.builtAt = new Date().toISOString();
}

export function sourceSignatureEntry(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

// Chunked-yield budget for the per-edit signature/stat loops. 100 stat calls
// per chunk keeps each synchronous burst well under pi's typing window while
// adding negligible scheduling overhead. The work and its output are identical
// to a tight synchronous loop — only the loop yields the event loop between
// chunks so a large project's cascade graph rebuild can't freeze the TUI.
export const STAT_YIELD_EVERY = 100;

export const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Async, chunked-yield twin of the per-file source-signature map. Produces the
 * exact same `file -> "size:mtimeMs"` map as a synchronous loop, but yields to
 * the event loop every {@link STAT_YIELD_EVERY} stats. Used on the per-edit
 * cascade path where statting every project file synchronously would otherwise
 * block the loop for hundreds of ms on a large repo.
 */
export async function sourceSignatureMapAsync(files: string[]): Promise<Map<string, string>> {
  const signatures = new Map<string, string>();
  let sinceYield = 0;
  for (const file of files) {
    signatures.set(file, sourceSignatureEntry(file));
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  return signatures;
}

export function sourceSignatureFromMap(signatures: Map<string, string>): string {
  return [...signatures.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, signature]) => `${file}:${signature}`)
    .join("|");
}

export function contentHashEntry(file: string): string {
  try {
    // sha256, not for security — a content fingerprint for change detection;
    // avoids SonarCloud's weak-hash (sha1/md5) flag.
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * #202: confirm which mtime/size-changed candidates actually changed CONTENT. A
 * candidate whose content hash matches the prior hash is pure mtime drift —
 * reusing its already-parsed graph nodes is safe. Returns the truly
 * content-changed subset plus the merged hash map (prior hashes + freshly
 * computed candidate hashes) for persisting. When prior hashes are absent (a
 * pre-#202 cache), every candidate reports as changed, so behavior degrades
 * exactly to the old mtime-only logic — never a false reuse.
 */
export async function confirmContentChanged(
  candidates: string[],
  previousHashes: Map<string, string> | undefined,
): Promise<{ trulyChanged: string[]; hashes: Map<string, string> }> {
  const prior = previousHashes ?? new Map<string, string>();
  const hashes = new Map(prior);
  const trulyChanged: string[] = [];
  let sinceYield = 0;
  for (const file of candidates) {
    const hash = contentHashEntry(file);
    hashes.set(file, hash);
    if (prior.get(file) !== hash) trulyChanged.push(file);
    if (++sinceYield >= STAT_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  return { trulyChanged, hashes };
}

interface SignatureDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * #202: structural delta between two source-signature maps. The predecessor
 * (changedSignatureFiles) returned undefined on ANY count change, so a single
 * newly-created file forced a full whole-repo rebuild — the dominant cause of
 * the multi-second graph_build spikes during a burst of new files (choco-pi-lsp has
 * no fs-watcher, so it learns of N new sibling files all at once on the next
 * edit). Reporting added / removed / changed explicitly lets an add-only or
 * change-only delta be applied incrementally — see {@link tryIncrementalFromCache}.
 */
export function diffSignatureMaps(
  previous: Map<string, string>,
  next: Map<string, string>,
): SignatureDelta {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [file, signature] of next) {
    const oldSignature = previous.get(file);
    if (oldSignature === undefined) added.push(file);
    else if (oldSignature !== signature) changed.push(file);
  }
  const removed: string[] = [];
  for (const file of previous.keys()) {
    if (!next.has(file)) removed.push(file);
  }
  return { added, removed, changed };
}

export function addNode(graph: ReviewGraph, node: ReviewGraphNode): void {
  graph.nodes.set(node.id, node);
  if (node.kind === "file" && node.filePath) {
    graph.fileNodes.set(node.filePath, node.id);
  }
}

export function addEdge(graph: ReviewGraph, edge: ReviewGraphEdge): void {
  graph.edges.push(edge);
  const from = graph.edgesByFrom.get(edge.from) ?? [];
  from.push(edge);
  graph.edgesByFrom.set(edge.from, from);
  const to = graph.edgesByTo.get(edge.to) ?? [];
  to.push(edge);
  graph.edgesByTo.set(edge.to, to);
}

export function rebuildIndexes(graph: ReviewGraph): void {
  graph.edgesByFrom = new Map();
  graph.edgesByTo = new Map();
  graph.fileNodes = new Map();
  graph.symbolNodesByFile = new Map();
  for (const node of graph.nodes.values()) {
    if (node.kind === "file" && node.filePath) {
      graph.fileNodes.set(node.filePath, node.id);
    }
    if (node.kind === "symbol" && node.filePath) {
      const ids = graph.symbolNodesByFile.get(node.filePath) ?? [];
      ids.push(node.id);
      graph.symbolNodesByFile.set(node.filePath, ids);
    }
  }
  for (const edge of graph.edges) {
    const from = graph.edgesByFrom.get(edge.from) ?? [];
    from.push(edge);
    graph.edgesByFrom.set(edge.from, from);
    const to = graph.edgesByTo.get(edge.to) ?? [];
    to.push(edge);
    graph.edgesByTo.set(edge.to, to);
  }
}
