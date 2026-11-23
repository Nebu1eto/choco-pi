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

export class TreeSitterClient {
  private readonly core: TreeSitterClientInternals;

  constructor(verbose = false, onWasmAbort?: () => void) {
    this.core = createTreeSitterClientInternals(this, verbose, onWasmAbort);
  }

  reportWasmAbort(error: LspBoundaryValue): boolean {
    return reportWasmAbort(this.core, error);
  }

  getRuntimeStats(): GetRuntimeStatsResultContract {
    return getRuntimeStats(this.core);
  }

  getParseCacheStats(): TreeSitterParseCacheStats {
    return getParseCacheStats(this.core);
  }

  ensureTreeCacheCapacity(fileCount: number): void {
    return ensureTreeCacheCapacity(this.core, fileCount);
  }

  withParseCacheMeasurement<T>(
    work: () => Promise<T>,
    onComplete: (stats: TreeSitterParseCacheStats) => void,
  ): Promise<T> {
    return withParseCacheMeasurement<T>(this.core, work, onComplete);
  }

  init(): Promise<boolean> {
    return init(this.core);
  }

  resetLoadStateForSession(): void {
    return resetLoadStateForSession(this.core);
  }

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

  isAvailable(): boolean {
    return isAvailable(this.core);
  }

  isLanguageSupported(languageId: string): Promise<boolean> {
    return isLanguageSupported(this.core, languageId);
  }

  getLanguage(languageId: string): TreeSitterLanguage | null {
    return getLanguage(this.core, languageId);
  }

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

  runQueryOnFile(
    queryDef: TreeSitterQuery,
    filePath: string,
    languageId: string,
    options: { maxResults?: number } = {},
    contentOverride?: string,
  ): Promise<StructuralMatch[]> {
    return runQueryOnFile(this.core, queryDef, filePath, languageId, options, contentOverride);
  }

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
