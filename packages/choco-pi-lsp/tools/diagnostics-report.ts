import { includePropertiesWhen } from "../clients/optional-properties.ts";
import type { ProtocolDictionary } from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeNumber, isRuntimeString } from "./runtime-values.ts";

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { arr, bool, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import {
  anchorsForDiagnostic,
  applyDispositions,
  applyWeakDispositions,
  getDisposition,
  type DispositionCandidate,
} from "../clients/diagnostic-dispositions.ts";
import { applyInlineSuppressions } from "../clients/dispatch/inline-suppressions.ts";
import { gateFindingsByPathFreshness } from "../clients/advisory-provenance.ts";
import { normalizeRuleId } from "../clients/dispatch/rule-id-normalize.ts";
import { applyRulePolicy, rulePolicyMapFromConfig } from "../clients/dispatch/rule-policy.ts";
import { loadPiLensProjectConfig } from "../clients/project-lsp-config.ts";
import { compactRenderResult } from "./render-compact.ts";
import { combineAbortSignals } from "../clients/deadline-utils.ts";
import { getProjectIgnoreMatcher } from "../clients/file-utils.ts";
import { isAtOrAboveHomeDir, normalizeFilePath } from "../clients/path-utils.ts";
import { getLSPService } from "../clients/lsp/index.ts";
import { primaryServerId } from "../clients/lsp/config.ts";
import type { LSPDiagnostic } from "../clients/lsp/client.ts";
import type { LSPWorkspaceUnconfirmedReason } from "../clients/lsp/index.ts";
import { getFullScanWallClockMs } from "../clients/lsp/workspace-sweep-hold.ts";
import { demoteInferredProjectSweepResults } from "../clients/lsp/inferred-project.ts";
import {
  hashDiagnosticContent,
  type BoundToCurrentDisk,
} from "../clients/lsp/diagnostic-binding.ts";
import type { CacheManager } from "../clients/cache-manager.ts";
import {
  loadProjectDiagnosticsDeltaReport,
  loadProjectDiagnosticsSnapshot,
  PROJECT_DIAGNOSTICS_CACHE_VERSION,
  reconcileProjectDiagnosticsSnapshot,
} from "../clients/project-diagnostics/cache.ts";
import { formatCacheAge, formatNotRunEntry } from "../clients/project-diagnostics/extractors.ts";
import type { FreshProjectDiagnosticsResult } from "../clients/project-diagnostics/fresh-fetch.ts";
import {
  ANALYZER_IDS,
  fetchFreshProjectDiagnostics,
} from "../clients/project-diagnostics/fresh-fetch.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { generatedSkipNotice, scanTruncationNotice } from "../clients/lsp-engine.ts";
import { scanProjectDiagnostics } from "../clients/project-diagnostics/scanner.ts";
import type {
  ProjectDiagnostic,
  ProjectDiagnosticsDeltaReport,
  ProjectDiagnosticsSnapshot,
} from "../clients/project-diagnostics/types.ts";
import type { ActionableWarningsReport } from "../clients/actionable-warnings.ts";
import type { CodeQualityWarningsReport } from "../clients/code-quality-warnings.ts";
import {
  getFileDiagnosticSummaries,
  type FileDiagnosticSummary,
  reconcileScanDiagnostics,
  reconcileStaleWidgetDependencyBlockers,
  reconcileStaleWidgetFiles,
  type WidgetDiagnostic,
} from "../clients/widget-state.ts";
import { logLatency } from "../clients/latency-logger.ts";
import { convertLspDiagnostics } from "../clients/dispatch/utils/lsp-diagnostics.ts";
import { retagAuxiliaryDiagnostics } from "../clients/dispatch/auxiliary-lsp.ts";
import { detectFileRole } from "../clients/file-role.ts";
import { STALE_LINE_MARKER } from "../clients/stale-marker.ts";
import { makeProgressReporter, scanningSummaryLine } from "./scan-progress.ts";
import {
  demotePastEofDiagnostics,
  PAST_EOF_STALE_MARKER,
  resyncDocumentOnPastEof,
} from "../clients/diagnostic-line-freshness.ts";

const MAX_DIAGNOSTICS_PER_FILE = 50;

const MAX_PATHS_ENTRIES = 200;

const NOT_REQUESTED_REASON =
  "refresh_runners not requested this call (quick mode) — pass refresh_runners=cheap/all/cached to diagnostics_report mode=full to run it";

export type LSPServiceLike = ReturnType<typeof getLSPService> & {
  runWorkspaceDiagnostics?: (
    cwd: string,
    options?: {
      maxFiles?: number;
      signal?: AbortSignal;
      onProgress?: (completed: number, total: number) => void;
      onServerReady?: () => void;
      nextWriteIndex?: () => number;
      files?: string[];
    },
  ) => Promise<WorkspaceLspDiagnosticResult[]>;
};

type WorkspaceLspDiagnosticResult = {
  filePath: string;
  diagnostics: LSPDiagnostic[];
  count?: number;
  error?: string;
  timedOut?: boolean;
  unconfirmedReason?: LSPWorkspaceUnconfirmedReason;
  observedAt?: number;
  contentHash?: string;
  boundToCurrentDisk?: BoundToCurrentDisk;
  writeIndex?: number;
};

const FULL_SCAN_WALL_CLOCK_MS = getFullScanWallClockMs();

const FULL_SCAN_BINDING_YIELD_EVERY = 16;

async function findFullScanBindingMismatches(
  results: readonly WorkspaceLspDiagnosticResult[],
): Promise<WeakSet<WorkspaceLspDiagnosticResult>> {
  const mismatched = new WeakSet<WorkspaceLspDiagnosticResult>();
  let sinceYield = 0;
  for (const result of results) {
    if (result.boundToCurrentDisk === false) {
      mismatched.add(result);
    } else if (result.boundToCurrentDisk !== true && result.contentHash !== undefined) {
      try {
        const content = await fs.readFile(result.filePath, "utf-8");
        if (hashDiagnosticContent(content) !== result.contentHash) {
          mismatched.add(result);
        }
      } catch {}
    }
    sinceYield += 1;
    if (sinceYield >= FULL_SCAN_BINDING_YIELD_EVERY) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return mismatched;
}

export function createLensDiagnosticsTool(
  cacheManager: CacheManager,
  getCwd: () => string,
  getLspService: () => LSPServiceLike = getLSPService,
  flushPending: () => Promise<void> = async () => {},
  nextWriteIndex?: () => number,
  captureLspStatusRepaint?: (ctx: RuntimeValue) => (() => void) | undefined,
  getRuntime?: () => import("../clients/runtime-coordinator.ts").RuntimeCoordinator | undefined,
) {
  return {
    name: "diagnostics_report" as const,
    label: "Project Diagnostics",
    description:
      "Query choco-pi-lsp's diagnostic state. mode=delta/all are cache-only and instant; " +
      "mode=full is an expensive active project-wide LSP scan merged with cached runner state.\n\n" +
      "IMPORTANT: unlike lsp_diagnostics (LSP only), this tool covers ALL dispatch " +
      "runners: LSP errors, tree-sitter structural rules, ast-grep security rules, " +
      "biome/ruff/eslint lint findings, complexity violations, and more.\n\n" +
      "mode=delta (default): all warnings for the current agent turn — fixable warnings " +
      "(actionable-warnings cache) AND code quality/style/complexity issues " +
      "(code-quality-warnings cache). Same scope as the turn-end advisory, current turn only.\n\n" +
      "mode=all: blocking errors and warnings — with the actual messages (line, rule, " +
      "text), not just counts — for every file the agent has " +
      "EDITED this session (files that went through the dispatch pipeline). " +
      "NOTE: unedited files with pre-existing errors do NOT appear here — this is " +
      "not a full project scan. Use before declaring work done; stale blocking " +
      "errors from earlier turns are visible even if they dropped from turn-end context.\n\n" +
      "mode=full: EXPENSIVE active scan. Runs project-wide LSP diagnostics for " +
      "all supported files (including unedited files), then merges/deduplicates " +
      "that with mode=all cached runner state. Optional refresh_runners=cheap/all/cached " +
      "folds in project-wide runner findings: the in-process scanners (tree-sitter + " +
      "fact-rules + ast-grep) plus a FRESH opengrep run — rather than a " +
      "possibly-stale session_start cache; each analyzer de-dupes against a " +
      "concurrent background run of itself, so this can't double-spawn.",
    promptSnippet: "Review cached or project-wide diagnostics.",
    renderResult: compactRenderResult<{
      mode?: string;
      phase?: string;
      completed?: number;
      total?: number;
      actionableWarnings?: number;
      qualityIssues?: number;
      projectDiagnostics?: number;
      filesWithIssues?: number;
      filesChecked?: number;
      totalBlocking?: number;
      totalErrors?: number;
      totalWarnings?: number;
      coldRunners?: string[];
      failedAnalyzers?: { id: string; summary: string }[];
    }>(({ details, args, isError, text }) => {
      const scanning = scanningSummaryLine(details, text);
      if (scanning) return scanning;
      const mode = details?.mode ?? (isRuntimeString(args.mode) ? args.mode : "delta");
      if (isError) {
        return `diagnostics_report ${mode} — ${text.split("\n")[0] ?? "error"}`;
      }
      const coldSuffix =
        details?.coldRunners && details.coldRunners.length > 0
          ? ` (${details.coldRunners.length} cold: ${details.coldRunners.join(", ")})`
          : "";
      const failedSuffix =
        details?.failedAnalyzers && details.failedAnalyzers.length > 0
          ? ` (${details.failedAnalyzers.length} failed: ${details.failedAnalyzers.map((item) => item.id).join(", ")})`
          : "";
      if (mode === "delta") {
        const aw = details?.actionableWarnings ?? 0;
        const cq = details?.qualityIssues ?? 0;
        const pd = details?.projectDiagnostics ?? 0;
        if (aw + cq + pd === 0)
          return `diagnostics_report delta — clean${coldSuffix}${failedSuffix}`;
        return `diagnostics_report delta — ${aw} actionable · ${cq} quality · ${pd} project${coldSuffix}${failedSuffix}`;
      }
      const b = details?.totalBlocking ?? 0;
      const e = details?.totalErrors ?? 0;
      const w = details?.totalWarnings ?? 0;
      const files = details?.filesWithIssues ?? details?.filesChecked ?? 0;
      if (b + e + w === 0) {
        return `diagnostics_report ${mode} — clean (${files} files)${coldSuffix}${failedSuffix}`;
      }
      return `diagnostics_report ${mode} — ${b} blocking · ${e} errors · ${w} warnings (${files} files)${coldSuffix}${failedSuffix}`;
    }),
    parameters: hostParams(
      obj({
        mode: opt(
          oneOf(["delta", "all", "full"], {
            description:
              "delta = current turn's fixable warnings (default). " +
              "all = session diagnostics for edited/dispatched files. " +
              "full = expensive active project-wide LSP scan plus cached runner diagnostics.",
          }),
        ),
        refresh_runners: opt(
          union([bool(), oneOf(["cached", "cheap", "all", "none"])], {
            description:
              "mode=full only: false/none = LSP + widget state only. cached/cheap/all trigger a FRESH run (#585) of the project analyzers (opengrep) instead of reading a possibly-stale session_start cache; safe to relaunch since each analyzer de-dupes concurrent runs against the same project root. cheap/all additionally refresh the in-process runners (tree-sitter + fact-rules + ast-grep) first.",
          }),
        ),
        max_project_files: opt(
          num({
            description:
              "mode=full refresh_runners=cheap/all only: cap project files scanned by the cheap project runners (tree-sitter + fact-rules + ast-grep). Does NOT bound the LSP sweep — use max_lsp_files for that.",
          }),
        ),
        max_lsp_files: opt(
          num({
            description:
              "mode=full only: cap the number of files routed through the language server for the project-wide LSP sweep. On large projects (e.g. a Next.js app with thousands of source files) the uncapped sweep can take many minutes; set this to bound it. Default is generous (env CHOCO_PI_LSP_LSP_WORKSPACE_MAX_FILES, else 5000).",
          }),
        ),
        include_generated: opt(
          bool({
            description:
              "mode=full refresh_runners=cheap/all only (no effect with refresh_runners=cached/none, since no project scan runs to apply it to): scan WITHOUT the generated/artifact NAME-heuristic filter (lockfiles, gen.ts-style names, generated/ dirs, …). Default false. Use when a scan's 'excluded by generated-name heuristics' notice suggests a real file was skipped.",
          }),
        ),
        severity: opt(
          oneOf(["error", "warning", "all"], {
            description: "Filter by severity (default: all).",
          }),
        ),
        paths: opt(
          arr(str(), {
            maxItems: MAX_PATHS_ENTRIES,
            description:
              `Restrict any mode to an explicit file/directory list (max ${MAX_PATHS_ENTRIES} entries; ` +
              "more errors instead of silently truncating). Entries may be relative " +
              "(resolved against cwd) or absolute, and a directory entry matches all " +
              'files under it (e.g. "src/"). mode=delta/all are a pure post-filter ' +
              "of cached/session state — they can only show findings for files choco-pi-lsp " +
              "has already dispatched, so an unseen file shows nothing (use mode=full " +
              "for an active scan). mode=full actively scans exactly these paths (LSP " +
              "sweep + cheap in-process runners); the project snapshot is still a post-filtered " +
              "cache reads, never relaunched. Explicitly-listed files are NOT filtered " +
              "through the project ignore matcher (matching lsp_diagnostics' paths " +
              "semantics) — naming a file is assumed to mean it regardless of " +
              ".gitignore/.choco-pi-lsp.json; a directory entry's expansion still honors " +
              "ignore (and when the list mixes directories and files, mode=full scans " +
              "via the ignore-filtered walk, so an ignore-excluded file entry is only " +
              "guaranteed an active scan in a files-only list). Nonexistent entries " +
              "are skipped (mode=full notes them; useful for git-staged-file wrappers " +
              "where a deleted-but-staged path can appear).",
          }),
        ),
      }),
    ),
    async execute(
      _toolCallId: string,
      params: ProtocolDictionary,
      signal: AbortSignal | undefined,
      onUpdate: RuntimeValue,
      ctx: { cwd?: string; signal?: AbortSignal },
    ) {
      const repaintLspStatus = captureLspStatusRepaint?.(ctx);
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const mode = (params.mode as string | undefined) ?? "delta";
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const severity = (params.severity as string | undefined) ?? "all";
      const refreshRunners = params.refresh_runners;
      const parsePositiveInt = (value: RuntimeValue): number | undefined =>
        isRuntimeNumber(value) && Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : undefined;
      const maxProjectFiles = parsePositiveInt(params.max_project_files);
      const maxLspFiles = parsePositiveInt(params.max_lsp_files);
      const includeGenerated = params.include_generated === true;
      const cwd = ctx.cwd ?? getCwd();

      let pathsScope: PathsScope | undefined;
      try {
        pathsScope = resolvePathsScope(cwd, params.paths);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
          details: { mode, pathsError: true },
        };
      }

      const abortSignal = combineAbortSignals(signal, ctx.signal);

      await flushPending();
      const staleDropped = await reconcileStaleWidgetFiles();

      if (mode === "all") {
        const dependencyGateStart = Date.now();
        const { demoted: dependencyDemoted, truncatedImports } =
          await reconcileStaleWidgetDependencyBlockers(cwd, getRuntime?.()?.turnIndex);
        logLatency({
          type: "phase",
          toolName: "diagnostics_report",
          filePath: cwd,
          phase: "blocker_freshness_widget_gate",
          durationMs: Date.now() - dependencyGateStart,
          metadata: {
            demoted: dependencyDemoted,
            truncatedImports,
            surface: "mode=all",
          },
        });
        return formatAllMode(
          cwd,
          severity,
          undefined,
          undefined,
          staleDropped,
          pathsScope,
          dependencyDemoted,
        );
      }
      if (mode === "full") {
        const ceiling = AbortSignal.timeout(FULL_SCAN_WALL_CLOCK_MS);
        const fullSignal = combineAbortSignals(abortSignal, ceiling);
        const onProgress = makeProgressReporter(onUpdate);
        return formatFullMode(cwd, severity, getLspService(), cacheManager, {
          refreshRunners,
          maxProjectFiles,
          maxLspFiles,
          includeGenerated,
          signal: fullSignal,
          wallClockMs: FULL_SCAN_WALL_CLOCK_MS,
          onProgress,
          onServerReady: repaintLspStatus,
          pathsScope,
          nextWriteIndex,
          runtime: getRuntime?.(),
        });
      }
      return formatDeltaMode(cacheManager, cwd, severity, pathsScope);
    },
  };
}

function formatProjectDeltaDiagnostic(diagnostic: ProjectDiagnostic, stale: boolean): string {
  const marker = diagnostic.semantic === "blocking" || diagnostic.severity === "error" ? "🔴" : "ℹ";
  const rule = diagnostic.rule ?? diagnostic.code ?? diagnostic.runner;
  const where = stale ? STALE_LINE_MARKER : `L${diagnostic.line ?? "?"}`;
  return `  ${marker} ${where}  ${rule}  ${diagnostic.message}`;
}

function appendProjectDiagnosticsDeltaLines(
  lines: string[],
  cwd: string,
  report: ProjectDiagnosticsDeltaReport | undefined,
  severity: string,
  includeFile: (filePath: string) => boolean,
): number {
  const scoped = (report?.diagnostics ?? []).filter(
    (diagnostic) =>
      includeFile(diagnostic.filePath) &&
      matchesSeverity(projectDiagnosticToWidget(diagnostic), severity),
  );
  const gated = gateFindingsByPathFreshness({
    store: "lens-diagnostics-delta-project",
    findings: scoped,
    cwd,
    scannedAt: report?.generatedAt,
    citedPath: (d) => d.filePath,
    onMissing: "drop",
  });
  const staleSet = new Set(gated.stale);
  const diagnostics = [...gated.live, ...gated.stale];
  const byFile = new Map<string, ProjectDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const filePath = path.resolve(diagnostic.filePath);
    const bucket = byFile.get(filePath) ?? [];
    bucket.push(diagnostic);
    byFile.set(filePath, bucket);
  }
  for (const [filePath, fileDiagnostics] of byFile) {
    const rel = path.relative(cwd, filePath);
    if (!lines.includes(rel)) lines.push(rel);
    for (const diagnostic of fileDiagnostics) {
      lines.push(formatProjectDeltaDiagnostic(diagnostic, staleSet.has(diagnostic)));
    }
  }
  return diagnostics.length;
}

