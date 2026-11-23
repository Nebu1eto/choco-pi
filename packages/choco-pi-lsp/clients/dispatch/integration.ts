import { arr, bool, lit, obj, opt, str, union, compile } from "@earendil-works/pi-schema";
import { getDiagnosticLogger, type LogContext } from "../diagnostic-logger.ts";
import type { FileKind } from "../file-kinds.ts";
import { detectFileKind } from "../file-kinds.ts";
import { getLspCapableKinds, getPrimaryDispatchGroup } from "../language-policy.ts";
import { formatSlopScoreSummary, type SlopScoreSummary } from "../session-summary.ts";
import {
  clearCoverageNoticeState,
  clearLatencyReports,
  createDispatchContext,
  type DispatchLatencyReport,
  dispatchForFile,
  formatLatencyReport,
  getLatencyReports,
  type RunnerLatency,
  RunnerRegistry,
  type RunnerResultSink,
} from "./dispatcher.ts";
import { FactStore } from "./fact-store.ts";
import { TOOL_PLANS } from "./plan.ts";
import type {
  DispatchResult,
  ModifiedRange,
  PiAgentAPI,
  RunnerGroup,
  RunnerResult,
} from "./types.ts";

export type { DispatchLatencyReport, RunnerLatency };
export { clearLatencyReports, formatLatencyReport, getLatencyReports };

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASCADE_NEIGHBOUR_BUDGET,
  type CascadeBudgetZone,
  deriveCascadeNeighbourBudget,
} from "../cascade-budget.ts";
import { formatCascadeNeighborDiagnostics } from "../cascade-format.ts";
import { logCascade } from "../cascade-logger.ts";
import type { CascadeResult, CascadeRun, CascadeSkipReason } from "../cascade-types.ts";
import { getDiagnosticTracker } from "../diagnostic-tracker.ts";
import {
  classifyCascadeWaitTier,
  isTierAwareCascadeEnabled,
  recordOutstandingCascadeTouch,
} from "../lsp/cascade-tier.ts";
import {
  type BoundToCurrentDisk,
  type TouchFileResult,
  bindingStateLabel,
  touchCoverageGap,
} from "../lsp/diagnostic-binding.ts";
import { getServersForFileWithConfig } from "../lsp/config.ts";
import { getLSPService } from "../lsp/index.ts";
import { isExternalOrVendorFile, normalizeMapKey } from "../path-utils.ts";
import { getProjectIgnoreMatcher } from "../file-utils.ts";
import {
  resetAstGrepNapiLoadState,
  resetAstGrepUnsupportedLanguageLog,
} from "./runners/ast-grep-napi.ts";
import { resetTreeSitterClientLoadState } from "../tree-sitter-shared.ts";
import { isTestRoleCollateral } from "../collateral-test-role.ts";
import {
  clearReviewGraphWorkspaceCache,
  getGraphBuildInfoForGraph,
  getGraphImportChanges,
  graphBuildInfoIsTrustworthy,
} from "../review-graph/builder.ts";
import {
  buildReverseDependencyIndexFromGraph,
  getAffectedFilesFromIndex,
  patchReverseDependencyIndex,
  writeReverseDependencyIndexToSnapshot,
  type ReverseDependencyIndex,
} from "../reverse-deps.ts";
import {
  buildOrUpdateGraph,
  computeImpactCascade,
  computeTransitiveImpact,
  formatImpactCascade,
} from "../review-graph/service.ts";
import { clearModuleGraphCache } from "../review-graph/workspace-modules.ts";
import { releaseWorkspaceTopologyIdleTimers } from "../workspace-topology.ts";
import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "../idle-timer-release.ts";
import { RUNTIME_CONFIG } from "../runtime-config.ts";
import { findCompiledClassesDir, hasJavaBuildDescriptor } from "../tool-policy.ts";
import {
  removeWordIndexDocument,
  updateWordIndexDocument,
  WORD_INDEX_MAX_BYTES,
  type WordIndex,
} from "../word-index.ts";
import { reconcileCascadeNeighborLspErrors } from "../widget-state.ts";
import { findAuxiliaryProfileForSource } from "./auxiliary-lsp.ts";
import { registerProvider, runProviders } from "./fact-runner.ts";
import { commentFactProvider } from "./facts/comment-facts.ts";
import { fileContentProvider } from "./facts/file-content.ts";
import { functionFactProvider } from "./facts/function-facts.ts";
import { importFactProvider } from "./facts/import-facts.ts";
import { tryCatchFactProvider } from "./facts/try-catch-facts.ts";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.ts";
import { registerDefaultRunners } from "./runners/index.ts";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.ts";

registerProvider(fileContentProvider);
registerProvider(tryCatchFactProvider);
registerProvider(functionFactProvider);
registerProvider(commentFactProvider);
registerProvider(importFactProvider);

import { registerRule } from "./fact-rule-runner.ts";
import { asyncNoiseRule } from "./rules/async-noise.ts";
import { asyncUnnecessaryWrapperRule } from "./rules/async-unnecessary-wrapper.ts";
import { corsWildcardRule } from "./rules/cors-wildcard.ts";
import { errorObscuringRule } from "./rules/error-obscuring.ts";
import { errorSwallowingRule } from "./rules/error-swallowing.ts";
import { highComplexityRule } from "./rules/high-complexity.ts";
import { highFanOutRule } from "./rules/high-fan-out.ts";
import { highImportCouplingRule } from "./rules/high-import-coupling.ts";
import { missingErrorPropagationRule } from "./rules/missing-error-propagation.ts";
import { commentedCredentialsRule } from "./rules/no-commented-credentials.ts";
import { passThroughWrappersRule } from "./rules/pass-through-wrappers.ts";
import { placeholderCommentsRule } from "./rules/placeholder-comments.ts";
import { unsafeBoundaryRule } from "./rules/unsafe-boundary.ts";
import { loadPiLensProjectConfig, type PiLensProjectConfig } from "../project-lsp-config.ts";

registerRule(errorObscuringRule);
registerRule(errorSwallowingRule);
registerRule(asyncNoiseRule);
registerRule(passThroughWrappersRule);
registerRule(placeholderCommentsRule);
registerRule(highComplexityRule);
registerRule(unsafeBoundaryRule);
registerRule(asyncUnnecessaryWrapperRule);
registerRule(missingErrorPropagationRule);
registerRule(highFanOutRule);
registerRule(highImportCouplingRule);
registerRule(corsWildcardRule);
registerRule(commentedCredentialsRule);

export function applyProjectLensConfig(cwd: string): PiLensProjectConfig {
  return loadPiLensProjectConfig(cwd);
}

const sessionFacts = new FactStore();
const cascadeDiagnosticBaselines = new Map<string, import("./types.ts").Diagnostic[]>();
const sessionRunnerRegistry = new RunnerRegistry();
registerDefaultRunners(sessionRunnerRegistry);
const LSP_CAPABLE_KINDS = new Set<FileKind>(getLspCapableKinds());
const FACT_RULE_IDS = new Set([
  "error-obscuring",
  "error-swallowing",
  "async-noise",
  "pass-through-wrappers",
  "placeholder-comments",
  "high-complexity",
  "unsafe-boundary",
  "async-unnecessary-wrapper",
  "missing-error-propagation",
  "high-fan-out",
  "commented-out-code",
  "duplicate-string-literal",
  "function-in-loop",
  "cors-wildcard",
  "dynamic-regexp",
  "max-switch-cases",
  "no-commented-credentials",
  "no-boolean-params",
  "high-import-coupling",
  "no-complex-conditionals",
]);
const sessionSlopRuleCounts = new Map<string, number>();
let sessionSlopDiagnosticCount = 0;
let sessionWrittenLineCount = 0;

const astGrepWarnDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AST_GREP_WARN_DEBOUNCE_MS = 2000;

