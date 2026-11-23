import * as fs from "node:fs";
import * as path from "node:path";
import { CacheManager, MCP_TURN_STATE_OWNER_ID } from "../cache-manager.ts";
import {
  CASCADE_GRAPH_KINDS,
  dispatchLintWithResult,
  getLatencyReports,
} from "../dispatch/integration.ts";
import { FactStore } from "../dispatch/fact-store.ts";
import type { Diagnostic } from "../dispatch/types.ts";
import { detectFileKind } from "../file-kinds.ts";
import { getDiagnosticTracker } from "../diagnostic-tracker.ts";
import { getLSPService } from "../lsp/index.ts";
import { PathKeyedMap } from "../path-keyed-map.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { loadProjectSnapshot } from "../project-snapshot.ts";
import { buildOrUpdateGraph } from "../review-graph/service.ts";
import { recordDiagnostics } from "../widget-state.ts";
import {
  deserializeWordIndex,
  removeWordIndexDocument,
  scheduleWordIndexPersist,
  updateWordIndexDocument,
  WORD_INDEX_MAX_BYTES,
  type WordIndex,
} from "../word-index.ts";
import { logWordIndex } from "../word-index-logger.ts";
import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "../idle-timer-release.ts";
import { createMcpHost } from "./host-shim.ts";

const warmGraphFacts = new FactStore();

const DEFAULT_WORD_INDEX_IDLE_EVICT_MS = 20 * 60_000;
const DEFAULT_WORD_INDEX_MAX_WARM_ROOTS = 8;

interface WarmWordIndexEntry {
  index: WordIndex | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  leases: number;
  lastUsedAt: number;
  generation: number;
}

const warmWordIndexes = new PathKeyedMap<WarmWordIndexEntry>(normalizeMapKey);

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function idleEvictMs(): number {
  return positiveEnv("CHOCO_PI_LSP_WORD_INDEX_IDLE_EVICT_MS", DEFAULT_WORD_INDEX_IDLE_EVICT_MS);
}

function maxWarmRoots(): number {
  return positiveEnv("CHOCO_PI_LSP_WORD_INDEX_MAX_WARM_ROOTS", DEFAULT_WORD_INDEX_MAX_WARM_ROOTS);
}

function clearWarmWordIndexTimer(entry: WarmWordIndexEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
}

registerIdleTimerRelease(() => {
  for (const entry of warmWordIndexes.values()) clearWarmWordIndexTimer(entry);
});

function evictWarmWordIndex(
  key: string,
  entry: WarmWordIndexEntry,
  reason: "idle" | "lru",
): boolean {
  if (entry.leases > 0 || warmWordIndexes.get(key) !== entry) return false;
  clearWarmWordIndexTimer(entry);
  warmWordIndexes.delete(key);
  logWordIndex({
    phase: "warm_cache_evicted",
    cwd: key,
    trigger: "mcp",
    reason,
  });
  return true;
}

function scheduleWarmWordIndexIdleEviction(key: string, entry: WarmWordIndexEntry): void {
  clearWarmWordIndexTimer(entry);
  if (idleEvictionTimersSuspended()) return;
  const generation = ++entry.generation;
  const timer = setTimeout(() => {
    entry.timer = undefined;
    if (warmWordIndexes.get(key) !== entry || entry.generation !== generation) return;
    if (!evictWarmWordIndex(key, entry, "idle")) scheduleWarmWordIndexIdleEviction(key, entry);
  }, idleEvictMs());
  timer.unref?.();
  entry.timer = timer;
}

function enforceWarmWordIndexLruCap(): void {
  while (warmWordIndexes.size > maxWarmRoots()) {
    const victim = [...warmWordIndexes.entries()]
      .filter(([, entry]) => entry.leases === 0)
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!victim || !evictWarmWordIndex(victim[0], victim[1], "lru")) return;
  }
}

export interface WarmWordIndexLease {
  index: WordIndex | undefined;
  release(): void;
}

