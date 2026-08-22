import type { CacheManager } from "../clients/cache-manager.ts";
import type { RuntimeCoordinator } from "../clients/runtime-coordinator.ts";
import { Type } from "../clients/deps/typebox.ts";
import type { LSPServiceLike } from "./diagnostics-report.ts";
import { compactRenderResult } from "./render-compact.ts";
import type { ProtocolDictionary, RuntimeValue } from "./runtime-values.ts";
import { isRuntimeString } from "./runtime-values.ts";
import { scanningSummaryLine } from "./scan-progress.ts";

const MAX_PATHS_ENTRIES = 200;

type DiagnosticsExecute = (
  toolCallId: string,
  params: ProtocolDictionary,
  signal: AbortSignal | undefined,
  onUpdate: RuntimeValue,
  ctx: { cwd?: string; signal?: AbortSignal },
) => Promise<RuntimeValue>;

interface DiagnosticsExecutable {
  execute: DiagnosticsExecute;
}

/** Register diagnostics_report metadata eagerly while loading its analysis graph on first use. */
export function createLensDiagnosticsTool(
  cacheManager: CacheManager,
  getCwd: () => string,
  getLspService?: () => LSPServiceLike,
  flushPending: () => Promise<void> = async () => {},
  nextWriteIndex?: () => number,
  captureLspStatusRepaint?: (ctx: RuntimeValue) => (() => void) | undefined,
  getRuntime?: () => RuntimeCoordinator | undefined,
) {
  let implementation: Promise<DiagnosticsExecutable> | undefined;

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
      "that with mode=all cached runner state. Optional refreshRunners=cheap/all/cached " +
      "folds in project-wide runner findings: the in-process scanners (tree-sitter + " +
      "fact-rules + ast-grep) plus a FRESH opengrep run — rather than a " +
      "possibly-stale session_start cache; each analyzer de-dupes against a " +
      "concurrent background run of itself, so this can't double-spawn.",
    promptSnippet:
      "Use diagnostics_report mode=all to verify no blocking errors remain; use mode=full for expensive project-wide checks",
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
    parameters: Type.Object({
      mode: Type.Optional(
        Type.String({
          enum: ["delta", "all", "full"],
          description:
            "delta = current turn's fixable warnings (default). " +
            "all = session diagnostics for edited/dispatched files. " +
            "full = expensive active project-wide LSP scan plus cached runner diagnostics.",
        }),
      ),
      refreshRunners: Type.Optional(
        Type.Union([Type.Boolean(), Type.String({ enum: ["cached", "cheap", "all", "none"] })], {
          description:
            "mode=full only: false/none = LSP + widget state only. cached/cheap/all trigger a FRESH run (#585) of the project analyzers (opengrep) instead of reading a possibly-stale session_start cache; safe to relaunch since each analyzer de-dupes concurrent runs against the same project root. cheap/all additionally refresh the in-process runners (tree-sitter + fact-rules + ast-grep) first.",
        }),
      ),
      maxProjectFiles: Type.Optional(
        Type.Number({
          description:
            "mode=full refreshRunners=cheap/all only: cap project files scanned by the cheap project runners (tree-sitter + fact-rules + ast-grep). Does NOT bound the LSP sweep — use maxLspFiles for that.",
        }),
      ),
      maxLspFiles: Type.Optional(
        Type.Number({
          description:
            "mode=full only: cap the number of files routed through the language server for the project-wide LSP sweep. On large projects (e.g. a Next.js app with thousands of source files) the uncapped sweep can take many minutes; set this to bound it. Default is generous (env CHOCO_PI_LSP_LSP_WORKSPACE_MAX_FILES, else 5000).",
        }),
      ),
      includeGenerated: Type.Optional(
        Type.Boolean({
          description:
            "mode=full refreshRunners=cheap/all only (no effect with refreshRunners=cached/none, since no project scan runs to apply it to): scan WITHOUT the generated/artifact NAME-heuristic filter (lockfiles, gen.ts-style names, generated/ dirs, …). Default false. Use when a scan's 'excluded by generated-name heuristics' notice suggests a real file was skipped.",
        }),
      ),
      severity: Type.Optional(
        Type.String({
          enum: ["error", "warning", "all"],
          description: "Filter by severity (default: all).",
        }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
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
    async execute(
      toolCallId: string,
      params: ProtocolDictionary,
      signal: AbortSignal | undefined,
      onUpdate: RuntimeValue,
      ctx: { cwd?: string; signal?: AbortSignal },
    ) {
      implementation ??= import("./diagnostics-report.ts").then((module) =>
        module.createLensDiagnosticsTool(
          cacheManager,
          getCwd,
          getLspService,
          flushPending,
          nextWriteIndex,
          captureLspStatusRepaint,
          getRuntime,
        ),
      );
      return (await implementation).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
