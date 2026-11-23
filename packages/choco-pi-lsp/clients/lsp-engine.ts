import { assignOptionalProperties } from "./optional-properties.ts";
import { isFiniteNumber } from "./runtime-guards.ts";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.ts";
import { getDiagnosticTracker } from "./diagnostic-tracker.ts";
import { type DispatchLatencyReport, getLatencyReports } from "./dispatch/integration.ts";
import {
  getResourceFootprint as getResourceFootprintSnapshot,
  type ResourceFootprint,
} from "./instance-registry.ts";
import { initLSPConfig } from "./lsp/config.ts";
import { getLSPService } from "./lsp/index.ts";
import { acquireWarmWordIndex } from "./mcp/analyze.ts";
import { normalizeMapKey } from "./path-utils.ts";
import { scanProjectDiagnostics } from "./project-diagnostics/scanner.ts";
import type { ProjectDiagnosticsSnapshot } from "./project-diagnostics/types.ts";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.ts";
import type { ReviewGraph } from "./review-graph/types.ts";
import { getTreeSitterRuntimeStatus, type TreeSitterRuntimeStatus } from "./tree-sitter-shared.ts";
import {
  centralityFromReverseDeps,
  getWordIndexBuildStatus,
  type RankedFile,
  searchWordIndex,
  triggerBackgroundWordIndexBuild,
} from "./word-index.ts";

export { type AnalyzeFileOptions, analyzeFile, type McpAnalyzeResult } from "./mcp/analyze.ts";
export { createMcpHost } from "./mcp/host-shim.ts";
export {
  createWarmIpcLineReader,
  createWarmIpcRequestQueue,
  ipcPathForCwd,
  readTurnEndStatus,
  requestWarmAnalyze,
  type TurnEndStatus,
  WARM_TURN_END_SCHEMA_VERSION,
  type WarmAnalyzeRequest,
  type WarmTurnEndRequest,
  type WarmTurnEndResponse,
} from "./mcp/ipc.ts";
export {
  analyzeFileFresh,
  canRebuildPiLens,
  REBUILD_UNAVAILABLE_MESSAGE,
  resolveRebuildScript,
  runRebuild,
  type ScanDiagnostic,
  summarizeScan,
} from "./mcp/review.ts";
export {
  acknowledgeTurnEnd,
  runSessionStart,
  runTurnEnd,
  runTurnEndForIpc,
  type SessionStartOutcome,
  type TurnEndDelivery,
  type TurnEndOutcome,
} from "./mcp/session.ts";
export {
  type ModuleReport,
  type ModuleReportOptions,
  type ModuleSymbolEntry,
  moduleReport,
  type ReadEnclosingOptions,
  type ReadEnclosingResult,
  type ReadSymbolResult,
  type RecommendedRead,
  readEnclosing,
  readSymbol,
  renderCompactModuleReport,
} from "./module-report.ts";
export {
  type ProjectReport,
  type ProjectReportOptions,
  projectReport,
  renderCompactProjectReport,
} from "./project-report.ts";
export {
  createDefaultHostPorts,
  type HostLogSink,
  type HostPorts,
  type HostPortsOverrides,
} from "./host-ports.ts";

export function recentLatency(limit = 5, fileFilter?: string): DispatchLatencyReport[] {
  let reports = getLatencyReports();
  if (fileFilter) {
    const needle = fileFilter.replace(/\\/g, "/");
    reports = reports.filter((report) => report.filePath.replace(/\\/g, "/").endsWith(needle));
  }
  return reports.slice(-limit).reverse();
}

export function projectScan(
  cwd: string,
  maxFiles?: number,
  includeGenerated?: boolean,
): Promise<ProjectDiagnosticsSnapshot> {
  return scanProjectDiagnostics({
    cwd,
    tier: "cheap",
    maxFiles,
    includeGenerated,
  });
}

export function scanTruncationNotice(
  snapshot: Pick<ProjectDiagnosticsSnapshot, "scanTruncated" | "filesScanned" | "treeSitterStatus">,
): string | undefined {
  if (!snapshot.scanTruncated) return undefined;
  if (snapshot.treeSitterStatus === "wasm_aborted_restart_required") {
    return (
      `⚠ Scan stopped after ${snapshot.filesScanned} complete file(s): the ` +
      "tree-sitter WASM runtime aborted. Results are partial and were not cached; " +
      "restart the choco-pi-lsp extension/MCP server to restore structural analysis."
    );
  }
  return (
    `⚠ Scan truncated at ${snapshot.filesScanned} file(s) — results are partial; ` +
    "raise maxProjectFiles in .choco-pi-lsp.json to scan fully."
  );
}