function filterDeltaReportDispositions(
  report: ProjectDiagnosticsDeltaReport | undefined,
  cwd: string,
  policyMap: ReturnType<typeof rulePolicyMapFromConfig>,
): ProjectDiagnosticsDeltaReport | undefined {
  if (!report?.diagnostics.length) return report;
  const kept = report.diagnostics.filter(
    (d) => applyWeakDispositions([projectDiagnosticToWidget(d)], cwd, d.filePath).length === 1,
  );
  const policyKept = applyRulePolicy(kept, policyMap);
  if (policyKept.length === report.diagnostics.length) return report;
  return { ...report, diagnostics: policyKept };
}

function loadProjectRulePolicyMap(cwd: string) {
  return rulePolicyMapFromConfig(loadPiLensProjectConfig(cwd).rules);
}

function applyDeltaFreshnessGate<W extends DispositionCandidate>(
  files: Array<{ filePath: string; warnings: W[] }>,
  cwd: string,
  generatedAt: string | undefined,
): Array<{ filePath: string; warnings: Array<W & { stale?: boolean }> }> {
  if (!generatedAt) return files;
  const flat: Array<{ filePath: string; warning: W }> = [];
  for (const file of files) {
    for (const warning of file.warnings) flat.push({ filePath: file.filePath, warning });
  }
  if (flat.length === 0) return files;
  const gated = gateFindingsByPathFreshness({
    store: "lens-diagnostics-delta",
    findings: flat,
    cwd,
    scannedAt: generatedAt,
    citedPath: (f) => f.filePath,
    onMissing: "drop",
  });
  const byFile = new Map<string, Array<W & { stale?: boolean }>>();
  for (const f of gated.live) {
    const arr = byFile.get(f.filePath) ?? [];
    arr.push(f.warning);
    byFile.set(f.filePath, arr);
  }
  for (const f of gated.stale) {
    const arr = byFile.get(f.filePath) ?? [];
    arr.push({ ...f.warning, stale: true, line: undefined });
    byFile.set(f.filePath, arr);
  }
  return files
    .map((file) => ({
      filePath: file.filePath,
      warnings: byFile.get(file.filePath) ?? [],
    }))
    .filter((file) => file.warnings.length > 0);
}

