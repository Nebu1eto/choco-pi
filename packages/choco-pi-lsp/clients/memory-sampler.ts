import type { WordIndex } from "./word-index.ts";
import { getSharedTreeSitterClient } from "./tree-sitter-shared.ts";
import { getReviewGraphWorkspaceCacheSnapshot } from "./review-graph/builder.ts";
import { getDispatchCascadeCacheStats } from "./dispatch/integration.ts";

export const MEMORY_SAMPLE_TURN_INTERVAL = 10;

export function shouldEmitMemorySample(turnIndex: number): boolean {
  return turnIndex > 0 && turnIndex % MEMORY_SAMPLE_TURN_INTERVAL === 0;
}

export interface MemoryProcessUsage {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export function toMemoryProcessUsage(mem: NodeJS.MemoryUsage): MemoryProcessUsage {
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
  };
}

export interface MemorySampleSubsystems {
  reviewGraph: {
    cacheEntries: number;
    totalNodes: number;
    totalEdges: number;
  };
  wordIndex: {
    docs: number;
    postings: number;
    forwardEntries: number;
  } | null;
  treeSitter: {
    languagesLoaded: number;
    parsersLoaded: number;
    queryCacheSize: number;
    queryBatchCacheSize: number;
    treeCacheSize: number;
    treeCacheMaxSize: number;
    treeCacheTotalBytes: number;
  } | null;
  dispatchCaches: {
    neighborTouchCacheSize: number;
    recentlyCleanNeighborCacheSize: number;
  };
}

export interface MemorySample {
  process: MemoryProcessUsage;
  subsystems: MemorySampleSubsystems;
}

export function collectMemorySampleSubsystems(wordIndex: WordIndex | null): MemorySampleSubsystems {
  const reviewGraph = getReviewGraphWorkspaceCacheSnapshot();

  const treeSitterClient = getSharedTreeSitterClient();
  const treeSitter = treeSitterClient
    ? (() => {
        const runtimeStats = treeSitterClient.getRuntimeStats();
        const cacheStats = treeSitterClient.getParseCacheStats();
        return {
          ...runtimeStats,
          treeCacheSize: cacheStats.size,
          treeCacheMaxSize: cacheStats.maxSize,
          treeCacheTotalBytes: cacheStats.totalBytes,
        };
      })()
    : null;

  const dispatchCaches = getDispatchCascadeCacheStats();

  return {
    reviewGraph,
    wordIndex: wordIndex
      ? {
          docs: wordIndex.docLengths.size,
          postings: wordIndex.postings.size,
          forwardEntries: wordIndex.forward?.size ?? 0,
        }
      : null,
    treeSitter,
    dispatchCaches,
  };
}

export function buildMemorySample(
  wordIndex: WordIndex | null,
  mem: NodeJS.MemoryUsage = process.memoryUsage(),
): MemorySample {
  return {
    process: toMemoryProcessUsage(mem),
    subsystems: collectMemorySampleSubsystems(wordIndex),
  };
}

const toMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export function formatMemoryHealthLine(sample: MemorySample): string {
  const { process: proc, subsystems } = sample;
  const treeCache = subsystems.treeSitter
    ? `${toMb(subsystems.treeSitter.treeCacheTotalBytes)}MB (${subsystems.treeSitter.treeCacheSize} trees)`
    : "n/a";
  const graph = `${subsystems.reviewGraph.totalNodes}n/${subsystems.reviewGraph.totalEdges}e (${subsystems.reviewGraph.cacheEntries} cwd)`;
  return (
    `Memory: RSS ${toMb(proc.rssBytes)}MB · heap ${toMb(proc.heapUsedBytes)}/${toMb(proc.heapTotalBytes)}MB` +
    ` · external ${toMb(proc.externalBytes)}MB · tree-sitter cache ${treeCache} · review-graph ${graph}`
  );
}