function scheduleAstGrepWarningScan(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  logContext: LogContext,
): void {
  const existing = astGrepWarnDebounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    astGrepWarnDebounceTimers.delete(filePath);
    try {
      const ctx = createDispatchContext(filePath, cwd, pi, sessionFacts, false);
      if (ctx.kind !== "jsts") return;

      const group: RunnerGroup = {
        mode: "all",
        runnerIds: ["ast-grep"],
        filterKinds: ["jsts"],
      };
      const result = await dispatchForFile(ctx, [group], sessionRunnerRegistry);
      if (result.diagnostics.length === 0) return;

      const logger = getDiagnosticLogger();
      for (const d of result.diagnostics) {
        logger.logCaught(d, logContext, false);
      }
    } catch {}
  }, AST_GREP_WARN_DEBOUNCE_MS);

  astGrepWarnDebounceTimers.set(filePath, timer);
}

function resetSessionSlopScore(): void {
  sessionSlopRuleCounts.clear();
  sessionSlopDiagnosticCount = 0;
  sessionWrittenLineCount = 0;
}

function detectFactRuleId(diagnostic: {
  id?: string;
  rule?: string;
  tool?: string;
}): string | undefined {
  if (diagnostic.rule && FACT_RULE_IDS.has(diagnostic.rule)) {
    return diagnostic.rule;
  }
  if (diagnostic.tool && FACT_RULE_IDS.has(diagnostic.tool)) {
    return diagnostic.tool;
  }
  if (diagnostic.id) {
    const prefix = diagnostic.id.split(":", 1)[0];
    if (FACT_RULE_IDS.has(prefix)) {
      return prefix;
    }
  }
  return undefined;
}

function trackSessionSlopStats(
  ctx: ReturnType<typeof createDispatchContext>,
  diagnostics: DispatchResult["diagnostics"],
): void {
  const lineCount = ctx.facts.getFileFact<number>(ctx.filePath, "file.lineCount");
  if (lineCount !== undefined && Number.isFinite(lineCount) && lineCount > 0) {
    sessionWrittenLineCount += lineCount;
  }

  for (const diagnostic of diagnostics) {
    const ruleId = detectFactRuleId(diagnostic);
    if (!ruleId) continue;
    sessionSlopDiagnosticCount += 1;
    sessionSlopRuleCounts.set(ruleId, (sessionSlopRuleCounts.get(ruleId) ?? 0) + 1);
  }
}

export function getDispatchSlopScoreSummary(): SlopScoreSummary | undefined {
  if (sessionSlopDiagnosticCount === 0 || sessionWrittenLineCount <= 0) {
    return undefined;
  }

  const totalKlocWritten = sessionWrittenLineCount / 1000;
  const ruleCounts = [...sessionSlopRuleCounts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

  return {
    totalRuleDiagnostics: sessionSlopDiagnosticCount,
    totalKlocWritten,
    scorePerKloc: sessionSlopDiagnosticCount / totalKlocWritten,
    ruleCounts,
  };
}

export function getDispatchSlopScoreLine(): string {
  const summary = getDispatchSlopScoreSummary();
  if (!summary) return "";
  return formatSlopScoreSummary(summary);
}

const SPOTBUGS_SUPPORTED_KINDS = new Set<FileKind>(["java", "kotlin"]);

function withSpotbugsGroup(
  kind: FileKind,
  groups: RunnerGroup[],
  ctx: ReturnType<typeof createDispatchContext>,
): RunnerGroup[] {
  if (!SPOTBUGS_SUPPORTED_KINDS.has(kind)) return groups;
  if (!ctx.pi.getFlag("lens-spotbugs")) return groups;
  if (!hasJavaBuildDescriptor(ctx.cwd) || !findCompiledClassesDir(ctx.cwd)) {
    return groups;
  }
  if (groups.some((group) => group.runnerIds.includes("spotbugs"))) return groups;
  return [
    ...groups,
    {
      mode: "all",
      runnerIds: ["spotbugs"],
      filterKinds: [kind],
      semantic: "warning",
    },
  ];
}

function withPrimaryPolicyGroup(
  kind: FileKind,
  groups: RunnerGroup[],
  pi: PiAgentAPI,
): RunnerGroup[] {
  const lspEnabled = !pi.getFlag("no-lsp");
  const normalizedGroups = lspEnabled
    ? groups
    : groups
        .map((group) => {
          const runnerIds = group.runnerIds.filter((id) => id !== "lsp");
          if (runnerIds.length === 0) return null;
          return {
            ...group,
            runnerIds,
          };
        })
        .filter((group): group is RunnerGroup => group !== null);

  const primary = getPrimaryDispatchGroup(kind, lspEnabled);
  if (!primary) return normalizedGroups;

  const alreadyHasPrimary = normalizedGroups.some((group) => {
    if (group.mode !== primary.mode) return false;
    if (group.runnerIds.length !== primary.runnerIds.length) return false;
    return group.runnerIds.every((id, index) => primary.runnerIds[index] === id);
  });
  if (alreadyHasPrimary) return normalizedGroups;

  return [primary, ...normalizedGroups];
}

export function getDispatchGroupsForKind(kind: FileKind, pi: PiAgentAPI): RunnerGroup[] {
  const plan = TOOL_PLANS[kind];
  if (!plan) {
    const lspEnabled = !pi.getFlag("no-lsp");
    const policyGroup = getPrimaryDispatchGroup(kind, lspEnabled);
    if (policyGroup) return [policyGroup];
    if (lspEnabled && LSP_CAPABLE_KINDS.has(kind)) {
      return [{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind] }];
    }
    return [];
  }
  return withPrimaryPolicyGroup(kind, plan.groups, pi);
}

export function resetDispatchBaselines(cwd?: string): void {
  if (cwd) applyProjectLensConfig(cwd);
  resetAstGrepUnsupportedLanguageLog();
  resetAstGrepNapiLoadState();
  resetTreeSitterClientLoadState();
  sessionFacts.clearAll();
  resetSessionSlopScore();
  clearCoverageNoticeState();
  clearReviewGraphWorkspaceCache();
  clearReverseDepsIndexCache();
  clearModuleGraphCache();
  neighborTouchCache.clear();
  recentlyCleanNeighborCache.clear();
  primaryFilesThisTurn.clear();
  cascadeDiagnosticBaselines.clear();
  cascadeSessionStats = {
    runs: 0,
    diagnosticsSurfaced: 0,
    coldSnapshotTouches: 0,
  };
  for (const timer of astGrepWarnDebounceTimers.values()) clearTimeout(timer);
  astGrepWarnDebounceTimers.clear();
}

let cascadeSessionStats = {
  runs: 0,
  diagnosticsSurfaced: 0,
  coldSnapshotTouches: 0,
};

export function getCascadeSessionStats() {
  return { ...cascadeSessionStats };
}

type NeighborCacheEntry = {
  turnSeq: number;
  writeSeq: number;
  diagnostics: import("./types.ts").Diagnostic[];
};
const neighborTouchCache = new Map<string, NeighborCacheEntry>();

type RecentlyCleanNeighborEntry = { turnSeq: number; checkedAt: number };
const recentlyCleanNeighborCache = new Map<string, RecentlyCleanNeighborEntry>();

export function getDispatchCascadeCacheStats() {
  return {
    neighborTouchCacheSize: neighborTouchCache.size,
    recentlyCleanNeighborCacheSize: recentlyCleanNeighborCache.size,
  };
}
const RECENTLY_CLEAN_TTL_TURNS = 5;

let cascadeTurnScope = 0;
const primaryFilesThisTurn = new Set<string>();

function ensureCascadeTurnScope(turnSeq: number): void {
  if (turnSeq === cascadeTurnScope) return;
  cascadeTurnScope = turnSeq;
  primaryFilesThisTurn.clear();
  neighborTouchCache.clear();
  for (const [key, entry] of recentlyCleanNeighborCache) {
    if (turnSeq - entry.turnSeq > RECENTLY_CLEAN_TTL_TURNS) {
      recentlyCleanNeighborCache.delete(key);
    }
  }
}

const CASCADE_TTL_MS = 240_000;
const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

function cascadeReconcilableLspErrors(
  rawDiags: readonly import("../lsp/client.ts").LSPDiagnostic[],
  neighborPath: string,
): ReturnType<typeof convertLspDiagnostics> {
  return convertLspDiagnostics(
    rawDiags
      .filter((d) => d.severity === 1 && !findAuxiliaryProfileForSource(d.source))
      .slice(0, MAX_PER_FILE),
    neighborPath,
  );
}

