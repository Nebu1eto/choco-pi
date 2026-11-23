import type { LspBoundaryValue } from "../runtime-guards.ts";
import { recordDegradation } from "../degradation-ledger.ts";
import { logTreeSitterDiagnostic } from "../tree-sitter-logger.ts";
import { createTreeCacheCounters, deriveScanTreeCacheCapacity } from "../tree-sitter-cache.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import {
  createParserCounters,
  isTreeSitterWasmAbortError,
  type GetRuntimeStatsResultContract,
  type ParseCacheMeasurement,
  type TreeSitterParseCacheStats,
  type TreeSitterParserCounters,
} from "./shared.ts";

export function recordParserCounter(
  core: TreeSitterClientInternals,
  key: keyof TreeSitterParserCounters,
  amount = 1,
): void {
  core.parserCounters[key] += amount;
  const measurement = core.parseCacheMeasurement.getStore();
  if (measurement) measurement[key] += amount;
}

export function reportWasmAbort(core: TreeSitterClientInternals, error: LspBoundaryValue): boolean {
  if (!isTreeSitterWasmAbortError(error)) return false;
  if (!core.wasmAborted) {
    core.wasmAborted = true;
    recordDegradation({
      kind: "wasm-abort",
      subject: "web-tree-sitter",
      reason: error instanceof Error ? error.message : String(error),
    });
    core.onWasmAbort?.();
  }
  return true;
}

export function getRuntimeStats(core: TreeSitterClientInternals): GetRuntimeStatsResultContract {
  return {
    languagesLoaded: core.languages.size,
    parsersLoaded: core.parsers.size,
    queryCacheSize: core.queryCache.size,
    queryBatchCacheSize: core.queryBatchCache.size,
  };
}

export function getParseCacheStats(core: TreeSitterClientInternals): TreeSitterParseCacheStats {
  return {
    ...core.treeCache.getStats(),
    ...core.parserCounters,
  };
}

export function ensureTreeCacheCapacity(core: TreeSitterClientInternals, fileCount: number): void {
  core.treeCache.setMaxSize(deriveScanTreeCacheCapacity(fileCount, core.treeCache.getMaxSize()));
}

export async function withParseCacheMeasurement<T>(
  core: TreeSitterClientInternals,
  work: () => Promise<T>,
  onComplete: (stats: TreeSitterParseCacheStats) => void,
): Promise<T> {
  const measurement: ParseCacheMeasurement = {
    ...createTreeCacheCounters(),
    ...createParserCounters(),
  };
  core.activeMeasurements++;
  try {
    return await core.parseCacheMeasurement.run(measurement, async () => {
      try {
        return await work();
      } finally {
        const cacheStats = core.treeCache.getStats();
        try {
          onComplete({
            ...cacheStats,
            ...measurement,
            misses: measurement.lookups - measurement.hits,
          });
        } catch {}
      }
    });
  } finally {
    if (--core.activeMeasurements === 0) core.parseCacheMeasurement.disable();
  }
}

export function dbg(core: TreeSitterClientInternals, msg: string): void {
  if (core.verbose) {
    logTreeSitterDiagnostic({
      subsystem: "tree-sitter-client",
      level: "debug",
      message: msg,
    });
  }
}
