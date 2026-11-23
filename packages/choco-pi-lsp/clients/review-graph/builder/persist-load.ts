/**
 * Loading a persisted review-graph snapshot and checking its on-disk version.
 */
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { constants as zlibConstants, gunzipSync } from "node:zlib";
import { getProjectDataDir } from "../../file-utils.ts";
import { resolveGitIdentity } from "../git-identity.ts";
import type {
  ReviewGraph,
  ReviewGraphEdge,
  ReviewGraphNode,
  ReviewGraphPersistCoverage,
} from "../types.ts";
import { rebuildIndexes } from "./graph-state.ts";
import { REVIEW_GRAPH_VERSION } from "./workspace-cache.ts";

export const GRAPH_CACHE_FILENAME = "review-graph.json.gz";
export const LEGACY_GRAPH_CACHE_FILENAME = "review-graph.json";
// #936 limit 2: the mid-build resume checkpoint lives in its OWN file, distinct
// from the authoritative `review-graph.json.gz`. Keeping it separate is the
// core honesty guarantee — `loadPersistedGraph` / `getCachedReviewGraph` only
// ever read the authoritative snapshot, so a mid-build checkpoint can never be
// laundered to a consumer as a complete graph. It is read back exclusively by
// the full-build resume path (`loadReviewGraphCheckpoint`).
export const GRAPH_CHECKPOINT_FILENAME = "review-graph.checkpoint.json.gz";

export interface PersistedGraphData {
  version: string;
  builtAt: string;
  signature: string;
  fileSignatures?: Array<[string, string]>;
  fileHashes?: Array<[string, string]>;
  nodes: Array<[string, ReviewGraphNode]>;
  edges: ReviewGraphEdge[];
  /** Honest total-vs-persisted counts for capped snapshots (#936). */
  coverage?: ReviewGraphPersistCoverage;
  // #300: git identity captured at persist time (fs-resolved, no `git` spawn —
  // see git-identity.ts). Optional so an older snapshot without a stamp still
  // loads exactly as before — only a PRESENT stamp that MISMATCHES the current
  // repo drops the snapshot. Absent for non-git cwds (no check possible).
  gitStamp?: { headCommit: string; worktreeRoot: string };
}

export function loadPersistedGraph(
  cwd: string,
  opts?: { verifyGitStamp?: boolean; allowPartial?: boolean },
): {
  signature: string;
  fileSignatures: Map<string, string>;
  fileHashes: Map<string, string>;
  graph: ReviewGraph;
} | null {
  const cacheDir = path.join(getProjectDataDir(cwd), "cache");
  const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
  const legacyPath = path.join(cacheDir, LEGACY_GRAPH_CACHE_FILENAME);
  try {
    const raw = fs.existsSync(cachePath)
      ? gunzipSync(fs.readFileSync(cachePath)).toString("utf-8")
      : fs.readFileSync(legacyPath, "utf-8");
    // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
    const data = JSON.parse(raw) as PersistedGraphData;
    // Derived projections require a canonical source identity. Legacy or
    // malformed snapshots are unavailable, never a clean empty graph.
    if (
      data.version !== REVIEW_GRAPH_VERSION ||
      !isRuntimeString(data.signature) ||
      !isRuntimeString(data.builtAt) ||
      !Array.isArray(data.nodes) ||
      !Array.isArray(data.edges)
    )
      return null;
    if (data.coverage?.partial && !opts?.allowPartial) return null;
    if (opts?.verifyGitStamp && data.gitStamp) {
      // #300: a stamped snapshot must match the CURRENT repo identity. This
      // closes the "worktree removed + re-added at the same path for a
      // different branch" edge — the data-dir slug is reused, but the stamp
      // mismatch forces a cold rebuild instead of serving the old branch's
      // graph. Opt-in per call site: only the BLIND read path
      // (getCachedReviewGraph) verifies — the build path's tier-2 load is
      // already content-verified downstream (signature + #202 hash confirm),
      // and dropping there on every HEAD move would nuke the cold cache
      // after each commit. Any resolution failure (non-git, unreadable HEAD)
      // yields undefined from resolveGitIdentity — treated as "can't
      // verify," not a mismatch, so it does NOT drop the snapshot.
      const current = resolveGitIdentity(cwd);
      if (
        current &&
        (current.headCommit !== data.gitStamp.headCommit ||
          current.worktreeRoot !== data.gitStamp.worktreeRoot)
      ) {
        return null;
      }
    }
    const graph: ReviewGraph = {
      version: data.version,
      builtAt: data.builtAt,
      nodes: new Map(data.nodes),
      edges: data.edges,
      edgesByFrom: new Map(),
      edgesByTo: new Map(),
      fileNodes: new Map(),
      symbolNodesByFile: new Map(),
      changedSymbolsByFile: new Map(),
      persistCoverage: data.coverage,
    };
    rebuildIndexes(graph);
    return {
      signature: data.signature,
      fileSignatures: new Map(data.fileSignatures ?? []),
      fileHashes: new Map(data.fileHashes ?? []),
      graph,
    };
  } catch {
    return null;
  }
}

/**
 * The version string of the persisted graph, read cheaply from the HEAD of the
 * cache file (the `version` key is serialized first) — never parses the multi-MB
 * body. Returns null when no graph is persisted.
 */
function getPersistedReviewGraphVersion(cwd: string): string | null {
  const cacheDir = path.join(getProjectDataDir(cwd), "cache");
  const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
  const legacyPath = path.join(cacheDir, LEGACY_GRAPH_CACHE_FILENAME);
  if (fs.existsSync(cachePath)) {
    // #950 review F4: never inflate+parse the whole multi-MB snapshot just
    // to read the version. `version` is serialized first, so decompressing
    // the first few KB (Z_SYNC_FLUSH tolerates the truncated stream) is
    // enough to sniff it — the gz analogue of the legacy 200-byte header
    // read below.
    let fd: number | undefined;
    try {
      fd = fs.openSync(cachePath, "r");
      const compressed = Buffer.alloc(4096);
      const n = fs.readSync(fd, compressed, 0, compressed.length, 0);
      const head = gunzipSync(compressed.subarray(0, n), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      }).toString("utf-8");
      const match = head.match(/"version"\s*:\s*"([^"]+)"/);
      return match ? match[1] : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(legacyPath, "r");
    const buf = Buffer.alloc(200);
    const n = fs.readSync(fd, buf, 0, 200, 0);
    const match = buf.toString("utf-8", 0, n).match(/"version"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * True when a persisted graph exists but was written under an OLDER
 * REVIEW_GRAPH_VERSION — a schema/scope change (#260: test exclusion) means it
 * must be rebuilt. The session bootstrap consults this to proactively rebuild
 * once after an upgrade, so reads aren't stranded cold until the next edit.
 * Returns false when nothing is persisted (a normal cold start builds on demand).
 */
export function isReviewGraphMigrationNeeded(cwd: string): boolean {
  const version = getPersistedReviewGraphVersion(cwd);
  return version !== null && version !== REVIEW_GRAPH_VERSION;
}