export function acquireWarmWordIndex(cwd: string): WarmWordIndexLease {
  const key = path.resolve(cwd);
  let entry = warmWordIndexes.get(key);
  if (!entry) {
    const snapshot = loadProjectSnapshot(key);
    const index = deserializeWordIndex(snapshot?.wordIndex) ?? undefined;
    entry = {
      index: index?.forward ? index : undefined,
      timer: undefined,
      leases: 0,
      lastUsedAt: Date.now(),
      generation: 0,
    };
    warmWordIndexes.set(key, entry);
  }
  entry.leases++;
  entry.lastUsedAt = Date.now();
  scheduleWarmWordIndexIdleEviction(key, entry);
  enforceWarmWordIndexLruCap();
  let released = false;
  return {
    index: entry.index,
    release() {
      if (released) return;
      released = true;
      entry.leases = Math.max(0, entry.leases - 1);
      entry.lastUsedAt = Date.now();
      if (warmWordIndexes.get(key) === entry) {
        scheduleWarmWordIndexIdleEviction(key, entry);
        enforceWarmWordIndexLruCap();
      }
    },
  };
}

export function _resetWarmWordIndexCacheForTests(): void {
  for (const entry of warmWordIndexes.values()) clearWarmWordIndexTimer(entry);
  warmWordIndexes.clear();
}

export function _getWarmWordIndexCacheStateForTests() {
  return {
    size: warmWordIndexes.size,
    keys: [...warmWordIndexes.keys()],
    timers: [...warmWordIndexes.values()].flatMap((entry) => (entry.timer ? [entry.timer] : [])),
  };
}

const WARMUP_CLIENT_WAIT_MS = 10_000;
const WARMUP_DIAGNOSTICS_WAIT_MS = 6_000;

export interface McpAnalyzeDiagnostic {
  line?: number;
  column?: number;
  severity: Diagnostic["severity"];
  semantic: Diagnostic["semantic"];
  tool: string;
  rule?: string;
  code?: string;
  message: string;
  fixable?: boolean;
  fixSuggestion?: string;
}

export interface McpRunnerLatency {
  runnerId: string;
  durationMs: number;
  status: string;
  diagnosticCount: number;
}

export interface McpAnalyzeResult {
  filePath: string;
  cwd: string;
  fileKind: string | undefined;
  durationMs: number;
  hasBlockers: boolean;
  counts: {
    diagnostics: number;
    blockers: number;
    warnings: number;
    fixed: number;
  };
  diagnostics: McpAnalyzeDiagnostic[];
  lsp?: {
    ran: boolean;
    status: string;
    diagnosticCount: number;
    durationMs: number;
  };
  latency?: {
    totalDurationMs: number;
    stoppedEarly: boolean;
    runners: McpRunnerLatency[];
  };
}

export interface AnalyzeFileOptions {
  flags?: Record<string, boolean | string | undefined>;
  blockingOnly?: boolean;
  warmLsp?: boolean;
  record?: boolean;
  registerTurnState?: boolean;
  updateGraph?: boolean;
  ownerId?: string;
}

function toMcpDiagnostic(diagnostic: Diagnostic): McpAnalyzeDiagnostic {
  return {
    line: diagnostic.line,
    column: diagnostic.column,
    severity: diagnostic.severity,
    semantic: diagnostic.semantic,
    tool: diagnostic.tool,
    rule: diagnostic.rule,
    code: diagnostic.code,
    message: diagnostic.message,
    fixable: diagnostic.fixable,
    fixSuggestion: diagnostic.fixSuggestion,
  };
}

