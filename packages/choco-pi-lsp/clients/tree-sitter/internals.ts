import type { AsyncLocalStorage } from "node:async_hooks";
import type { TreeCache } from "../tree-sitter-cache.ts";
import type { TreeSitterNavigator } from "../tree-sitter-navigator.ts";
import type { TreeSitterQueryLoader } from "../tree-sitter-query-loader.ts";
import type { TreeSitterClient } from "./client.ts";
import type {
  ParseCacheMeasurement,
  QueryBatch,
  TreeSitterLanguage,
  TreeSitterParserCounters,
  TreeSitterParserInstance,
} from "./shared.ts";

export const QUERY_CACHE_MAX_ENTRIES = 256;

export const QUERY_BATCH_CACHE_MAX_ENTRIES = 256;

export interface TreeSitterClientInternals {
  client: TreeSitterClient;

  initialized: boolean;

  initPromise: Promise<boolean> | null;

  webTreeSitterLoadFailed: boolean;

  languages: Map<string, TreeSitterLanguage>;

  parsers: Map<string, TreeSitterParserInstance>;

  treeCache: TreeCache;

  navigator: TreeSitterNavigator;

  grammarsDir: string;

  grammarEnsurePromises: Map<string, Promise<boolean>>;

  grammarRetryAtMs: Map<string, number>;

  verifiedGrammarPaths: Map<string, string>;

  decodeFailedGrammarPaths: Map<string, string>;

  poisonedGrammarPaths: Set<string>;

  grammarFailureAttempts: Map<string, number>;

  grammarLastNotifiedDelayMs: Map<string, number>;

  grammarNotificationsLedgerGen: number;

  trustBlockedGrammarNotifications: Set<string>;

  trustNotificationsGeneration: number;

  ParserClass: any;

  LanguageLoader: any;

  queryCache: Map<string, any>;

  queryBatchCache: Map<string, QueryBatch | null>;

  queryBatchLoadFailures: Map<string, number>;

  queryLoader: TreeSitterQueryLoader;

  verbose: boolean;

  parserCounters: TreeSitterParserCounters;

  parseCacheMeasurement: AsyncLocalStorage<ParseCacheMeasurement>;

  activeMeasurements: number;

  onWasmAbort: (() => void) | undefined;

  wasmAborted: boolean;

  _bundledGrammarsDir?: string;

  _vendoredGrammarsDir?: string;

  reportedCompileFailures: Set<string>;

  reportedMissingPostFilters: Set<string>;

  reportedPostFilterFailures: Set<string>;

  textPredicatesInvalidLogged: boolean;
}
