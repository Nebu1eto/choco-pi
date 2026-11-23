import { isString, type LspBoundaryValue, type LspDictionaryValue } from "./runtime-guards.ts";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { noteAuthoritativeContentAttachment } from "./agent-nudge.ts";
import {
  extractReadPathsFromCommand,
  extractDeletedPathsFromCommand,
  extractGrepSearchReadsFromOutput,
  extractWrittenPathsFromCommand,
} from "./bash-file-access.ts";
import type { BiomeClient } from "./biome-client.ts";
import { registerSearchReads, type SearchReadLocation } from "./search-read-registration.ts";
import type { CacheManager } from "./cache-manager.ts";
import { createFileTime } from "./file-time.ts";
import { publishFormatQueued } from "./format-events-publish.ts";
import { isPathIgnoredByProject } from "./file-utils.ts";
import type { ReadGuard } from "./read-guard.ts";
import { getFormatService } from "./format-service.ts";
import { isExternalOrVendorFile, normalizeEphemeralMapKey, pathsEqual } from "./path-utils.ts";
import { PathKeyedMap } from "./path-keyed-map.ts";
import { resolveLanguageRootForFile } from "./language-profile.ts";
import { logLatency } from "./latency-logger.ts";
import { resolveToolCallCorrelationId } from "./tool-event.ts";
import {
  boundedIndexesForCount,
  createReadGuardEditBatchSummary,
  getReadGuardCorrelationId,
  logReadGuardEvent,
} from "./read-guard-logger.ts";
import type { PiLensFlagSource } from "./lsp-config.ts";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import type { LSPShutdownOptions } from "./lsp/client.ts";
import { notifyExternalFileChange } from "./lsp/index.ts";
import type { MetricsClient } from "./metrics-client.ts";
import { runPipeline, type PipelineResult } from "./pipeline.ts";
import {
  appendProjectChange,
  type ProjectChangeRange,
  type ProjectChangeSource,
} from "./project-changes.ts";
import type { RuffClient } from "./ruff-client.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { syncGitGuardRecord } from "./git-guard.ts";
import { scheduleWordIndexPersist } from "./word-index.ts";
import { RUNTIME_CONFIG } from "./runtime-config.ts";

function shellCommandFromInput(input: LspBoundaryValue): string | undefined {
  if (
    input === null ||
    Object(input) !== input ||
    Array.isArray(input) ||
    input instanceof Function
  ) {
    return undefined;
  }
  // SAFETY: The structural check above permits reading the one host input field this path consumes.
  const command = (input as { command?: LspBoundaryValue }).command;
  return isString(command) ? command : undefined;
}

const AUTHORITATIVE_CONTENT_MAX_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;

interface ToolResultEvent {
  toolName: string;
  toolCallId?: string | number;
  isError?: boolean;
  input: unknown;
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
}

interface ToolResultDeps {
  event: ToolResultEvent;
  getFlag: (name: string, filePath?: string) => boolean | string | undefined;
  getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
  dbg: (msg: string) => void;
  runtime: RuntimeCoordinator;
  cacheManager: CacheManager;
  biomeClient: BiomeClient;
  ruffClient: RuffClient;
  metricsClient: MetricsClient;
  resetLSPService: (options?: LSPShutdownOptions) => void;
  agentBehaviorRecord: (toolName: string, filePath?: string) => unknown[];
  formatBehaviorWarnings: (warnings: unknown[]) => string;
  readGuard?: ReadGuard;
  sessionId?: string;
  _bypassDebounce?: boolean;
  _telemetryParticipantIds?: string[];
  _telemetryParticipantTotal?: number;
  _autofixMode?: "immediate" | "deferred";
}

function parseDiffRanges(diff: string): { start: number; end: number }[] {
  const changedLines: number[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^[+-]\s*(\d+)\s/);
    if (match) {
      changedLines.push(Number.parseInt(match[1], 10));
    }
  }

  if (changedLines.length === 0) return [];

  const sorted = [...new Set(changedLines)].sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (const line of sorted.slice(1)) {
    if (line <= rangeEnd + 1) {
      rangeEnd = line;
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = line;
      rangeEnd = line;
    }
  }
  ranges.push({ start: rangeStart, end: rangeEnd });

  return ranges;
}

interface InFlightPipeline {
  promise: Promise<unknown>;
  participantIds: string[];
  participantTotal: number;
}

const inFlightPipelines = new PathKeyedMap<Map<string, InFlightPipeline>>(normalizeEphemeralMapKey);
const lastAnalyzedStateByFile = new PathKeyedMap<{
  turnIndex: number;
  stateHash: string;
}>(normalizeEphemeralMapKey);

export function clearLastAnalyzedStateCache(): void {
  lastAnalyzedStateByFile.clear();
}

type ToolResultReturn = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
} | void;

