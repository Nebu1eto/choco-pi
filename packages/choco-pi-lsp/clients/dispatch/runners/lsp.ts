import { logExtension } from "../../extension-log.ts";
import { getLspCapableKinds } from "../../language-policy.ts";
import { touchCoverageGap } from "../../lsp/diagnostic-binding.ts";
import { getLSPService } from "../../lsp/index.ts";
import { RUNTIME_CONFIG } from "../../runtime-config.ts";
import { PRIORITY } from "../priorities.ts";
import { resolveRunnerPath } from "../runner-context.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { convertLspDiagnostics } from "../utils/lsp-diagnostics.ts";
import { demoteInferredProjectDiagnostics } from "../../lsp/inferred-project.ts";
import { enabledAuxiliaryLspServerIds, retagAuxiliaryDiagnostics } from "../auxiliary-lsp.ts";
import { readFileContent } from "./utils.ts";
import { tryWarmAttachedCodeActions, tryWarmAttachedDiagnostics } from "../../warm-attach.ts";
import { contentHash, WARM_CODE_ACTION_LOOKUP_LIMIT } from "../../mcp/ipc.ts";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const LSP_SPAWN_BUDGET_MS = RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs;

const LSP_DIAGNOSTICS_WAIT_MS = 2500;
const MAX_CODE_ACTION_TITLES = 3;

function normalizeActionTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function buildCodeActionSuggestion(
  actions: import("../../lsp/client.ts").LSPCodeAction[],
): string | undefined {
  if (!actions.length) return undefined;
  const quickFixes = actions.filter((action) => action.kind?.startsWith("quickfix"));
  if (!quickFixes.length) return undefined;

  const titles = Array.from(
    new Set(
      quickFixes
        .map((action) => normalizeActionTitle(action.title))
        .filter((title) => title.length > 0),
    ),
  ).slice(0, MAX_CODE_ACTION_TITLES);

  if (!titles.length) return undefined;
  return `LSP quick fixes: ${titles.join("; ")}`;
}

