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
export const GRAPH_CHECKPOINT_FILENAME = "review-graph.checkpoint.json.gz";

export interface PersistedGraphData {
  version: string;
  builtAt: string;
  signature: string;
  fileSignatures?: Array<[string, string]>;
  fileHashes?: Array<[string, string]>;
  nodes: Array<[string, ReviewGraphNode]>;
  edges: ReviewGraphEdge[];
  coverage?: ReviewGraphPersistCoverage;
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

function getPersistedReviewGraphVersion(cwd: string): string | null {
  const cacheDir = path.join(getProjectDataDir(cwd), "cache");
  const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
  const legacyPath = path.join(cacheDir, LEGACY_GRAPH_CACHE_FILENAME);
  if (fs.existsSync(cachePath)) {
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
        } catch {}
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
      } catch {}
    }
  }
}

export function isReviewGraphMigrationNeeded(cwd: string): boolean {
  const version = getPersistedReviewGraphVersion(cwd);
  return version !== null && version !== REVIEW_GRAPH_VERSION;
}
