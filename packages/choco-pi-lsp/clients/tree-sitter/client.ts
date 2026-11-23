/**
 * TreeSitterClient: the public class. Each method delegates to a module function that takes the internals record.
 */
import type { LspBoundaryValue } from "../runtime-guards.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { getDegradationLedgerGeneration } from "../degradation-ledger.ts";
import { getProjectTrustGeneration } from "../project-trust.ts";
import { TreeCache } from "../tree-sitter-cache.ts";
import { TreeSitterNavigator } from "../tree-sitter-navigator.ts";
import { type TreeSitterQuery, TreeSitterQueryLoader } from "../tree-sitter-query-loader.ts";
import { findGrammarsDir, init, resetLoadStateForSession } from "./grammar-loader.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import {
  extractInjections,
  getLanguage,
  isAvailable,
  isLanguageSupported,
  parseFile,
  withParsedTree,
} from "./parse.ts";
import { runQueriesOnFile, runQueryOnFile, structuralSearch } from "./query-search.ts";
import {
  ensureTreeCacheCapacity,
  getParseCacheStats,
  getRuntimeStats,
  reportWasmAbort,
  withParseCacheMeasurement,
} from "./runtime.ts";
import {
  createParserCounters,
  type GetRuntimeStatsResultContract,
  type ParseCacheMeasurement,
  type ParsedTreeOutcome,
  type QueryBatch,
  type StructuralMatch,
  type TreeSitterLanguage,
  type TreeSitterParseCacheStats,
  type TreeSitterTree,
} from "./shared.ts";

/**
 * Creates the internals record: the former field initializers in declaration
 * order, then the former constructor body. `grammarsDir`, `verbose` and
 * `onWasmAbort` hold their unset values while `findGrammarsDir` runs, as the
 * uninitialized fields did when the constructor called it first.
 */
function createTreeSitterClientInternals(
  client: TreeSitterClient,
  verbose: boolean,
  onWasmAbort: (() => void) | undefined,
): TreeSitterClientInternals {
  const core: TreeSitterClientInternals = {
    client,
    initialized: false,
    initPromise: null,
    webTreeSitterLoadFailed: false,
    languages: new Map(),
    parsers: new Map(),
    treeCache: new TreeCache(
      50,
      verbose,
      4096,
      (key, amount) => {
        const measurement = core.parseCacheMeasurement.getStore();
        if (measurement) measurement[key] += amount;
      },
      (error) => core.client.reportWasmAbort(error),
    ),
    navigator: new TreeSitterNavigator(),
    grammarsDir: "",
    grammarEnsurePromises: new Map<string, Promise<boolean>>(),
    grammarRetryAtMs: new Map<string, number>(),
    verifiedGrammarPaths: new Map<string, string>(),
    decodeFailedGrammarPaths: new Map<string, string>(),
    poisonedGrammarPaths: new Set<string>(),
    grammarFailureAttempts: new Map<string, number>(),
    grammarLastNotifiedDelayMs: new Map<string, number>(),
    grammarNotificationsLedgerGen: getDegradationLedgerGeneration(),
    trustBlockedGrammarNotifications: new Set<string>(),
    trustNotificationsGeneration: getProjectTrustGeneration(),
    ParserClass: null,
    LanguageLoader: null,
    queryCache: new Map<string, any>(),
    queryBatchCache: new Map<string, QueryBatch | null>(),
    queryBatchLoadFailures: new Map<string, number>(),
    queryLoader: new TreeSitterQueryLoader(),
    verbose: false,
    parserCounters: createParserCounters(),
    parseCacheMeasurement: new AsyncLocalStorage<ParseCacheMeasurement>(),
    activeMeasurements: 0,
    onWasmAbort: undefined,
    wasmAborted: false,
    reportedCompileFailures: new Set<string>(),
    reportedMissingPostFilters: new Set<string>(),
    reportedPostFilterFailures: new Set<string>(),
    textPredicatesInvalidLogged: false,
  };
  core.grammarsDir = findGrammarsDir();
  core.verbose = verbose;
  core.onWasmAbort = onWasmAbort;
  return core;
}

// --- Parser Manager ---

export class TreeSitterClient {
  private readonly core: TreeSitterClientInternals;

  constructor(verbose = false, onWasmAbort?: () => void) {
    this.core = createTreeSitterClientInternals(this, verbose, onWasmAbort);
  }

