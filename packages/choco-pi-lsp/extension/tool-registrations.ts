/**
 * Tool registration: always-active tools, the lazy situational tier, and lsp_activate_tools.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

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

/** The lazy-tool catalog and the activation memory the session_start restore reads. */
export interface LazyToolRegistration {
  readonly LAZY_TOOL_CATALOG: ActivatableToolInfo[];
  readonly rememberedLazyTools: Set<string>;
}

/** Register every choco-pi-lsp tool. */
export function registerTools(activation: ExtensionActivation): LazyToolRegistration {
  const { pi, runtime, astGrepClient, cacheManager, getLensFlag, captureLspStatusRepaint } =
    activation;
  // --- Tools (extracted to tools/) ---
  // Guard each registration: if another extension (e.g. @narumitw/pi-lsp) already
  // owns the same tool name, registerTool throws and would abort extension load.
  // Catch the collision silently so both extensions can coexist.
  //
  // Always-active tools (6): stay on for every turn — cheap, broadly useful,
  // or (in the loader's case) required to bootstrap dynamic activation below.
  const alwaysActiveTools = [
    createLensDiagnosticsTool(
      cacheManager,
      () => runtime.projectRoot,
      undefined,
      // Flush pending per-edit dispatches before reporting so fixes made
      // earlier this turn are reflected (not the stale pre-fix state) (#190).
      () => flushDebouncedToolResults(),
      // #571: reconcile mode=full's fresh, confirmed results into the footer
      // (widget-state's allDiagnostics) using the SAME write-ordering token
      // source pipeline.ts's per-edit recordDiagnostics calls draw from, so
      // a scan-originated write can't clobber a concurrent newer per-edit
      // write (or vice versa).
      () => runtime.nextWriteIndex(),
      captureLspStatusRepaint,
      () => runtime,
    ),
    createLspDiagnosticsTool(
      // #571: same reconciliation wiring as diagnostics_report mode=full, for
      // the standalone on-demand check.
      () => runtime.nextWriteIndex(),
      // #1561: and the same confirmed result must retire this file's stale
      // inline blocker, not only correct the footer. The eviction is logged so
      // it is confirmable from the runtime log rather than from the absence of
      // complaints (#1432 Gap 1).
      // #1561 F2: the retire also recomputes the commit-gate latch and the
      // persisted record — see `retireInlineBlockerAndResyncGuard`.
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
      // choco-pi fork: the /lsp runtime toggle (and --no-lsp / lsp.enabled)
      // makes the tool report disabled instead of spawning servers.
      (name: string) => getLensFlag(name),
    ),
    createSymbolSearchTool(() => runtime.projectRoot),
    createProjectReportTool(() => runtime.projectRoot),
    createModuleReportTool(() => runtime.projectRoot),
    createReadSymbolTool(
      () => runtime.projectRoot,
      // Read-substitute tie-in (#245): a returned symbol body is a genuine read
      // of that range, so record it as read-guard coverage for the symbol.
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

  // Situational tools (6): registered but, on hosts that support pi's dynamic
  // tooling (`pi.getActiveTools`/`pi.setActiveTools`), left inactive at load —
  // deactivated in the block below right after registration. The model
  // activates the ones it needs via `lsp_activate_tools`. On hosts without
  // that API this whole tier is simply left statically active, matching
  // choco-pi-lsp's behavior before this feature existed.
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
  // #1453: the lazy tools the model activated in THIS logical conversation.
  // Extension closure state outlives a session rebuild (the runner keeps the
  // activated extension; it does not re-run this factory), which is exactly
  // what lets a fork/reload/resume restore the parent's tool posture. Reset
  // on startup/new, carried across fork/reload/resume — see the session_start
  // handler below.
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

  // #1327: opt-in compact one-line tool rendering. Read once at load (like
  // the other session-scoped flags above) rather than per-render, so the
  // flag-off path registers the ORIGINAL tool definitions untouched —
  // byte-identical to pre-#1327 behavior (no renderCall/renderResult added
  // or altered). Only tools that already define `renderResult` (every
  // substantive choco-pi-lsp tool — see tools/render-compact.ts) are wrapped;
  // the rest pass through wrapToolsForCompactLine unchanged.
  const compactToolLineEnabled = getLensFlag("lens-compact-tool-line") === true;
  const toolsToRegister = [...alwaysActiveTools, activateToolsTool, ...lazyTools];
  for (const tool of compactToolLineEnabled
    ? // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      wrapToolsForCompactLine(toolsToRegister as any)
    : toolsToRegister) {
    try {
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      pi.registerTool(tool as any);
    } catch {
      // another extension already registered a tool with this name
    }
  }

  // Dynamic tooling (#pi 0.80.x+): deactivate the 6 situational tools so they
  // start inactive and the model must call `lsp_activate_tools` to bring
  // them in (next-turn visibility, per the docs' loader pattern). This used
  // to run synchronously right here, immediately after registration — but
  // that point is still inside the extension's own load/activation function,
  // before the runtime considers itself initialized, so `setActiveTools`
  // structurally cannot succeed yet on ANY host (#643: it threw "Extension
  // runtime not initialized. Action methods cannot be called during
  // extension loading" on effectively every session_start, regardless of
  // host version — the 5 lazy tools were never actually deactivated). Moved
  // into the `pi.on("session_start", ...)` handler below, which fires after
  // the extension has finished loading — see the deactivation block there.

  // REMOVED: ~450 lines of inline tool definitions moved to tools/
  // See tools/ast-grep-search.ts, tools/ast-grep-replace.ts, tools/lsp-navigation.ts

  // Runtime state is managed by RuntimeCoordinator.

  // Project rules scan result and per-turn state live in RuntimeCoordinator.
  return { LAZY_TOOL_CATALOG, rememberedLazyTools };
}