function formatDeltaMode(
  cacheManager: CacheManager,
  cwd: string,
  severity: string,
  pathsScope?: PathsScope,
): DiagnosticsToolResult {
  const actionableEntry = cacheManager.readCache<ActionableWarningsReport>(
    "actionable-warnings",
    cwd,
  );
  const qualityEntry = cacheManager.readCache<CodeQualityWarningsReport>(
    "code-quality-warnings",
    cwd,
  );
  const actionable = actionableEntry?.data;
  const quality = qualityEntry?.data;
  const policyMap = loadProjectRulePolicyMap(cwd);
  const projectDelta = filterDeltaReportDispositions(
    loadProjectDiagnosticsDeltaReport(cwd),
    cwd,
    policyMap,
  );
  const ignoreFile = createCurrentIgnoreFilter(cwd);
  const includeFile = (filePath: string) =>
    ignoreFile(filePath) && (!pathsScope || pathsScope.includeFile(filePath));
  const visibleWarningFiles = <W extends DispositionCandidate>(
    files: Array<{ filePath: string; warnings?: W[] }> | undefined,
  ) =>
    (files ?? [])
      .filter((file) => includeFile(file.filePath))
      .map((file) => ({
        filePath: file.filePath,
        warnings: applyRulePolicy(
          applyWeakDispositions(file.warnings ?? [], cwd, file.filePath),
          policyMap,
        ),
      }))
      .filter((file) => file.warnings.length > 0);
  const actionableFiles = applyDeltaFreshnessGate(
    visibleWarningFiles(actionable?.files),
    cwd,
    actionable?.generatedAt,
  );
  const qualityFiles = applyDeltaFreshnessGate(
    visibleWarningFiles(quality?.files),
    cwd,
    quality?.generatedAt,
  );

  const lines: string[] = [];

  if (severity !== "error") {
    for (const file of actionableFiles) {
      const rel = path.relative(cwd, file.filePath);
      lines.push(`${rel}`);
      for (const w of file.warnings) {
        const where = w.stale ? STALE_LINE_MARKER : `L${w.line ?? "?"}`;
        lines.push(`  ⚠ ${where}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`);
      }
    }
  }

  if (severity !== "error") {
    for (const file of qualityFiles) {
      const rel = path.relative(cwd, file.filePath);
      if (!lines.includes(rel)) lines.push(rel);
      for (const w of file.warnings) {
        const where = w.stale ? STALE_LINE_MARKER : `L${w.line ?? "?"}`;
        lines.push(`  ℹ ${where}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`);
      }
    }
  }

  const projectDeltaCount = appendProjectDiagnosticsDeltaLines(
    lines,
    cwd,
    projectDelta,
    severity,
    includeFile,
  );

  const aw = actionableFiles.reduce((count, file) => count + file.warnings.length, 0);
  const cq = qualityFiles.reduce((count, file) => count + file.warnings.length, 0);

  if (lines.length === 0) {
    let text = `No ${severity === "all" ? "" : severity + " "}issues in the current turn delta.`;
    const carried = getFileDiagnosticSummaries()
      .filter((f) => includeFile(f.filePath))
      .map((f) => ({
        ...f,
        diagnostics: applyRulePolicy(
          applyWeakDispositions(f.diagnostics, cwd, f.filePath),
          policyMap,
        ),
      }))
      .filter((f) => f.diagnostics.length > 0);
    const carriedIssues = carried.reduce((n, f) => n + f.diagnostics.length, 0);
    if (carried.length > 0) {
      text += ` ${carriedIssues} finding${carriedIssues === 1 ? "" : "s"} across ${carried.length} file${carried.length === 1 ? "" : "s"} carried over from earlier this session — use mode=all to see them.`;
    }
    text += pathsScopeCacheOnlyNote(pathsScope);
    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "delta", warnings: 0, carriedOverFiles: carried.length },
    };
  }

  const summary = `\nSummary (turn delta): ${aw} actionable warning${aw === 1 ? "" : "s"} · ${cq} quality issue${cq === 1 ? "" : "s"} · ${projectDeltaCount} project diagnostic${projectDeltaCount === 1 ? "" : "s"}`;
  return {
    content: [{ type: "text" as const, text: lines.join("\n") + summary }],
    details: {
      mode: "delta",
      actionableWarnings: aw,
      qualityIssues: cq,
      projectDiagnostics: projectDeltaCount,
    },
  };
}

