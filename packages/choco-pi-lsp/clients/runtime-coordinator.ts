import { isString, type LspBoundaryValue } from "./runtime-guards.ts";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionableWarningRecord } from "./actionable-warnings.ts";
import type { FunctionCallGraph } from "./call-graph.ts";
import type { WordIndex } from "./word-index.ts";
import type { CascadeRun } from "./cascade-types.ts";
import { logCascade } from "./cascade-logger.ts";
import type { CodeQualityWarningRecord } from "./code-quality-warnings.ts";
import type { FileComplexity } from "./complexity-client.ts";
import { normalizeMapKey, pathsEqual } from "./path-utils.ts";
import { PathKeyedMap } from "./path-keyed-map.ts";
import { BoundedLruCache } from "./bounded-cache.ts";
import { ReadGuard } from "./read-guard.ts";
import type { RuleScanResult } from "./rules-scanner.ts";
import { RUNTIME_CONFIG } from "./runtime-config.ts";
import { TurnSummaryCollector } from "./turn-summary.ts";
import { deriveProviderFromModelId } from "./model-provider.ts";

type RecordMutationToolReceiptResultContract = { autofixMode: "immediate" | "deferred" };
type BumpFileSeqResultContract = { projectSeq: number; fileSeq: number };
type ClaimDeferredFormatFilesResultContract = {
  claimed: DeferredFormatRecord[];
  staleClaimed: DeferredFormatRecord[];
  deferredToOwner: DeferredFormatRecord[];
  droppedOrphans: DeferredFormatRecord[];
};
type ReadHostModelIdentityResultContract = {
  model?: string;
  provider?: string;
};

export interface ErrorDebtBaseline {
  testsPassed: boolean;
  buildPassed: boolean;
}

export interface CascadeSessionStats {
  runs: number;
  diagnosticsSurfaced: number;
  coldSnapshotTouches: number;
}

export type DeferredMutationKind = "autofix" | "format";

export interface PathSetLike {
  add(value: string): PathSetLike;
  has(value: string): boolean;
  delete(value: string): boolean;
  clear(): void;
}

export interface DeferredMutationRecord {
  filePath: string;
  cwd: string;
  turnStateCwd: string;
  firstTouchedAt: number;
  lastTouchedAt: number;
  toolNames: Set<"write" | "edit">;
  kinds: Set<DeferredMutationKind>;
  queuedTurnIndex: number;
  ownerSessionId: string | undefined;
  originCwd: string;
}

export type DeferredFormatRecord = DeferredMutationRecord;

export interface InlineBlockerRecord {
  filePath: string;
  summary: string;
  writeIndex?: number;
  sources?: readonly string[];
  recordedAtMs?: number;
  stale?: boolean;
  staleReason?: "dependency-drift" | "past-eof";
  lines?: readonly number[];
}

export interface ToolCallAttribution {
  resolvedPath: string | undefined;
  skipped: boolean;
  originCwd: string;
  recordedAt: number;
}

const TOOL_CALL_ATTRIBUTION_CAPACITY = 256;

const TOOL_CALL_ATTRIBUTION_TTL_MS = 5 * 60_000;

