import {
  isFunction,
  isString,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { loadBootstrapClients } from "./bootstrap.ts";
import type { CacheManager } from "./cache-manager.ts";
import { recordDegradationOnce } from "./degradation-ledger.ts";
import { detectFileKind } from "./file-kinds.ts";
import { isPathIgnoredByProject } from "./file-utils.ts";
import { evaluateGitGuard, isGitCommitOrPushAttempt } from "./git-guard.ts";
import { normalizeForGuardMatch } from "./host-edit-normalize.ts";
import { retargetReplacementIndentation } from "./indent-retarget.ts";
import { LANGUAGE_POLICY } from "./language-policy.ts";
import type { LSPShutdownOptions } from "./lsp/client.ts";
import { getLSPService } from "./lsp/index.ts";
import {
  findDocumentSymbolAtLine,
  getOpenDocumentSymbols,
  lspSymbolKindName,
  qualifiedLspSymbolName,
} from "./lsp-document-symbols.ts";
import {
  computeTrailingWhitespaceOldTextPatch,
  findUniqueMatchLineRange,
} from "./oldtext-autopatch.ts";
import { applyPartiallyApplicableEdits } from "./partial-edit-apply.ts";
import {
  type HostPathVariantResolution,
  isExternalOrVendorFile,
  resolveHostPathVariants,
  resolveHostToolPath,
} from "./path-utils.ts";
import { EXPANSION_BUDGET_MS, EXPANSION_LIMIT_LINES, tryExpandRead } from "./read-expansion.ts";
import {
  boundedIndexesForCount,
  createReadGuardEditBatchSummary,
  getReadGuardCorrelationId,
  logReadGuardEvent,
} from "./read-guard-logger.ts";
import {
  countFileLines,
  getTouchedLinesForGuard,
  relocateEditRange,
  tryCorrectIndentationMismatch,
  tryCorrectIndentationMismatchFromContent,
} from "./read-guard-tool-lines.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { handleToolResult } from "./runtime-tool-result.ts";
import { isToolCallEventType, resolveToolCallCorrelationId } from "./tool-event.ts";
import { getSharedTreeSitterClient } from "./tree-sitter-shared.ts";

const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CHOCO_PI_LSP_TOOLCALL_NAV_TOUCH_MS ??
      process.env.CHOCO_PI_LSP_LSP_NAV_CLIENT_WAIT_MS ??
      "1500",
    10,
  ) || 1500,
);
const LSP_TOOLCALL_TOUCH_BUDGET_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_TOOLCALL_TOUCH_MS ?? "750", 10) || 750,
);

function getToolCallRawFilePath(toolName: string, event: { input?: unknown }): string | undefined {
  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const inputObj = (event.input ?? {}) as Record<string, LspDictionaryValue>;

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if (isToolCallEventType("write", event as any) || isToolCallEventType("edit", event as any)) {
    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    const filePath = (event.input as { path?: unknown }).path;

    return isString(filePath) ? filePath : undefined;
  }

  if (toolName === "read") {
    if (isString(inputObj.path)) return inputObj.path;

    if (isString(inputObj.filePath)) return inputObj.filePath;
    return undefined;
  }

  if (toolName === "lsp_navigation") {
    return isString(inputObj.filePath) ? inputObj.filePath : undefined;
  }

  return undefined;
}

function resolveToolCallFilePath(
  rawFilePath: string | undefined,
  cwd: string | undefined,
  projectRoot: string,
): HostPathVariantResolution | undefined {
  if (!rawFilePath) return undefined;
  return resolveHostPathVariants(resolveHostToolPath(rawFilePath, cwd ?? projectRoot));
}

type ReadToolInput = {
  path?: string;
  filePath?: string;
  offset?: number;
  limit?: number;
};

function getReadToolInput(toolName: string, input: LspBoundaryValue): ReadToolInput | undefined {
  if (toolName !== "read") return undefined;

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  return input as ReadToolInput;
}

function getEffectiveReadLimit(
  filePath: string | undefined,
  readInput: ReadToolInput | undefined,
): number | undefined {
  if (!filePath || !readInput) return undefined;
  const requestedOffset = readInput.offset ?? 1;
  const requestedLimit = readInput.limit;
  return requestedLimit ?? Math.max(1, countFileLines(filePath) - requestedOffset + 1);
}