const TouchMetadataSchema = obj(
  {
    binding: opt(
      obj(
        {
          boundToCurrentDisk: opt(union([bool(), lit("unknown")])),
        },
        { open: true },
      ),
    ),
    inconclusive: opt(bool()),
    inconclusiveServerIds: opt(arr(str())),
    inconclusiveReason: opt(str()),
  },
  { open: true },
);
const isTouchMetadata = compile(TouchMetadataSchema).check;

interface InconclusiveAttribution {
  inconclusiveServerIds?: string[];
  inconclusiveReason?: string;
}

function readBoundToCurrentDisk<T>(rawDiags: T): BoundToCurrentDisk | undefined {
  return isTouchMetadata(rawDiags) ? rawDiags.binding?.boundToCurrentDisk : undefined;
}

function readInconclusive<T>(rawDiags: T): boolean {
  return isTouchMetadata(rawDiags) && rawDiags.inconclusive === true;
}

function readInconclusiveAttribution<T>(rawDiags: T): InconclusiveAttribution {
  const attribution: InconclusiveAttribution = {};
  if (!isTouchMetadata(rawDiags)) return attribution;
  if (rawDiags.inconclusiveServerIds?.length) {
    attribution.inconclusiveServerIds = [...rawDiags.inconclusiveServerIds];
  }
  if (rawDiags.inconclusiveReason) {
    attribution.inconclusiveReason = rawDiags.inconclusiveReason;
  }
  return attribution;
}

function isConfirmedTouch(rawDiags: TouchFileResult): boolean {
  return (
    !readInconclusive(rawDiags) &&
    touchCoverageGap(rawDiags).length === 0 &&
    readBoundToCurrentDisk(rawDiags) !== false
  );
}