function createCurrentIgnoreFilter(cwd: string): (filePath: string) => boolean {
  try {
    const matcher = getProjectIgnoreMatcher(cwd);
    return (filePath: string) => !matcher.isIgnored(path.resolve(filePath), false);
  } catch {
    return () => true;
  }
}

interface DiagnosticsToolResult {
  content: [{ type: "text"; text: string }];
  details: object;
}

interface PathsScope {
  includeFile: (filePath: string) => boolean;
  missing: string[];
  existingEntries: string[];
  hasDirectoryEntries: boolean;
}

function resolvePathsScope(cwd: string, rawPaths: RuntimeValue): PathsScope | undefined {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return undefined;
  if (rawPaths.length > MAX_PATHS_ENTRIES) {
    throw new Error(
      `paths has ${rawPaths.length} entries, over the ${MAX_PATHS_ENTRIES} cap. ` +
        "Narrow the list or omit paths to scan without a restriction.",
    );
  }
  const entries = rawPaths
    .filter((entry): entry is string => isRuntimeString(entry) && entry.trim().length > 0)
    .map((entry) => path.resolve(path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)));

  const missing: string[] = [];
  const fileEntries: string[] = [];
  const existingEntries: string[] = [];
  const dirEntries: string[] = [];
  for (const entry of entries) {
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(entry);
    } catch {
      missing.push(entry);
      fileEntries.push(entry);
      continue;
    }
    if (stat.isDirectory()) {
      dirEntries.push(entry);
    } else {
      fileEntries.push(entry);
      existingEntries.push(entry);
    }
  }

  const fileKeys = new Set(fileEntries.map((f) => normalizeFilePath(f)));
  const dirPrefixes = dirEntries.map((d) => normalizeFilePath(d));

  const includeFile = (filePath: string): boolean => {
    const key = normalizeFilePath(path.resolve(filePath));
    if (fileKeys.has(key)) return true;
    return dirPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  };

  return {
    includeFile,
    missing,
    existingEntries,
    hasDirectoryEntries: dirEntries.length > 0,
  };
}

function pathsScopeCacheOnlyNote(scope: PathsScope | undefined): string {
  if (!scope) return "";
  return (
    "\n\nNote: paths restricts this to cached findings for files choco-pi-lsp has " +
    "already dispatched this session — mode=delta/all can't see files it " +
    "hasn't touched. Use mode=full to actively scan exactly these paths."
  );
}

function pathsScopeMissingNote(scope: PathsScope | undefined): string {
  if (!scope || scope.missing.length === 0) return "";
  const shown = scope.missing.slice(0, 10).map((p) => path.basename(p));
  const more =
    scope.missing.length > shown.length ? ` (+${scope.missing.length - shown.length} more)` : "";
  return `\n\n⚠ Skipped ${scope.missing.length} path(s) not found on disk: ${shown.join(", ")}${more}`;
}

function filterProjectDiagnosticsSnapshot(
  snapshot: ProjectDiagnosticsSnapshot | undefined,
  includeFile: (filePath: string) => boolean,
): ProjectDiagnosticsSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    diagnostics: snapshot.diagnostics.filter((d) => includeFile(d.filePath)),
  };
}

function filterProjectDiagnosticsDeltaReport(
  report: ProjectDiagnosticsDeltaReport | undefined,
  includeFile: (filePath: string) => boolean,
): ProjectDiagnosticsDeltaReport | undefined {
  if (!report) return undefined;
  return {
    ...report,
    diagnostics: report.diagnostics.filter((d) => includeFile(d.filePath)),
  };
}

function applyProjectRulePolicy<T extends { diagnostics: ProjectDiagnostic[] }>(
  value: T | undefined,
  policyMap: ReturnType<typeof rulePolicyMapFromConfig>,
): T | undefined {
  if (!value) return undefined;
  return { ...value, diagnostics: applyRulePolicy(value.diagnostics, policyMap) };
}

function isErrorLike(d: WidgetDiagnostic): boolean {
  if (d.stale) return false;
  return d.semantic === "blocking" || d.severity === "error";
}

function matchesSeverity(d: WidgetDiagnostic, severity: string): boolean {
  if (severity === "error") return isErrorLike(d);
  if (severity === "warning") return !isErrorLike(d);
  return true;
}

function severityRank(d: WidgetDiagnostic): number {
  if (d.semantic === "blocking") return 0;
  if (d.severity === "error") return 1;
  if (d.severity === "warning") return 2;
  return 3;
}

function bySeverityThenLine(a: WidgetDiagnostic, b: WidgetDiagnostic): number {
  return severityRank(a) - severityRank(b) || (a.line ?? 0) - (b.line ?? 0);
}

function lspSeverityName(severity: LSPDiagnostic["severity"]): string {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  return "hint";
}

function lspRuleId(diagnostic: LSPDiagnostic): string {
  const code = diagnostic.code === undefined ? undefined : String(diagnostic.code);
  if (diagnostic.source && code) return `${diagnostic.source}:${code}`;
  return diagnostic.source ?? code ?? "lsp";
}

function lspDiagnosticToWidget(diagnostic: LSPDiagnostic): WidgetDiagnostic {
  const severity = lspSeverityName(diagnostic.severity);
  const rule = lspRuleId(diagnostic);
  return {
    severity,
    semantic: diagnostic.severity === 1 ? "blocking" : "warning",
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
    col: diagnostic.range.start.character + 1,
    rule,
    tool: "lsp",
  };
}

function projectDiagnosticToWidget(diagnostic: ProjectDiagnostic): WidgetDiagnostic {
  return {
    severity: diagnostic.severity,
    semantic: diagnostic.semantic,
    message: diagnostic.message,
    line: diagnostic.line,
    col: diagnostic.column,
    rule: diagnostic.rule ?? diagnostic.code,
    tool: diagnostic.runner || diagnostic.tool,
  };
}

function diagnosticDedupKey(filePath: string, diagnostic: WidgetDiagnostic): string {
  const ruleId = normalizeRuleId(diagnostic.rule ?? diagnostic.tool ?? "");
  return [path.resolve(filePath), diagnostic.line ?? "?", ruleId].join(":");
}

function summarizeDiagnostics(
  filePath: string,
  diagnostics: WidgetDiagnostic[],
  hasFinalSnapshot: boolean,
): FileDiagnosticSummary {
  let blocking = 0;
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.stale) continue;
    if (diagnostic.semantic === "blocking") blocking++;
    if (diagnostic.severity === "error") errors++;
    else if (
      diagnostic.severity === "warning" ||
      diagnostic.severity === "hint" ||
      diagnostic.severity === "info"
    )
      warnings++;
  }
  return {
    filePath,
    blocking,
    errors,
    warnings,
    hasFinalSnapshot,
    diagnostics,
  };
}