function isLspCapableFile(filePath: string): boolean {
  const kind = detectFileKind(filePath);
  if (!kind) return false;
  return LANGUAGE_POLICY[kind]?.lspCapable !== false;
}

function shouldSkipLspAutoTouch(filePath: string, projectRoot: string): boolean {
  const normalized = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (normalized.includes("/.choco-pi-lsp/")) return true;
  if (normalized.includes("/.harness/")) return true;
  if (isExternalOrVendorFile(filePath, projectRoot)) return true;
  if (base === "stdout.jsonl" || base === "stderr.txt" || base === "prompt.txt") {
    return true;
  }
  if (base === "case.json" && normalized.includes("/cases/")) {
    return true;
  }
  return false;
}

function normalizeOldTextForMatch(text: string): string {
  return normalizeForGuardMatch(text);
}

function countTextOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

function countOldTextMatches(
  filePath: string,
  oldText: string,
  cachedNormalizedContent?: string,
): number {
  try {
    const content =
      cachedNormalizedContent ?? normalizeOldTextForMatch(nodeFs.readFileSync(filePath, "utf-8"));
    return countTextOccurrences(content, normalizeOldTextForMatch(oldText));
  } catch {
    return 0;
  }
}

function isIndentationOnlyChange(before: string, after: string): boolean {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  if (beforeLines.length !== afterLines.length) return false;
  return beforeLines.every((line, index) => line.trim() === afterLines[index].trim());
}

function getNewContentFromToolCall(event: LspBoundaryValue): string | undefined {
  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if (isToolCallEventType("write", event as any)) {
    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    return ((event as { input?: unknown }).input as { content?: string }).content;
  }

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if (isToolCallEventType("edit", event as any)) {
    // SAFETY: The edit discriminator establishes an input object whose edits use the host's documented edit shape.
    const edits = (
      (event as { input?: unknown }).input as {
        edits?: Array<{ newText?: string }>;
      }
    ).edits;
    return edits?.map((edit) => edit.newText ?? "").join("\n");
  }
  return undefined;
}

interface ToolCallEvent {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  details?: unknown;
  provider?: string;
  model?: string;
  sessionId?: string;
  session?: { id?: string };
}

interface ToolCallCtx {
  cwd?: string;
  ui?: {
    setStatus: (id: string, text: string | undefined) => void;
    theme: {
      fg: (color: "accent" | "success" | "error" | "warning" | "dim", text: string) => string;
    };
  };
}

interface ToolCallDeps {
  event: ToolCallEvent;
  ctx: ToolCallCtx;
  lensEnabled: boolean;
  getFlag: (name: string) => boolean | string | undefined;
  dbg: (msg: string) => void;
  runtime: RuntimeCoordinator;
  cacheManager: CacheManager;
  ensureLSPConfigInitialized: (cwd: string) => Promise<void>;
  updateLspStatus: (
    setStatus: (id: string, text: string | undefined) => void,
    theme: {
      fg: (color: "accent" | "success" | "error" | "warning" | "dim", text: string) => string;
    },
  ) => void;
  resetLSPService: (options?: LSPShutdownOptions) => void;
  getTreeSitterClient?: typeof getSharedTreeSitterClient;
}

export type ToolCallResult = { block: true; reason?: string } | void;

export async function handleToolCall(deps: ToolCallDeps): Promise<ToolCallResult> {
  try {
    const result = await handleToolCallImpl(deps);

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    if (result && (result as { block?: boolean }).block) {
      try {
        const toolCallId = resolveToolCallCorrelationId(deps.event);
        if (toolCallId !== undefined) {
          deps.runtime.takeToolCallAttribution(toolCallId);
        }
      } catch (cleanupError) {
        const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        recordDegradationOnce({
          kind: "tool-call-handler-throw",

          // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
          subject: `attribution-cleanup:${(deps.event as { toolName?: string } | undefined)?.toolName ?? "unknown"}`,
          reason,
        });
        try {
          deps.dbg?.(
            `tool_call blocked-attribution cleanup threw (block verdict preserved): ${reason}`,
          );
        } catch {}
      }
    }
    return result;
  } catch (error) {
    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    const toolName = (deps.event as { toolName?: string } | undefined)?.toolName ?? "unknown";
    const reason = error instanceof Error ? error.message : String(error);
    recordDegradationOnce({
      kind: "tool-call-handler-throw",
      subject: toolName,
      reason,
    });
    try {
      deps.dbg?.(`tool_call handler threw for ${toolName} (degraded, not blocking): ${reason}`);
      if (error instanceof Error && error.stack) {
        deps.dbg?.(`tool_call handler stack: ${error.stack}`);
      }
    } catch {}
    return undefined;
  }
}