type ReverseDepsCacheEntry = {
  index: ReverseDependencyIndex;
  savedToSnapshot: boolean;
  generation: number | undefined;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const reverseDepsIndexCache = new Map<string, ReverseDepsCacheEntry>();
const REVERSE_DEPS_MAX_WARM_ROOTS = 8;
const REVERSE_DEPS_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function reverseDepsIdleEvictMs(): number {
  const value = Number.parseInt(process.env.CHOCO_PI_LSP_REVERSE_DEPS_IDLE_EVICT_MS ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : REVERSE_DEPS_IDLE_EVICT_MS_DEFAULT;
}

registerIdleTimerRelease(() => {
  for (const entry of reverseDepsIndexCache.values()) {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
});

function deleteReverseDepsEntry(key: string): void {
  const entry = reverseDepsIndexCache.get(key);
  if (entry?.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  if (entry) entry.idleTimer = undefined;
  reverseDepsIndexCache.delete(key);
}

function touchReverseDepsEntry(
  key: string,
  entry: ReverseDepsCacheEntry,
  armIdleTimer = true,
): void {
  entry.lastUsedAt = Date.now();
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  if (!armIdleTimer || idleEvictionTimersSuspended()) return;
  const stamp = entry.lastUsedAt;
  entry.idleTimer = setTimeout(() => {
    if (reverseDepsIndexCache.get(key) !== entry || entry.lastUsedAt !== stamp) return;
    deleteReverseDepsEntry(key);
  }, reverseDepsIdleEvictMs());
  entry.idleTimer.unref?.();
}

function setReverseDepsEntry(
  key: string,
  entry: Omit<ReverseDepsCacheEntry, "lastUsedAt" | "idleTimer">,
  armIdleTimer = true,
): void {
  const resident: ReverseDepsCacheEntry = { ...entry, lastUsedAt: Date.now() };
  reverseDepsIndexCache.set(key, resident);
  touchReverseDepsEntry(key, resident, armIdleTimer);
  while (reverseDepsIndexCache.size > REVERSE_DEPS_MAX_WARM_ROOTS) {
    const victim = [...reverseDepsIndexCache.entries()].sort(
      ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
    )[0];
    if (!victim) break;
    deleteReverseDepsEntry(victim[0]);
  }
}

function reverseDepsReuseEnabled(): boolean {
  const raw = process.env.CHOCO_PI_LSP_REVERSE_DEPS_REUSE;
  return raw !== "0" && raw !== "false";
}

export function clearReverseDepsIndexCache(): void {
  for (const key of reverseDepsIndexCache.keys()) deleteReverseDepsEntry(key);
}

export function _getReverseDepsIndexCacheKeysForTests(): string[] {
  return [...reverseDepsIndexCache.entries()]
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
    .map(([key]) => key);
}

export function _seedReverseDepsIndexCacheForTests(
  key: string,
  index: ReverseDependencyIndex,
  generation?: number,
): void {
  setReverseDepsEntry(key, { index, savedToSnapshot: false, generation });
}

const CASCADE_TRANSITIVE_DEPTH = Math.max(
  1,
  Number.parseInt(process.env.CHOCO_PI_LSP_CASCADE_TRANSITIVE_DEPTH ?? "2", 10) || 2,
);
export const CASCADE_GRAPH_KINDS = new Set(["jsts", "python", "go", "rust", "ruby", "cxx"]);

function isIgnoredCascadeNeighbor(filePath: string, cwd: string): boolean {
  try {
    return getProjectIgnoreMatcher(cwd).isIgnored(filePath, false);
  } catch {
    return false;
  }
}

function updateWordIndexForCascade(args: {
  wordIndex?: WordIndex | null;
  filePath: string;
  content?: string;
  onUpdated?: (index: WordIndex) => void;
  dbg?: (msg: string) => void;
}): void {
  const { wordIndex, filePath, content, onUpdated, dbg } = args;
  if (!wordIndex || !wordIndex.forward) return;
  if (content === undefined) return;

  const byteLength = Buffer.byteLength(content, "utf-8");
  if (byteLength > WORD_INDEX_MAX_BYTES) {
    removeWordIndexDocument(wordIndex, filePath);
    dbg?.(`word-index per-edit: dropped ${filePath} (over size cap)`);
  } else {
    updateWordIndexDocument(wordIndex, { path: filePath, content });
    dbg?.(`word-index per-edit: updated ${filePath}`);
  }
  onUpdated?.(wordIndex);
}

export async function computeCascadeForFile(
  filePath: string,
  cwd: string,
  options: {
    hasBlockers?: boolean;
    dbg?: (msg: string) => void;
    turnSeq?: number;
    writeSeq?: number;
    seqState?: {
      projectSeq: () => number;
      getFilesChangedSince: (seq: number) => string[];
    };
    turnEndCascadeSettleStart?: () => number | undefined;
    fileContent?: string;
    wordIndex?: WordIndex | null;
    onWordIndexUpdated?: (index: WordIndex) => void;
  } = {},
): Promise<CascadeRun> {
  const reverseDepsTimersToRelease = new Set<string>();
  const reverseDepsEntriesAtStart = new Set(reverseDepsIndexCache.values());
  const cascadeStart = Date.now();
  try {
    const {
      hasBlockers = false,
      dbg,
      turnSeq = 0,
      writeSeq,
      seqState,
      turnEndCascadeSettleStart,
      fileContent,
      wordIndex,
      onWordIndexUpdated,
    } = options;

    ensureCascadeTurnScope(turnSeq);

    if (hasBlockers) {
      logCascade({
        phase: "cascade_skip",
        filePath,
        reason: "primary_has_blockers",
      });
      return {
        filePath,
        result: undefined,
        neighborCount: 0,
        diagnosticCount: 0,
        skipReason: "blockers",
      };
    }

    const fileKind = detectFileKind(filePath);
    if (!fileKind) {
      logCascade({ phase: "cascade_skip", filePath, reason: "non_code_file" });
      return {
        filePath,
        result: undefined,
        neighborCount: 0,
        diagnosticCount: 0,
        skipReason: "non_code",
      };
    }

    const normalizedFile = resolveRunnerPath(cwd, filePath);
    const normalizedFileKey = normalizeMapKey(normalizedFile);

    primaryFilesThisTurn.add(normalizedFileKey);

    updateWordIndexForCascade({
      wordIndex,
      filePath: nodePath.resolve(filePath),
      content: fileContent,
      onUpdated: onWordIndexUpdated,
      dbg,
    });

    let impact: ReturnType<typeof computeImpactCascade> = {
      filePath: normalizedFile,
      changedSymbols: [],
      directImporters: [],
      directCallers: [],
      neighborFiles: [],
      riskFlags: [],
    };
    let sortedNeighbors: string[] = [];
    let importerSet = new Set<string>();
    let callerSet = new Set<string>();
    let referenceCount = 0;
    let cascadeCandidateCount = 0;
    let cascadeEligibleCount = 0;
    let cascadeFilterDroppedCount = 0;
    let cascadeBudgetTruncated = 0;
    let transitiveTruncated = false;
    let cascadeNeighbourBudget = CASCADE_NEIGHBOUR_BUDGET;
    let cascadeBudgetRemainingMs = 0;
    let cascadeBudgetZone: CascadeBudgetZone = "fits";
    let cascadeDeliveryWindowMs = 0;

    if (CASCADE_GRAPH_KINDS.has(fileKind)) {
      const graphStart = Date.now();
      const graph = await buildOrUpdateGraph(cwd, [normalizedFile], sessionFacts, seqState);
      const graphMs = Date.now() - graphStart;
      const graphBuildInfo = getGraphBuildInfoForGraph(graph);
      const graphBuildInfoTrustworthy = graphBuildInfoIsTrustworthy(graph);
      const workspaceKey = normalizeMapKey(cwd);
      const cachedReverseDeps = reverseDepsIndexCache.get(workspaceKey);
      if (cachedReverseDeps) {
        touchReverseDepsEntry(workspaceKey, cachedReverseDeps, false);
        reverseDepsTimersToRelease.add(workspaceKey);
      }
      const importDelta = getGraphImportChanges(graph);
      const deltaContiguous =
        importDelta !== undefined &&
        importDelta.fromGeneration !== undefined &&
        cachedReverseDeps !== undefined &&
        cachedReverseDeps.generation === importDelta.fromGeneration;
      const importChanges = deltaContiguous ? importDelta.changes : undefined;
      const importsChanged = importChanges?.some(
        (change) =>
          change.existedBefore !== change.existsAfter ||
          change.priorTargets.length !== change.newTargets.length ||
          change.priorTargets.some((target, index) => target !== change.newTargets[index]),
      );
      const canReuse =
        reverseDepsReuseEnabled() &&
        cachedReverseDeps !== undefined &&
        ((graph.buildGeneration !== undefined &&
          cachedReverseDeps.generation === graph.buildGeneration) ||
          (importChanges !== undefined && !importsChanged));

      let reverseDepsIndex: ReverseDependencyIndex;
      let reverseDepsSaved: boolean;
      if (canReuse && cachedReverseDeps) {
        reverseDepsIndex = cachedReverseDeps.index;
        reverseDepsSaved = cachedReverseDeps.savedToSnapshot;
        cachedReverseDeps.generation = graph.buildGeneration;
        logCascade({
          phase: "reverse_deps_cache",
          filePath,
          durationMs: Date.now() - graphStart,
          metadata: {
            action: "reused_unchanged",
            savedToSnapshot: reverseDepsSaved,
            importsFileCount: Object.keys(reverseDepsIndex.imports).length,
            importedByFileCount: Object.keys(reverseDepsIndex.importedBy).length,
          },
        });
      } else if (cachedReverseDeps && importChanges && importsChanged) {
        reverseDepsIndex = patchReverseDependencyIndex(cachedReverseDeps.index, importChanges);
        reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
          cwd,
          index: reverseDepsIndex,
          dbg,
        });
        setReverseDepsEntry(
          workspaceKey,
          {
            index: reverseDepsIndex,
            savedToSnapshot: reverseDepsSaved,
            generation: graph.buildGeneration,
          },
          false,
        );
        reverseDepsTimersToRelease.add(workspaceKey);
        logCascade({
          phase: "reverse_deps_cache",
          filePath,
          durationMs: Date.now() - graphStart,
          metadata: {
            action: "patched_import_changes",
            changedFileCount: importChanges.length,
            savedToSnapshot: reverseDepsSaved,
          },
        });
      } else {
        reverseDepsIndex = buildReverseDependencyIndexFromGraph({
          cwd,
          graph,
        });
        reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
          cwd,
          index: reverseDepsIndex,
          dbg,
        });
        setReverseDepsEntry(
          workspaceKey,
          {
            index: reverseDepsIndex,
            savedToSnapshot: reverseDepsSaved,
            generation: graph.buildGeneration,
          },
          false,
        );
        reverseDepsTimersToRelease.add(workspaceKey);
        logCascade({
          phase: "reverse_deps_cache",
          filePath,
          durationMs: Date.now() - graphStart,
          metadata: {
            action: "refresh_from_review_graph",
            savedToSnapshot: reverseDepsSaved,
            importsFileCount: Object.keys(reverseDepsIndex.imports).length,
            importedByFileCount: Object.keys(reverseDepsIndex.importedBy).length,
            importEdgeCount: Object.values(reverseDepsIndex.imports).reduce(
              (total, imports) => total + imports.length,
              0,
            ),
          },
        });
      }

      const graphFileCount = new Set(
        [...graph.nodes.values()].flatMap((n) => (n.filePath ? [n.filePath] : [])),
      ).size;

      logCascade({
        phase: "graph_build",
        filePath,
        graphBuiltMs: graphMs,
        graphReused: graphBuildInfo.reused,
        graphNodeCount: graph.nodes.size,
        graphFileCount,
        graphChangedSymbolCount: (graph.changedSymbolsByFile.get(normalizedFileKey) ?? []).length,
        metadata: {
          graphBuildMode: graphBuildInfo.mode,
          skipReason: graphBuildInfo.skipReason,
          sourceFileCount: graphBuildInfo.sourceFileCount,
          maxFileCount: graphBuildInfo.maxFileCount,
          seqFastpathFallback: graphBuildInfo.seqFastpathFallback,
        },
      });

      impact = computeImpactCascade(graph, normalizedFile, cwd);
      if (
        (graphBuildInfo.mode === "skipped" ||
          graph.persistCoverage?.partial === true ||
          !graphBuildInfoTrustworthy) &&
        !impact.indeterminate
      ) {
        const coverage = graph.persistCoverage;
        impact.indeterminate = {
          reason: "graph_degraded",
          detail: !graphBuildInfoTrustworthy
            ? "review graph coverage unknown — build state unavailable for this graph"
            : graphBuildInfo.mode === "skipped"
              ? graphBuildInfo.skipReason === "too_many_files"
                ? graphBuildInfo.sourceFileCountTruncated
                  ? `review graph disabled — more than ${graphBuildInfo.maxFileCount ?? "?"} files (cap ${graphBuildInfo.maxFileCount ?? "?"})`
                  : `review graph disabled — ${graphBuildInfo.sourceFileCount ?? "?"} files over the ${graphBuildInfo.maxFileCount ?? "?"} cap`
                : graphBuildInfo.skipReason === "unsafe_root"
                  ? "review graph skipped — workspace root is at/above home dir"
                  : `review graph unavailable (${graphBuildInfo.skipReason ?? "skipped"})`
              : coverage?.sourceFilesTruncated
                ? "review graph partial — source walk stopped at its visited-entry budget"
                : "review graph partial — persisted graph coverage is incomplete",
          sourceFileCount: graphBuildInfo.sourceFileCount,
          maxFileCount: graphBuildInfo.maxFileCount,
        };
      }
      const reverseDepNeighbors = getAffectedFilesFromIndex(
        reverseDepsIndex,
        normalizedFile,
        1,
        MAX_FILES * 2,
      );
      logCascade({
        phase: "reverse_deps_cache",
        filePath,
        metadata: {
          action: "merge_neighbors",
          depth: 1,
          neighborCount: reverseDepNeighbors.length,
          neighbors: reverseDepNeighbors.slice(0, 10),
        },
      });
      if (reverseDepNeighbors.length > 0) {
        impact.directImporters = [...new Set([...impact.directImporters, ...reverseDepNeighbors])];
        impact.neighborFiles = [...new Set([...impact.neighborFiles, ...reverseDepNeighbors])];
        logCascade({
          phase: "neighbor_snapshot",
          filePath,
          neighborFile: "[reverse-deps-cache]",
          diagnosticCount: reverseDepNeighbors.length,
          autoPropagate: false,
          metadata: { reverseDepsCache: true },
        });
      }

      if (impact.changedSymbols.length > 0) {
        const lspService = getLSPService();
        const symbolNodeIds = graph.symbolNodesByFile.get(normalizedFileKey) ?? [];
        const refFiles = new Set<string>();
        const refsStart = Date.now();
        for (const symbolName of impact.changedSymbols.slice(0, 3)) {
          const symbolNodeId = symbolNodeIds.find((id) => {
            const node = graph.nodes.get(id);
            return node?.symbolName === symbolName;
          });
          if (!symbolNodeId) continue;
          const node = graph.nodes.get(symbolNodeId);
          const line = Number(node?.metadata?.line ?? 0);
          const column = Number(node?.metadata?.column ?? 0);
          if (line <= 0) continue;
          let refsTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const refs = await Promise.race([
              lspService.references(normalizedFile, line - 1, column - 1, false),
              new Promise<never>((_, reject) => {
                refsTimer = setTimeout(() => reject(new Error("timeout")), 750);
              }),
            ]);
            for (const ref of refs) {
              let resolved: string;
              try {
                resolved = ref.uri.startsWith("file://") ? fileURLToPath(ref.uri) : ref.uri;
              } catch {
                continue;
              }
              if (normalizeMapKey(resolved) !== normalizedFileKey && nodeFs.existsSync(resolved)) {
                refFiles.add(normalizeMapKey(resolved));
              }
            }
          } catch {
          } finally {
            if (refsTimer !== undefined) clearTimeout(refsTimer);
          }
          if (Date.now() - refsStart > 1200) break;
        }
        if (refFiles.size > 0) {
          impact.neighborFiles = [...new Set([...impact.neighborFiles, ...refFiles])];
          logCascade({
            phase: "neighbor_snapshot",
            filePath,
            neighborFile: "[lsp-references]",
            diagnosticCount: refFiles.size,
            durationMs: Date.now() - refsStart,
            autoPropagate: false,
            metadata: { lspReferences: true },
          });
        }
      }

      {
        const settleStart = turnEndCascadeSettleStart?.();
        const elapsedMs = turnEndCascadeSettleStart
          ? settleStart !== undefined && Number.isFinite(settleStart)
            ? Math.max(0, Date.now() - settleStart)
            : 0
          : Date.now() - cascadeStart;
        const decision = deriveCascadeNeighbourBudget({ elapsedMs });
        cascadeNeighbourBudget = decision.budget;
        cascadeBudgetRemainingMs = decision.remainingMs;
        cascadeBudgetZone = decision.zone;
        cascadeDeliveryWindowMs = decision.deliveryWindowMs;
      }

      if (CASCADE_TRANSITIVE_DEPTH > 1) {
        const transitive = computeTransitiveImpact(graph, normalizedFile, {
          maxDepth: CASCADE_TRANSITIVE_DEPTH,
          maxHits: cascadeNeighbourBudget,
        });
        transitiveTruncated = transitive.truncated;
        const added = [
          ...new Set(
            transitive.hits
              .map((hit) => hit.file)
              .filter((file) => file && normalizeMapKey(file) !== normalizedFileKey),
          ),
        ].filter((file) => !impact.neighborFiles.includes(file));
        if (added.length > 0) {
          impact.neighborFiles = [...impact.neighborFiles, ...added];
          logCascade({
            phase: "neighbor_snapshot",
            filePath,
            neighborFile: "[transitive-impact]",
            diagnosticCount: added.length,
            autoPropagate: false,
            metadata: {
              transitive: true,
              maxDepth: CASCADE_TRANSITIVE_DEPTH,
              maxDepthReached: transitive.maxDepthReached,
              truncated: transitive.truncated,
            },
          });
        }
      }

      cascadeCandidateCount = impact.neighborFiles.length;
      impact.directImporters = impact.directImporters.filter((f) => !isTestRoleCollateral(f));
      impact.directCallers = impact.directCallers.filter((f) => !isTestRoleCollateral(f));
      impact.neighborFiles = impact.neighborFiles.filter((f) => !isTestRoleCollateral(f));

      importerSet = new Set(impact.directImporters);
      callerSet = new Set(impact.directCallers);
      const importerOrCallerSet = new Set([...impact.directImporters, ...impact.directCallers]);
      referenceCount = impact.neighborFiles.filter((n) => !importerOrCallerSet.has(n)).length;
      const eligibleNeighbors = [...impact.neighborFiles]
        .filter((n) => nodeFs.existsSync(n))
        .filter((n) => !isExternalOrVendorFile(n, cwd))
        .filter((n) => !isIgnoredCascadeNeighbor(n, cwd))
        .filter((n) => !primaryFilesThisTurn.has(normalizeMapKey(n)))
        .sort((a, b) => {
          const rank = (p: string) => (importerSet.has(p) ? 0 : callerSet.has(p) ? 1 : 2);
          return rank(a) - rank(b);
        });
      cascadeEligibleCount = eligibleNeighbors.length;
      cascadeFilterDroppedCount = Math.max(0, cascadeCandidateCount - cascadeEligibleCount);
      cascadeBudgetTruncated = Math.max(0, eligibleNeighbors.length - cascadeNeighbourBudget);
      sortedNeighbors = eligibleNeighbors.slice(0, cascadeNeighbourBudget);
      if (cascadeBudgetTruncated > 0 || transitiveTruncated) {
        const budget = {
          candidateCount: cascadeCandidateCount,
          eligibleCount: cascadeEligibleCount,
          selectedCount: sortedNeighbors.length,
          truncatedCount: cascadeBudgetTruncated,
          ...(transitiveTruncated && { transitiveTruncated: true }),
        };
        const detailParts = [
          ...(cascadeBudgetTruncated > 0
            ? [
                `cascade neighbor budget checked ${budget.selectedCount} of ${budget.eligibleCount} eligible dependents ` +
                  `(${budget.truncatedCount} omitted)`,
              ]
            : []),
          ...(transitiveTruncated
            ? ["transitive expansion was capped before all eligible dependents were enumerated"]
            : []),
        ];
        const detail = detailParts.join("; ");
        impact.indeterminate = impact.indeterminate
          ? {
              ...impact.indeterminate,
              detail: impact.indeterminate.detail
                ? `${impact.indeterminate.detail}; ${detail}`
                : detail,
              budget,
            }
          : { reason: "budget_truncated", detail, budget };
      }
    } else {
      logCascade({
        phase: "cascade_skip",
        filePath,
        reason: "unsupported_graph_kind",
        metadata: { fileKind },
      });
      return {
        filePath,
        result: undefined,
        neighborCount: 0,
        diagnosticCount: 0,
        skipReason: "non_code",
      };
    }

    logCascade({
      phase: "neighbors_computed",
      filePath,
      neighborCount: sortedNeighbors.length,
      totalNeighborCount: impact.neighborFiles.length,
      importerCount: impact.directImporters.length,
      callerCount: impact.directCallers.length,
      referenceCount: Math.max(0, referenceCount),
      riskFlags: impact.riskFlags,
      metadata: {
        neighbors: sortedNeighbors.slice(0, 10),
        candidateNeighborCount: cascadeCandidateCount,
        eligibleNeighborCount: cascadeEligibleCount,
        filterDroppedCount: cascadeFilterDroppedCount,
        budgetTrimmedCount: cascadeBudgetTruncated,
      },
    });

    const lspService = getLSPService();

    const allDiags = await lspService.getAllDiagnostics();

    const neighbors: CascadeResult["neighbors"] = [];
    let producedLspData = false;
    let coldSnapshotPaths: string[] = [];
    let fallbackBindingRejected = false;
    const noLspCandidatePaths = new Set<string>();
    let collectLaterSkipped = 0;
    let recentlyCleanHits = 0;
    let cacheHits = 0;
    let deferredTouches = 0;
    let coldTouches = 0;
    let passiveSnapshotHits = 0;
    let noLspConfigured = 0;
    let touchFailures = 0;

    if (sortedNeighbors.length > 0) {
      const snapshotPaths = sortedNeighbors.filter(shouldReadCascadeFromSnapshot);
      const activePaths = sortedNeighbors.filter((n) => !shouldReadCascadeFromSnapshot(n));

      coldSnapshotPaths = [];
      for (const neighborPath of snapshotPaths) {
        const neighborStart = Date.now();
        const entry = allDiags.get(normalizeMapKey(neighborPath));
        const snapshotAgeSec = entry ? Math.round((Date.now() - entry.ts) / 1000) : undefined;
        const ttlFresh = entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;
        const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
          ? readBoundToCurrentDisk(entry)
          : undefined;
        const bindingRejected = boundToDisk === false;
        const snapshotValid = ttlFresh && !bindingRejected;

        if (!snapshotValid) {
          logCascade({
            phase: "neighbor_snapshot",
            filePath,
            neighborFile: neighborPath,
            diagnosticCount: 0,
            durationMs: Date.now() - neighborStart,
            autoPropagate: true,
            snapshotMissing: entry == null,
            snapshotAgeSec,
            coldSnapshot: true,
            ...(bindingRejected && {
              metadata: { bindingState: bindingStateLabel(boundToDisk) },
            }),
          });
          coldSnapshotPaths.push(neighborPath);
          continue;
        }

        const diags = convertLspDiagnostics(
          entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
          neighborPath,
        );
        producedLspData = true;
        passiveSnapshotHits++;
        const durationMs = Date.now() - neighborStart;

        logCascade({
          phase: "neighbor_snapshot",
          filePath,
          neighborFile: neighborPath,
          diagnosticCount: diags.length,
          durationMs,
          autoPropagate: true,
          snapshotMissing: false,
          snapshotAgeSec,
        });

        reconcileCascadeNeighborLspErrors(
          neighborPath,
          cascadeReconcilableLspErrors(entry.diags, neighborPath),
          writeSeq,
          entry.ts,
        );

        neighbors.push({
          filePath: neighborPath,
          reason: neighborReason(importerSet, callerSet, neighborPath),
          diagnostics: diags,
          lspTouched: false,
          durationMs,
        });
      }

      const touchResults = await Promise.allSettled(
        [...activePaths, ...coldSnapshotPaths].map(async (neighborPath) => {
          const isColdSnapshot = coldSnapshotPaths.includes(neighborPath);
          const neighborStart = Date.now();
          const cacheKey = normalizeMapKey(neighborPath);

          const passiveEntry = allDiags.get(cacheKey);
          const hasFreshPassiveErrors =
            passiveEntry != null &&
            Date.now() - passiveEntry.ts < CASCADE_TTL_MS &&
            passiveEntry.diags.some((d) => d.severity === 1);
          const recentlyClean = recentlyCleanNeighborCache.get(cacheKey);
          if (
            recentlyClean &&
            turnSeq - recentlyClean.turnSeq <= RECENTLY_CLEAN_TTL_TURNS &&
            !hasFreshPassiveErrors
          ) {
            producedLspData = true;
            recentlyCleanHits++;
            const durationMs = Date.now() - neighborStart;
            logCascade({
              phase: "neighbor_snapshot",
              filePath,
              neighborFile: neighborPath,
              diagnosticCount: 0,
              durationMs,
              autoPropagate: false,
              snapshotMissing: false,
              metadata: {
                recentlyClean: true,
                cleanTurnSeq: recentlyClean.turnSeq,
              },
            });
            return {
              filePath: neighborPath,
              reason: neighborReason(importerSet, callerSet, neighborPath),
              diagnostics: [],
              lspTouched: false,
              durationMs,
            } satisfies CascadeResult["neighbors"][number];
          }

          const cached = writeSeq != null ? neighborTouchCache.get(cacheKey) : undefined;
          if (cached?.turnSeq === turnSeq && cached?.writeSeq === writeSeq) {
            producedLspData = true;
            cacheHits++;
            const durationMs = Date.now() - neighborStart;
            logCascade({
              phase: "neighbor_snapshot",
              filePath,
              neighborFile: neighborPath,
              diagnosticCount: cached.diagnostics.length,
              durationMs,
              autoPropagate: false,
              snapshotMissing: false,
              metadata: { cachedWriteSeq: writeSeq },
            });
            return {
              filePath: neighborPath,
              reason: neighborReason(importerSet, callerSet, neighborPath),
              diagnostics: cached.diagnostics,
              lspTouched: false,
              durationMs,
            } satisfies CascadeResult["neighbors"][number];
          }

          const configuredServerCount = getServersForFileWithConfig(neighborPath).length;
          if (configuredServerCount === 0) {
            noLspConfigured++;
            noLspCandidatePaths.add(cacheKey);
            logCascade({
              phase: "neighbor_fallback",
              filePath,
              neighborFile: neighborPath,
              fallbackUsed: false,
              error: "no_lsp_server_configured",
            });
            return undefined;
          }

          const content = await nodeFs.promises.readFile(neighborPath, "utf8");

          if (isTierAwareCascadeEnabled()) {
            try {
              const snapshots = (await lspService.getCapabilitySnapshots?.(neighborPath)) ?? [];
              const tier = classifyCascadeWaitTier(lspService, neighborPath, snapshots);
              if (tier === "tier3-silent" || tier === "collect-later") {
                const spawnedForTouch = await lspService.getClientForFile(neighborPath);
                if (spawnedForTouch) {
                  const touchedAt = Date.now();
                  await lspService.touchFile(neighborPath, content, {
                    diagnostics: "none",
                    collectDiagnostics: false,
                    silent: true,
                    source: "cascade",
                    clientScope: "primary",
                  });
                  recordOutstandingCascadeTouch({
                    filePath: neighborPath,
                    serverId: spawnedForTouch.client.serverId,
                    touchedAt,
                  });
                  const durationMs = Date.now() - neighborStart;
                  if (tier === "collect-later") collectLaterSkipped++;
                  deferredTouches++;
                  logCascade({
                    phase: "cascade_tier3_skip",
                    filePath,
                    neighborFile: neighborPath,
                    durationMs,
                    lspServerCount: configuredServerCount,
                    coldSnapshot: isColdSnapshot,
                    metadata: {
                      serverId: spawnedForTouch.client.serverId,
                      waitTier: tier,
                    },
                  });
                  return undefined;
                }
              }
            } catch (tierErr) {
              dbg?.(
                `cascade tier-aware skip attempt failed for ${neighborPath}, falling back to full wait: ${tierErr}`,
              );
            }
          }

          coldTouches++;
          const rawDiags = await lspService.touchFile(neighborPath, content, {
            diagnostics: "document",
            collectDiagnostics: true,
            maxClientWaitMs: isColdSnapshot ? 1000 : 2000,
            silent: true,
            source: "cascade",
            clientScope: "primary",
          });
          if (!rawDiags) return undefined;
          const confirmed = isConfirmedTouch(rawDiags);
          const bindingRejected = readBoundToCurrentDisk(rawDiags) === false;
          const inconclusive = readInconclusive(rawDiags);
          const unconfirmedServerIds = touchCoverageGap(rawDiags);
          const diags = convertLspDiagnostics(
            rawDiags.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
            neighborPath,
          );
          const durationMs = Date.now() - neighborStart;

          if (writeSeq != null && confirmed) {
            neighborTouchCache.set(cacheKey, {
              turnSeq,
              writeSeq,
              diagnostics: diags,
            });
          }
          if (diags.length === 0) {
            if (confirmed) {
              recentlyCleanNeighborCache.set(cacheKey, {
                turnSeq,
                checkedAt: Date.now(),
              });
            }
          } else {
            recentlyCleanNeighborCache.delete(cacheKey);
          }
          producedLspData = true;

          logCascade({
            phase: "neighbor_touch",
            filePath,
            neighborFile: neighborPath,
            diagnosticCount: diags.length,
            durationMs,
            lspTouched: true,
            lspServerCount: configuredServerCount,
            coldSnapshot: isColdSnapshot,
            metadata: {
              inconclusive,
              ...(inconclusive && readInconclusiveAttribution(rawDiags)),
              ...(bindingRejected && {
                bindingState: bindingStateLabel(false),
              }),
              ...(unconfirmedServerIds.length > 0 && {
                unconfirmedServerIds: [...unconfirmedServerIds],
              }),
            },
          });

          if (confirmed) {
            reconcileCascadeNeighborLspErrors(
              neighborPath,
              cascadeReconcilableLspErrors(rawDiags.diags, neighborPath),
              writeSeq,
            );
          }

          return {
            filePath: neighborPath,
            reason: neighborReason(importerSet, callerSet, neighborPath),
            diagnostics: diags,
            lspTouched: true as const,
            ...(inconclusive && { inconclusive: true as const }),
            ...(unconfirmedServerIds.length > 0 && {
              unconfirmedServerIds: [...unconfirmedServerIds],
            }),
            durationMs,
          } satisfies CascadeResult["neighbors"][number];
        }),
      );

      const allTouchPaths = [...activePaths, ...coldSnapshotPaths];
      for (let i = 0; i < touchResults.length; i++) {
        const result = touchResults[i];
        const neighborPath = allTouchPaths[i];
        if (result.status === "fulfilled") {
          if (result.value) neighbors.push(result.value);
        } else {
          touchFailures++;
          dbg?.(`cascade neighbor touch error for ${neighborPath}: ${result.reason}`);
          const entry = allDiags.get(normalizeMapKey(neighborPath));
          const ttlFresh = entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;
          const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
            ? readBoundToCurrentDisk(entry)
            : undefined;
          const bindingRejected = boundToDisk === false;
          if (bindingRejected) fallbackBindingRejected = true;
          logCascade({
            phase: "neighbor_fallback",
            filePath,
            neighborFile: neighborPath,
            fallbackUsed: true,
            error: String(result.reason),
            ...(bindingRejected && {
              metadata: { bindingState: bindingStateLabel(boundToDisk) },
            }),
          });
          const diags =
            ttlFresh && !bindingRejected
              ? convertLspDiagnostics(
                  entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
                  neighborPath,
                )
              : [];
          neighbors.push({
            filePath: neighborPath,
            reason: "fallback",
            diagnostics: diags,
            lspTouched: false,
          });
        }
      }
    }

    if (producedLspData && noLspCandidatePaths.size > 0) {
      const bindingRejected = appendFallbackNeighbors(
        neighbors,
        allDiags,
        normalizedFileKey,
        cwd,
        filePath,
        noLspCandidatePaths,
      );
      if (bindingRejected) fallbackBindingRejected = true;
    } else if (!producedLspData) {
      const bindingRejected = appendFallbackNeighbors(
        neighbors,
        allDiags,
        normalizedFileKey,
        cwd,
        filePath,
      );
      if (bindingRejected) fallbackBindingRejected = true;
      if (neighbors.some((n) => n.reason === "fallback")) {
        logCascade({
          phase: "neighbor_fallback",
          filePath,
          fallbackUsed: true,
          neighborCount: neighbors.length,
        });
      }
    }

    const visibleNeighbors = applyCascadeDeltaBaselines(neighbors);

    const formatted = formatCascadeResult(
      cwd,
      impact,
      visibleNeighbors,
      impact.neighborFiles.length,
    );

    if (!formatted && fallbackBindingRejected && !impact.indeterminate) {
      impact.indeterminate = {
        reason: "lsp_binding_rejected",
        detail:
          "cascade fallback diagnostics were withheld — stale snapshot content did not match current disk (binding rejected)",
      };
    }

    const filesWithErrors = visibleNeighbors.filter((n) => n.diagnostics.length > 0).length;
    const selectedOutcomeCount =
      passiveSnapshotHits +
      cacheHits +
      recentlyCleanHits +
      deferredTouches +
      coldTouches +
      noLspConfigured;
    const selectedOutcomeGap = Math.max(0, sortedNeighbors.length - selectedOutcomeCount);
    logCascade({
      phase: "cascade_result",
      filePath,
      neighborCount: visibleNeighbors.length,
      diagnosticCount: visibleNeighbors.reduce((sum, n) => sum + n.diagnostics.length, 0),
      metadata: {
        filesWithErrors,
        hasOutput: formatted.length > 0,
        indeterminateReason: impact.indeterminate?.reason,
        candidateNeighborCount: cascadeCandidateCount,
        eligibleNeighborCount: cascadeEligibleCount,
        filterDroppedCount: cascadeFilterDroppedCount,
        selectedNeighborCount: sortedNeighbors.length,
        selectedOutcomeCount,
        selectedOutcomeGap,
        passiveSnapshotHits,
        noLspConfigured,
        touchFailures,
        collectLaterSkipped,
        noNeighbors: visibleNeighbors.length === 0,
        noErrors: visibleNeighbors.length > 0 && filesWithErrors === 0,
        cacheHits,
        recentlyCleanHits,
        deferredTouches,
        coldTouches,
        neighborBudget: cascadeNeighbourBudget,
        neighborBudgetCeiling: CASCADE_NEIGHBOUR_BUDGET,
        budgetRemainingMs: cascadeBudgetRemainingMs,
        budgetZone: cascadeBudgetZone,
        budgetDeliveryWindowMs: cascadeDeliveryWindowMs,
        budgetTruncated: cascadeBudgetTruncated,
        transitiveTruncated,
        budgetTrimmedCount: cascadeBudgetTruncated,
        budgetDerivationDisabled: cascadeBudgetZone === "no-rescue-window",
        budgetDerivationDisabledReason:
          cascadeBudgetZone === "no-rescue-window" ? "no-rescue-window" : undefined,
        neighbors: visibleNeighbors.slice(0, 10).map((n) => ({
          file: n.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/"),
          diagnostics: n.diagnostics.length,
        })),
      },
    });

    const diagCount = visibleNeighbors.reduce((sum, n) => sum + n.diagnostics.length, 0);

    cascadeSessionStats.runs += 1;
    cascadeSessionStats.diagnosticsSurfaced += diagCount;
    cascadeSessionStats.coldSnapshotTouches += coldSnapshotPaths.length;

    if (!formatted) {
      if (impact.indeterminate) {
        return {
          filePath,
          result: undefined,
          neighborCount: visibleNeighbors.length,
          diagnosticCount: diagCount,
          skipReason: "indeterminate",
          indeterminate: impact.indeterminate,
          selectedNeighborPaths: sortedNeighbors.slice(),
        };
      }
      const skipReason: CascadeSkipReason =
        visibleNeighbors.length === 0 ? "no_neighbors" : "clean";
      return {
        filePath,
        result: undefined,
        neighborCount: visibleNeighbors.length,
        diagnosticCount: diagCount,
        skipReason,
      };
    }

    getDiagnosticTracker().trackShown(visibleNeighbors.flatMap((n) => n.diagnostics));

    return {
      filePath,
      result: { filePath, impact, neighbors: visibleNeighbors, formatted },
      neighborCount: visibleNeighbors.length,
      diagnosticCount: diagCount,
      ...(impact.indeterminate && { indeterminate: impact.indeterminate }),
    };
  } finally {
    for (const key of reverseDepsTimersToRelease) {
      const entry = reverseDepsIndexCache.get(key);
      if (entry?.idleTimer !== undefined) clearTimeout(entry.idleTimer);
      if (entry) entry.idleTimer = undefined;
    }
    for (const [key, entry] of reverseDepsIndexCache) {
      if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      if (!reverseDepsTimersToRelease.has(key) && reverseDepsEntriesAtStart.has(entry)) {
        reverseDepsTimersToRelease.add(key);
      }
    }
    for (const timer of astGrepWarnDebounceTimers.values()) clearTimeout(timer);
    astGrepWarnDebounceTimers.clear();
    releaseWorkspaceTopologyIdleTimers();
  }
}