interface UnconfirmedReasonText {
  budget: string;
  inconclusive: string;
  coverage_gap: string;
  service_destroyed: string;
  error: string;
  binding_mismatch: string;
}

const UNCONFIRMED_REASON_SENTENCE: UnconfirmedReasonText = {
  budget: "check didn't complete within budget",
  inconclusive: "check was inconclusive (notify-write or diagnostics wait timed out)",
  coverage_gap: "an auxiliary scanner coverage gap",
  service_destroyed: "the LSP service was reset mid-sweep",
  error: "check errored",
  binding_mismatch: "the file changed on disk since this result was computed",
};

const UNCONFIRMED_REASON_COUNT_LABEL: UnconfirmedReasonText = {
  budget: "timed out",
  inconclusive: "inconclusive",
  coverage_gap: "coverage gap",
  service_destroyed: "service reset mid-sweep",
  error: "errored",
  binding_mismatch: "stale binding",
};

function classifyUnconfirmedReason(
  result: WorkspaceLspDiagnosticResult,
  mismatched: WeakSet<WorkspaceLspDiagnosticResult>,
): LSPWorkspaceUnconfirmedReason {
  if (mismatched.has(result)) return "binding_mismatch";
  return result.unconfirmedReason ?? (result.error ? "error" : "budget");
}

function tallyUnconfirmedReasons(
  results: readonly WorkspaceLspDiagnosticResult[],
  mismatched: WeakSet<WorkspaceLspDiagnosticResult>,
): Map<LSPWorkspaceUnconfirmedReason, number> {
  const tally = new Map<LSPWorkspaceUnconfirmedReason, number>();
  for (const result of results) {
    const reason = classifyUnconfirmedReason(result, mismatched);
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  return tally;
}

function formatUnconfirmedReasonClause(tally: Map<LSPWorkspaceUnconfirmedReason, number>): string {
  const entries = [...tally.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    return UNCONFIRMED_REASON_SENTENCE[entries[0][0]];
  }
  return entries
    .map(([reason, count]) => `${count} ${UNCONFIRMED_REASON_COUNT_LABEL[reason]}`)
    .join(", ");
}

function tallyLspByPrimaryServer(
  confirmed: WorkspaceLspDiagnosticResult[],
  unconfirmed: WorkspaceLspDiagnosticResult[],
): Map<string, { confirmed: number; total: number }> {
  const byServer = new Map<string, { confirmed: number; total: number }>();
  const bump = (filePath: string, wasConfirmed: boolean) => {
    const id = primaryServerId(filePath) ?? "unknown";
    const entry = byServer.get(id) ?? { confirmed: 0, total: 0 };
    entry.total += 1;
    if (wasConfirmed) entry.confirmed += 1;
    byServer.set(id, entry);
  };
  for (const result of confirmed) bump(result.filePath, true);
  for (const result of unconfirmed) bump(result.filePath, false);
  return byServer;
}

function formatLspServerBreakdown(
  byServer: Map<string, { confirmed: number; total: number }>,
): string {
  return [...byServer.entries()]
    .sort((a, b) => {
      const rateA = a[1].confirmed / a[1].total;
      const rateB = b[1].confirmed / b[1].total;
      return rateA - rateB;
    })
    .map(([id, { confirmed, total }]) => `${id}: ${confirmed}/${total}`)
    .join(", ");
}

function tallyLspPrimaryVsAuxiliary(results: WorkspaceLspDiagnosticResult[]) {
  let primary = 0;
  let auxiliary = 0;
  for (const result of results) {
    const primaryId = primaryServerId(result.filePath);
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.source === primaryId) primary += 1;
      else auxiliary += 1;
    }
  }
  return { primary, auxiliary };
}

function mergeDiagnosticsWithWidgetSummaries(
  widgetSummaries: FileDiagnosticSummary[],
  lspResults: WorkspaceLspDiagnosticResult[],
  projectSnapshot?: ProjectDiagnosticsSnapshot,
  projectDelta?: ProjectDiagnosticsDeltaReport,
): FileDiagnosticSummary[] {
  const byFile = new Map<string, FileDiagnosticSummary>();
  const seen = new Set<string>();

  for (const summary of widgetSummaries) {
    const filePath = path.resolve(summary.filePath);
    const diagnostics = (summary.diagnostics ?? []).map((d) => ({ ...d }));
    byFile.set(filePath, { ...summary, filePath, diagnostics });
    for (const diagnostic of diagnostics) {
      seen.add(diagnosticDedupKey(filePath, diagnostic));
    }
  }

  const addDiagnostic = (filePath: string, widgetDiagnostic: WidgetDiagnostic) => {
    const existing = byFile.get(filePath);
    const diagnostics = existing ? [...existing.diagnostics] : [];
    const key = diagnosticDedupKey(filePath, widgetDiagnostic);
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(widgetDiagnostic);
    byFile.set(
      filePath,
      summarizeDiagnostics(filePath, diagnostics, existing?.hasFinalSnapshot ?? true),
    );
  };

  for (const result of lspResults) {
    const filePath = path.resolve(result.filePath);
    for (const diagnostic of result.diagnostics ?? []) {
      addDiagnostic(filePath, lspDiagnosticToWidget(diagnostic));
    }
  }

  for (const diagnostic of projectSnapshot?.diagnostics ?? []) {
    addDiagnostic(path.resolve(diagnostic.filePath), projectDiagnosticToWidget(diagnostic));
  }
  for (const diagnostic of projectDelta?.diagnostics ?? []) {
    addDiagnostic(path.resolve(diagnostic.filePath), projectDiagnosticToWidget(diagnostic));
  }

  return [...byFile.values()];
}

async function applyInlineSuppressionsToSummaries(
  summaries: FileDiagnosticSummary[],
  cwd: string,
  policyMap: ReturnType<typeof rulePolicyMapFromConfig>,
): Promise<FileDiagnosticSummary[]> {
  return Promise.all(
    summaries.map(async (summary) => {
      if (!summary.diagnostics.length) return summary;
      let content: string;
      try {
        content = await fs.readFile(summary.filePath, "utf8");
      } catch {
        const policyKept = applyRulePolicy(summary.diagnostics, policyMap);
        return policyKept.length === summary.diagnostics.length
          ? summary
          : summarizeDiagnostics(summary.filePath, policyKept, summary.hasFinalSnapshot);
      }
      const inlineKept = applyInlineSuppressions(summary.diagnostics, content);
      const kept = applyDispositions(inlineKept, cwd, summary.filePath, content);
      const policyKept = applyRulePolicy(kept, policyMap);
      for (const d of policyKept) {
        const { weak } = anchorsForDiagnostic(cwd, summary.filePath, d, content);
        if (getDisposition(cwd, weak)?.disposition === "flagged") {
          // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
          (d as { flagged?: boolean }).flagged = true;
        }
      }
      if (policyKept.length === summary.diagnostics.length) return summary;
      return summarizeDiagnostics(summary.filePath, policyKept, summary.hasFinalSnapshot);
    }),
  );
}

function shouldUseCachedProjectDiagnostics(value: RuntimeValue): boolean {
  return value === "cached";
}

function shouldRefreshProjectDiagnostics(value: RuntimeValue): boolean {
  return value === "cheap" || value === "all";
}

function shouldIncludeProjectRunners(value: RuntimeValue): boolean {
  return shouldRefreshProjectDiagnostics(value) || value === "cached";
}

