/**
 * Debug logging, parser counters, WASM-abort handling, runtime and parse-cache statistics.
 */
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

/**
 * O(1) runtime footprint counters (#1123 item 2 memory attribution): every
 * field is a `Map.size` read, never an iteration over the maps' contents.
 * `wasmMemoryBytes` is deliberately NOT included here — web-tree-sitter
 * 0.25.10's Emscripten `Module` (which owns the WASM linear memory /
 * `HEAPU8.buffer`) is a private closure variable in the package's
 * `bindings.ts` and is not exposed through any public export (`Parser`,
 * `Language`, `Query`, ...); reaching it would require either reflecting
 * into the package's internal module state (brittle across web-tree-sitter
 * versions/bundling) or overriding Emscripten's `wasmMemory` module option
 * at `Parser.init()` time with a hand-constructed `WebAssembly.Memory`
 * matching the library's own default page-count math (risks a memory-import
 * mismatch that would break ALL structural analysis, for an
 * observability-only feature). `process.memoryUsage().arrayBuffers` is the
 * process-wide proxy used instead (WASM linear memory backs an ArrayBuffer,
 * so it is included there) — see clients/memory-sampler.ts.
 */
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

/**
 * Grow the tree cache to span a full-project scan's working set (#1715).
 * The interactive default (50 entries) can't hold a mid/large project's
 * file count, so a second scan re-parses everything the first scan's LRU
 * evicted — live dogfood evidence showed every miss on a second 110-file
 * scan was a `capacityMisses` one. Bounded by
 * `TREE_CACHE_SCAN_CAPACITY_CEILING` (see `deriveScanTreeCacheCapacity`'s
 * heap-cost note) and monotonic — a smaller scan never shrinks a capacity
 * an earlier, larger one already grew.
 */
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
        } catch {
          // Telemetry must not fail the measured work.
        }
      }
    });
  } finally {
    // On Node 22 an active AsyncLocalStorage keeps an async_hooks init hook
    // enabled for every promise in the process, so release it once the last
    // overlapping measurement is done rather than taxing the whole session.
    if (--core.activeMeasurements === 0) core.parseCacheMeasurement.disable();
  }
}

/** Debug logging helper */
export function dbg(core: TreeSitterClientInternals, msg: string): void {
  if (core.verbose) {
    // #1333: verbose gating is preserved, but the SINK is tree-sitter.log —
    // a raw write would corrupt pi's frame the moment verbose is enabled.
    logTreeSitterDiagnostic({
      subsystem: "tree-sitter-client",
      level: "debug",
      message: msg,
    });
  }
}