function diagnosticDeltaKey(diagnostic: import("./types.ts").Diagnostic): string {
  return [
    diagnostic.id,
    diagnostic.rule ?? "",
    diagnostic.line ?? 0,
    diagnostic.column ?? 0,
    diagnostic.message,
  ].join(":");
}

function applyCascadeDeltaBaselines(
  neighbors: CascadeResult["neighbors"],
): CascadeResult["neighbors"] {
  return neighbors.map((neighbor) => {
    const baselineKey = `session.baseline.cascade.${normalizeMapKey(neighbor.filePath)}`;
    const previous =
      cascadeDiagnosticBaselines.get(baselineKey) ??
      sessionFacts.getSessionFact<import("./types.ts").Diagnostic[]>(baselineKey);
    cascadeDiagnosticBaselines.set(baselineKey, [...neighbor.diagnostics]);
    sessionFacts.setSessionFact(baselineKey, [...neighbor.diagnostics]);
    if (!previous) return neighbor;
    const before = new Set(previous.map(diagnosticDeltaKey));
    return {
      ...neighbor,
      diagnostics: neighbor.diagnostics.filter(
        (diagnostic) => !before.has(diagnosticDeltaKey(diagnostic)),
      ),
    };
  });
}

function appendFallbackNeighbors(
  neighbors: CascadeResult["neighbors"],
  allDiags: Map<string, { diags: import("../lsp/client.ts").LSPDiagnostic[]; ts: number }>,
  normalizedFileKey: string,
  cwd: string,
  filePath: string,
  allowedPaths?: ReadonlySet<string>,
): boolean {
  const now = Date.now();
  const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
  let bindingRejected = false;
  for (const [diagPath, entry] of allDiags) {
    const { diags, ts } = entry;
    const diagKey = normalizeMapKey(diagPath);
    if (diagKey === normalizedFileKey || seen.has(diagKey)) continue;
    if (allowedPaths && !allowedPaths.has(diagKey)) continue;
    if (primaryFilesThisTurn.has(diagKey)) continue;
    if (isExternalOrVendorFile(diagPath, cwd)) continue;
    if (isIgnoredCascadeNeighbor(diagPath, cwd)) continue;
    if (isTestRoleCollateral(diagPath)) continue;
    if (!nodeFs.existsSync(diagPath)) continue;
    if (now - ts > CASCADE_TTL_MS) continue;
    const boundToDisk = readBoundToCurrentDisk(entry);
    if (boundToDisk === false) {
      bindingRejected = true;
      logCascade({
        phase: "neighbor_fallback",
        filePath,
        neighborFile: diagPath,
        fallbackUsed: false,
        metadata: { bindingState: bindingStateLabel(false) },
      });
      continue;
    }
    const errors = convertLspDiagnostics(
      diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
      diagPath,
    );
    if (errors.length === 0) continue;
    neighbors.push({
      filePath: diagPath,
      reason: "fallback",
      diagnostics: errors,
      lspTouched: false,
    });
    seen.add(diagKey);
    if (neighbors.length >= MAX_FILES) break;
  }
  return bindingRejected;
}