function foldExtraDiagnosticsIntoSnapshot(
  snapshot: ProjectDiagnosticsSnapshot | undefined,
  extra: ProjectDiagnostic[],
  runners: string[],
  cwd: string,
): ProjectDiagnosticsSnapshot | undefined {
  if (extra.length === 0) return snapshot;
  if (snapshot) {
    const merged = new Set([...snapshot.runners, ...runners]);
    return {
      ...snapshot,
      diagnostics: [...snapshot.diagnostics, ...extra],
      runners: [...merged],
    };
  }
  return {
    version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
    cwd,
    tier: "all",
    scannedAt: new Date().toISOString(),
    diagnostics: extra,
    filesScanned: 0,
    runners,
  };
}

async function getProjectDiagnosticsSnapshotForFullMode(
  cwd: string,
  options: {
    refreshRunners?: RuntimeValue;
    maxProjectFiles?: number;
    signal?: AbortSignal;
    files?: string[];
    includeGenerated?: boolean;
  },
): Promise<ProjectDiagnosticsSnapshot | undefined> {
  if (shouldRefreshProjectDiagnostics(options.refreshRunners)) {
    return scanProjectDiagnostics({
      cwd,
      tier: "cheap",
      maxFiles: options.maxProjectFiles,
      signal: options.signal,
      files: options.files,
      includeGenerated: options.includeGenerated,
    });
  }
  if (shouldUseCachedProjectDiagnostics(options.refreshRunners)) {
    const cached = loadProjectDiagnosticsSnapshot(cwd);
    return cached ? reconcileProjectDiagnosticsSnapshot(cached).snapshot : undefined;
  }
  return undefined;
}