interface DebouncedEntry {
  timer: NodeJS.Timeout;
  promise: Promise<ToolResultReturn>;
  resolve: (value: ToolResultReturn) => void;

  reject: (err: LspBoundaryValue) => void;
  latestDeps: ToolResultDeps;
  scheduledAt: number;
  coalescedCount: number;
}

const debouncedPipelines = new PathKeyedMap<DebouncedEntry>(normalizeEphemeralMapKey);

const DEFAULT_DEBOUNCE_MS = 0;
const MAX_DEBOUNCE_MS = 1000;

function getDebounceMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_TOOL_RESULT_DEBOUNCE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DEBOUNCE_MS;
  return Math.min(raw, MAX_DEBOUNCE_MS);
}

export async function flushDebouncedToolResults(filePath?: string): Promise<void> {
  const entries = filePath
    ? debouncedPipelines.has(filePath)
      ? // SAFETY: The checked element count and construction order establish this fixed tuple representation.
        [[filePath, debouncedPipelines.get(filePath) as DebouncedEntry] as const]
      : []
    : [...debouncedPipelines.entries()];
  for (const [key, entry] of entries) {
    clearTimeout(entry.timer);
    debouncedPipelines.delete(key);
    handleToolResult({ ...entry.latestDeps, _bypassDebounce: true }).then(
      entry.resolve,
      entry.reject,
    );
  }
  if (entries.length > 0) {
    await Promise.all(entries.map(([, entry]) => entry.promise.catch(() => undefined)));
  }
}

function scheduleDebounced(
  filePath: string,
  debounceMs: number,
  deps: ToolResultDeps,
): Promise<ToolResultReturn> {
  const existing = debouncedPipelines.get(filePath);
  if (existing) {
    clearTimeout(existing.timer);
    const incomingId = deps._telemetryParticipantIds?.[0] ?? getReadGuardCorrelationId(deps.event);
    const priorIds = existing.latestDeps._telemetryParticipantIds ?? [];
    existing.latestDeps = {
      ...deps,
      _telemetryParticipantIds: [...priorIds, incomingId].slice(0, 100),
      _telemetryParticipantTotal:
        (existing.latestDeps._telemetryParticipantTotal ?? priorIds.length) + 1,
    };
    existing.coalescedCount += 1;
    existing.timer = setTimeout(() => {
      debouncedPipelines.delete(filePath);
      deps.dbg(
        `tool_result: debounce fired after ${
          existing.coalescedCount
        } coalesced calls for ${filePath}`,
      );
      handleToolResult({ ...existing.latestDeps, _bypassDebounce: true }).then(
        existing.resolve,
        existing.reject,
      );
    }, debounceMs);
    deps.dbg(
      `tool_result: coalesced into pending debounce for ${filePath} (count=${existing.coalescedCount})`,
    );
    return existing.promise;
  }

  let resolveFn!: (value: ToolResultReturn) => void;

  let rejectFn!: (err: LspBoundaryValue) => void;
  const promise = new Promise<ToolResultReturn>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const initialParticipantIds = deps._telemetryParticipantIds ?? [
    getReadGuardCorrelationId(deps.event),
  ];
  const entry: DebouncedEntry = {
    timer: setTimeout(() => {
      debouncedPipelines.delete(filePath);
      handleToolResult({ ...entry.latestDeps, _bypassDebounce: true }).then(
        entry.resolve,
        entry.reject,
      );
    }, debounceMs),
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    latestDeps: {
      ...deps,
      _telemetryParticipantIds: initialParticipantIds.slice(0, 100),
      _telemetryParticipantTotal: deps._telemetryParticipantTotal ?? initialParticipantIds.length,
    },
    scheduledAt: Date.now(),
    coalescedCount: 1,
  };
  debouncedPipelines.set(filePath, entry);
  return promise;
}

function getFileStateHash(filePath: string): string {
  try {
    const content = nodeFs.readFileSync(filePath);
    return nodeCrypto.createHash("sha256").update(content).digest("hex");
  } catch (err) {
    // SAFETY: The adjacent Error and property-presence checks establish the optional Node error code representation.
    const code = (err as { code?: string }).code ?? "unknown";
    return `unreadable:${code}`;
  }
}

function getRequestedEditCount(event: ToolResultEvent): number {
  if (event.toolName === "write") return 1;

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const edits = (event.input as { edits?: unknown[] } | undefined)?.edits;
  return Array.isArray(edits) && edits.length > 0 ? edits.length : 1;
}

function getRequestedEditIndexes(event: ToolResultEvent): number[] {
  return boundedIndexesForCount(getRequestedEditCount(event));
}

function sourceForToolName(toolName: string, details?: LspBoundaryValue): ProjectChangeSource {
  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  if ((details as { piLensPartialApply?: unknown } | undefined)?.piLensPartialApply) {
    return "partial-apply";
  }
  return toolName === "write" ? "agent-write" : "agent-edit";
}