function shouldReadCascadeFromSnapshot(filePath: string): boolean {
  return getServersForFileWithConfig(filePath).some(
    (server) => server.autoPropagateDiagnostics === true,
  );
}

function neighborReason(
  importerSet: Set<string>,
  callerSet: Set<string>,
  neighborPath: string,
): CascadeResult["neighbors"][number]["reason"] {
  if (importerSet.has(neighborPath)) return "imports";
  if (callerSet.has(neighborPath)) return "calls";
  return "references";
}

function formatCascadeResult(
  cwd: string,
  impact: ReturnType<typeof computeImpactCascade>,
  neighbors: CascadeResult["neighbors"],
  totalNeighbors: number,
): string {
  const diagnosticsBlock = formatCascadeNeighborDiagnostics(cwd, neighbors, {
    noun: "neighbor",
    includeReason: true,
  });
  if (!diagnosticsBlock) return "";

  const impactHeader = formatImpactCascade(impact, RUNTIME_CONFIG.pipeline.cascadeMaxFiles);
  let out = impactHeader ? `${impactHeader}\n${diagnosticsBlock}` : diagnosticsBlock;

  const truncated = totalNeighbors - neighbors.length;
  if (truncated > 0) {
    const truncatedNames = impact.neighborFiles
      .slice(neighbors.length, neighbors.length + 3)
      .map((p) => toRunnerDisplayPath(cwd, p))
      .join(", ");
    const moreLabel = truncatedNames
      ? `${truncated} more dependent file(s): ${truncatedNames}`
      : `${truncated} more dependent file(s)`;
    out += `\n... and ${moreLabel}`;
  }

  return out;
}