async function formatFullMode(
  cwd: string,
  severity: string,
  lspService: LSPServiceLike,
  cacheManager: CacheManager,
  options: {
    refreshRunners?: RuntimeValue;
    maxProjectFiles?: number;
    maxLspFiles?: number;
    signal?: AbortSignal;
    wallClockMs?: number;
    onProgress?: (completed: number, total: number) => void;
    onServerReady?: () => void;
    pathsScope?: PathsScope;
    nextWriteIndex?: () => number;
    runtime?: import("../clients/runtime-coordinator.ts").RuntimeCoordinator;
    includeGenerated?: boolean;
  } = {},
): Promise<{ content: [{ type: "text"; text: string }]; details: object }> {
  const runWorkspaceDiagnostics = lspService.runWorkspaceDiagnostics;
  if (!runWorkspaceDiagnostics) {
    return {
      content: [
        {
          type: "text" as const,
          text: "LSP service does not support project-wide workspace diagnostics.",
        },
      ],
      details: { mode: "full", filesChecked: 0, lspUnavailable: true },
    };
  }
  const { signal, pathsScope, nextWriteIndex } = options;
  const ignoreFile = createCurrentIgnoreFilter(cwd);
  const includeFile = (filePath: string) =>
    ignoreFile(filePath) && (!pathsScope || pathsScope.includeFile(filePath));
  const explicitFiles =
    pathsScope && !pathsScope.hasDirectoryEntries ? pathsScope.existingEntries : undefined;
  const projectRunnersRequested = shouldIncludeProjectRunners(options.refreshRunners);
  const analyzersPromise = projectRunnersRequested
    ? loadBootstrapClients().then((clients) =>
        fetchFreshProjectDiagnostics(cacheManager, cwd, clients, signal, {
          runtime: options.runtime,
        }),
      )
    : Promise.resolve<FreshProjectDiagnosticsResult>({
        diagnostics: [],
        runners: [],
        cold: [...ANALYZER_IDS],
        coldReasons: Object.fromEntries(ANALYZER_IDS.map((id) => [id, NOT_REQUESTED_REASON])),
        failed: [],
        timings: {},
      });
  const [rawLspResults, rawProjectSnapshot, extracted] = await Promise.all([
    runWorkspaceDiagnostics.call(lspService, cwd, {
      maxFiles: options.maxLspFiles,
      signal,
      onProgress: options.onProgress,
      onServerReady: options.onServerReady,
      nextWriteIndex: options.nextWriteIndex,
      files: explicitFiles,
    }),
    getProjectDiagnosticsSnapshotForFullMode(cwd, {
      ...options,
      files: explicitFiles,
    }),
    analyzersPromise,
  ]);
  const aborted = signal?.aborted ?? false;
  const lspResults = await demoteInferredProjectSweepResults(
    rawLspResults.filter((result) => includeFile(result.filePath)),
    cwd,
    lspService,
    signal,
  );
  const mismatchedLspResults = await findFullScanBindingMismatches(lspResults);
  const confirmedLspResults = lspResults.filter(
    (result) => !result.timedOut && !result.error && !mismatchedLspResults.has(result),
  );
  const unconfirmedLspResults = lspResults.filter(
    (result) => result.timedOut || result.error || mismatchedLspResults.has(result),
  );
  for (const result of confirmedLspResults) {
    try {
      const diagnostics = convertLspDiagnostics(result.diagnostics, result.filePath, {
        scanOrigin: "lens_diagnostics_full",
      });
      const retagged = retagAuxiliaryDiagnostics(diagnostics, result.diagnostics, "", {
        cwd,
        fileRole: detectFileRole(result.filePath),
      });
      reconcileScanDiagnostics(
        result.filePath,
        retagged,
        true,
        result.writeIndex ?? nextWriteIndex?.(),
        result.observedAt,
      );
    } catch {}
  }
  const policyMap = loadProjectRulePolicyMap(cwd);
  const scannedSnapshot = filterProjectDiagnosticsSnapshot(rawProjectSnapshot, includeFile);
  const projectSnapshot = applyProjectRulePolicy(
    foldExtraDiagnosticsIntoSnapshot(
      scannedSnapshot,
      extracted.diagnostics.filter((d) => includeFile(d.filePath)),
      extracted.runners,
      cwd,
    ),
    policyMap,
  );
  const projectDelta = applyProjectRulePolicy(
    filterProjectDiagnosticsDeltaReport(loadProjectDiagnosticsDeltaReport(cwd), includeFile),
    policyMap,
  );
  const summaries = await applyInlineSuppressionsToSummaries(
    mergeDiagnosticsWithWidgetSummaries(
      getFileDiagnosticSummaries().filter((summary) => includeFile(summary.filePath)),
      confirmedLspResults,
      projectSnapshot,
      projectDelta,
    ),
    cwd,
    policyMap,
  );
  const result = formatAllMode(cwd, severity, summaries, {
    mode: "full",
    lspFilesChecked: rawLspResults.length,
    partial: aborted,
    projectDiagnostics:
      projectSnapshot === undefined
        ? undefined
        : {
            tier: projectSnapshot.tier,
            filesScanned: projectSnapshot.filesScanned,
            diagnostics: projectSnapshot.diagnostics.length,
            runners: projectSnapshot.runners,
          },
    projectDiagnosticsDelta:
      projectDelta === undefined
        ? undefined
        : {
            diagnostics: projectDelta.diagnostics.length,
            sources: projectDelta.sources,
            turnIndex: projectDelta.turnIndex,
          },
  });
  const missingNote = pathsScopeMissingNote(pathsScope);
  const unconfirmedByReason = tallyUnconfirmedReasons(unconfirmedLspResults, mismatchedLspResults);
  const lspServerBreakdown = tallyLspByPrimaryServer(confirmedLspResults, unconfirmedLspResults);
  const serverBreakdownClause =
    lspServerBreakdown.size > 1
      ? ` — by server: ${formatLspServerBreakdown(lspServerBreakdown)}.`
      : "";
  const unconfirmedLspNote =
    unconfirmedLspResults.length > 0
      ? `\n\n⚠ LSP sweep: ${confirmedLspResults.length} file(s) confirmed via LSP, ` +
        `${unconfirmedLspResults.length} unconfirmed (${formatUnconfirmedReasonClause(
          unconfirmedByReason,
        )})${serverBreakdownClause} — NOT the same as 0 diagnostics for: ${unconfirmedLspResults
          .slice(0, 20)
          .map((result) => result.filePath)
          .join(
            ", ",
          )}${unconfirmedLspResults.length > 20 ? ", …" : ""}. These files' LSP contribution is excluded from this result; re-run mode=full to retry them (they may still show findings above from cached/project-runner state).`
      : "";
  const lspPrimaryVsAuxiliary = tallyLspPrimaryVsAuxiliary(confirmedLspResults);
  const lspPrimaryVsAuxiliaryNote =
    lspPrimaryVsAuxiliary.primary + lspPrimaryVsAuxiliary.auxiliary > 0
      ? `\n\nLSP sweep findings: ${lspPrimaryVsAuxiliary.primary} primary (language server), ` +
        `${lspPrimaryVsAuxiliary.auxiliary} auxiliary (ast-grep/opengrep/zizmor/typos/marksman/...).`
      : "";
  const abortedIds = new Set(extracted.abortedIds ?? []);
  const genuinelyColdIds = extracted.cold.filter((id) => !abortedIds.has(id));
  const coldNote = extracted.unsafeRoot
    ? `\n\nheavyweight analyzers skipped: the working directory resolves at or above the home directory, so a fresh project scan would walk every unrelated tree under it. Re-run from inside a project directory. Absence of their findings is NOT a clean verdict.`
    : !projectRunnersRequested && genuinelyColdIds.length > 0
      ? `\n\nnot run this call (quick mode): ${genuinelyColdIds.join(", ")}. ${NOT_REQUESTED_REASON}. Absence of their findings is NOT a clean verdict.`
      : genuinelyColdIds.length > 0
        ? `\n\ncold (not applicable / unavailable this run): ${genuinelyColdIds
            .map((id) => formatNotRunEntry(id, extracted.coldReasons))
            .join(
              ", ",
            )}. These analyzers have not contributed to this result — absence of their findings is NOT a clean verdict.`
        : "";
  const testRunnerEditScopedNote = extracted.runners.includes("test-runner")
    ? `\n\ntest-runner coverage is edit-scoped, NOT a full-project run: its findings only reflect the test file(s) touched by the most recent edit's turn_end fire, not a fresh whole-project test suite run (mode=full never re-runs the suite — see fresh-fetch.ts). Absence of test-runner findings elsewhere in the project is NOT a clean verdict, and presence here does not mean "just checked" — it may be from several turns ago.`
    : "";
  const failedAnalyzers = extracted.failed ?? [];
  const failedNote =
    failedAnalyzers.length > 0
      ? `\n\nfailed (ran, but no trustworthy result): ${failedAnalyzers
          .map(({ id, summary }) => `${id} — ${summary}`)
          .join(
            ", ",
          )}. These analyzers were not cached and will be retried; absence of their findings is NOT a clean verdict.`
      : "";
  const dispositionSuppressedByLaneText = Object.entries(
    extracted.dispositionSuppressedByLane ?? {},
  )
    .map(([id, count]) => `${id} ${count}`)
    .join(", ");
  const dispositionSuppressedNote =
    (extracted.dispositionSuppressed ?? 0) > 0
      ? `\n\nsuppressed by disposition: ${extracted.dispositionSuppressed} finding(s) dropped from this result because they're marked false-positive or won't-fix (${dispositionSuppressedByLaneText}). Not a clean verdict for those locations — they were found, then intentionally hidden.`
      : "";
  const walkUnsafeRoot = explicitFiles === undefined && isAtOrAboveHomeDir(cwd);
  const walkUnsafeRootNote = walkUnsafeRoot
    ? `\n\nproject file walk skipped: the working directory resolves at or above the home directory, so the cheap project scan and the LSP workspace sweep would each enumerate every unrelated tree under it. Re-run from inside a project directory. Absence of their findings is NOT a clean verdict.`
    : "";
  const scanTruncatedNoticeText = projectSnapshot
    ? scanTruncationNotice(projectSnapshot)
    : undefined;
  const scanTruncatedNote = scanTruncatedNoticeText ? `\n\n${scanTruncatedNoticeText}` : "";
  const generatedSkipNoticeText = projectSnapshot
    ? generatedSkipNotice(projectSnapshot)
    : undefined;
  const generatedSkipNote = generatedSkipNoticeText ? `\n\n${generatedSkipNoticeText}` : "";
  const cheapScanScannedAtMs = rawProjectSnapshot?.scannedAt
    ? Date.parse(rawProjectSnapshot.scannedAt)
    : undefined;
  const cheapScanStatusNote = !projectRunnersRequested
    ? `\n\ncheap project scan (tree-sitter/fact-rules/ast-grep): not run this call (${NOT_REQUESTED_REASON}).`
    : options.refreshRunners === "cached"
      ? cheapScanScannedAtMs !== undefined && Number.isFinite(cheapScanScannedAtMs)
        ? `\n\ncheap project scan (tree-sitter/fact-rules/ast-grep): served from cache, ${formatCacheAge(
            Date.now() - cheapScanScannedAtMs,
          )} old — not re-run this call.`
        : `\n\ncheap project scan (tree-sitter/fact-rules/ast-grep): not run (no cached scan; refresh with refresh_runners=cheap/all to populate).`
      : "";
  const abortedNote =
    abortedIds.size > 0
      ? `\n\nstopped mid-scan (still running in the background, not reflected in this result): ${[
          ...abortedIds,
        ].join(
          ", ",
        )}. Not a clean verdict for these — re-run mode=full to pick up their result once it's cached.`
      : "";
  const cachedAgeMs = extracted.cachedAgeMs ?? {};
  const timingEntries = Object.entries(extracted.timings ?? {}).filter(
    ([id]) => !(id in cachedAgeMs),
  );
  const freshNote =
    timingEntries.length > 0
      ? `\n\nfetched fresh this call: ${timingEntries
          .map(([id, ms]) => `${id} (${Math.round(ms)}ms)`)
          .join(", ")}.`
      : "";
  const cachedAgeEntries = Object.entries(cachedAgeMs);
  const cachedAgeNote =
    cachedAgeEntries.length > 0
      ? `\n\nserved from cache this call (not re-run): ${cachedAgeEntries
          .map(([id, ms]) => `${id} (${formatCacheAge(ms)} old)`)
          .join(", ")}.`
      : "";
  const resultWithCold = {
    ...result,
    details: {
      ...result.details,
      coldRunners: extracted.cold,
      coldReasons: extracted.coldReasons ?? {},
      failedAnalyzers,
      analyzerTimingsMs: extracted.timings,
      dispositionSuppressed: extracted.dispositionSuppressed ?? 0,
      dispositionSuppressedByLane: extracted.dispositionSuppressedByLane ?? {},
      analyzersCachedAgeMs: cachedAgeMs,
      analyzersAborted: extracted.aborted ?? false,
      analyzersAbortedIds: extracted.abortedIds ?? [],
      analyzersUnsafeRoot: extracted.unsafeRoot ?? false,
      projectWalkUnsafeRoot: walkUnsafeRoot,
      lspFilesConfirmed: confirmedLspResults.length,
      lspFilesUnconfirmed: unconfirmedLspResults.length,
      unconfirmedLspFiles: unconfirmedLspResults.map((result) => result.filePath),
      lspServerBreakdown: Object.fromEntries(lspServerBreakdown),
      lspPrimaryDiagnosticsCount: lspPrimaryVsAuxiliary.primary,
      lspAuxiliaryDiagnosticsCount: lspPrimaryVsAuxiliary.auxiliary,
      projectScanTruncated: projectSnapshot?.scanTruncated ?? false,
      ...includePropertiesWhen(projectSnapshot?.generatedFileSkips, () => ({
        projectGeneratedFileSkips: projectSnapshot?.generatedFileSkips ?? 0,
      })),
      ...includePropertiesWhen(projectSnapshot?.generatedNameOnlySkips, () => ({
        projectGeneratedNameOnlySkips: projectSnapshot?.generatedNameOnlySkips ?? 0,
      })),
      ...includePropertiesWhen(projectSnapshot?.generatedDirSkips, () => ({
        projectGeneratedDirSkips: projectSnapshot?.generatedDirSkips ?? 0,
      })),
    },
  };
  if (aborted) {
    const timedOut =
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      (signal as (AbortSignal & { reason?: { name?: string } }) | undefined)?.reason?.name ===
      "TimeoutError";
    const note = timedOut
      ? `\n\n⚠ Scan exceeded its ${Math.round((options.wallClockMs ?? 0) / 1000)}s time budget and was stopped — results are partial. ` +
        "Narrow it with max_lsp_files, or raise CHOCO_PI_LSP_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS."
      : "\n\n⚠ Scan cancelled before completion — results are partial. " +
        "Re-run with a smaller max_lsp_files to finish within budget.";
    return {
      content: [
        {
          type: "text" as const,
          text:
            result.content[0].text +
            note +
            unconfirmedLspNote +
            lspPrimaryVsAuxiliaryNote +
            coldNote +
            testRunnerEditScopedNote +
            failedNote +
            dispositionSuppressedNote +
            walkUnsafeRootNote +
            scanTruncatedNote +
            generatedSkipNote +
            abortedNote +
            freshNote +
            cachedAgeNote +
            cheapScanStatusNote +
            missingNote,
        },
      ],
      details: { ...resultWithCold.details, timedOut },
    };
  }
  if (
    missingNote ||
    coldNote ||
    testRunnerEditScopedNote ||
    failedNote ||
    dispositionSuppressedNote ||
    walkUnsafeRootNote ||
    scanTruncatedNote ||
    generatedSkipNote ||
    abortedNote ||
    freshNote ||
    cachedAgeNote ||
    cheapScanStatusNote ||
    unconfirmedLspNote ||
    lspPrimaryVsAuxiliaryNote
  ) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            result.content[0].text +
            unconfirmedLspNote +
            lspPrimaryVsAuxiliaryNote +
            coldNote +
            testRunnerEditScopedNote +
            failedNote +
            dispositionSuppressedNote +
            walkUnsafeRootNote +
            scanTruncatedNote +
            generatedSkipNote +
            abortedNote +
            freshNote +
            cachedAgeNote +
            cheapScanStatusNote +
            missingNote,
        },
      ],
      details: resultWithCold.details,
    };
  }
  return resultWithCold;
}