export function generatedSkipNotice(
  snapshot: Pick<ProjectDiagnosticsSnapshot, "generatedNameOnlySkips" | "generatedDirSkips">,
): string | undefined {
  const files = snapshot.generatedNameOnlySkips ?? 0;
  const dirs = snapshot.generatedDirSkips ?? 0;
  if (files === 0 && dirs === 0) return undefined;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file(s)`);
  if (dirs > 0) parts.push(`${dirs} director${dirs === 1 ? "y" : "ies"}`);
  return (
    `ℹ ${parts.join(" and ")} excluded by generated-name heuristics with no ` +
    "confirming evidence — a real hand-written file/directory whose name " +
    "looks generated (e.g. `gen.ts`, `generated/`) can be excluded too; " +
    "pass include_generated: true to diagnostics_report " +
    "to scan without this filter if you suspect a false skip."
  );
}

export function treeSitterRuntimeStatus(): TreeSitterRuntimeStatus {
  return getTreeSitterRuntimeStatus();
}

export interface LspStatus {
  aliveClients: number;
  servers: Array<{
    serverId: string;
    root: string;
    connected: boolean;
    pullFailureHistory: Array<{
      timestamp: number;
      method: string;
      code?: number | string;
      message: string;
    }>;
  }>;
  brokenServers: ReturnType<ReturnType<typeof getLSPService>["getBrokenStatus"]>;
}

export function lspStatus(): LspStatus {
  const lsp = getLSPService();
  return {
    aliveClients: lsp.getAliveClientCount(),
    servers: lsp.getStatus(),
    brokenServers: lsp.getBrokenStatus(),
  };
}

export function renderLspBrokenStatusLines(brokenServers: LspStatus["brokenServers"]): string[] {
  return brokenServers.map((server) =>
    server.permanentlyBroken
      ? `  ✗ ${server.serverId} — disabled after ${server.failures} failures (${server.root})`
      : `  ✗ ${server.serverId} — cooling down after ${server.failures} failure(s) until ${new Date(server.cooldownUntil).toISOString()} (${server.root})`,
  );
}

export function diagnosticStats(): ReturnType<ReturnType<typeof getDiagnosticTracker>["getStats"]> {
  return getDiagnosticTracker().getStats();
}

export function ensureLspConfig(cwd: string): Promise<void> {
  return initLSPConfig(cwd);
}

export type { ResourceFootprint } from "./instance-registry.ts";

export function resourceFootprint(): Promise<ResourceFootprint> {
  return getResourceFootprintSnapshot();
}

export interface SymbolSearchHit {
  file: string;
  score: number;
  hits: number;
  startLine: number;
  endLine: number;
  annotations?: { fanIn: number; complexity?: number };
}

export interface SymbolSearchOptions {
  paths?: string[];
  lang?: string;
}

interface SYMBOLSEARCHLANGEXTENSIONSValues extends Readonly<Record<string, readonly string[]>> {}
const SYMBOL_SEARCH_LANG_EXTENSIONS: SYMBOLSEARCHLANGEXTENSIONSValues = {
  bash: [".sh", ".bash"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css", ".scss", ".less"],
  elixir: [".ex", ".exs"],
  go: [".go"],
  haskell: [".hs", ".lhs"],
  html: [".html", ".htm"],
  java: [".java"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc", ".json5"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  nix: [".nix"],
  php: [".php"],
  python: [".py", ".pyi"],
  ruby: [".rb", ".rake", ".gemspec"],
  rust: [".rs"],
  scala: [".scala", ".sc"],
  solidity: [".sol"],
  swift: [".swift"],
  tsx: [".tsx"],
  typescript: [".ts", ".mts", ".cts"],
  yaml: [".yaml", ".yml"],
};

function fileMatchesLang(file: string, lang: string): boolean {
  const exts = SYMBOL_SEARCH_LANG_EXTENSIONS[lang];
  if (!exts) return false;
  return exts.includes(path.extname(file).toLowerCase());
}

function fileMatchesPathGlobs(file: string, cwd: string, globs: readonly string[]): boolean {
  const rel = path.relative(cwd, file).split(path.sep).join("/");
  const options = { dot: true, nocase: process.platform === "win32" };
  return globs.some((raw) => {
    const pattern = raw.split("\\").join("/");
    return minimatch(rel, pattern, options) || minimatch(rel, `${pattern}/**`, options);
  });
}

function buildSymbolSearchFileFilter(
  cwd: string,
  options: SymbolSearchOptions,
): ((file: string) => boolean) | undefined {
  const paths = options.paths?.filter((p) => p.trim().length > 0);
  const lang = options.lang?.trim();
  if (!paths?.length && !lang) return undefined;
  return (file: string) => {
    if (paths?.length && !fileMatchesPathGlobs(file, cwd, paths)) return false;
    if (lang && !fileMatchesLang(file, lang)) return false;
    return true;
  };
}

function annotateSymbolSearchHitsWithGraph(
  hits: SymbolSearchHit[],
  centrality: Map<string, number>,
  graph: ReviewGraph,
): void {
  for (const hit of hits) {
    const normalized = normalizeMapKey(path.resolve(hit.file));
    const fanIn = centrality.get(hit.file) ?? 0;
    let complexity: number | undefined;
    for (const symbolId of graph.symbolNodesByFile.get(normalized) ?? []) {
      const raw = graph.nodes.get(symbolId)?.metadata?.cyclomaticComplexity;

      if (isFiniteNumber(raw) && (complexity === undefined || raw > complexity)) {
        complexity = raw;
      }
    }
    hit.annotations = assignOptionalProperties({ fanIn }, complexity !== undefined, () => ({
      complexity,
    }));
  }
}

export interface SymbolSearchResult {
  available: boolean;
  query: string;
  results: SymbolSearchHit[];
  coverage?: { files: number; truncated: boolean };
  hint?: string;
  unavailableReason?: "building" | "refused" | "last-build-failed";
  snapshotGeneratedAt?: string;
}

function toSymbolSearchHit(result: RankedFile): SymbolSearchHit {
  const line = result.lines[0] ?? 1;
  return {
    file: result.file,
    score: result.score,
    hits: result.hits,
    startLine: line,
    endLine: line,
  };
}

export async function symbolSearch(
  query: string,
  cwd: string,
  limit = 20,
  options: SymbolSearchOptions = {},
): Promise<SymbolSearchResult> {
  const warmLease = acquireWarmWordIndex(cwd);
  const snapshot = loadProjectSnapshotWithoutWordIndex(cwd);
  const index = warmLease.index;
  if (!index) {
    warmLease.release();
    const priorStatus = getWordIndexBuildStatus(cwd);
    const status =
      priorStatus?.state === "refused" ? priorStatus : triggerBackgroundWordIndexBuild(cwd);
    const unavailableReason =
      priorStatus?.state === "failed"
        ? "last-build-failed"
        : status.state === "refused"
          ? "refused"
          : "building";
    const hint =
      unavailableReason === "refused"
        ? `Word index build was refused for safety: ${status.state === "refused" ? status.reason : "unsafe workspace root"}. Run symbol_search from inside a project directory.`
        : unavailableReason === "last-build-failed"
          ? `The last word index build failed: ${priorStatus?.state === "failed" ? priorStatus.reason : "unknown error"}. A retry is now running in the background.`
          : "Word index is building in the background for this workspace — retry this query shortly.";
    return {
      available: false,
      query,
      results: [],
      unavailableReason,
      hint,
    };
  }
  let centrality: Map<string, number>;
  let results: RankedFile[];
  try {
    centrality = centralityFromReverseDeps(index, snapshot?.reverseDeps, (file) =>
      normalizeMapKey(path.resolve(file)),
    );
    const fileFilter = buildSymbolSearchFileFilter(cwd, options);
    results = searchWordIndex(index, query, { limit, centrality, fileFilter });
  } finally {
    warmLease.release();
  }
  const hits = results.map(toSymbolSearchHit);

  const { getCachedReviewGraph } = await import("./review-graph/builder.ts");
  const graph = getCachedReviewGraph(cwd);
  if (graph) annotateSymbolSearchHitsWithGraph(hits, centrality, graph);

  return {
    available: true,
    query,
    results: hits,
    coverage: { files: index.docCount, truncated: index.truncated === true },
    snapshotGeneratedAt: snapshot?.generatedAt,
  };
}
