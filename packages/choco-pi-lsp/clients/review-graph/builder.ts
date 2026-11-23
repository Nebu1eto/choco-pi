export { REVIEW_GRAPH_VERSION, REVIEW_GRAPH_SOURCE_EXTENSIONS } from "./builder/workspace-cache.ts";
export {
  getGraphBuildInfoForGraph,
  graphBuildInfoIsTrustworthy,
  clearGraphCache,
  clearReviewGraphWorkspaceCache,
  _setReviewGraphBuildGateForTests,
  getReviewGraphWorkspaceCacheSnapshot,
  _getReviewGraphWorkspaceCacheKeysForTests,
  _getReviewGraphCacheStateForTests,
  getReviewGraphCacheIdentity,
  _resetCwdWorktreeMismatchLogForTests,
  getLastGraphBuildInfo,
  _setLastGraphBuildInfoForTests,
} from "./builder/build-info.ts";
export type {
  GraphSeqHint,
  GraphBuildInfo,
  ReviewGraphWorkspaceCacheSnapshot,
  ReviewGraphCacheIdentity,
} from "./builder/build-info.ts";
export { getCachedReviewGraph } from "./builder/graph-state.ts";
export {
  getReviewGraphMaxFiles,
  _resetReviewGraphSizeSkipTtlForTests,
  getLastReviewGraphBuildAttempt,
  _resetReviewGraphBuildAttemptsForTests,
  _resetReviewGraphSizeSkipVerdictsForTests,
  getReviewGraphSizeSkipVerdict,
  _setReviewGraphEntryBudgetForTests,
  _setReviewGraphEntryCounterForTests,
  getGraphSourceFiles,
} from "./builder/source-files.ts";
export type {
  ReviewGraphSizeSkipVerdict,
  ReviewGraphBuildAttempt,
} from "./builder/source-files.ts";
export { isReviewGraphMigrationNeeded } from "./builder/persist-load.ts";
export {
  GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT,
  flushReviewGraphPersistsForExitForTests,
  getReviewGraphPersistLifetimeForTests,
} from "./builder/persist-worker-client.ts";
export { _resetReviewGraphStageSweepForTests } from "./builder/persist.ts";
export { _readReviewGraphCheckpointForTests } from "./builder/checkpoint.ts";
export {
  flushReviewGraphPersistsForTests,
  waitForReviewGraphPersistsForTests,
  terminateReviewGraphPersistWorkerForTests,
  resetReviewGraphPersistWorkerForTests,
  getCheckpointOffloadCountForTests,
  getReviewGraphWorkerFallbackReasonForTests,
  reviewGraphCachePath,
  flushReviewGraphPersist,
} from "./builder/persist-flush.ts";
export type { ReviewGraphPersistFlushResult } from "./builder/persist-flush.ts";
export {
  captureReviewGraphStructuralIr,
  addLspFallbackSymbols,
} from "./builder/tree-sitter-file.ts";
export { getGraphImportChanges } from "./builder/file-update.ts";
export type { GraphFileImportChange, GraphImportDelta } from "./builder/file-update.ts";
export { buildOrUpdateGraph } from "./builder/build.ts";
export { extractSymbolsAndRefsFromGraph } from "./builder/graph-symbols.ts";