async function warmLspForFile(
  absPath: string,
  host: ReturnType<typeof createMcpHost>,
): Promise<void> {
  if (host.getFlag("no-lsp")) return;
  const lspService = getLSPService();
  if (!lspService.supportsLSP(absPath)) return;
  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return;
  }
  try {
    await lspService.touchFile(absPath, content, {
      diagnostics: "document",
      collectDiagnostics: true,
      clientScope: "primary",
      maxClientWaitMs: WARMUP_CLIENT_WAIT_MS,
      maxDiagnosticsWaitMs: WARMUP_DIAGNOSTICS_WAIT_MS,
      source: "mcp-warmup",
    });
  } catch {}
}

export async function analyzeFile(
  filePath: string,
  cwd: string,
  options: AnalyzeFileOptions = {},
): Promise<McpAnalyzeResult> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const host = createMcpHost({ "no-delta": true, ...options.flags }, cwd);

  if (options.warmLsp !== false) {
    await warmLspForFile(absPath, host);
  }

  const reportsBefore = getLatencyReports().length;
  const start = Date.now();
  const result = await dispatchLintWithResult(absPath, cwd, host, undefined, undefined, {
    blockingOnly: options.blockingOnly ?? false,
  });
  const durationMs = Date.now() - start;

  if (options.record !== false) {
    recordDiagnostics(absPath, result.diagnostics);
    if (result.diagnostics.length > 0) {
      getDiagnosticTracker().trackShown(result.diagnostics);
    }
  }

  if (options.registerTurnState) {
    try {
      const lineCount = fs.readFileSync(absPath, "utf8").split("\n").length;
      new CacheManager().addModifiedRange(
        absPath,
        { start: 1, end: lineCount },
        true,
        cwd,
        options.ownerId ?? MCP_TURN_STATE_OWNER_ID,
        "mcp",
      );
    } catch {}
  }

  if (options.updateGraph && !result.hasBlockers) {
    const fileKind = detectFileKind(absPath);
    if (fileKind && CASCADE_GRAPH_KINDS.has(fileKind)) {
      try {
        await buildOrUpdateGraph(cwd, [absPath], warmGraphFacts);
      } catch {}
    }

    const warmLease = acquireWarmWordIndex(cwd);
    const warmIndex = warmLease.index;
    try {
      if (warmIndex) {
        try {
          const content = fs.readFileSync(absPath, "utf8");
          const byteLength = Buffer.byteLength(content, "utf-8");
          if (byteLength > WORD_INDEX_MAX_BYTES) {
            removeWordIndexDocument(warmIndex, absPath);
          } else {
            updateWordIndexDocument(warmIndex, { path: absPath, content });
          }
          scheduleWordIndexPersist(cwd, warmIndex);
        } catch {}
      }
    } finally {
      warmLease.release();
    }
  }

  const newReports = getLatencyReports().slice(reportsBefore);
  const latencyReport =
    newReports.find((report) => path.resolve(report.filePath) === absPath) ??
    newReports[newReports.length - 1];

  const lspRunner = latencyReport?.runners.find((runner) => runner.runnerId === "lsp");
  const lsp = lspRunner
    ? {
        ran: lspRunner.status !== "skipped" && lspRunner.status !== "when_skipped",
        status: lspRunner.status,
        diagnosticCount: lspRunner.diagnosticCount,
        durationMs: lspRunner.durationMs,
      }
    : undefined;

  return {
    filePath: absPath,
    cwd,
    fileKind: latencyReport?.fileKind,
    durationMs,
    hasBlockers: result.hasBlockers,
    counts: {
      diagnostics: result.diagnostics.length,
      blockers: result.blockers.length,
      warnings: result.warnings.length,
      fixed: result.fixed.length,
    },
    lsp,
    diagnostics: result.diagnostics.map(toMcpDiagnostic),
    latency: latencyReport
      ? {
          totalDurationMs: latencyReport.totalDurationMs,
          stoppedEarly: latencyReport.stoppedEarly,
          runners: latencyReport.runners.map((runner) => ({
            runnerId: runner.runnerId,
            durationMs: runner.durationMs,
            status: runner.status,
            diagnosticCount: runner.diagnosticCount,
          })),
        }
      : undefined,
  };
}