function formatAllMode(
  cwd: string,
  severity: string,
  summaries: FileDiagnosticSummary[] = getFileDiagnosticSummaries(),
  detailOverrides: ProtocolDictionary = { mode: "all" },
  staleDropped = 0,
  pathsScope?: PathsScope,
  dependencyDemoted = 0,
): DiagnosticsToolResult {
  const staleNote =
    (staleDropped > 0
      ? ` (${staleDropped} changed file${staleDropped === 1 ? "" : "s"} omitted as stale — use mode=full to rescan)`
      : "") +
    (dependencyDemoted > 0
      ? ` (${dependencyDemoted} blocking finding${dependencyDemoted === 1 ? "" : "s"} demoted to [stale] — an imported file changed since; re-run to confirm)`
      : "");

  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const isFullMode = (detailOverrides as { mode?: string }).mode === "full";

  const ignoreFile = createCurrentIgnoreFilter(cwd);
  const includeFile = (filePath: string) =>
    ignoreFile(filePath) && (!pathsScope || pathsScope.includeFile(filePath));
  const policyMap = loadProjectRulePolicyMap(cwd);
  const dispositioned = isFullMode
    ? summaries
    : summaries.map((s) => {
        const kept = applyWeakDispositions(s.diagnostics ?? [], cwd, s.filePath);
        const policyKept = applyRulePolicy(kept, policyMap);
        if (policyKept.length === kept.length && kept.length === (s.diagnostics?.length ?? 0))
          return s;
        return summarizeDiagnostics(s.filePath, policyKept, s.hasFinalSnapshot);
      });
  const eofGated = dispositioned.map((s) => {
    const { diagnostics, demotedCount } = demotePastEofDiagnostics({
      store: "diagnostics_report",
      cwd,
      filePath: s.filePath,
      diagnostics: s.diagnostics ?? [],
      resync: resyncDocumentOnPastEof,
    });
    if (demotedCount === 0) return s;
    return summarizeDiagnostics(s.filePath, diagnostics, s.hasFinalSnapshot);
  });
  const visibleSummaries = eofGated.filter((s) => includeFile(s.filePath));

  const withIssues = visibleSummaries.filter((s) => {
    if (severity === "error") return s.blocking > 0 || s.errors > 0;
    if (severity === "warning") return s.warnings > 0;
    return (
      s.blocking > 0 || s.errors > 0 || s.warnings > 0 || (s.diagnostics ?? []).some((d) => d.stale)
    );
  });

  const pathsNote = isFullMode ? "" : pathsScopeCacheOnlyNote(pathsScope);

  if (withIssues.length === 0) {
    const text =
      (visibleSummaries.length === 0
        ? "No files diagnosed yet this session."
        : `No ${severity === "all" ? "" : severity + " "}issues across ${visibleSummaries.length} file${visibleSummaries.length === 1 ? "" : "s"} diagnosed this session. ✓`) +
      staleNote +
      pathsNote;
    return {
      content: [{ type: "text" as const, text }],
      details: {
        ...detailOverrides,
        filesChecked: visibleSummaries.length,
        staleDropped,
      },
    };
  }

  const sorted = withIssues.sort(
    (a, b) => b.blocking - a.blocking || b.errors - a.errors || b.warnings - a.warnings,
  );

  const lines: string[] = [];
  let totalBlocking = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const s of sorted) {
    const rel = path.relative(cwd, s.filePath);
    const parts: string[] = [];
    if (s.blocking > 0) parts.push(`🔴 ${s.blocking} blocking`);
    if (s.errors > 0 && s.blocking === 0) parts.push(`${s.errors}E`);
    if (s.warnings > 0) parts.push(`${s.warnings}W`);
    if (!s.hasFinalSnapshot) parts.push(`(pending)`);
    const staleCount = (s.diagnostics ?? []).filter((d) => d.stale).length;
    if (staleCount > 0) {
      parts.push(`${staleCount} stale — re-run to confirm`);
    }
    lines.push(`${rel}  ${parts.join("  ")}`);

    const matching = (s.diagnostics ?? [])
      .filter((d) => matchesSeverity(d, severity))
      .sort(bySeverityThenLine);
    const shown = matching.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    for (const d of shown) {
      const marker = d.stale ? "" : isErrorLike(d) ? (d.semantic === "blocking" ? "🔴 " : "") : "";
      const label = d.rule ?? d.tool;
      const tag = label ? ` [${label}]` : "";
      const flaggedTag = d.flagged ? " 📌 flagged-to-fix" : "";
      const msg = d.message.replace(/\s+/g, " ").trim();
      const pastEof = d.stale && (d.staleReason ?? "past-eof") === "past-eof";
      const loc = pastEof ? PAST_EOF_STALE_MARKER : `L${d.line ?? "?"}`;
      const staleTag = d.stale && !pastEof ? ` ${STALE_LINE_MARKER}` : "";
      lines.push(`  ${marker}${loc}: ${msg}${tag}${flaggedTag}${staleTag}`);
    }
    if (matching.length > shown.length) {
      lines.push(
        `  … ${matching.length - shown.length} more in this file (showing ${shown.length} of ${matching.length})`,
      );
    }

    totalBlocking += s.blocking;
    totalErrors += s.errors;
    totalWarnings += s.warnings;
  }

  const summary = [
    `\nSummary (${visibleSummaries.length} files diagnosed this session):`,
    totalBlocking > 0
      ? `  🔴 ${totalBlocking} blocking error${totalBlocking === 1 ? "" : "s"}`
      : null,
    totalErrors > 0 ? `  ${totalErrors} error${totalErrors === 1 ? "" : "s"}` : null,
    totalWarnings > 0 ? `  ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content: [{ type: "text" as const, text: lines.join("\n") + summary + staleNote }],
    details: {
      ...detailOverrides,
      filesWithIssues: withIssues.length,
      totalBlocking,
      totalErrors,
      totalWarnings,
      staleDropped,
    },
  };
}