  reportWasmAbort(error: LspBoundaryValue): boolean {
    return reportWasmAbort(this.core, error);
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
  getRuntimeStats(): GetRuntimeStatsResultContract {
    return getRuntimeStats(this.core);
  }

  getParseCacheStats(): TreeSitterParseCacheStats {
    return getParseCacheStats(this.core);
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
  ensureTreeCacheCapacity(fileCount: number): void {
    return ensureTreeCacheCapacity(this.core, fileCount);
  }

  withParseCacheMeasurement<T>(
    work: () => Promise<T>,
    onComplete: (stats: TreeSitterParseCacheStats) => void,
  ): Promise<T> {
    return withParseCacheMeasurement<T>(this.core, work, onComplete);
  }

  /** Initialize tree-sitter WASM runtime */
  init(): Promise<boolean> {
    return init(this.core);
  }

  /**
   * Re-arm the web-tree-sitter load latch for a new session (#1592 review
   * round 2 F2). Deliberately does NOT touch `wasmAborted` or `initialized`
   * — see `webTreeSitterLoadFailed`'s doc for why the abort case stays
   * process-lifetime, and a successful init has nothing to re-arm. Called
   * from `resetTreeSitterClientLoadState()` (tree-sitter-shared.ts), wired
   * into `resetDispatchBaselines()` beside `resetAstGrepNapiLoadState()`.
   */
  resetLoadStateForSession(): void {
    return resetLoadStateForSession(this.core);
  }

  /**
   * Parse a file and return the AST tree. The tree stays valid only until the
   * caller's next `await` — prefer `withParsedTree`, which extracts inside the
   * cache-safe window (#417/#675).
   */
  parseFile(
    filePath: string,
    languageId: string,
    contentOverride?: string,
  ): Promise<TreeSitterTree | null> {
    return parseFile(this.core, filePath, languageId, contentOverride);
  }

  withParsedTree<T>(
    filePath: string,
    languageId: string,
    contentOverride: string | undefined,
    consume: (tree: TreeSitterTree) => T,
  ): Promise<ParsedTreeOutcome<T>> {
    return withParsedTree<T>(this.core, filePath, languageId, contentOverride, consume);
  }

  /**
   * Detect and extract injected content from template literals
   * Used for security analysis (SQL injection, unsafe regex, etc.)
   */
  extractInjections(
    filePath: string,
    content: string,
  ): Array<{
    type: "sql" | "css" | "html" | "gql" | "regex";
    content: string;
    line: number;
    column: number;
  }> {
    return extractInjections(this.core, filePath, content);
  }

  /** Check if tree-sitter is available (a core grammar resolves somewhere). */
  isAvailable(): boolean {
    return isAvailable(this.core);
  }

  /** Check if specific language is supported */
  isLanguageSupported(languageId: string): Promise<boolean> {
    return isLanguageSupported(this.core, languageId);
  }

  /** Get loaded language for symbol extraction */
  getLanguage(languageId: string): TreeSitterLanguage | null {
    return getLanguage(this.core, languageId);
  }

  // --- Structural Search ---

  /**
   * Search for a structural pattern in files
   *
   * @param pattern - Pattern with metavariables (e.g., "console.log($MSG)")
   * @param languageId - Language ID (typescript, python, etc.)
   * @param rootDir - Directory to search
   * @param options - Search options
   * @returns Array of matches with captures
   */
  structuralSearch(
    pattern: string,
    languageId: string,
    rootDir: string,
    options: {
      maxResults?: number;
      fileFilter?: (path: string) => boolean;
    } = {},
  ): Promise<StructuralMatch[]> {
    return structuralSearch(this.core, pattern, languageId, rootDir, options);
  }

  /**
   * Run a preloaded query definition against a single file.
   *
   * Optimized for dispatch runner usage to avoid per-query directory scans.
   */
  runQueryOnFile(
    queryDef: TreeSitterQuery,
    filePath: string,
    languageId: string,
    options: { maxResults?: number } = {},
    contentOverride?: string,
  ): Promise<StructuralMatch[]> {
    return runQueryOnFile(this.core, queryDef, filePath, languageId, options, contentOverride);
  }

  /**
   * Run a whole rule set against one file in a SINGLE tree walk (#675).
   *
   * Calling `runQueryOnFile` per rule re-walks the tree once per rule — ~34
   * walks per file on a project scan, measured at 3.3× the cost of one
   * combined query for byte-identical matches. Patterns are concatenated in
   * rule order and `match.patternIndex` maps back to the owning rule, so
   * per-rule metavars, predicates, post-filters and caps still apply and
   * results stay grouped in rule order. Rules that don't compile against this
   * language are dropped individually (never poisoning the batch), and a
   * combined query that fails to compile falls back to per-rule execution.
   */
  runQueriesOnFile(
    queryDefs: TreeSitterQuery[],
    filePath: string,
    languageId: string,
    options: { maxResults?: number } = {},
    contentOverride?: string,
  ): Promise<Array<{ queryDef: TreeSitterQuery; match: StructuralMatch }>> {
    return runQueriesOnFile(this.core, queryDefs, filePath, languageId, options, contentOverride);
  }
}