const lspRunner: RunnerDefinition = {
  id: "lsp",
  appliesTo: getLspCapableKinds(),
  priority: PRIORITY.LSP_PRIMARY,
  enabledByDefault: true,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const diagnosticPath = resolveRunnerPath(ctx.cwd, ctx.filePath);
    if (ctx.pi.getFlag("no-lsp")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const lspService = getLSPService();

    if (!lspService.supportsLSP(ctx.filePath)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let lspDiags: import("../../lsp/client.ts").LSPDiagnostic[] = [];
    let serverFailed = false;
    let lspClientReady = true;
    let diagnosticsInconclusive = false;
    let unconfirmedServerIds: readonly string[] = [];
    let usedWarmAttach = false;
    let failureReason = "";
    const content = readFileContent(ctx.filePath);
    if (!content) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const sizeBytes = Buffer.byteLength(content, "utf-8");
    const lineCount = content.split("\n").length;
    if (sizeBytes > LSP_MAX_FILE_BYTES || lineCount > LSP_MAX_FILE_LINES) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const auxiliaryServerIds = enabledAuxiliaryLspServerIds((f) => ctx.pi.getFlag(f));
    try {
      const attached = await tryWarmAttachedDiagnostics(
        ctx.filePath,
        content,
        Math.max(LSP_SPAWN_BUDGET_MS, LSP_DIAGNOSTICS_WAIT_MS),
      );
      usedWarmAttach = attached?.available === true;
      const touched = attached?.available
        ? {
            diags: attached.response.diagnostics,
            ...(attached.response.unconfirmedServerIds !== undefined && {
              unconfirmedServerIds: attached.response.unconfirmedServerIds,
            }),
          }
        : await lspService.touchFile(ctx.filePath, content, {
            diagnostics: "document",
            collectDiagnostics: true,
            clientScope: auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary",
            auxiliaryServerIds,
            maxClientWaitMs: LSP_SPAWN_BUDGET_MS,
            maxDiagnosticsWaitMs: LSP_DIAGNOSTICS_WAIT_MS,
            source: "dispatch-lsp-runner",
          });
      if (touched === undefined) {
        lspClientReady = false;
      } else {
        lspDiags = touched.diags;
        diagnosticsInconclusive = touched.inconclusive === true;
        unconfirmedServerIds = touchCoverageGap(touched);
      }
    } catch (err) {
      serverFailed = true;
      failureReason = err instanceof Error ? err.message : String(err);
      if (
        failureReason.includes("spawn") ||
        failureReason.includes("exited") ||
        failureReason.includes("connection") ||
        failureReason.includes("JSON RPC")
      ) {
        logExtension({
          subsystem: "lsp-runner",
          message: `LSP server failed for ${diagnosticPath}: ${failureReason}`,
          metadata: { filePath: diagnosticPath },
        });
      }
    }

    if (serverFailed) {
      return {
        status: "failed",
        failureKind: "server_error",
        failureMessage: failureReason.slice(0, 200),
        diagnostics: [
          {
            id: `lsp:server-error:0`,
            message: `LSP server failed: ${failureReason}`,
            filePath: diagnosticPath,
            line: 1,
            column: 1,
            severity: "error",
            semantic: "warning",
            tool: "lsp",
          },
        ],
        semantic: "warning",
      };
    }

    if (!lspClientReady) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (diagnosticsInconclusive) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (lspDiags.length === 0) {
      if (unconfirmedServerIds.length > 0) {
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }
      return {
        status: "succeeded",
        diagnostics: [],
        semantic: "none",
        rawOutput: "no-diagnostics",
      };
    }

    const rawValidLspDiags = lspDiags.filter((d) => d.range?.start?.line !== undefined);
    const validLspDiags = usedWarmAttach
      ? rawValidLspDiags
      : await demoteInferredProjectDiagnostics(rawValidLspDiags, {
          filePath: diagnosticPath,
          cwd: ctx.cwd,
          service: lspService,
        });
    const fixSuggestionByIndex = new Map<number, string>();

    const blockingDiagIndexes = rawValidLspDiags
      .map((d, idx) => ({ d, idx }))
      .filter(({ d }) => d.severity === 1)
      .slice(0, WARM_CODE_ACTION_LOOKUP_LIMIT);

    if (usedWarmAttach) {
      const ranges = blockingDiagIndexes.map(({ d }) => ({
        start: d.range.start,
        end: d.range.end ?? d.range.start,
      }));
      const result = await tryWarmAttachedCodeActions(
        ctx.filePath,
        contentHash(content),
        ranges,
        LSP_DIAGNOSTICS_WAIT_MS,
      );
      if (result?.available) {
        result.response.actions.forEach((actions, responseIndex) => {
          const diagnosticIndex = blockingDiagIndexes[responseIndex]?.idx;
          const suggestion = buildCodeActionSuggestion(actions);
          if (diagnosticIndex !== undefined && suggestion) {
            fixSuggestionByIndex.set(diagnosticIndex, suggestion);
          }
        });
      }
    } else {
      await Promise.all(
        blockingDiagIndexes.map(async ({ d, idx }) => {
          try {
            const start = d.range.start;
            const end = d.range.end ?? d.range.start;
            const actions = await lspService.codeAction(
              ctx.filePath,
              start.line,
              start.character,
              end.line,
              end.character,
            );
            const suggestion = buildCodeActionSuggestion(actions);
            if (suggestion) {
              fixSuggestionByIndex.set(idx, suggestion);
            }
          } catch {}
        }),
      );
    }

    const diagnostics: Diagnostic[] = convertLspDiagnostics(validLspDiags, diagnosticPath, {
      fixSuggestionByIndex,
    });

    const keptDiagnostics = retagAuxiliaryDiagnostics(diagnostics, validLspDiags, content, {
      cwd: ctx.cwd,
      fileRole: ctx.fileRole,
    });

    const hasErrors = keptDiagnostics.some((d) => d.semantic === "blocking");
    const resultSemantic = hasErrors ? "blocking" : keptDiagnostics.length > 0 ? "warning" : "none";

    return {
      status: hasErrors ? "failed" : "succeeded",
      failureKind: hasErrors ? "blocking_diagnostics" : undefined,
      diagnostics: keptDiagnostics,
      semantic: resultSemantic,
    };
  },
};

export default lspRunner;