async function handleToolCallImpl(deps: ToolCallDeps): Promise<ToolCallResult> {
  const {
    event,
    ctx,
    lensEnabled,
    getFlag,
    dbg,
    runtime,
    cacheManager,
    ensureLSPConfigInitialized,
    updateLspStatus,
    resetLSPService,
    getTreeSitterClient = getSharedTreeSitterClient,
  } = deps;

  const readGuardCorrelationId = getReadGuardCorrelationId(event);
  let filePath: string | undefined;
  const logToolReadGuardEvent = (entry: Parameters<typeof logReadGuardEvent>[0]): void =>
    logReadGuardEvent({ ...entry, correlationId: readGuardCorrelationId });

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const toolName = (event as { toolName?: string }).toolName ?? "";

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const editInputForTelemetry = (event as { input?: unknown }).input as
    | { edits?: unknown[] }
    | undefined;
  const requestedEditIndexes =
    toolName === "write"
      ? [0]
      : Array.isArray(editInputForTelemetry?.edits)
        ? boundedIndexesForCount(editInputForTelemetry.edits.length)
        : [0];
  const requestedEditTotal =
    toolName === "write"
      ? 1
      : Array.isArray(editInputForTelemetry?.edits)
        ? editInputForTelemetry.edits.length
        : 1;
  const logBlockedEditSummary = (source: string): void =>
    logToolReadGuardEvent({
      event: "edit_batch_summary",
      filePath: filePath ?? "",
      metadata: {
        tool: toolName,
        source,
        editBatchSummary: createReadGuardEditBatchSummary({
          requestedIndexes: requestedEditIndexes,
          requestedTotal: requestedEditTotal,
          rejectedReasons: requestedEditIndexes.map((index) => ({
            index,
            code: "preflight_blocked" as const,
          })),
          rejectedTotal: requestedEditTotal,
          terminalStatus: "blocked",
        }),
      },
    });
  if (!lensEnabled) return;
  if (getFlag("lens-guard") && isGitCommitOrPushAttempt(toolName, event.input)) {
    const guard = evaluateGitGuard(runtime, cacheManager, ctx.cwd ?? runtime.projectRoot);
    if (guard.block) {
      return {
        block: true,
        reason: guard.reason,
      };
    }
  }

  const rawFilePath = getToolCallRawFilePath(toolName, event);
  const pathResolution = resolveToolCallFilePath(rawFilePath, ctx.cwd, runtime.projectRoot);
  filePath = pathResolution?.path;
  if (pathResolution?.variant) {
    dbg(`tool_call: path resolved via host ${pathResolution.variant} variant → ${filePath}`);
  }

  if (!getFlag("no-lsp")) {
    try {
      const configCwd = filePath
        ? path.dirname(filePath)
        : (ctx.cwd ?? runtime.projectRoot ?? process.cwd());
      await ensureLSPConfigInitialized(configCwd);
    } catch (cfgErr) {
      dbg(`lsp config init failed during tool_call: ${cfgErr}`);
    }
  }

  if (!filePath) return;

  dbg(`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`);
  const toolCallId = resolveToolCallCorrelationId(event);
  const attributesMutationTarget =
    toolCallId !== undefined && (toolName === "write" || toolName === "edit");
  const targetMissing = !nodeFs.existsSync(filePath);
  const targetIgnored = isPathIgnoredByProject(filePath, runtime.projectRoot, false);
  if (attributesMutationTarget) {
    runtime.recordToolCallAttribution(toolCallId, {
      resolvedPath: filePath,
      skipped: targetIgnored,
      originCwd: ctx.cwd ?? runtime.projectRoot,
    });
  }
  if (targetMissing) {
    if (toolName !== "write" && pathResolution?.unresolved) {
      const tried =
        pathResolution.triedVariants.length > 0
          ? `tried ${pathResolution.triedVariants.join(", ")}`
          : "no variant differed from the resolved path";
      recordDegradationOnce({
        kind: "path-variant-unresolved",
        subject: filePath,
        reason: `${toolName}: no file at the resolved path, and none of pi's variants matched (${tried})`,
      });
    }
    return;
  }
  if (targetIgnored) {
    dbg(`tool_call: skipping gitignored file ${filePath}`);
    return;
  }

  const isExternalOrVendor = isExternalOrVendorFile(filePath, runtime.projectRoot);

  const lspCapableFile = isLspCapableFile(filePath);
  const lspAutoTouchSkipped = shouldSkipLspAutoTouch(filePath, runtime.projectRoot);
  const lspAutoTouchEligible = lspCapableFile && !lspAutoTouchSkipped;
  const shouldWarmReadLsp =
    toolName === "read" && lspAutoTouchEligible && runtime.shouldWarmLspOnRead(filePath);
  const shouldAutoTouch =
    (toolName === "write" ||
      toolName === "edit" ||
      toolName === "lsp_navigation" ||
      shouldWarmReadLsp) &&
    !getFlag("no-lsp") &&
    lspAutoTouchEligible;
  if (!lspCapableFile && !getFlag("no-lsp")) {
    dbg(`lsp auto-touch skipped: ${path.basename(filePath)} (file kind not LSP-capable)`);
  } else if (lspAutoTouchSkipped && !getFlag("no-lsp")) {
    dbg(`lsp auto-touch skipped: ${path.basename(filePath)} (internal/support artifact)`);
  }
  if (toolName === "read" && !getFlag("no-lsp") && !shouldWarmReadLsp) {
    const readSkipReason = !lspAutoTouchEligible
      ? "file not eligible for LSP warm"
      : "already warming or warmed recently";
    dbg(`lsp read warm skipped: ${path.basename(filePath)} (${readSkipReason})`);
  }
  if (shouldAutoTouch) {
    try {
      const fileContent = nodeFs.readFileSync(filePath, "utf-8");
      const maxClientWaitMs =
        toolName === "lsp_navigation"
          ? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS
          : LSP_TOOLCALL_TOUCH_BUDGET_MS;
      if (toolName === "read") {
        runtime.markLspReadWarmStarted(filePath);
        dbg(`lsp read warm started: ${path.basename(filePath)}`);
      }
      void getLSPService()
        .touchFile(filePath, fileContent, {
          diagnostics: "none",
          source: `tool_call:${toolName}`,
          clientScope: "primary",
          maxClientWaitMs,
        })
        .then((result) => {
          if (toolName === "read") {
            if (result === undefined) {
              runtime.clearLspReadWarmState(filePath);
              dbg(`lsp read warm unavailable: ${path.basename(filePath)} (no LSP client ready)`);
            } else {
              runtime.markLspReadWarmCompleted(filePath);
              dbg(`lsp read warm completed: ${path.basename(filePath)}`);
            }
          }
          if (ctx.ui) {
            if (ctx.ui) updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
          }
        })
        .catch((err) => {
          if (toolName === "read") {
            runtime.clearLspReadWarmState(filePath);
          }
          dbg(`lsp auto-touch failed for ${filePath}: ${err}`);
        });
    } catch {
      if (toolName === "read") {
        runtime.clearLspReadWarmState(filePath);
      }
    }
  }

  const readInput = getReadToolInput(toolName, event.input);
  const requestedReadOffset = readInput?.offset ?? 1;
  const requestedReadLimit = readInput?.limit;
  let effectiveReadOffset = requestedReadOffset;
  let effectiveReadLimit = getEffectiveReadLimit(filePath, readInput);

  let expandedByLsp = false;
  let enclosingSymbol:
    | {
        name: string;
        kind: string;
        startLine: number;
        endLine: number;
      }
    | undefined;

  const readExpansionClient =
    toolName === "read" &&
    !getFlag("no-lsp") &&
    !isExternalOrVendor &&
    filePath &&
    readInput &&
    requestedReadLimit != null &&
    requestedReadLimit <= EXPANSION_LIMIT_LINES
      ? getTreeSitterClient()
      : null;
  if (readExpansionClient && filePath && readInput && requestedReadLimit != null) {
    const totalLines =
      effectiveReadLimit != null && requestedReadLimit == null
        ? effectiveReadLimit
        : countFileLines(filePath);
    try {
      const expansion = await tryExpandRead(
        filePath,
        requestedReadOffset,
        requestedReadLimit,
        totalLines,
        readExpansionClient,
      );
      if (expansion) {
        readInput.offset = expansion.newOffset;
        readInput.limit = expansion.newLimit;
        effectiveReadOffset = expansion.newOffset;
        effectiveReadLimit = expansion.newLimit;
        expandedByLsp = true;
        let enriched = false;
        let enrichedAncestry = expansion.ancestry;
        const lspSymbols = await getOpenDocumentSymbols(filePath);
        const located = lspSymbols
          ? findDocumentSymbolAtLine(lspSymbols, expansion.enclosingSymbol.startLine)
          : undefined;
        if (located) {
          enclosingSymbol = {
            ...expansion.enclosingSymbol,
            name: qualifiedLspSymbolName(located, lspSymbols),
            kind: lspSymbolKindName(located.symbol.kind),
          };
          if (located.ancestry.length > 0) {
            enrichedAncestry = located.ancestry.map((entry) => ({
              name: entry.name,
              kind: lspSymbolKindName(entry.kind),
              startLine: ((entry.range ?? entry.location?.range)?.start.line ?? 0) + 1,
              endLine: ((entry.range ?? entry.location?.range)?.end.line ?? 0) + 1,
            }));
          }
          enriched = true;
        } else {
          enclosingSymbol = expansion.enclosingSymbol;
        }
        logToolReadGuardEvent({
          event: "ts_range_expanded",
          sessionId: runtime.telemetrySessionId,
          filePath,
          requestedOffset: requestedReadOffset,
          requestedLimit: requestedReadLimit,
          effectiveOffset: expansion.newOffset,
          effectiveLimit: expansion.newLimit,
          symbol: enclosingSymbol.name,
          symbolKind: enclosingSymbol.kind,
          symbolStartLine: expansion.enclosingSymbol.startLine,
          symbolEndLine: expansion.enclosingSymbol.endLine,
          metadata: {
            enriched,
            durationMs: expansion.durationMs,
            budgetMs: EXPANSION_BUDGET_MS,
          },
        });
        const symbolPath = [
          ...(enrichedAncestry ?? []).map((a) => a.name),
          enclosingSymbol.name,
        ].join(" → ");
        dbg(
          `ts expanded read: ${path.basename(filePath)} ` +
            `lines ${requestedReadOffset}–${requestedReadOffset + requestedReadLimit - 1} ` +
            `→ ${symbolPath} ` +
            `(${expansion.newOffset}–${expansion.newOffset + expansion.newLimit - 1})`,
        );
      }
    } catch {}
  }

  if (toolName === "read" && filePath && !isExternalOrVendor) {
    const totalLines = countFileLines(filePath);
    const deliveredLimit = effectiveReadLimit ?? 1;
    logToolReadGuardEvent({
      event: "read_pattern",
      sessionId: runtime.telemetrySessionId,
      filePath,
      requestedOffset: requestedReadOffset,
      requestedLimit: requestedReadLimit ?? deliveredLimit,
      effectiveOffset: effectiveReadOffset,
      effectiveLimit: deliveredLimit,
      metadata: {
        totalLines,
        isPartial: requestedReadLimit != null && requestedReadLimit < totalLines,
        fileKind: detectFileKind(filePath) ?? "unknown",
        fractionRead: totalLines > 0 ? Math.round((deliveredLimit / totalLines) * 100) / 100 : 1,
        expandedByTs: expandedByLsp,
      },
    });
    runtime.readGuard.recordRead({
      filePath,
      requestedOffset: requestedReadOffset,
      requestedLimit: requestedReadLimit ?? deliveredLimit,
      effectiveOffset: effectiveReadOffset,
      effectiveLimit: deliveredLimit,
      expandedByLsp,
      enclosingSymbol,
      turnIndex: runtime.turnIndex,
      writeIndex: runtime.peekWriteIndex(),
      timestamp: Date.now(),
    });
  }

  const { complexityClient } = await loadBootstrapClients();
  if (
    !isExternalOrVendor &&
    complexityClient.isSupportedFile(filePath) &&
    !runtime.complexityBaselines.has(filePath)
  ) {
    const baseline = await complexityClient.analyzeFile(filePath);
    if (baseline) {
      runtime.complexityBaselines.set(filePath, baseline);
      const { captureSnapshot } = await import("./metrics-history.ts");
      captureSnapshot(filePath, {
        maintainabilityIndex: baseline.maintainabilityIndex,
        cognitiveComplexity: baseline.cognitiveComplexity,
        maxNestingDepth: baseline.maxNestingDepth,
        linesOfCode: baseline.linesOfCode,
        maxCyclomatic: baseline.maxCyclomaticComplexity,
        entropy: baseline.codeEntropy,
      });
    }
  }

  const isEditOnly = isToolCallEventType("edit", event);
  const isWriteOrEdit = isToolCallEventType("write", event) || isEditOnly;

  if (!isEditOnly && isWriteOrEdit && filePath && !getFlag("no-read-guard")) {
    runtime.readGuard.noteCreatedFile(filePath, runtime.turnIndex, runtime.peekWriteIndex());
  }

  if (isEditOnly && filePath) {
    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    const editInput = (event as { input?: unknown }).input as {
      oldText?: string;
      newText?: string;
      edits?: Array<{ oldText?: string; newText?: string }>;
    };
    type EditIndentTarget = {
      label: string;
      value: string;
      newText: string | undefined;
      apply: (corrected: string) => void;
      applyNewText: (corrected: string) => void;
    };
    const oldTexts: EditIndentTarget[] = editInput.oldText
      ? [
          {
            label: "oldText",
            value: editInput.oldText,
            newText: editInput.newText,
            apply: (corrected: string) => {
              editInput.oldText = corrected;
            },
            applyNewText: (corrected: string) => {
              editInput.newText = corrected;
            },
          },
        ]
      : (editInput.edits ?? [])
          .map((e, i) =>
            e.oldText
              ? {
                  label: `edits[${i}].oldText`,
                  value: e.oldText,
                  newText: e.newText,
                  apply: (corrected: string) => {
                    e.oldText = corrected;
                  },
                  applyNewText: (corrected: string) => {
                    e.newText = corrected;
                  },
                }
              : null,
          )
          .filter((entry): entry is EditIndentTarget => entry !== null);
    let crlfContent: string | undefined;
    let matchNormalizedContent: string | undefined;
    try {
      const raw = nodeFs.readFileSync(filePath, "utf-8");
      crlfContent = raw.replace(/\r\n/g, "\n");
      matchNormalizedContent = normalizeOldTextForMatch(raw);
    } catch {}

    if (matchNormalizedContent !== undefined) {
      for (const entry of oldTexts) {
        const v = entry.value;
        if (!v.includes("\t") && !v.includes("\n")) continue;
        if (countOldTextMatches(filePath, v, matchNormalizedContent) !== 0) continue;
        const escaped = v.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
        if (escaped === v) continue;
        if (countOldTextMatches(filePath, escaped, matchNormalizedContent) !== 1) continue;
        entry.apply(escaped);
        entry.value = escaped;
        logToolReadGuardEvent({
          event: "oldtext_escape_autopatched",
          sessionId: runtime.telemetrySessionId,
          filePath,
          metadata: { tool: "edit", label: entry.label },
        });
      }
    }

    if (crlfContent !== undefined) {
      for (const entry of oldTexts) {
        const patch = computeTrailingWhitespaceOldTextPatch({
          oldText: entry.value,
          newText: entry.newText,
          fileContent: crlfContent,
        });
        if (!patch) continue;
        entry.apply(patch.oldText);
        entry.value = patch.oldText;
        const newTextPatched = patch.newText !== undefined && patch.newText !== entry.newText;
        if (newTextPatched) {
          entry.applyNewText(patch.newText!);
          entry.newText = patch.newText;
        }
        logToolReadGuardEvent({
          event: "oldtext_trailing_ws_autopatched",
          sessionId: runtime.telemetrySessionId,
          filePath,
          metadata: {
            tool: "edit",
            label: entry.label,
            removedLineTrailingWhitespace: patch.removedLineTrailingWhitespace,
            removedTrailingEmptyLineCount: patch.removedTrailingEmptyLineCount,
            newTextTrailingEmptyLinesPatched: newTextPatched,
          },
        });
        if (matchNormalizedContent !== undefined && runtime.readGuard) {
          const range = findUniqueMatchLineRange(matchNormalizedContent, patch.oldText);
          if (range) {
            runtime.readGuard.recordRead({
              filePath,
              requestedOffset: range.startLine,
              requestedLimit: range.endLine - range.startLine + 1,
              effectiveOffset: range.startLine,
              effectiveLimit: range.endLine - range.startLine + 1,
              expandedByLsp: false,
              turnIndex: runtime.turnIndex,
              writeIndex: 0,
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    const correctedOldTexts = oldTexts
      .map(({ label, value, newText, apply, applyNewText }) => {
        const corrected =
          crlfContent !== undefined
            ? tryCorrectIndentationMismatchFromContent(value, crlfContent)
            : tryCorrectIndentationMismatch(value, filePath);
        return corrected === undefined
          ? undefined
          : {
              label,
              value,
              newText,
              corrected,
              apply,
              applyNewText,
              currentMatchCount: countOldTextMatches(filePath, value, matchNormalizedContent),
              correctedMatchCount: countOldTextMatches(filePath, corrected, matchNormalizedContent),
              indentationOnly: isIndentationOnlyChange(value, corrected),
            };
      })
      .filter(
        (
          entry,
        ): entry is EditIndentTarget & {
          corrected: string;
          currentMatchCount: number;
          correctedMatchCount: number;
          indentationOnly: boolean;
        } => entry !== undefined,
      );
    for (const entry of correctedOldTexts) {
      if (
        entry.indentationOnly &&
        entry.currentMatchCount === 0 &&
        entry.correctedMatchCount === 1
      ) {
        entry.apply(entry.corrected);
        const correctedNewText = entry.newText
          ? retargetReplacementIndentation(entry.newText, entry.value, entry.corrected)
          : undefined;
        if (correctedNewText !== undefined) {
          entry.applyNewText(correctedNewText);
        }
        logToolReadGuardEvent({
          event: "oldtext_indent_autopatched",
          sessionId: runtime.telemetrySessionId,
          filePath,
          metadata: {
            tool: "edit",
            label: entry.label,
            correctedMatchCount: entry.correctedMatchCount,
            newTextIndentationPatched: correctedNewText !== undefined,
          },
        });
        if (matchNormalizedContent !== undefined && runtime.readGuard) {
          const range = findUniqueMatchLineRange(matchNormalizedContent, entry.corrected);
          if (range) {
            runtime.readGuard.recordRead({
              filePath,
              requestedOffset: range.startLine,
              requestedLimit: range.endLine - range.startLine + 1,
              effectiveOffset: range.startLine,
              effectiveLimit: range.endLine - range.startLine + 1,
              expandedByLsp: false,
              turnIndex: runtime.turnIndex,
              writeIndex: 0,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  }
  if (isEditOnly && filePath && !getFlag("no-read-guard")) {
    const readGuard = runtime.readGuard;
    const isExistingFile = !isFunction(readGuard?.isNewFile) || !readGuard.isNewFile(filePath);
    if (readGuard && isExistingFile && !isExternalOrVendor) {
      const {
        touchedLines,
        editRanges,
        preflightError,
        partiallyApplicable,
        contentMatchValidated,
        editBatchSummary,
      } = getTouchedLinesForGuard(
        event,
        filePath,
        runtime.telemetrySessionId,
        readGuardCorrelationId,
      );
      if (preflightError) {
        if (partiallyApplicable && partiallyApplicable.length > 0) {
          try {
            const partial = await applyPartiallyApplicableEdits({
              filePath,
              edits: partiallyApplicable,
              summary: editBatchSummary,
              correlationId: readGuardCorrelationId,
              afterWrite: async () => {
                const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
                  await loadBootstrapClients();
                const result = await handleToolResult({
                  event: {
                    toolName: "write",
                    input: { path: filePath },
                    details: {
                      piLensPartialApply: true,
                      readGuardCorrelationId,
                    },
                    content: [],
                  },
                  getFlag: (name: string) => getFlag(name),
                  dbg,
                  runtime,
                  cacheManager,
                  biomeClient,
                  ruffClient,
                  metricsClient,
                  resetLSPService,
                  readGuard: runtime.readGuard,
                  agentBehaviorRecord: (toolName, analyzedPath) =>
                    agentBehaviorClient.recordToolCall(toolName, analyzedPath),
                  formatBehaviorWarnings: (warnings) =>
                    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
                    agentBehaviorClient.formatWarnings(warnings as any),
                });
                if (result?.isError) {
                  throw new Error("post-edit pipeline rejected synthetic partial apply");
                }
                return result?.content
                  ?.map((item) => item.text)
                  .filter((text): text is string => !!text)
                  .join("\n\n");
              },
            });
            if (partial.postEditStatus === "failed") {
              return {
                block: true,
                reason: `${preflightError}\n\nPartial apply pipeline failed after ${partial.appliedCount} edit${partial.appliedCount === 1 ? "" : "s"} committed.`,
              };
            }
            if (partial.appliedCount > 0) {
              logToolReadGuardEvent({
                event: "edit_partial_apply",
                sessionId: runtime.telemetrySessionId,
                filePath,
                metadata: {
                  appliedCount: partial.appliedCount,
                  appliedTotal: partial.appliedTotal,
                  appliedIndices: partial.appliedIndices,
                  skippedCount: partial.skippedCount ?? 0,
                  skippedTotal: partial.skippedTotal ?? 0,
                  skippedIndices: partial.skippedIndices ?? "",
                  indexesTruncated: partial.indexesTruncated ?? false,
                  editBatchSummary: partial.summary,
                  routedThroughPostEditPipeline: true,
                },
              });
              let reason = preflightError.replace(
                "🔄 RETRYABLE — Edit target not found",
                `⚠️ PARTIAL APPLY — ${partial.appliedCount} edit${partial.appliedCount !== 1 ? "s" : ""} applied (${partial.appliedIndices})`,
              );
              if (partial.postEditOutput) {
                reason += `\n\nPost-apply analysis:\n${partial.postEditOutput}`;
              }
              return { block: true, reason };
            }
          } catch {}
        }
        if (!editBatchSummary) logBlockedEditSummary("preflight");
        return { block: true, reason: preflightError };
      }
      logToolReadGuardEvent({
        event: "edit_check_started",
        sessionId: runtime.telemetrySessionId,
        filePath,
        metadata: {
          tool: isToolCallEventType("write", event) ? "write" : "edit",
          touchedLines: touchedLines ?? null,
          isExistingFile,
        },
      });
      const verdict = isFunction(readGuard.checkEdit)
        ? readGuard.checkEdit(filePath, touchedLines, editRanges, {
            skipSnapshotCheck: !!contentMatchValidated,
            oldTextResolved: !!contentMatchValidated,
          })
        : { action: "allow" as const };
      if (verdict.relocation) {
        const relocated = relocateEditRange(
          // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
          (event as { input?: unknown }).input,
          verdict.relocation.from,
          verdict.relocation.to,
        );
        if (relocated) {
          const [toStart, toEnd] = verdict.relocation.to;
          runtime.readGuard?.recordRead({
            filePath,
            requestedOffset: toStart,
            requestedLimit: toEnd - toStart + 1,
            effectiveOffset: toStart,
            effectiveLimit: toEnd - toStart + 1,
            expandedByLsp: false,
            turnIndex: runtime.turnIndex,
            writeIndex: 0,
            timestamp: Date.now(),
          });
          logToolReadGuardEvent({
            event: "edit_range_relocated",
            sessionId: runtime.telemetrySessionId,
            filePath,
            metadata: {
              tool: "edit",
              from: verdict.relocation.from,
              to: verdict.relocation.to,
            },
          });
        } else if (verdict.action === "block") {
          logBlockedEditSummary("range_relocated_blocked");
          return { block: true, reason: verdict.reason };
        }
      } else if (verdict.action === "block") {
        logBlockedEditSummary("read_guard_blocked");
        return {
          block: true,
          reason: verdict.reason,
        };
      }
    }
  }

  if (isWriteOrEdit && runtime.cachedExports.size > 0) {
    const newContent = getNewContentFromToolCall(event);
    if (newContent) {
      const dupeWarnings: string[] = [];
      const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
      let currentFileExports: Set<string> | undefined;
      if (filePath && nodeFs.existsSync(filePath)) {
        try {
          const currentContent = nodeFs.readFileSync(filePath, "utf-8");
          currentFileExports = new Set<string>();
          for (const m of currentContent.matchAll(exportRe)) {
            currentFileExports.add(m[1]);
          }
        } catch {}
      }
      for (const match of newContent.matchAll(exportRe)) {
        const name = match[1];
        const existingFile = runtime.cachedExports.get(name);
        if (
          existingFile &&
          path.resolve(existingFile) !== path.resolve(filePath) &&
          !currentFileExports?.has(name)
        ) {
          dupeWarnings.push(
            `\`${name}\` already exists in ${path.relative(runtime.projectRoot, existingFile)}`,
          );
        }
      }
      if (dupeWarnings.length > 0) {
        return {
          block: true,
          reason:
            "🔴 STOP - Redefining existing export(s). Import instead:\n" +
            dupeWarnings.map((w) => "  • " + w).join("\n"),
        };
      }
    }
  }
}