export async function dispatchLint(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  modifiedRanges?: ModifiedRange[],
  projectRoot?: string,
): Promise<string> {
  const ctx = createDispatchContext(
    filePath,
    cwd,
    pi,
    sessionFacts,
    true,
    modifiedRanges,
    projectRoot,
  );
  sessionFacts.clearFileFactsFor(ctx.filePath);

  const kind = ctx.kind;
  if (!kind) return "";

  const groups = withSpotbugsGroup(kind, getDispatchGroupsForKind(kind, pi), ctx);
  if (groups.length === 0) return "";

  await runProviders(ctx);
  const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
  trackSessionSlopStats(ctx, result.diagnostics);
  return result.output;
}

export async function dispatchLintWithResult(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  modifiedRanges?: ModifiedRange[],
  logContext?: LogContext,
  options?: {
    blockingOnly?: boolean;
    projectRoot?: string;
    writeIndex?: number;
    telemetryModel?: string;
    telemetryProvider?: string;
  },
): Promise<DispatchResult> {
  const ctx = createDispatchContext(
    filePath,
    cwd,
    pi,
    sessionFacts,
    options?.blockingOnly ?? true,
    modifiedRanges,
    options?.projectRoot,
    options?.writeIndex,
    options?.telemetryModel,
    options?.telemetryProvider,
  );
  sessionFacts.clearFileFactsFor(ctx.filePath);

  const kind = ctx.kind;
  if (!kind) {
    return {
      diagnostics: [],
      blockers: [],
      warnings: [],
      baselineWarningCount: 0,
      fixed: [],
      resolvedCount: 0,
      output: "",
      blockerOutput: "",
      hasBlockers: false,
    };
  }

  const groups = withSpotbugsGroup(kind, getDispatchGroupsForKind(kind, pi), ctx);
  if (groups.length === 0) {
    return {
      diagnostics: [],
      blockers: [],
      warnings: [],
      baselineWarningCount: 0,
      fixed: [],
      resolvedCount: 0,
      output: "",
      blockerOutput: "",
      hasBlockers: false,
    };
  }

  await runProviders(ctx);
  const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
  trackSessionSlopStats(ctx, result.diagnostics);

  if (kind === "jsts" && logContext) {
    scheduleAstGrepWarningScan(filePath, cwd, pi, logContext);
  }

  return result;
}

