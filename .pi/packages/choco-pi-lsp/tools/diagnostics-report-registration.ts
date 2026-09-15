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
    description: "Query cached, edited-file, or project-wide diagnostic state.",
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
    parameters: Type.Object({
      mode: Type.Optional(
        Type.String({
          enum: ["delta", "all", "full"],
          description: "Scan current-turn, edited-file, or project-wide diagnostics.",
        }),
      ),
      refreshRunners: Type.Optional(
        Type.Union([Type.Boolean(), Type.String({ enum: ["cached", "cheap", "all", "none"] })], {
          description: "Project analyzer refresh level for full mode.",
        }),
      ),
      maxProjectFiles: Type.Optional(
        Type.Number({
          description: "Project-file cap for cheap analyzers.",
        }),
      ),
      maxLspFiles: Type.Optional(
        Type.Number({
          description: "File cap for the full LSP sweep.",
        }),
      ),
      includeGenerated: Type.Optional(
        Type.Boolean({
          description: "Include generated-looking files in project analyzers.",
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
          description: `Limit diagnostics to at most ${MAX_PATHS_ENTRIES} files or directories.`,
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