export class RuntimeCoordinator {
  private _projectRoot = normalizeMapKey(process.cwd());
  private _sessionGeneration = 0;
  private _sessionStartedAt = Date.now();
  private _errorDebtBaseline: ErrorDebtBaseline | null = null;
  private _pipelineCrashCounts = new Map<string, number>();
  private _cachedExports = new Map<string, string>();
  private _startupScansInFlight = new Map<string, number>();
  private _cascadeRuns: CascadeRun[] = [];
  private _turnEndCascadeSettleStarts = new Map<number, number>();
  private _nextCascadeSettleToken = 0;
  private _pendingCascadeRuns: Promise<CascadeRun>[] = [];
  private _cascadeSessionStats: CascadeSessionStats = {
    runs: 0,
    diagnosticsSurfaced: 0,
    coldSnapshotTouches: 0,
  };
  private _complexityBaselines = new Map<string, FileComplexity>();
  private readonly _fixedThisTurn = new PathKeyedMap<true>(normalizeMapKey);
  private readonly _writtenThisTurn = new PathKeyedMap<true>(normalizeMapKey);
  private readonly _autofixDemotedThisTurn = new PathKeyedMap<true>(normalizeMapKey);
  private readonly _reportedThisTurn = new Set<string>();
  private _projectRulesScan: RuleScanResult = {
    rules: [],
    hasCustomRules: false,
  };
  private _telemetrySessionId = `lens-${Date.now().toString(36)}`;
  private _lifecycleReason: string | undefined;
  private _hasStableSessionId = false;
  private _telemetryModel = "unknown";
  private _telemetryModelId = "";
  private _telemetryProvider = "";
  private _telemetryProviderIsExplicit = false;
  private _turnIndex = 0;
  private _writeIndex = 0;
  private _projectSeq = 0;
  private _turnStartProjectSeq = 0;
  private readonly _fileSeq = new Map<string, number>();
  private readonly _fileLastProjectSeq = new Map<string, number>();
  private _gitGuardHasBlockers = false;
  private _gitGuardSummary = "";
  private _gitGuardCacheUnknownReason: string | undefined;
  callGraph: FunctionCallGraph | null = null;
  wordIndex: WordIndex | null = null;
  private _readGuard: ReadGuard | null = null;
  private readonly _pendingDeferredMutations = new PathKeyedMap<DeferredMutationRecord>(
    normalizeMapKey,
  );
  private readonly _toolCallAttributions = new BoundedLruCache<string, ToolCallAttribution>(
    TOOL_CALL_ATTRIBUTION_CAPACITY,
  );
  private readonly _lspReadWarmState = new Map<
    string,
    { status: "warming" | "ready"; ts: number }
  >();
  private readonly _pendingInlineBlockers = new PathKeyedMap<InlineBlockerRecord>(normalizeMapKey);
  private readonly _actionableWarningsThisTurn = new Map<string, ActionableWarningRecord>();
  private readonly _codeQualityWarningsThisTurn = new Map<string, CodeQualityWarningRecord>();
  private readonly _turnSummary = new TurnSummaryCollector();

