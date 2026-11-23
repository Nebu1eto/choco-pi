import { retireInlineBlockerAndResyncGuard } from "../clients/git-guard.ts";
import { wrapToolsForCompactLine } from "../clients/tool-render.ts";
import { flushDebouncedToolResults } from "../clients/runtime-tool-result.ts";
import { createAstGrepDumpTool } from "../tools/ast-dump.ts";
import { createActivateToolsTool, type ActivatableToolInfo } from "../tools/activate-tools.ts";
import { createLensDiagnosticsTool } from "../tools/diagnostics-report-registration.ts";
import { createLensDiagnosticMarkTool } from "../tools/diagnostic-mark.ts";
import { createAstGrepReplaceTool } from "../tools/ast-grep-replace.ts";
import { createAstGrepSearchTool } from "../tools/ast-grep-search.ts";
import { createAstGrepOutlineTool } from "../tools/ast-grep-outline.ts";
import { createLspDiagnosticsTool } from "../tools/lsp-diagnostics.ts";
import { createLspNavigationTool } from "../tools/lsp-navigation.ts";
import {
  createModuleReportTool,
  createReadEnclosingTool,
  createReadSymbolTool,
} from "../tools/module-report.ts";
import { createProjectReportTool } from "../tools/project-report.ts";
import { createSymbolSearchTool } from "../tools/symbol-search.ts";
import { recordToolSetMutation, supportsDeferredTools } from "../clients/tool-set-policy.ts";
import type { ExtensionActivation } from "./activation.ts";
import { dbg } from "./shared.ts";

export interface LazyToolRegistration {
  readonly LAZY_TOOL_CATALOG: ActivatableToolInfo[];
  readonly rememberedLazyTools: Set<string>;
}

export function registerTools(activation: ExtensionActivation): LazyToolRegistration {
  const { pi, runtime, astGrepClient, cacheManager, getLensFlag, captureLspStatusRepaint } =
    activation;
  const alwaysActiveTools = [
    createLensDiagnosticsTool(
      cacheManager,
      () => runtime.projectRoot,
      undefined,
      () => flushDebouncedToolResults(),
      () => runtime.nextWriteIndex(),
      captureLspStatusRepaint,
      () => runtime,
    ),
    createLspDiagnosticsTool(
      () => runtime.nextWriteIndex(),
      ({ filePath, writeIndex, coveredSources, cwd }) => {
        const retired = retireInlineBlockerAndResyncGuard({
          runtime,
          cacheManager,
          cwd,
          filePath,
          writeIndex,
          coveredSources,
          lensGuardEnabled: getLensFlag("lens-guard") === true,
        });
        if (retired) {
          dbg(
            `inline_blocker: retired for ${filePath} — lsp_diagnostics confirmed clean (writeIndex ${writeIndex ?? "none"}, covered ${coveredSources.join(",") || "none"})`,
          );
        }
      },
      (name: string) => getLensFlag(name),
    ),
    createSymbolSearchTool(() => runtime.projectRoot),
    createProjectReportTool(() => runtime.projectRoot),
    createModuleReportTool(() => runtime.projectRoot),
    createReadSymbolTool(
      () => runtime.projectRoot,
      (filePath, symbol) =>
        runtime.readGuard.recordSymbolRead(
          filePath,
          symbol,
          runtime.turnIndex,
          runtime.peekWriteIndex(),
        ),
    ),
    createReadEnclosingTool(
      () => runtime.projectRoot,
      (filePath, symbol) =>
        runtime.readGuard.recordSymbolRead(
          filePath,
          symbol,
          runtime.turnIndex,
          runtime.peekWriteIndex(),
        ),
    ),
  ];

  const lazyTools = [
    createAstGrepSearchTool(astGrepClient),
    createAstGrepReplaceTool(astGrepClient),
    createAstGrepOutlineTool(astGrepClient),
    createAstGrepDumpTool(astGrepClient),
    createLspNavigationTool((name, cwd) => getLensFlag(name, cwd), {
      runtime,
      cacheManager,
      readGuard: runtime.readGuard,
      dbg,
    }),
    createLensDiagnosticMarkTool(
      () => runtime.projectRoot,
      () => ({
        model: runtime.telemetryModelId,
        provider: runtime.telemetryProviderId,
      }),
    ),
  ];
  const LAZY_TOOL_CATALOG: ActivatableToolInfo[] = [
    {
      name: "ast_grep_search",
      summary: "AST-aware structural code search across ~40 languages (ast-grep patterns).",
    },
    {
      name: "ast_grep_replace",
      summary: "AST-aware structural code rewrite/refactor (ast-grep patterns).",
    },
    {
      name: "ast_grep_outline",
      summary:
        "Syntax-only file/dir structure (symbols/imports/exports/members) via ast-grep outline — no index/LSP.",
    },
    {
      name: "ast_grep_dump",
      summary: "Dump the tree-sitter AST for a source snippet to discover node kinds/field names.",
    },
    {
      name: "lsp_navigation",
      summary:
        "IDE-style LSP navigation: definition, references, implementation, rename, call hierarchy.",
    },
    {
      name: "diagnostic_mark",
      summary:
        "Record a disposition for a diagnostic: false-positive / suppress (inline ignore comment) / defer (this session) / flagged (to fix).",
    },
  ];
  const rememberedLazyTools = new Set<string>();
  const activateToolsTool = createActivateToolsTool(
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    pi as {
      getActiveTools?: () => string[];
      setActiveTools?: (names: string[]) => void;
    },
    LAZY_TOOL_CATALOG,
    {
      onActivated: (names) => {
        for (const name of names) rememberedLazyTools.add(name);
      },
      deferredToolSupport: (ctx) => {
        try {
          return supportsDeferredTools(
            // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
            (ctx as { model?: Parameters<typeof supportsDeferredTools>[0] })?.model,
          );
        } catch {
          return false;
        }
      },
      onMutation: recordToolSetMutation,
    },
  );

  const compactToolLineEnabled = getLensFlag("lens-compact-tool-line") === true;
  const toolsToRegister = [...alwaysActiveTools, activateToolsTool, ...lazyTools];
  for (const tool of compactToolLineEnabled
    ? // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      wrapToolsForCompactLine(toolsToRegister as any)
    : toolsToRegister) {
    try {
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      pi.registerTool(tool as any);
    } catch {}
  }

  return { LAZY_TOOL_CATALOG, rememberedLazyTools };
}