export interface RunnerOutcome {
  runnerId: string;
  result: RunnerResult;
}

export async function dispatchLintDetailed(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  options?: {
    blockingOnly?: boolean;
    modifiedRanges?: ModifiedRange[];
    projectRoot?: string;
  },
): Promise<{ result: DispatchResult; runners: RunnerOutcome[] }> {
  const empty: DispatchResult = {
    diagnostics: [],
    blockers: [],
    warnings: [],
    baselineWarningCount: 0,
    fixed: [],
    resolvedCount: 0,
    output: "",
    blockerOutput: "",
    hasBlockers: false,
  };

  const ctx = createDispatchContext(
    filePath,
    cwd,
    pi,
    sessionFacts,
    options?.blockingOnly ?? false,
    options?.modifiedRanges,
    options?.projectRoot,
  );
  sessionFacts.clearFileFactsFor(ctx.filePath);

  const kind = ctx.kind;
  if (!kind) return { result: empty, runners: [] };

  const groups = withSpotbugsGroup(kind, getDispatchGroupsForKind(kind, pi), ctx);
  if (groups.length === 0) return { result: empty, runners: [] };

  const runners: RunnerOutcome[] = [];
  const sink: RunnerResultSink = (runnerId, result) => {
    runners.push({ runnerId, result });
  };

  await runProviders(ctx);
  const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry, sink);
  trackSessionSlopStats(ctx, result.diagnostics);

  return { result, runners };
}

export function shouldDispatch(filePath: string): boolean {
  const kind = detectFileKind(filePath);
  return kind !== undefined;
}

export async function getAvailableRunners(filePath: string): Promise<string[]> {
  const kind = detectFileKind(filePath);
  if (!kind) return [];

  const normalizedPath = filePath.replace(/\\/g, "/");
  const pathForFilter = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const runners = sessionRunnerRegistry.getForKind(kind, pathForFilter);
  return runners.map((r) => r.id);
}