  resetForSession(startedAt = Date.now()): void {
    this._sessionGeneration += 1;
    this._sessionStartedAt = startedAt;
    this._complexityBaselines.clear();
    this._pipelineCrashCounts.clear();
    this._cachedExports.clear();
    this.wordIndex = null;
    this._startupScansInFlight.clear();
    this._cascadeRuns = [];
    this._pendingCascadeRuns = [];
    this._turnEndCascadeSettleStarts.clear();
    this._cascadeSessionStats = {
      runs: 0,
      diagnosticsSurfaced: 0,
      coldSnapshotTouches: 0,
    };
    this._fixedThisTurn.clear();
    this._writtenThisTurn.clear();
    this._autofixDemotedThisTurn.clear();
    this._reportedThisTurn.clear();
    this._telemetrySessionId = `lens-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    this._hasStableSessionId = false;
    this._telemetryModel = "unknown";
    this._telemetryModelId = "";
    this._telemetryProvider = "";
    this._telemetryProviderIsExplicit = false;
    this._turnIndex = 0;
    this._writeIndex = 0;
    this._projectSeq = 0;
    this._turnStartProjectSeq = 0;
    this._fileSeq.clear();
    this._fileLastProjectSeq.clear();
    this._gitGuardHasBlockers = false;
    this._gitGuardSummary = "";
    this._gitGuardCacheUnknownReason = undefined;
    this._readGuard = null;
    this._pendingDeferredMutations.clear();
    this._toolCallAttributions.clear();
    this._lspReadWarmState.clear();
    this._pendingInlineBlockers.clear();
    this._actionableWarningsThisTurn.clear();
    this._codeQualityWarningsThisTurn.clear();
    this._turnSummary.clear();
  }

  get sessionStartedAt(): number {
    return this._sessionStartedAt;
  }

  get cascadeSessionStats(): CascadeSessionStats {
    return this._cascadeSessionStats;
  }

  recordCascadeRun(diagnosticsSurfaced: number, coldSnapshotTouches: number): void {
    this._cascadeSessionStats.runs += 1;
    this._cascadeSessionStats.diagnosticsSurfaced += diagnosticsSurfaced;
    this._cascadeSessionStats.coldSnapshotTouches += coldSnapshotTouches;
  }

  updateGitGuardStatus(hasBlockers: boolean, output: string): void {
    this._gitGuardHasBlockers = hasBlockers || this.getInlineBlockersSnapshot().length > 0;
    if (!this._gitGuardHasBlockers) {
      this._gitGuardSummary = "";
      return;
    }
    const firstLine = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const summaries = this.getInlineBlockersSnapshot()
      .map((entry) => entry.summary.trim())
      .filter(Boolean);
    this._gitGuardSummary = (summaries[0] ?? firstLine ?? "Unresolved blockers detected").slice(
      0,
      160,
    );
  }

  get gitGuardHasBlockers(): boolean {
    return this._gitGuardHasBlockers;
  }

  get gitGuardSummary(): string {
    return this._gitGuardSummary;
  }

  markGitGuardCacheUnknown(reason: string): void {
    this._gitGuardCacheUnknownReason = reason;
  }

  clearGitGuardCacheUnknown(): void {
    this._gitGuardCacheUnknownReason = undefined;
  }

  get gitGuardCacheUnknownReason(): string | undefined {
    return this._gitGuardCacheUnknownReason;
  }

  beginTurn(): void {
    this._cascadeRuns = this._cascadeRuns.flatMap((run) => {
      const carriedTurns = (run.carriedTurns ?? 0) + 1;
      if (carriedTurns > 1) {
        logCascade({
          phase: "cascade_carry_over_drop",
          filePath: run.filePath,
          neighborCount: run.neighborCount,
          diagnosticCount: run.diagnosticCount,
          metadata: { carriedTurns, turnIndex: this._turnIndex },
        });
        return [];
      }
      return [{ ...run, carriedTurns }];
    });
    this._actionableWarningsThisTurn.clear();
    this._codeQualityWarningsThisTurn.clear();
    this._turnStartProjectSeq = this._projectSeq;
    this._turnIndex += 1;
    this._writeIndex = 0;
    this._reportedThisTurn.clear();
    this._writtenThisTurn.clear();
    this._autofixDemotedThisTurn.clear();
  }

  recordMutationToolReceipt(
    filePath: string,
    toolName: "write" | "edit",
  ): RecordMutationToolReceiptResultContract {
    if (toolName === "write") {
      this._writtenThisTurn.set(filePath, true);
    } else if (this._writtenThisTurn.has(filePath)) {
      this._autofixDemotedThisTurn.set(filePath, true);
      this._fixedThisTurn.delete(filePath);
    }

    return {
      autofixMode:
        toolName === "edit" || this._autofixDemotedThisTurn.has(filePath)
          ? "deferred"
          : "immediate",
    };
  }

  get reportedThisTurn(): Set<string> {
    return this._reportedThisTurn;
  }

  nextWriteIndex(): number {
    this._writeIndex += 1;
    return this._writeIndex;
  }

  peekWriteIndex(): number {
    return this._writeIndex;
  }

  setTelemetryIdentity(identity: { sessionId?: string; model?: string; provider?: string }): void {
    if (identity.sessionId && identity.sessionId.trim()) {
      this._telemetrySessionId = identity.sessionId.trim();
    }
    const model = identity.model?.trim();
    const provider = identity.provider?.trim();
    if (model && provider) {
      this._telemetryModel = `${provider}/${model}`;
    } else if (model) {
      this._telemetryModel = model;
    } else if (provider) {
      this._telemetryModel = provider;
    }
    if (model) this._telemetryModelId = model;
    if (provider) {
      this._telemetryProvider = provider;
      this._telemetryProviderIsExplicit = true;
    } else if (model && !this._telemetryProviderIsExplicit) {
      this._telemetryProvider = deriveProviderFromModelId(model);
    }
  }

  get telemetrySessionId(): string {
    return this._telemetrySessionId;
  }

  setSessionLifecycle(args: { sessionId?: string; reason?: string }): void {
    if (args.sessionId && args.sessionId.trim()) {
      this._telemetrySessionId = args.sessionId.trim();
      this._hasStableSessionId = true;
    }
    this._lifecycleReason = args.reason;
  }

  get sessionLifecycleReason(): string | undefined {
    return this._lifecycleReason;
  }

  get hasStableSessionId(): boolean {
    return this._hasStableSessionId;
  }

  get telemetryModel(): string {
    return this._telemetryModel;
  }

  get telemetryModelId(): string {
    return this._telemetryModelId;
  }

  get telemetryProviderId(): string {
    return this._telemetryProvider;
  }

  get turnIndex(): number {
    return this._turnIndex;
  }

  get projectSeq(): number {
    return this._projectSeq;
  }

  get turnStartProjectSeq(): number {
    return this._turnStartProjectSeq;
  }

  seedProjectSequence(projectSeq: number, fileSeqByPath?: Map<string, number>): void {
    this._projectSeq = Math.max(0, Math.floor(projectSeq));
    this._turnStartProjectSeq = this._projectSeq;
    this._fileSeq.clear();
    this._fileLastProjectSeq.clear();
    for (const [filePath, seq] of fileSeqByPath ?? []) {
      this._fileSeq.set(normalizeMapKey(path.resolve(filePath)), Math.max(0, seq));
    }
  }

  bumpFileSeq(filePath: string): BumpFileSeqResultContract {
    const key = normalizeMapKey(path.resolve(filePath));
    this._projectSeq += 1;
    const fileSeq = (this._fileSeq.get(key) ?? 0) + 1;
    this._fileSeq.set(key, fileSeq);
    this._fileLastProjectSeq.set(key, this._projectSeq);

    return { projectSeq: this._projectSeq, fileSeq };
  }

  getFilesChangedSince(seq: number): string[] {
    const changed: string[] = [];
    for (const [key, lastSeq] of this._fileLastProjectSeq) {
      if (lastSeq > seq) changed.push(key);
    }
    return changed;
  }

  getFileSeq(filePath: string): number {
    return this._fileSeq.get(normalizeMapKey(path.resolve(filePath))) ?? 0;
  }

  getFileSeqEntries(): Array<[string, number]> {
    return [...this._fileSeq.entries()];
  }

  get sessionGeneration(): number {
    return this._sessionGeneration;
  }

  isCurrentSession(generation: number): boolean {
    return this._sessionGeneration === generation;
  }

  markStartupScanInFlight(name: string, generation: number): void {
    this._startupScansInFlight.set(name, generation);
  }

  clearStartupScanInFlight(name: string, generation: number): void {
    const owner = this._startupScansInFlight.get(name);
    if (owner === generation) {
      this._startupScansInFlight.delete(name);
    }
  }

  isStartupScanInFlight(name: string): boolean {
    return this._startupScansInFlight.has(name);
  }

  formatPipelineCrashNotice(filePath: string, err: LspBoundaryValue): string {
    const key = path.resolve(filePath);
    const count = (this._pipelineCrashCounts.get(key) ?? 0) + 1;
    this._pipelineCrashCounts.set(key, count);

    const message = err instanceof Error ? err.message : String(err);
    const shortMessage = message.split("\n")[0].slice(0, 220);
    const shouldSurface =
      count <= RUNTIME_CONFIG.crashNotice.alwaysShowFirstN ||
      count % RUNTIME_CONFIG.crashNotice.showEveryNth === 0;
    if (!shouldSurface) return "";

    return [
      "⚠️ choco-pi-lsp pipeline crashed while analyzing this write.",
      `File: ${path.basename(filePath)} | crash count this session: ${count}`,
      `Error: ${shortMessage}`,
      "Recovery: LSP service was reset. If this repeats, rerun with --no-lsp and report the file + stack.",
    ].join("\n");
  }

  getCrashEntries(): Array<[string, number]> {
    return Array.from(this._pipelineCrashCounts.entries());
  }

  get projectRoot(): string {
    return this._projectRoot;
  }

  set projectRoot(value: string) {
    this._projectRoot = normalizeMapKey(value);
  }

  get errorDebtBaseline(): ErrorDebtBaseline | null {
    return this._errorDebtBaseline;
  }

  set errorDebtBaseline(value: ErrorDebtBaseline | null) {
    this._errorDebtBaseline = value;
  }

  get cachedExports(): Map<string, string> {
    return this._cachedExports;
  }

  appendCascadeRun(run: CascadeRun): void {
    this._cascadeRuns.push(run);
  }

  appendCascadePromise(p: Promise<CascadeRun>): void {
    this._pendingCascadeRuns.push(p);
  }

  getTurnEndCascadeSettleStart(): number | undefined {
    let latest: number | undefined;
    for (const start of this._turnEndCascadeSettleStarts.values()) latest = start;
    return latest;
  }

  async settleCascadeRuns(
    maxWaitMs: number,
    settleOptions: { trackTurnEndClock?: boolean } = {},
  ): Promise<{ settled: number; timedOut: number }> {
    const pending = this._pendingCascadeRuns;
    if (pending.length === 0) return { settled: 0, timedOut: 0 };
    this._pendingCascadeRuns = [];
    const settleToken = settleOptions.trackTurnEndClock
      ? ++this._nextCascadeSettleToken
      : undefined;
    if (settleToken !== undefined) {
      this._turnEndCascadeSettleStarts.set(settleToken, Date.now());
    }

    try {
      const tracked = pending.map((p) => {
        interface EntryValues {
          done: boolean;
          run?: CascadeRun;
          promise: Promise<CascadeRun>;
        }
        const entry: EntryValues = {
          done: false,
          promise: p,
        };
        entry.promise = p.then((run) => {
          entry.done = true;
          entry.run = run;
          return run;
        });
        return entry;
      });

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, maxWaitMs).unref?.();
      });
      await Promise.race([Promise.allSettled(tracked.map((t) => t.promise)), timeout]);

      let settled = 0;
      let timedOut = 0;
      for (const entry of tracked) {
        if (entry.done && entry.run) {
          this.appendCascadeRun(entry.run);
          settled += 1;
        } else {
          this._pendingCascadeRuns.push(entry.promise);
          timedOut += 1;
        }
      }
      return { settled, timedOut };
    } finally {
      if (settleToken !== undefined) {
        this._turnEndCascadeSettleStarts.delete(settleToken);
      }
    }
  }

  consumeCascadeRuns(): CascadeRun[] {
    const runs = this._cascadeRuns;
    this._cascadeRuns = [];
    return runs;
  }

  hasCascadeRuns(): boolean {
    return this._cascadeRuns.length > 0;
  }

  recordInlineBlockers(
    filePath: string,
    summary: string,
    writeIndex?: number,
    sources?: readonly string[],
    lines?: readonly number[],
  ): void {
    this._pendingInlineBlockers.set(path.resolve(filePath), {
      filePath,
      summary,
      writeIndex,
      sources,
      lines,
      recordedAtMs: Date.now(),
      stale: false,
    });
  }

  clearInlineBlockers(filePath: string): void {
    this._pendingInlineBlockers.delete(path.resolve(filePath));
  }

  markInlineBlockerStale(
    filePath: string,
    reason: "dependency-drift" | "past-eof" = "dependency-drift",
  ): boolean {
    const key = path.resolve(filePath);
    const existing = this._pendingInlineBlockers.get(key);
    if (!existing || existing.stale) return false;
    this._pendingInlineBlockers.set(key, {
      ...existing,
      stale: true,
      staleReason: reason,
    });
    return true;
  }

  setInlineBlockerPastEofStale(filePath: string, isPastEof: boolean): boolean {
    const key = path.resolve(filePath);
    const existing = this._pendingInlineBlockers.get(key);
    if (!existing) return false;
    if (existing.stale && existing.staleReason !== "past-eof") return false;
    const currentlyPastEof = !!existing.stale && existing.staleReason === "past-eof";
    if (currentlyPastEof === isPastEof) return false;
    this._pendingInlineBlockers.set(key, {
      ...existing,
      stale: isPastEof,
      staleReason: isPastEof ? "past-eof" : undefined,
    });
    return true;
  }

  retireInlineBlockerOnConfirmedClean(
    filePath: string,
    confirmedAtWriteIndex?: number,
    coveredSources?: readonly string[],
  ): boolean {
    const key = path.resolve(filePath);
    const existing = this._pendingInlineBlockers.get(key);
    if (!existing) return false;
    if (
      existing.writeIndex !== undefined &&
      confirmedAtWriteIndex !== undefined &&
      confirmedAtWriteIndex <= existing.writeIndex
    ) {
      return false;
    }
    if (!existing.sources || existing.sources.length === 0) return false;
    const covered = new Set(coveredSources ?? []);
    if (!existing.sources.every((source) => covered.has(source))) return false;
    this._pendingInlineBlockers.delete(key);
    return true;
  }

  reconcileInlineBlockers(): void {
    const survivors: Array<[string, InlineBlockerRecord]> = [];
    for (const [displayPath, value] of this._pendingInlineBlockers.entries()) {
      if (fs.existsSync(displayPath)) survivors.push([displayPath, value]);
    }
    if (survivors.length !== this._pendingInlineBlockers.size) {
      this._pendingInlineBlockers.clear();
      for (const [displayPath, value] of survivors) {
        this._pendingInlineBlockers.set(displayPath, value);
      }
    }
  }

  getInlineBlockersSnapshot(): InlineBlockerRecord[] {
    this.reconcileInlineBlockers();
    return [...this._pendingInlineBlockers.values()];
  }

  consumeInlineBlockers(): InlineBlockerRecord[] {
    const entries = this.getInlineBlockersSnapshot();
    this._pendingInlineBlockers.clear();
    return entries;
  }

  recordActionableWarnings(warnings: ActionableWarningRecord[]): void {
    for (const warning of warnings) {
      this._actionableWarningsThisTurn.set(warning.id, warning);
    }
  }

  peekActionableWarnings(): ActionableWarningRecord[] {
    return [...this._actionableWarningsThisTurn.values()];
  }

  clearActionableWarnings(): void {
    this._actionableWarningsThisTurn.clear();
  }

  recordCodeQualityWarnings(warnings: CodeQualityWarningRecord[]): void {
    for (const warning of warnings) {
      this._codeQualityWarningsThisTurn.set(warning.id, warning);
    }
  }

  peekCodeQualityWarnings(): CodeQualityWarningRecord[] {
    return [...this._codeQualityWarningsThisTurn.values()];
  }

  clearCodeQualityWarnings(): void {
    this._codeQualityWarningsThisTurn.clear();
  }

  get turnSummary(): TurnSummaryCollector {
    return this._turnSummary;
  }

  get complexityBaselines(): Map<string, FileComplexity> {
    return this._complexityBaselines;
  }

  get fixedThisTurn(): PathSetLike {
    const facade: PathSetLike = {
      add: (filePath) => {
        this._fixedThisTurn.set(filePath, true);
        return facade;
      },
      has: (filePath) => this._fixedThisTurn.has(filePath),
      delete: (filePath) => this._fixedThisTurn.delete(filePath),
      clear: () => this._fixedThisTurn.clear(),
    };
    return facade;
  }

  get projectRulesScan(): RuleScanResult {
    return this._projectRulesScan;
  }

  set projectRulesScan(value: RuleScanResult) {
    this._projectRulesScan = value;
  }

  get readGuard(): ReadGuard {
    this._readGuard ??= new ReadGuard(this._telemetrySessionId);
    return this._readGuard;
  }

  recordToolCallAttribution(
    toolCallId: string,
    attribution: Omit<ToolCallAttribution, "recordedAt">,
  ): void {
    this._toolCallAttributions.set(toolCallId, {
      ...attribution,
      recordedAt: Date.now(),
    });
  }

  takeToolCallAttribution(toolCallId: string): ToolCallAttribution | undefined {
    const attribution = this._toolCallAttributions.get(toolCallId);
    if (attribution === undefined) return undefined;
    this._toolCallAttributions.delete(toolCallId);
    if (Date.now() - attribution.recordedAt > TOOL_CALL_ATTRIBUTION_TTL_MS) {
      return undefined;
    }
    return attribution;
  }

  deferMutation(
    filePath: string,
    cwd: string,
    toolName: "write" | "edit",
    turnStateCwd: string,
    kind: DeferredMutationKind,
    ownerSessionId?: string,
    originCwd?: string,
  ): boolean {
    const key = path.resolve(filePath);
    const now = Date.now();
    const resolvedOriginCwd = originCwd ?? turnStateCwd;
    const existing = this._pendingDeferredMutations.get(key);
    if (existing) {
      const addedKind = !existing.kinds.has(kind);
      existing.lastTouchedAt = now;
      existing.cwd = cwd;
      existing.turnStateCwd = turnStateCwd;
      existing.toolNames.add(toolName);
      existing.kinds.add(kind);
      existing.queuedTurnIndex = this._turnIndex;
      existing.ownerSessionId = ownerSessionId;
      existing.originCwd = resolvedOriginCwd;
      return addedKind;
    }
    this._pendingDeferredMutations.set(key, {
      filePath: key,
      cwd,
      turnStateCwd,
      firstTouchedAt: now,
      lastTouchedAt: now,
      toolNames: new Set([toolName]),
      kinds: new Set([kind]),
      queuedTurnIndex: this._turnIndex,
      ownerSessionId,
      originCwd: resolvedOriginCwd,
    });
    return true;
  }

  deferFormat(
    filePath: string,
    cwd: string,
    toolName: "write" | "edit",
    turnStateCwd: string,
    ownerSessionId?: string,
    originCwd?: string,
  ): boolean {
    return this.deferMutation(
      filePath,
      cwd,
      toolName,
      turnStateCwd,
      "format",
      ownerSessionId,
      originCwd,
    );
  }

  get pendingDeferredFormatCount(): number {
    return this._pendingDeferredMutations.size;
  }

  get pendingDeferredMutationCount(): number {
    return this._pendingDeferredMutations.size;
  }

  consumeDeferredFormatFiles(): DeferredFormatRecord[] {
    const records = [...this._pendingDeferredMutations.values()];
    this._pendingDeferredMutations.clear();
    return records;
  }

  claimDeferredFormatFiles(
    currentSessionId: string | undefined,
    now: number,
    staleAfterMs: number,
    currentOriginCwd?: string,
  ): ClaimDeferredFormatFilesResultContract {
    const claimed: DeferredFormatRecord[] = [];
    const staleClaimed: DeferredFormatRecord[] = [];
    const deferredToOwner: DeferredFormatRecord[] = [];
    const droppedOrphans: DeferredFormatRecord[] = [];
    for (const [key, record] of this._pendingDeferredMutations) {
      const sameSession =
        record.ownerSessionId === undefined ||
        currentSessionId === undefined ||
        record.ownerSessionId === currentSessionId;
      if (sameSession) {
        claimed.push(record);
        this._pendingDeferredMutations.delete(key);
        continue;
      }
      const age = now - record.lastTouchedAt;
      if (age > staleAfterMs) {
        const originMatches =
          currentOriginCwd === undefined || pathsEqual(record.originCwd, currentOriginCwd);
        if (originMatches) {
          this._pendingDeferredMutations.delete(key);
          staleClaimed.push(record);
        } else {
          droppedOrphans.push(record);
        }
        continue;
      }
      deferredToOwner.push(record);
    }

    return { claimed, staleClaimed, deferredToOwner, droppedOrphans };
  }

  requeueDeferredFormatFiles(records: DeferredFormatRecord[]): void {
    for (const record of records) {
      const key = path.resolve(record.filePath);
      const existing = this._pendingDeferredMutations.get(key);
      if (existing) {
        for (const kind of record.kinds) existing.kinds.add(kind);
        for (const toolName of record.toolNames) existing.toolNames.add(toolName);
        continue;
      }
      this._pendingDeferredMutations.set(key, {
        ...record,
        kinds: new Set(record.kinds),
        toolNames: new Set(record.toolNames),
      });
    }
  }

  claimDeferredMutations(
    currentSessionId: string | undefined,
    now: number,
    staleAfterMs: number,
    currentOriginCwd?: string,
  ) {
    return this.claimDeferredFormatFiles(currentSessionId, now, staleAfterMs, currentOriginCwd);
  }

  requeueDeferredMutations(records: DeferredMutationRecord[]): void {
    this.requeueDeferredFormatFiles(records);
  }

  shouldWarmLspOnRead(filePath: string, maxAgeMs = 120_000): boolean {
    const state = this._lspReadWarmState.get(path.resolve(filePath));
    if (!state) return true;
    if (state.status === "warming") return false;
    return Date.now() - state.ts > maxAgeMs;
  }

  markLspReadWarmStarted(filePath: string): void {
    this._lspReadWarmState.set(path.resolve(filePath), {
      status: "warming",
      ts: Date.now(),
    });
  }

  markLspReadWarmCompleted(filePath: string): void {
    this._lspReadWarmState.set(path.resolve(filePath), {
      status: "ready",
      ts: Date.now(),
    });
  }

  clearLspReadWarmState(filePath: string): void {
    this._lspReadWarmState.delete(path.resolve(filePath));
  }
}

export function readHostModelIdentity(ctx: LspBoundaryValue): ReadHostModelIdentityResultContract {
  try {
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const model = (ctx as { model?: { id?: unknown; provider?: unknown } } | null)?.model;

    return {
      model: isString(model?.id) ? model.id : undefined,

      provider: isString(model?.provider) ? model.provider : undefined,
    };
  } catch {
    return {};
  }
}