function singleRange(
  ranges: Array<{ start: number; end: number }> | undefined,
): ProjectChangeRange | undefined {
  return ranges?.length === 1 ? ranges[0] : undefined;
}

function recordProjectChange(args: {
  runtime: RuntimeCoordinator;
  cwd: string;
  filePath: string;
  source: ProjectChangeSource;
  changedRange?: ProjectChangeRange;
  dbg: (msg: string) => void;
}): void {
  // SAFETY: The runtime dependency is the concrete RuntimeCoordinator; the optional member check immediately after this access preserves compatibility.
  const bump = (args.runtime as Partial<RuntimeCoordinator>).bumpFileSeq;
  if (!bump) return;
  const { projectSeq, fileSeq } = bump.call(args.runtime, args.filePath);
  try {
    appendProjectChange(args.cwd, {
      seq: projectSeq,
      timestamp: new Date().toISOString(),
      sessionId: args.runtime.telemetrySessionId,
      turnIndex: args.runtime.turnIndex,
      source: args.source,
      filePath: path.resolve(args.filePath),
      fileSeq,
      changedRange: args.changedRange,
    });
  } catch (err) {
    args.dbg(`project change log append failed for ${args.filePath}: ${err}`);
  }
}

export async function handleToolResult(deps: ToolResultDeps): Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
} | void> {
  const {
    event,
    getFlag,
    getFlagSource,
    dbg,
    runtime,
    cacheManager,
    biomeClient,
    ruffClient,
    metricsClient,
    resetLSPService,
    agentBehaviorRecord,
    formatBehaviorWarnings,
  } = deps;

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const rawFilePath = (event.input as { path?: string }).path;
  const workspaceRoot = runtime.projectRoot || process.cwd();

  const toolCallId = resolveToolCallCorrelationId(event);
  const attribution =
    toolCallId !== undefined ? runtime.takeToolCallAttribution(toolCallId) : undefined;

  let resolutionBasis: string;
  if (attribution) {
    resolutionBasis = attribution.originCwd;
  } else if (toolCallId !== undefined && rawFilePath && !path.isAbsolute(rawFilePath)) {
    const guessedPath = path.resolve(workspaceRoot, rawFilePath);
    dbg(
      `path_attribution_missing: no recorded resolution basis for toolCallId=${toolCallId}, refusing relative path ${rawFilePath} (would have guessed ${guessedPath})`,
    );
    logLatency({
      type: "phase",
      toolName: event.toolName,
      filePath: guessedPath,
      phase: "path_attribution_missing",
      durationMs: 0,
      metadata: { toolCallId, rawFilePath, guessedPath },
    });
    return;
  } else {
    resolutionBasis = workspaceRoot;
  }
  const filePath = rawFilePath
    ? path.isAbsolute(rawFilePath)
      ? rawFilePath
      : path.resolve(resolutionBasis, rawFilePath)
    : rawFilePath;

  if (
    attribution?.skipped &&
    filePath &&
    attribution.resolvedPath &&
    !pathsEqual(filePath, attribution.resolvedPath)
  ) {
    const message = `path_attribution_refused: call target ${attribution.resolvedPath} (originCwd=${attribution.originCwd}) vs tool_result resolved ${filePath}`;
    dbg(message);
    logLatency({
      type: "phase",
      toolName: event.toolName,
      filePath,
      phase: "path_attribution_refused",
      durationMs: 0,
      metadata: {
        callTarget: attribution.resolvedPath,
        resolvedPath: filePath,
        originCwd: attribution.originCwd,
      },
    });
  }
  const behaviorWarnings = agentBehaviorRecord(event.toolName, filePath);
  const syntheticWriteContent: Array<{ type: string; text?: string }> = [];
  let syntheticAttachmentBytes = 0;

  const shellCommand = event.toolName === "bash" ? shellCommandFromInput(event.input) : undefined;
  if (shellCommand !== undefined) {
    const command = shellCommand;
    const written = extractWrittenPathsFromCommand(command, workspaceRoot).filter(
      (wp) =>
        event.isError !== true &&
        !isExternalOrVendorFile(wp, workspaceRoot) &&
        !isPathIgnoredByProject(wp, workspaceRoot, false),
    );
    for (const wp of written) {
      if (!getFlag("no-read-guard")) deps.readGuard?.recordWritten(wp);

      // SAFETY: The runtime dependency is the concrete RuntimeCoordinator; the optional member check immediately after this access preserves compatibility.
      const receipt = (runtime as Partial<RuntimeCoordinator>).recordMutationToolReceipt;
      const autofixMode = receipt ? receipt.call(runtime, wp, "write").autofixMode : "immediate";
      const syntheticResult = await handleToolResult({
        ...deps,
        event: { ...event, toolName: "write", input: { path: wp } },
        _bypassDebounce: true,
        _autofixMode: autofixMode,
      });
      if (syntheticResult) {
        for (const block of syntheticResult.content.slice(event.content.length)) {
          const blockBytes = isString(block.text) ? Buffer.byteLength(block.text, "utf-8") : 0;
          const isAuthoritativeAttachment =
            isString(block.text) && block.text.startsWith("choco-pi-lsp applied autofix to ");
          if (
            isAuthoritativeAttachment &&
            syntheticAttachmentBytes + blockBytes > AUTHORITATIVE_CONTENT_MAX_BYTES
          ) {
            logLatency({
              type: "phase",
              phase: "authoritative_content_attachment_decision",
              filePath: wp,
              durationMs: 0,
              metadata: { path: wp, bytes: blockBytes, decision: "aggregate-budget-degraded" },
            });
            noteAuthoritativeContentAttachment(path.resolve(wp), false);
            syntheticWriteContent.push({
              type: "text",
              text: `⚠️ **File was modified by auto-format/fix. You MUST re-read ${wp} before making any further edits — the aggregate authoritative content for this command is too large to attach.**`,
            });
            continue;
          }
          if (isAuthoritativeAttachment) {
            syntheticAttachmentBytes += blockBytes;
          }
          syntheticWriteContent.push(block);
        }
      }
    }
    if (event.isError !== true && !getFlag("no-read-guard")) {
      for (const span of extractReadPathsFromCommand(command, workspaceRoot)) {
        if (isExternalOrVendorFile(span.filePath, workspaceRoot)) continue;
        if (isPathIgnoredByProject(span.filePath, workspaceRoot, false)) continue;
        deps.readGuard?.recordRead({
          filePath: span.filePath,
          requestedOffset: span.offset,
          requestedLimit: span.limit,
          effectiveOffset: span.offset,
          effectiveLimit: span.limit,
          expandedByLsp: false,
          turnIndex: runtime.turnIndex,
          writeIndex: runtime.peekWriteIndex(),
          timestamp: Date.now(),
        });
      }
    }

    if (event.isError !== true && !getFlag("no-lsp") && !getFlag("no-read-guard")) {
      for (const dp of extractDeletedPathsFromCommand(command, workspaceRoot)) {
        if (isExternalOrVendorFile(dp, workspaceRoot)) continue;
        if (isPathIgnoredByProject(dp, workspaceRoot, false)) continue;
        if (!deps.readGuard || !deps.readGuard.hasKnownPath(dp)) continue;
        if (nodeFs.existsSync(dp)) continue;
        deps.readGuard.forgetPath(dp);
        void notifyExternalFileChange(dp, 3).catch((err) => {
          dbg(`tool_result: external-delete notify failed for ${dp}: ${err}`);
        });
      }
    }
  }

  if (deps.readGuard && event.isError !== true && !getFlag("no-read-guard")) {
    const searchReads: SearchReadLocation[] = [];

    // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
    const detailSearchReads = (event.details as { searchReads?: SearchReadLocation[] })
      ?.searchReads;
    if (Array.isArray(detailSearchReads)) searchReads.push(...detailSearchReads);
    const searchShellCommand =
      event.toolName === "bash" ? shellCommandFromInput(event.input) : undefined;
    if (searchShellCommand !== undefined) {
      const command = searchShellCommand;
      const output = event.content

        .map((part) => (isString(part.text) ? part.text : ""))
        .join("\n");
      searchReads.push(...extractGrepSearchReadsFromOutput(command, workspaceRoot, output));
    }
    if (searchReads.length > 0) {
      registerSearchReads(deps.readGuard, searchReads, {
        projectRoot: workspaceRoot,
        turnIndex: runtime.turnIndex,
        writeIndex: runtime.peekWriteIndex(),
      });
    }
  }

  if (event.toolName !== "write" && event.toolName !== "edit") {
    dbg(`tool_result: skipped turn tracking - toolName="${event.toolName}" (not write/edit)`);
    return syntheticWriteContent.length > 0
      ? { content: [...event.content, ...syntheticWriteContent] }
      : undefined;
  }
  if (!filePath) {
    dbg(`tool_result: skipped turn tracking - no filePath for toolName="${event.toolName}"`);
    return;
  }
  if (isExternalOrVendorFile(filePath, workspaceRoot)) {
    dbg(
      `tool_result: skipped pipeline - file outside project root or in node_modules: ${filePath}`,
    );
    return;
  }
  const readGuardCorrelationId = getReadGuardCorrelationId(event);

  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const resultDetails = (event.details ?? {}) as Record<string, LspDictionaryValue>;
  const isPartialApplyResult = resultDetails.piLensPartialApply === true;
  const requestedEditIndexes = getRequestedEditIndexes(event);
  const requestedEditTotal = getRequestedEditCount(event);
  const participantIds = [...(deps._telemetryParticipantIds ?? []), readGuardCorrelationId].slice(
    0,
    100,
  );
  const participantTotal =
    (deps._telemetryParticipantTotal ?? 0) +
    (deps._telemetryParticipantIds?.includes(readGuardCorrelationId) ? 0 : 1);
  const hostToolResultFailed = event.isError === true || resultDetails.isError === true;
  if (hostToolResultFailed) {
    logReadGuardEvent({
      event: "edit_batch_summary",
      correlationId: readGuardCorrelationId,
      filePath,
      metadata: {
        tool: event.toolName,
        source: "host_tool_result",
        editBatchSummary: createReadGuardEditBatchSummary({
          requestedIndexes: requestedEditIndexes,
          requestedTotal: requestedEditTotal,
          rejectedReasons: requestedEditIndexes.map((index) => ({
            index,
            code: "write_failed" as const,
          })),
          rejectedTotal: requestedEditTotal,
          participantIds: [readGuardCorrelationId],
          participantTotal: 1,
          commitStatus: "failed",
          terminalStatus: "failed",
        }),
      },
    });
    return { content: event.content, isError: true };
  }

  // SAFETY: The runtime dependency is the concrete RuntimeCoordinator; the optional member check immediately after this access preserves compatibility.
  const receipt = (runtime as Partial<RuntimeCoordinator>).recordMutationToolReceipt;
  const autofixMode = deps._bypassDebounce
    ? (deps._autofixMode ?? (event.toolName === "edit" ? "deferred" : "immediate"))
    : receipt
      ? receipt.call(runtime, filePath, event.toolName).autofixMode
      : event.toolName === "edit"
        ? "deferred"
        : "immediate";

  if (!deps._bypassDebounce) {
    const debounceMs = getDebounceMs();
    if (debounceMs > 0) {
      return scheduleDebounced(filePath, debounceMs, {
        ...deps,
        _autofixMode: autofixMode,
        _telemetryParticipantIds: [readGuardCorrelationId],
        _telemetryParticipantTotal: 1,
      });
    }
  }

  deps.readGuard?.recordWritten(filePath);

  if (runtime.cachedExports.size > 0 && nodeFs.existsSync(filePath)) {
    const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
    for (const [name, file] of runtime.cachedExports) {
      if (path.resolve(file) === path.resolve(filePath)) {
        runtime.cachedExports.delete(name);
      }
    }
    try {
      const freshContent = nodeFs.readFileSync(filePath, "utf-8");
      for (const match of freshContent.matchAll(exportRe)) {
        const name = match[1];
        if (!runtime.cachedExports.has(name)) {
          runtime.cachedExports.set(name, filePath);
        }
      }
    } catch {}
  }

  const initialStateHash = getFileStateHash(filePath);

  const inFlight = inFlightPipelines.get(filePath)?.get(initialStateHash);
  if (inFlight) {
    dbg(`tool_result: skipping duplicate concurrent state for ${filePath}`);
    const duplicateId = readGuardCorrelationId;
    if (inFlight.participantIds.length < 100) {
      inFlight.participantIds.push(duplicateId);
    }
    inFlight.participantTotal += 1;
    await inFlight.promise;
    return;
  }

  const lastAnalyzed = lastAnalyzedStateByFile.get(filePath);
  if (
    lastAnalyzed?.turnIndex === runtime.turnIndex &&
    lastAnalyzed.stateHash === initialStateHash
  ) {
    dbg(`tool_result: skipping already-analyzed file state this turn for ${filePath}`);
    return;
  }

  const sessionFileTime = createFileTime("default");
  sessionFileTime.read(filePath);
  if (!getFlag("no-read-guard")) {
    // SAFETY: This package creates runtime and attaches an optional readGuard with this method signature.
    const readGuard = (
      runtime as {
        readGuard?: { recordWritten?: (writtenPath: string) => void };
      }
    ).readGuard;
    readGuard?.recordWritten?.(filePath);
  }

  const toolResultStart = Date.now();
  dbg(`tool_result: tracking turn state for ${event.toolName} on ${filePath}`);

  if (isPathIgnoredByProject(filePath, workspaceRoot, false)) {
    dbg(`tool_result: skipping gitignored file ${filePath}`);
    return;
  }

  const dispatchCwd = resolveLanguageRootForFile(filePath, workspaceRoot);
  const turnStateCwd = path.resolve(workspaceRoot);
  dbg(
    `tool_result: resolved dispatch cwd ${dispatchCwd} for ${filePath} (turnState cwd ${turnStateCwd})`,
  );
  const writeIndex = runtime.nextWriteIndex();
  let modifiedRanges: Array<{ start: number; end: number }> | undefined;
  try {
    // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
    const details = event.details as Partial<EditToolDetails> | undefined;
    dbg(
      `tool_result: details.diff=${details?.diff ? "present" : "missing"}, details keys: ${Object.keys(event.details || {}).join(", ")}`,
    );
    if (event.toolName === "edit" && details?.diff) {
      const diff = details.diff;
      dbg(`tool_result: diff content (first 500 chars): ${diff.substring(0, 500)}`);
      const ranges = parseDiffRanges(diff);
      modifiedRanges = ranges;
      const importsChanged = /import\s/.test(diff) || /from\s+['"]/.test(diff);
      dbg(`tool_result: parsed ${ranges.length} ranges, importsChanged=${importsChanged}`);
      for (const range of ranges) {
        dbg(`tool_result: adding range ${range.start}-${range.end} for ${filePath}`);
        cacheManager.addModifiedRange(
          filePath,
          range,
          importsChanged,
          turnStateCwd,
          runtime.telemetrySessionId,
        );
      }
      dbg(
        `tool_result: turn state after add: ${JSON.stringify(cacheManager.readTurnState(turnStateCwd))}`,
      );
    } else if (event.toolName === "write" && nodeFs.existsSync(filePath)) {
      const content = nodeFs.readFileSync(filePath, "utf-8");
      const lineCount = content.split("\n").length;
      const hasImports = /^import\s/m.test(content);
      modifiedRanges = [{ start: 1, end: lineCount }];
      cacheManager.addModifiedRange(
        filePath,
        { start: 1, end: lineCount },
        hasImports,
        turnStateCwd,
        runtime.telemetrySessionId,
      );
    }
  } catch (err) {
    dbg(`turn state tracking error: ${err}`);

    dbg(`turn state tracking error stack: ${err instanceof Error ? err.stack : undefined}`);
  }

  recordProjectChange({
    runtime,
    cwd: turnStateCwd,
    filePath,
    source: sourceForToolName(event.toolName, event.details),
    changedRange: singleRange(modifiedRanges),
    dbg,
  });

  const turnStateMs = Date.now() - toolResultStart;
  logLatency({
    type: "phase",
    toolName: event.toolName,
    filePath,
    phase: "turn_state_tracking",
    durationMs: turnStateMs,
  });
  dbg(`tool_result fired for: ${filePath} (turn_state: ${turnStateMs}ms)`);

  let result: PipelineResult;
  const pipelinePromise = runPipeline(
    {
      filePath,
      cwd: dispatchCwd,
      projectRoot: turnStateCwd,
      toolName: event.toolName,
      autofixMode,
      modifiedRanges,
      telemetry: {
        model: runtime.telemetryModel,
        sessionId: runtime.telemetrySessionId,
        turnIndex: runtime.turnIndex,
        writeIndex,
        modelId: runtime.telemetryModelId,
        provider: runtime.telemetryProviderId,
      },
      getFlag,
      getFlagSource,
      dbg,
      seqState: {
        projectSeq: () => runtime.projectSeq,
        getFilesChangedSince: (seq: number) => runtime.getFilesChangedSince(seq),
      },
      turnEndCascadeSettleStart: () => runtime.getTurnEndCascadeSettleStart(),
      wordIndex: runtime.wordIndex,
      onWordIndexUpdated: (index) => {
        scheduleWordIndexPersist(dispatchCwd, index, dbg);
      },
    },
    {
      biomeClient,
      ruffClient,
      metricsClient,
      getFormatService,
      fixedThisTurn: runtime.fixedThisTurn,
    },
  );
  const pipelineTelemetry: InFlightPipeline = {
    promise: pipelinePromise,
    participantIds: [...new Set(participantIds)].slice(0, 100),
    participantTotal,
  };
  let filePipelines = inFlightPipelines.get(filePath);
  if (!filePipelines) {
    filePipelines = new Map<string, InFlightPipeline>();
    inFlightPipelines.set(filePath, filePipelines);
  }
  filePipelines.set(initialStateHash, pipelineTelemetry);
  try {
    result = await pipelinePromise;
  } catch (pipelineErr) {
    if (getFlag("lens-guard")) {
      runtime.markGitGuardCacheUnknown("pipeline_crash");
    }
    dbg(`runPipeline crashed: ${pipelineErr}`);
    logReadGuardEvent({
      event: "edit_post_edit_pipeline_failed",
      correlationId: readGuardCorrelationId,
      filePath,
      metadata: {
        tool: event.toolName,
        commitStatus: "committed",
        reasonCode: "pipeline_failed",
      },
    });
    logReadGuardEvent({
      event: "edit_batch_summary",
      correlationId: readGuardCorrelationId,
      filePath,
      metadata: {
        tool: event.toolName,
        editBatchSummary: createReadGuardEditBatchSummary({
          requestedIndexes: requestedEditIndexes,
          requestedTotal: requestedEditTotal,
          resolvedIndexes: requestedEditIndexes,
          resolvedTotal: requestedEditTotal,
          appliedIndexes: requestedEditIndexes,
          appliedTotal: requestedEditTotal,
          participantIds: pipelineTelemetry.participantIds,
          participantTotal: pipelineTelemetry.participantTotal,
          commitStatus: "committed",
          postEditStatus: "failed",
          terminalStatus: "failed",
          durationMs: Date.now() - toolResultStart,
        }),
      },
    });

    dbg(`runPipeline crash stack: ${pipelineErr instanceof Error ? pipelineErr.stack : undefined}`);
    if (!getFlag("no-lsp")) {
      resetLSPService({ fast: true, reason: "pipeline_crash" });
    }

    logLatency({
      type: "tool_result",
      toolName: event.toolName,
      filePath,
      durationMs: Date.now() - toolResultStart,
      result: "pipeline_crash",
    });

    const notice = runtime.formatPipelineCrashNotice(filePath, pipelineErr);
    return {
      content: notice ? [...event.content, { type: "text", text: notice }] : event.content,
      isError: true,
    };
  } finally {
    filePipelines.delete(initialStateHash);
    if (filePipelines.size === 0) {
      inFlightPipelines.delete(filePath);
    }
  }

  if (!isPartialApplyResult) {
    const postEditStatus = result.isError ? "failed" : "succeeded";
    if (result.isError) {
      logReadGuardEvent({
        event: "edit_post_edit_pipeline_failed",
        correlationId: readGuardCorrelationId,
        filePath,
        metadata: {
          tool: event.toolName,
          commitStatus: "committed",
          reasonCode: "pipeline_failed",
        },
      });
    }
    logReadGuardEvent({
      event: "edit_batch_summary",
      correlationId: readGuardCorrelationId,
      filePath,
      metadata: {
        tool: event.toolName,
        editBatchSummary: createReadGuardEditBatchSummary({
          requestedIndexes: requestedEditIndexes,
          requestedTotal: requestedEditTotal,
          resolvedIndexes: requestedEditIndexes,
          resolvedTotal: requestedEditTotal,
          appliedIndexes: requestedEditIndexes,
          appliedTotal: requestedEditTotal,
          participantIds: pipelineTelemetry.participantIds,
          participantTotal: pipelineTelemetry.participantTotal,
          commitStatus: "committed",
          postEditStatus,
          terminalStatus: postEditStatus === "failed" ? "failed" : "success",
          durationMs: Date.now() - toolResultStart,
        }),
      },
    });
  }

  lastAnalyzedStateByFile.set(filePath, {
    turnIndex: runtime.turnIndex,
    stateHash: getFileStateHash(filePath),
  });

  if (!getFlag("no-read-guard")) {
    const changedForReadGuard = new Set([
      path.resolve(filePath),
      ...(result.changedFiles ?? []).map((changedFile) => path.resolve(changedFile)),
    ]);
    for (const changedFile of changedForReadGuard) {
      if (nodeFs.existsSync(changedFile)) {
        deps.readGuard?.recordWritten(changedFile);
      }
    }
  }

  let autofixNewlyQueued = false;
  if (!result.isError && autofixMode === "deferred" && nodeFs.existsSync(filePath)) {
    autofixNewlyQueued =
      // SAFETY: The runtime dependency is the concrete RuntimeCoordinator; the optional member check immediately after this access preserves compatibility.
      (runtime as Partial<RuntimeCoordinator>).deferMutation?.call(
        runtime,
        filePath,
        dispatchCwd,
        event.toolName,
        turnStateCwd,
        "autofix",
        deps.sessionId,
        resolutionBasis,
      ) ?? false;
    dbg(`tool_result: queued deferred autofix for ${filePath}`);
  }
  let formatQueued = false;

  if (
    !result.isError &&
    !getFlag("no-autoformat", filePath) &&
    (autofixMode === "deferred" || !getFlag("immediate-format")) &&
    nodeFs.existsSync(filePath)
  ) {
    const isNewlyQueued = runtime.deferFormat(
      filePath,
      dispatchCwd,
      event.toolName,
      turnStateCwd,
      deps.sessionId,
      resolutionBasis,
    );
    formatQueued = true;
    dbg(`tool_result: queued deferred format for ${filePath}`);
    logLatency({
      type: "phase",
      toolName: event.toolName,
      filePath,
      phase: "deferred_format_queued",
      durationMs: 0,
      metadata: { cwd: dispatchCwd },
    });
    if (isNewlyQueued || autofixNewlyQueued) {
      publishFormatQueued({
        filePath,
        cwd: dispatchCwd,
        tool: event.toolName,
        dbg,
        kinds: autofixMode === "deferred" ? ["autofix", "format"] : ["format"],
      });
    }
  }
  if (autofixNewlyQueued && !formatQueued) {
    publishFormatQueued({
      filePath,
      cwd: dispatchCwd,
      tool: event.toolName,
      kinds: ["autofix"],
      dbg,
    });
  }

  for (const changedFile of result.changedFiles ?? []) {
    const resolvedChanged = path.resolve(changedFile);
    if (!nodeFs.existsSync(resolvedChanged)) continue;
    recordProjectChange({
      runtime,
      cwd: turnStateCwd,
      filePath: resolvedChanged,
      source: "autofix",
      dbg,
    });
    if (resolvedChanged === path.resolve(filePath)) continue;
    try {
      const content = nodeFs.readFileSync(resolvedChanged, "utf-8");
      const lineCount = content.split("\n").length;
      const hasImports = /^import\s/m.test(content);
      cacheManager.addModifiedRange(
        resolvedChanged,
        { start: 1, end: lineCount },
        hasImports,
        turnStateCwd,
      );
      dbg(`tool_result: tracking choco-pi-lsp side-effect change for ${resolvedChanged}`);
    } catch (err) {
      dbg(`tool_result: side-effect tracking failed for ${resolvedChanged}: ${err}`);
    }
  }

  if (result.cascadePromise) {
    runtime.appendCascadePromise(result.cascadePromise);
  }

  if (result.actionableWarnings?.length) {
    runtime.recordActionableWarnings(result.actionableWarnings);
  }
  if (result.codeQualityWarnings?.length) {
    runtime.recordCodeQualityWarnings(result.codeQualityWarnings);
  }

  if (getFlag("lens-turn-summary")) {
    if (result.diagnostics?.length) {
      for (const d of result.diagnostics) {
        runtime.turnSummary.recordDiagnostic(d.filePath || filePath, {
          tool: d.tool,
          ruleId: d.rule ?? d.code,
          severity: d.severity,
          line: d.line,
          description: d.message,
        });
      }
    }
    if (result.fixedCount && result.fixedCount > 0) {
      for (const label of result.autofixTools ?? []) {
        const [tool, countStr] = label.split(":");
        const count = Number.parseInt(countStr ?? "", 10);
        runtime.turnSummary.recordAutofix(filePath, {
          tool: tool || label,
          description: Number.isFinite(count) && count > 0 ? `${count} issue(s) fixed` : undefined,
        });
      }
    }
    if (result.formattersUsed?.length) {
      for (const tool of result.formattersUsed) {
        runtime.turnSummary.recordFormat(filePath, { tool });
      }
    }
  }

  if (result.inlineBlockerSummary) {
    runtime.recordInlineBlockers(
      filePath,
      result.inlineBlockerSummary,
      writeIndex,
      result.inlineBlockerSources,
      result.inlineBlockerLines,
    );
  } else {
    runtime.clearInlineBlockers(filePath);
  }

  runtime.updateGitGuardStatus(result.hasBlockers, result.output);
  if (getFlag("lens-guard")) {
    syncGitGuardRecord(runtime, cacheManager, turnStateCwd, filePath);
    if (result.isError && !result.hasBlockers) {
      runtime.markGitGuardCacheUnknown("pipeline_error");
    }
  }

  if (result.isError) {
    return {
      content: [...event.content, { type: "text", text: result.output }],
      isError: true,
    };
  }

  let output = result.output;
  if (behaviorWarnings.length > 0 && !result.hasBlockers) {
    output += `\n\n${formatBehaviorWarnings(behaviorWarnings)}`;
  }

  const totalMs = Date.now() - toolResultStart;
  logLatency({
    type: "tool_result",
    toolName: event.toolName,
    filePath,
    durationMs: totalMs,
    result: output ? "completed" : "no_output",
  });

  runtime.reportedThisTurn.add(filePath);

  const postMutation = result.postMutation;
  const attachAuthoritativeContent =
    postMutation !== undefined &&
    Buffer.byteLength(postMutation.content, "utf-8") <= AUTHORITATIVE_CONTENT_MAX_BYTES;
  if (postMutation) {
    const bytes = Buffer.byteLength(postMutation.content, "utf-8");
    logLatency({
      type: "phase",
      phase: "authoritative_content_attachment_decision",
      filePath: postMutation.filePath,
      durationMs: 0,
      metadata: {
        path: postMutation.filePath,
        bytes,
        decision: attachAuthoritativeContent ? "attached" : "size-capped",
      },
    });
    noteAuthoritativeContentAttachment(postMutation.filePath, attachAuthoritativeContent);
  }
  const returnedContent = attachAuthoritativeContent
    ? [
        ...event.content,
        {
          type: "text",
          text: `choco-pi-lsp applied autofix to ${postMutation!.filePath}. The following full content is authoritative for subsequent edits:\n\n${postMutation!.content}`,
        },
      ]
    : event.content;
  if (postMutation && !attachAuthoritativeContent) {
    output = `${output ? `${output}\n\n` : ""}⚠️ **File was modified by auto-format/fix. You MUST re-read ${postMutation.filePath} before making any further edits — the authoritative content is too large to attach.**`;
  }

  if (!output && !result.postMutation) return;

  return {
    content: output ? [...returnedContent, { type: "text", text: output }] : returnedContent,
  };
}
