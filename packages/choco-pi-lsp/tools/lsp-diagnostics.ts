import type { ProtocolDictionary } from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "./runtime-values.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../clients/file-utils.ts";
import {
  getLSPService,
  groupFilesByPrimaryServer,
  runPerServerGroups,
} from "../clients/lsp/index.ts";
import {
  buildScopeKey,
  createWorkspaceDiagnosticsCacheContext,
  type WorkspaceDiagnosticsCacheContext,
} from "../clients/lsp/workspace-diagnostics-cache.ts";
import { getServersForFileWithConfig, primaryServerId } from "../clients/lsp/config.ts";
import { combineAbortSignals, withDeadline } from "../clients/deadline-utils.ts";
import {
  applyAuxiliarySuppressions,
  retagAuxiliaryDiagnostics,
} from "../clients/dispatch/auxiliary-lsp.ts";
import { detectFileRole } from "../clients/file-role.ts";
import type { LSPDiagnostic } from "../clients/lsp/client.ts";
import {
  hashDiagnosticContent,
  touchCompletedConfirmationPolicy,
  touchCoverageGap,
  type DiagnosticBinding,
  type TouchFileResult,
} from "../clients/lsp/diagnostic-binding.ts";
import { classifyCascadeWaitTier } from "../clients/lsp/wait-policy/index.ts";
import { attemptTsserverSyncDiagnostics } from "../clients/lsp/tsserver-sync.ts";
import { convertLspDiagnostics } from "../clients/dispatch/utils/lsp-diagnostics.ts";
import { demoteInferredProjectDiagnostics } from "../clients/lsp/inferred-project.ts";
import { isBlocking, reconcileScanDiagnostics } from "../clients/widget-state.ts";
import { baseName, compactRenderResult } from "./render-compact.ts";
import { makeProgressReporter, scanningSummaryLine } from "./scan-progress.ts";
import { isWarmAttached, tryWarmAttachedDiagnostics } from "../clients/warm-attach.ts";

interface LanguageExtensions {
  [language: string]: string[];
}

const LANG_EXTENSIONS: LanguageExtensions = {
  ".ts": [".ts", ".tsx", ".mts", ".cts"],
  ".tsx": [".ts", ".tsx", ".mts", ".cts"],
  ".js": [".js", ".jsx", ".mjs", ".cjs"],
  ".py": [".py", ".pyi"],
  ".rs": [".rs"],
  ".go": [".go"],
  ".rb": [".rb", ".rake", ".gemspec"],
  ".java": [".java"],
  ".kt": [".kt", ".kts"],
  ".swift": [".swift"],
  ".cs": [".cs"],
  ".cpp": [".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
  ".c": [".c", ".h"],
  ".zig": [".zig", ".zon"],
  ".hs": [".hs", ".lhs"],
  ".ex": [".ex", ".exs"],
  ".gleam": [".gleam"],
  ".tf": [".tf", ".tfvars"],
  ".nix": [".nix"],
  ".sh": [".sh", ".bash", ".zsh"],
  ".php": [".php"],
  ".lua": [".lua"],
  ".dart": [".dart"],
  ".vue": [".vue"],
  ".svelte": [".svelte"],
  ".css": [".css", ".scss", ".less"],
  ".html": [".html", ".htm"],
  ".json": [".json", ".jsonc"],
  ".yaml": [".yaml", ".yml"],
  ".toml": [".toml"],
  ".prisma": [".prisma"],
};

const MAX_FILES = 100;
const MAX_BATCH_FILES = 100;
const MAX_DIAGNOSTICS = 200;
const DEFAULT_BATCH_CONCURRENCY = 8;
const MAX_BATCH_CONCURRENCY = 16;
const DEFAULT_BATCH_FILE_DEADLINE_MS = 15_000;

interface SeverityNames {
  [severity: number]: string;
}

const SEVERITY_NAMES: SeverityNames = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

type LspHealthLike = {
  health?: string;
  serverCountAttempted?: number;
  serverCountReady?: number;
  candidateServerIds?: string[];
  mergedCount?: number;
};

type BatchOptions = {
  concurrency: number;
  waitMs?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  nextWriteIndex?: () => number;
  serverScope?: "primary" | "all";
  cwd?: string;
  onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void;
};

type FileDiag = {
  file: string;
  line?: number;
  character?: number;
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
};

type FileDiagnosticResult = {
  file: string;
  diagnostics: FileDiag[];
  outcome?: BatchFileOutcome;
  unavailable?: string;
  error?: string;
  inconclusiveReason?: string;
  confirmation?: "clean" | "unconfirmed";
  timedOut?: boolean;
  primaryServerId?: string;
};

type BatchFileOutcome =
  | "clean"
  | "findings"
  | "unsupported"
  | "unavailable"
  | "failed"
  | "inconclusive";

function batchFileDeadlineMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_BATCH_FILE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BATCH_FILE_DEADLINE_MS;
}

function lspUnavailableMessage(
  filePath: string,
  health: LspHealthLike | undefined,
): string | undefined {
  if (!health || !String(health.health ?? "").startsWith("no_clients")) {
    return undefined;
  }
  const candidates = health.candidateServerIds?.length
    ? ` candidates=${health.candidateServerIds.join(",")}`
    : "";
  const reason =
    (health.serverCountAttempted ?? 0) === 0
      ? "no LSP server configured"
      : "no LSP client is currently ready";
  const stale =
    (health.mergedCount ?? 0) > 0
      ? " Showing stale last-known diagnostics below."
      : " No diagnostics were collected.";
  return `LSP unavailable for ${filePath}: ${reason}; ready=${health.serverCountReady ?? 0}/${health.serverCountAttempted ?? 0}.${candidates}.${stale}`;
}

function boundedPositiveInt(
  value: RuntimeValue,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = isRuntimeNumber(value) ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function mapWithConcurrency<R>(
  items: string[],
  concurrency: number,
  mapper: (item: string, index: number) => Promise<R>,
  lspService: NonNullable<ReturnType<typeof getLSPService>> | undefined,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = [];
  let completed = 0;
  const pendingIndices = new Map<string, number[]>();
  items.forEach((item, index) => {
    const queue = pendingIndices.get(item);
    if (queue) queue.push(index);
    else pendingIndices.set(item, [index]);
  });
  const groups = groupFilesByPrimaryServer(items);
  await runPerServerGroups(
    groups,
    concurrency,
    async (group) => {
      if (signal?.aborted) return;
      const first = group.files[0];
      if (
        first &&
        lspService &&
        !isWarmAttached() &&
        isRuntimeFunction(lspService.ensureWarmForSweep)
      ) {
        await lspService.ensureWarmForSweep(first, { signal });
        if (signal?.aborted) return;
      }
      for (const item of group.files) {
        if (signal?.aborted) return;
        const index = pendingIndices.get(item)!.shift()!;
        results[index] = await mapper(item, index);
        completed += 1;
        onProgress?.(completed, items.length);
      }
    },
    signal,
  );
  return results;
}

function projectIgnorePredicate(root: string): (fullPath: string, isDir: boolean) => boolean {
  try {
    const matcher = getProjectIgnoreMatcher(root);
    return (fullPath, isDir) => matcher.isIgnored(fullPath, isDir);
  } catch {
    return () => false;
  }
}

async function collectFiles(
  dir: string,
  extensions: string[],
  maxFiles: number,
  isIgnored: (fullPath: string, isDir: boolean) => boolean = () => false,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isExcludedDirName(entry.name) && !isIgnored(full, true)) await walk(full);
      } else if (entry.isFile() && extensions.includes(path.extname(full))) {
        if (isIgnored(full, false)) continue;
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files;
}

export function createLspDiagnosticsTool(
  nextWriteIndex?: () => number,
  onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
  getFlag?: (name: string) => boolean | string | undefined,
) {
  return {
    name: "lsp_diagnostics" as const,
    label: "LSP Diagnostics",
    description: "Get language-server diagnostics for files or directories.",
    promptSnippet: "Check files or directories for language-server diagnostics.",
    renderResult: compactRenderResult<{
      mode?: string;
      phase?: string;
      completed?: number;
      total?: number;
      filePath?: string;
      diagnostics?: unknown[];
      totalDiagnostics?: number;
      filesChecked?: number;
      filesScanned?: number;
      cleanFiles?: number;
      unconfirmedFiles?: number;
      timedOutFiles?: number;
      outcomeCounts?: Record<string, number>;
      incompleteFiles?: number;
      unconfirmed?: boolean;
      timedOut?: boolean;
    }>(({ details, args, isError, text }) => {
      const scanning = scanningSummaryLine(details, text);
      if (scanning) return scanning;
      if (isError) {
        return `lsp_diagnostics — ${text.split("\n")[0] ?? "error"}`;
      }
      const count = details?.totalDiagnostics ?? details?.diagnostics?.length ?? 0;
      const target = baseName(details?.filePath ?? args.path) || "workspace";
      const files = details?.filesChecked ?? details?.filesScanned;
      const scope =
        isRuntimeNumber(files) && files > 1 ? ` across ${files} files` : target ? ` ${target}` : "";
      const noun = count === 1 ? "diagnostic" : "diagnostics";
      const unconfirmedFiles = details?.unconfirmedFiles ?? 0;
      if (unconfirmedFiles > 0) {
        const cleanFiles = details?.cleanFiles ?? 0;
        const timedOutFiles = details?.timedOutFiles ?? 0;
        const suffix = timedOutFiles > 0 ? ` (${timedOutFiles} timed out)` : "";
        return `lsp_diagnostics${scope} — ${count} ${noun} · ${cleanFiles} clean · ${unconfirmedFiles} unconfirmed${suffix}`;
      }
      const outcomeCounts = details?.outcomeCounts;
      const notConfirmed = outcomeCounts
        ? (outcomeCounts.inconclusive ?? 0) +
          (outcomeCounts.unavailable ?? 0) +
          (outcomeCounts.unsupported ?? 0) +
          (outcomeCounts.failed ?? 0)
        : 0;
      if (notConfirmed > 0) {
        return `lsp_diagnostics${scope} — ${count} ${noun} · ${notConfirmed} checks not confirmed`;
      }
      if ((details?.incompleteFiles ?? 0) > 0) {
        return `lsp_diagnostics${scope} — incomplete (${details?.incompleteFiles} files not confirmed)`;
      }
      if (count === 0 && details?.unconfirmed) {
        return details?.timedOut
          ? `lsp_diagnostics${scope} — timed out (result may be incomplete)`
          : `lsp_diagnostics${scope} — unconfirmed (server cannot confirm clean)`;
      }
      return `lsp_diagnostics${scope} — ${count} ${noun}`;
    }),
    parameters: hostParams(
      obj({
        path: opt(
          str({
            description: "File or directory to check.",
          }),
        ),
        paths: opt(
          arr(str(), {
            minItems: 1,
            maxItems: MAX_BATCH_FILES,
            description: "Explicit file batch; overrides path.",
          }),
        ),
        severity: opt(
          oneOf(["error", "warning", "information", "hint", "all"], {
            description: "Filter by severity level (default: all)",
          }),
        ),
        concurrency: opt(
          num({
            description: "Concurrent language-server groups; defaults to 8, maximum 16.",
          }),
        ),
        wait_ms: opt(
          num({
            description: "Per-file wait budget in milliseconds.",
          }),
        ),
        server_scope: opt(
          oneOf(["primary", "all"], {
            description: "Use the primary server only or all auxiliary scanners.",
          }),
        ),
      }),
    ),
    async execute(
      _toolCallId: string,
      params: ProtocolDictionary,
      _signal: AbortSignal | undefined,
      onUpdate: RuntimeValue,
      ctx: { cwd?: string; signal?: AbortSignal },
    ) {
      if (getFlag?.("no-lsp")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "LSP usage is currently disabled (/lsp off, --no-lsp, or lsp.enabled=false), so lsp_diagnostics did not run. Ask the user to run /lsp on to re-enable it.",
            },
          ],
          details: { lspDisabled: true },
        };
      }
      const signal = combineAbortSignals(_signal, ctx.signal);
      const onProgress = makeProgressReporter(onUpdate, "Scanning LSP diagnostics");
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const typedParams = params as {
        path?: string;
        paths?: string[];
        severity?: string;
        concurrency?: number;
        wait_ms?: number;
        server_scope?: string;
      };
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const severity = (typedParams.severity ?? "all") as string;
      const cwd = ctx.cwd ?? process.cwd();
      const concurrency = boundedPositiveInt(
        typedParams.concurrency,
        DEFAULT_BATCH_CONCURRENCY,
        1,
        MAX_BATCH_CONCURRENCY,
      );
      const waitMs =
        isRuntimeNumber(typedParams.wait_ms) && typedParams.wait_ms >= 0
          ? Math.floor(typedParams.wait_ms)
          : undefined;
      const serverScope: "primary" | "all" =
        typedParams.server_scope === "primary" ? "primary" : "all";

      const lspService = getLSPService();
      if (!lspService) {
        return {
          content: [{ type: "text" as const, text: "LSP service not available." }],
          isError: true,
          details: {},
        };
      }

      if (Array.isArray(typedParams.paths) && typedParams.paths.length > 0) {
        if (typedParams.paths.length > MAX_BATCH_FILES) {
          return {
            content: [
              {
                type: "text" as const,
                text: `paths accepts at most ${MAX_BATCH_FILES} files; received ${typedParams.paths.length}.`,
              },
            ],
            isError: true,
            details: { mode: "batch", filesChecked: 0 },
          };
        }
        const rawPaths = typedParams.paths.filter(
          (entry): entry is string => isRuntimeString(entry) && entry.trim().length > 0,
        );
        if (rawPaths.length !== typedParams.paths.length) {
          return {
            content: [{ type: "text" as const, text: "paths must contain non-empty file paths." }],
            isError: true,
            details: { mode: "batch", filesChecked: 0 },
          };
        }
        const absPaths = rawPaths.map((entry) =>
          path.normalize(path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)),
        );
        return runBatchFileDiagnostics(absPaths, severity, lspService, {
          concurrency,
          waitMs,
          signal,
          onProgress,
          nextWriteIndex,
          serverScope,
          cwd,
          onConfirmedNoBlockers,
        });
      }

      const rawPath = typedParams.path;
      if (!rawPath || rawPath.trim().length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "path or paths is required.",
            },
          ],
          isError: true,
          details: {},
        };
      }
      const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Path not found: ${absPath}` }],
          isError: true,
          details: {},
        };
      }

      if (stat.isDirectory()) {
        return runDirectoryDiagnostics(absPath, severity, lspService, {
          concurrency,
          waitMs,
          signal,
          onProgress,
          nextWriteIndex,
          serverScope,
          cwd,
          onConfirmedNoBlockers,
        });
      }
      return runFileDiagnostics(
        absPath,
        severity,
        lspService,
        waitMs,
        nextWriteIndex,
        serverScope,
        cwd,
        onConfirmedNoBlockers,
      );
    },
  };
}

type DiagnosticsCollectionResult = {
  diagnostics: LSPDiagnostic[];
  timedOut: boolean;
  confirmedByTouch: boolean;
  unconfirmedServerIds: readonly string[];
  content?: string;
  binding?: DiagnosticBinding;
};

async function collectDiagnosticsForFile(
  absPath: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  waitMs?: number,
  serverScope: "primary" | "all" = "all",
): Promise<DiagnosticsCollectionResult> {
  let timedOut = false;
  let content: string | undefined;
  let touched: TouchFileResult | undefined;
  let usedTouch = false;
  try {
    content = fs.readFileSync(absPath, "utf-8");
    if (isWarmAttached()) {
      const attachedBudgetMs = waitMs ?? 15_000;
      const attached = await tryWarmAttachedDiagnostics(
        absPath,
        content,
        attachedBudgetMs,
        "sweep",
      );
      if (attached?.available) {
        const scopedDiagnostics =
          serverScope === "primary"
            ? attached.response.diagnostics.filter(
                (item) => item.source === primaryServerId(absPath),
              )
            : attached.response.diagnostics;
        const filtered = applyAuxiliarySuppressions(scopedDiagnostics, content, {
          fileRole: detectFileRole(absPath, content),
        });
        return {
          diagnostics: filtered,
          timedOut: false,
          confirmedByTouch:
            attached.response.confirmation !== undefined &&
            primaryServerId(absPath) !== "typescript",
          unconfirmedServerIds: attached.response.unconfirmedServerIds ?? [],
          content,
        };
      }
    }
    // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
    const serviceWithTouch = lspService as NonNullable<ReturnType<typeof getLSPService>> & {
      touchFile?: (
        filePath: string,
        content: string,
        options: {
          diagnostics: "document";
          collectDiagnostics: true;
          maxClientWaitMs?: number;
          source: string;
          clientScope: "all" | "primary";
        },
      ) => Promise<TouchFileResult | undefined>;
    };
    if (isRuntimeFunction(serviceWithTouch.touchFile)) {
      usedTouch = true;
      touched = await serviceWithTouch.touchFile(absPath, content, {
        diagnostics: "document",
        collectDiagnostics: true,
        maxClientWaitMs: waitMs,
        source: "lsp_diagnostics",
        clientScope: serverScope,
      });
      timedOut = touched?.inconclusive === true;
    } else {
      await lspService.openFile(absPath, content, {
        preserveDiagnostics: false,
      });
    }
  } catch {}

  const diagnostics =
    usedTouch && touched !== undefined
      ? touched.diags
      : await lspService.getDiagnostics(absPath, waitMs !== undefined ? "document" : "full");
  const filtered =
    content !== undefined
      ? applyAuxiliarySuppressions(diagnostics, content, {
          fileRole: detectFileRole(absPath, content),
        })
      : diagnostics;
  const binding = usedTouch ? touched?.binding : undefined;
  const confirmedByTouch = usedTouch && touchCompletedConfirmationPolicy(touched);
  return {
    diagnostics: filtered,
    timedOut,
    confirmedByTouch,
    unconfirmedServerIds: usedTouch ? touchCoverageGap(touched) : [],
    content,
    binding,
  };
}

function diagnosticsToFileDiags(file: string, diagnostics: LSPDiagnostic[]): FileDiag[] {
  return diagnostics.map((d) => ({
    file,
    line: d.range?.start?.line,
    character: d.range?.start?.character,
    severity: d.severity,
    message: d.message,
    source: d.source,
    code: d.code,
  }));
}

async function classifyEmptyResult(
  file: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<"clean" | "unconfirmed"> {
  try {
    const snapshots = await lspService.getCapabilitySnapshots(file);
    const tier = classifyCascadeWaitTier(lspService, file, snapshots);
    return tier === "tier3-silent" ? "unconfirmed" : "clean";
  } catch {
    return "clean";
  }
}

async function resolveEmptyResult(
  file: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<{ confirmed: boolean; diagnostics: LSPDiagnostic[] }> {
  try {
    const snapshots = await lspService.getCapabilitySnapshots(file);
    const tier = classifyCascadeWaitTier(lspService, file, snapshots);
    if (tier !== "tier3-silent") {
      return { confirmed: true, diagnostics: [] };
    }
    const syncDiagnostics = await attemptTsserverSyncDiagnostics(file, lspService);
    if (syncDiagnostics === undefined) {
      return { confirmed: false, diagnostics: [] };
    }
    return { confirmed: true, diagnostics: syncDiagnostics };
  } catch {
    return { confirmed: true, diagnostics: [] };
  }
}

function canTrustTouchConfirmation(
  file: string,
  serverScope: "primary" | "all",
  confirmedByTouch: boolean,
): boolean {
  return confirmedByTouch && (serverScope === "primary" || primaryServerId(file) !== "typescript");
}

type LspReconcileVerdict = {
  confirmed: boolean;
  blocking: boolean;
};

function coveredSourcesForCheck(
  file: string,
  serverScope: "primary" | "all",
  unconfirmedServerIds: readonly string[],
): string[] {
  const unconfirmed = new Set(unconfirmedServerIds);
  const covered = new Set<string>();
  let servers: Array<{ id: string; role?: string }> = [];
  try {
    // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
    servers = (getServersForFileWithConfig(file) ?? []) as Array<{
      id: string;
      role?: string;
    }>;
  } catch {
    return [];
  }
  for (const server of servers) {
    const auxiliary = server.role === "auxiliary";
    if (auxiliary && serverScope === "primary") continue;
    if (unconfirmed.has(server.id)) continue;
    covered.add(auxiliary ? server.id : "lsp");
  }
  return [...covered];
}

function demoteInferredForFile(
  file: string,
  diagnostics: LSPDiagnostic[],
  cwd: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<LSPDiagnostic[]> {
  return demoteInferredProjectDiagnostics(diagnostics, {
    filePath: file,
    cwd,
    service: lspService,
  });
}

export type ConfirmedNoBlockersInfo = {
  filePath: string;
  writeIndex?: number;
  coveredSources: string[];
  cwd: string;
};

function reconcileWidgetFromLspResult(
  file: string,
  rawDiags: LSPDiagnostic[],
  confirmation: "clean" | "unconfirmed" | undefined,
  writeIndex: number | undefined,
  cwd: string,
  content: string | undefined,
  boundMismatch = false,
  observedAt?: number,
): LspReconcileVerdict {
  const confirmed = (rawDiags.length > 0 || confirmation !== "unconfirmed") && !boundMismatch;
  if (!confirmed) return { confirmed: false, blocking: true };
  try {
    const diagnostics = convertLspDiagnostics(rawDiags, file, {
      scanOrigin: "lsp_diagnostics",
    });
    const retagged = retagAuxiliaryDiagnostics(diagnostics, rawDiags, content ?? "", {
      cwd,
      fileRole: detectFileRole(file, content),
    });
    reconcileScanDiagnostics(file, retagged, true, writeIndex, observedAt);
    return { confirmed: true, blocking: retagged.some(isBlocking) };
  } catch {
    return { confirmed: false, blocking: true };
  }
}

async function collectFileDiagnosticResult(
  file: string,
  severity: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  waitMs?: number,
  nextWriteIndex?: () => number,
  serverScope: "primary" | "all" = "all",
  cacheCtx?: WorkspaceDiagnosticsCacheContext,
  scopeKey?: string,
  cwd: string = process.cwd(),
  onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
): Promise<FileDiagnosticResult> {
  const writeIndex = nextWriteIndex?.();
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) {
      return { file, diagnostics: [], error: `${file}: not a file` };
    }
  } catch {
    return { file, diagnostics: [], error: `${file}: path not found` };
  }

  if (cacheCtx && scopeKey !== undefined) {
    const cached = cacheCtx.lookup(file, scopeKey);
    if (cached && cached.binding.boundToCurrentDisk !== false) {
      const confirmation: "clean" | undefined =
        cached.diagnostics.length === 0 ? "clean" : undefined;
      const cachedDiags = await demoteInferredForFile(file, cached.diagnostics, cwd, lspService);
      const filteredDiags = applySeverityFilter(cachedDiags, severity);
      reconcileWidgetFromLspResult(
        file,
        cachedDiags,
        confirmation,
        writeIndex,
        cwd,
        undefined,
        false,
        cached.scannedAt,
      );
      return {
        file,
        diagnostics: diagnosticsToFileDiags(file, filteredDiags),
        confirmation,
        primaryServerId: primaryServerId(file),
      };
    }
  }

  const {
    diagnostics: rawDiags,
    timedOut,
    confirmedByTouch,
    unconfirmedServerIds,
    content: collectedContent,
    binding,
  } = await collectDiagnosticsForFile(file, lspService, waitMs, serverScope);
  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const health = lspService.getDiagnosticsHealth?.(file) as LspHealthLike | undefined;
  let effectiveRawDiags = rawDiags;
  let confirmation: "clean" | "unconfirmed" | undefined;
  if (timedOut) {
    if (applySeverityFilter(rawDiags, severity).length === 0) {
      confirmation = "unconfirmed";
    }
  } else if (canTrustTouchConfirmation(file, serverScope, confirmedByTouch)) {
    if (applySeverityFilter(rawDiags, severity).length === 0) {
      confirmation = "clean";
    }
  } else if (rawDiags.length === 0) {
    const resolved = await resolveEmptyResult(file, lspService);
    effectiveRawDiags = resolved.diagnostics;
    confirmation = resolved.confirmed
      ? resolved.diagnostics.length === 0
        ? "clean"
        : undefined
      : "unconfirmed";
  } else if (applySeverityFilter(rawDiags, severity).length === 0) {
    confirmation = await classifyEmptyResult(file, lspService);
  }
  const boundMismatch = binding?.boundToCurrentDisk === false;
  if (boundMismatch) confirmation = "unconfirmed";
  if (unconfirmedServerIds.length > 0 && confirmation === "clean") {
    confirmation = "unconfirmed";
  }
  effectiveRawDiags = await demoteInferredForFile(file, effectiveRawDiags, cwd, lspService);
  const filteredDiags = applySeverityFilter(effectiveRawDiags, severity);
  const verdict = reconcileWidgetFromLspResult(
    file,
    effectiveRawDiags,
    confirmation,
    writeIndex,
    cwd,
    collectedContent,
    boundMismatch,
  );
  if (verdict.confirmed && !verdict.blocking) {
    onConfirmedNoBlockers?.({
      filePath: file,
      writeIndex,
      coveredSources: coveredSourcesForCheck(file, serverScope, unconfirmedServerIds),
      cwd,
    });
  }
  if (cacheCtx && scopeKey !== undefined && confirmation !== "unconfirmed") {
    cacheCtx.record(
      file,
      scopeKey,
      effectiveRawDiags,
      stat.mtimeMs,
      collectedContent !== undefined ? hashDiagnosticContent(collectedContent) : undefined,
    );
  }
  return {
    file,
    diagnostics: diagnosticsToFileDiags(file, filteredDiags),
    unavailable: lspUnavailableMessage(file, health),
    confirmation,
    timedOut: confirmation === "unconfirmed" ? timedOut : undefined,
    primaryServerId: primaryServerId(file),
  };
}

async function runFileDiagnostics(
  absPath: string,
  severity: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  waitMs?: number,
  nextWriteIndex?: () => number,
  serverScope: "primary" | "all" = "all",
  cwd: string = process.cwd(),
  onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
) {
  const writeIndex = nextWriteIndex?.();
  const {
    diagnostics: rawDiags,
    timedOut,
    confirmedByTouch,
    unconfirmedServerIds,
    content: collectedContent,
    binding,
  } = await collectDiagnosticsForFile(absPath, lspService, waitMs, serverScope);
  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const lspHealth = lspService.getDiagnosticsHealth?.(absPath) as LspHealthLike | undefined;
  const unavailable = lspUnavailableMessage(absPath, lspHealth);
  let effectiveRawDiags = rawDiags;
  let confirmation: "clean" | "unconfirmed" | undefined;
  if (timedOut) {
    if (applySeverityFilter(rawDiags, severity).length === 0) {
      confirmation = "unconfirmed";
    }
  } else if (canTrustTouchConfirmation(absPath, serverScope, confirmedByTouch)) {
    if (applySeverityFilter(rawDiags, severity).length === 0) {
      confirmation = "clean";
    }
  } else if (rawDiags.length === 0) {
    const resolved = await resolveEmptyResult(absPath, lspService);
    effectiveRawDiags = resolved.diagnostics;
    confirmation = resolved.confirmed
      ? resolved.diagnostics.length === 0
        ? "clean"
        : undefined
      : "unconfirmed";
  } else if (applySeverityFilter(rawDiags, severity).length === 0) {
    confirmation = await classifyEmptyResult(absPath, lspService);
  }
  const boundMismatch = binding?.boundToCurrentDisk === false;
  if (boundMismatch) confirmation = "unconfirmed";
  const primaryCoverageGapOnly = unconfirmedServerIds.length > 0 && confirmation === "clean";
  if (primaryCoverageGapOnly) confirmation = "unconfirmed";
  effectiveRawDiags = await demoteInferredForFile(absPath, effectiveRawDiags, cwd, lspService);
  const filtered = applySeverityFilter(effectiveRawDiags, severity);
  const total = filtered.length;
  const truncated = total > MAX_DIAGNOSTICS;
  const limited = truncated ? filtered.slice(0, MAX_DIAGNOSTICS) : filtered;
  const unconfirmed = confirmation === "unconfirmed";
  const verdict = reconcileWidgetFromLspResult(
    absPath,
    effectiveRawDiags,
    confirmation,
    writeIndex,
    cwd,
    collectedContent,
    boundMismatch,
  );
  if (verdict.confirmed && !verdict.blocking) {
    onConfirmedNoBlockers?.({
      filePath: absPath,
      writeIndex,
      coveredSources: coveredSourcesForCheck(absPath, serverScope, unconfirmedServerIds),
      cwd,
    });
  }

  const primaryId = primaryServerId(absPath);
  const primaryDiags = limited.filter((d) => d.source === primaryId);
  const auxiliaryDiags = limited.filter((d) => d.source !== primaryId);

  const primaryLine = (() => {
    if (timedOut) {
      return (
        "Primary LSP: check timed out — NOT the same as 0 diagnostics; the " +
        "file may still have errors that just hadn't been reported yet. " +
        "Re-check after the server settles, or increase wait_ms."
      );
    }
    if (unconfirmed && !primaryCoverageGapOnly) {
      return (
        `Primary LSP${primaryId ? ` (${primaryId})` : ""}: unconfirmed — ` +
        "cannot confirm clean (push-only, silent-on-clean, e.g. classic " +
        "typescript-language-server never publishes on a clean re-check). " +
        "NOT the same as 0 diagnostics; re-check after an edit, or use " +
        "wait_ms to wait longer."
      );
    }
    if (primaryDiags.length === 0) {
      return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: confirmed clean.`;
    }
    return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: ${primaryDiags.length} diagnostic${primaryDiags.length === 1 ? "" : "s"}.`;
  })();

  const coverageLine =
    unconfirmedServerIds.length > 0
      ? `Auxiliary coverage INCOMPLETE — ${[...unconfirmedServerIds].join(", ")} did not answer within the wait budget, so ${unconfirmedServerIds.length === 1 ? "its findings are" : "their findings are"} NOT included here. This is not a clean bill of health for ${unconfirmedServerIds.length === 1 ? "that scanner" : "those scanners"}; re-check after the next edit, or use wait_ms to wait longer.`
      : undefined;

  let text: string;
  if (total === 0) {
    text = [
      primaryLine,
      "",
      unavailable ?? "No auxiliary findings.",
      ...(coverageLine ? [coverageLine] : []),
    ].join("\n");
  } else {
    const lines = [primaryLine, ""];
    if (primaryDiags.length > 0) {
      lines.push(...primaryDiags.map(formatDiag), "");
    }
    if (auxiliaryDiags.length > 0) {
      lines.push(`Auxiliary findings (${auxiliaryDiags.length}):`);
      lines.push(...auxiliaryDiags.map(formatDiag));
    }
    if (coverageLine) lines.push("", coverageLine);
    if (unavailable) lines.unshift(unavailable, "");
    if (truncated) {
      lines.unshift(`Found ${total} diagnostics (showing first ${MAX_DIAGNOSTICS}):`);
    }
    text = lines.join("\n");
  }

  return {
    content: [{ type: "text" as const, text }],
    details: {
      filePath: absPath,
      mode: "file",
      severity,
      serverScope,
      primaryServerId: primaryId,
      primaryDiagnosticsCount: primaryDiags.length,
      auxiliaryDiagnosticsCount: auxiliaryDiags.length,
      diagnostics: limited.map((d) => ({
        line: d.range?.start?.line,
        character: d.range?.start?.character,
        severity: d.severity,
        message: d.message,
        source: d.source,
        code: d.code,
      })),
      totalDiagnostics: total,
      truncated,
      unconfirmed,
      timedOut: unconfirmed ? timedOut : undefined,
      ...(unconfirmedServerIds.length > 0 && {
        unconfirmedServerIds: [...unconfirmedServerIds],
      }),
      lspHealth,
      waitMs,
    },
  };
}

function tallyConfirmation(results: FileDiagnosticResult[]) {
  let clean = 0;
  let unconfirmed = 0;
  let timedOut = 0;
  for (const result of results) {
    if (result.diagnostics.length > 0) continue;
    if (result.confirmation === "unconfirmed") {
      unconfirmed += 1;
      if (result.timedOut) timedOut += 1;
    } else {
      clean += 1;
    }
  }
  return { clean, unconfirmed, timedOut };
}

function classifyBatchFileOutcome(result: FileDiagnosticResult): BatchFileOutcome {
  if (result.error) return "failed";
  if (result.timedOut || result.confirmation === "unconfirmed") {
    return "inconclusive";
  }
  if (result.diagnostics.length > 0) return "findings";
  if (result.unavailable) {
    return result.primaryServerId ? "unavailable" : "unsupported";
  }
  if (!result.primaryServerId) return "unsupported";
  return "clean";
}

function inconclusiveBatchResult(file: string, reason: string): FileDiagnosticResult {
  return {
    file,
    diagnostics: [],
    confirmation: "unconfirmed",
    timedOut: true,
    outcome: "inconclusive",
    inconclusiveReason: reason,
  };
}

function unconfirmedReasonClause(unconfirmed: number, timedOut: number): string {
  const silent = unconfirmed - timedOut;
  if (timedOut > 0 && silent > 0) {
    return (
      `${timedOut} timed out (check didn't complete within budget) and ` +
      `${silent} from a server that cannot confirm clean (push-only, ` +
      "silent-on-clean)."
    );
  }
  if (timedOut > 0) {
    return `${timedOut} timed out (check didn't complete within the wait budget).`;
  }
  return (
    "from a server that cannot confirm clean (push-only, silent-on-clean; " +
    "e.g. classic typescript-language-server does not publish on a clean " +
    "re-check)."
  );
}

async function collectBatchDiagnostics(
  files: string[],
  severity: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  options: BatchOptions,
): Promise<{
  results: FileDiagnosticResult[];
  fileErrors: string[];
  lspHealthWarnings: string[];
  total: number;
  truncated: boolean;
  display: FileDiag[];
  primaryDisplay: FileDiag[];
  auxiliaryDisplay: FileDiag[];
  clean: number;
  unconfirmed: number;
  timedOut: number;
  outcomeCounts: Record<BatchFileOutcome, number>;
  incompleteFiles: number;
}> {
  const resolvedCwd = options.cwd ?? process.cwd();
  const cacheCtx = createWorkspaceDiagnosticsCacheContext(resolvedCwd);
  const scopeKey = buildScopeKey(options.serverScope ?? "all");
  const results = await mapWithConcurrency(
    files,
    options.concurrency,
    async (file) => {
      const work = collectFileDiagnosticResult(
        file,
        severity,
        lspService,
        options.waitMs,
        options.nextWriteIndex,
        options.serverScope,
        cacheCtx,
        scopeKey,
        resolvedCwd,
        options.onConfirmedNoBlockers,
      );
      const bounded = withDeadline(work, {
        ms: batchFileDeadlineMs(),
        onTimeout: "undefined",
        onReject: "undefined",
      });
      const result = options.signal
        ? await Promise.race([
            bounded,
            new Promise<FileDiagnosticResult | undefined>((resolve) => {
              if (options.signal?.aborted) {
                resolve(undefined);
                return;
              }
              options.signal?.addEventListener("abort", () => resolve(undefined), {
                once: true,
              });
            }),
          ])
        : await bounded;
      return (
        result ??
        inconclusiveBatchResult(
          file,
          options.signal?.aborted
            ? "Batch aborted before this file completed."
            : `File check exceeded ${batchFileDeadlineMs()}ms.`,
        )
      );
    },
    lspService,
    options.signal,
    options.onProgress,
  );
  cacheCtx.persist();
  const fileErrors = results.flatMap((result) => (result.error ? [result.error] : []));
  const lspHealthWarnings = results.flatMap((result) =>
    result.unavailable ? [result.unavailable] : [],
  );
  const allDiags = results.flatMap((result) => result.diagnostics);
  const total = allDiags.length;
  const truncated = total > MAX_DIAGNOSTICS;
  const display = truncated ? allDiags.slice(0, MAX_DIAGNOSTICS) : allDiags;
  const { clean, unconfirmed, timedOut } = tallyConfirmation(results);
  for (const result of results) {
    result.outcome = classifyBatchFileOutcome(result);
  }
  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const outcomeCounts = Object.fromEntries(
    (["clean", "findings", "unsupported", "unavailable", "failed", "inconclusive"] as const).map(
      (outcome) => [outcome, results.filter((result) => result.outcome === outcome).length],
    ),
  ) as Record<BatchFileOutcome, number>;
  const primaryIdByFile = new Map(results.map((r) => [r.file, r.primaryServerId] as const));
  const primaryDisplay = display.filter((d) => d.source === primaryIdByFile.get(d.file));
  const auxiliaryDisplay = display.filter((d) => d.source !== primaryIdByFile.get(d.file));
  return {
    results,
    fileErrors,
    lspHealthWarnings,
    total,
    truncated,
    display,
    primaryDisplay,
    auxiliaryDisplay,
    clean,
    unconfirmed,
    timedOut,
    outcomeCounts,
    incompleteFiles: Math.max(0, files.length - results.length),
  };
}

async function runBatchFileDiagnostics(
  absPaths: string[],
  severity: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  options: BatchOptions,
) {
  if (absPaths.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No file paths provided." }],
      isError: true,
      details: { mode: "batch", severity, filesChecked: 0 },
    };
  }

  const {
    results,
    fileErrors,
    lspHealthWarnings,
    total,
    truncated,
    display,
    primaryDisplay,
    auxiliaryDisplay,
    clean,
    unconfirmed,
    timedOut,
    outcomeCounts,
    incompleteFiles,
  } = await collectBatchDiagnostics(absPaths, severity, lspService, options);

  const lines: string[] = [
    `Files checked: ${results.length}`,
    `Total diagnostics: ${total}`,
    `Concurrency: ${options.concurrency}`,
  ];
  if (options.waitMs !== undefined) lines.push(`Wait budget: ${options.waitMs}ms`);
  lines.push(
    `Outcomes: ${Object.entries(outcomeCounts)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(", ")}`,
  );
  const notConfirmed =
    outcomeCounts.inconclusive +
    outcomeCounts.unavailable +
    outcomeCounts.unsupported +
    outcomeCounts.failed +
    incompleteFiles;
  if (notConfirmed > 0) {
    lines.push(
      "",
      `Checks not confirmed: ${notConfirmed} (inconclusive/unavailable/unsupported/failed or not started).`,
    );
  }
  if (incompleteFiles > 0) {
    lines.push(
      "",
      `Batch incomplete: ${incompleteFiles} file${incompleteFiles === 1 ? "" : "s"} were not confirmed because the batch was aborted.`,
    );
  }
  if (fileErrors.length > 0) lines.push("", "File errors:", ...fileErrors);
  if (lspHealthWarnings.length > 0) {
    lines.push("", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10));
  }
  if (unconfirmed > 0) {
    lines.push(
      "",
      `${clean} file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
        `${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`,
    );
  }
  if (display.length === 0) {
    if (unconfirmed === 0) {
      lines.push("", "No diagnostics found.");
    }
  } else {
    if (primaryDisplay.length > 0) {
      lines.push("", `Primary findings (${primaryDisplay.length}):`);
      lines.push(...primaryDisplay.map(formatDisplayDiag));
    }
    if (auxiliaryDisplay.length > 0) {
      lines.push("", `Auxiliary findings (${auxiliaryDisplay.length}):`);
      lines.push(...auxiliaryDisplay.map(formatDisplayDiag));
    }
    if (truncated) {
      lines.push("", `... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`);
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "batch",
      severity,
      serverScope: options.serverScope ?? "all",
      filesChecked: results.length,
      concurrency: options.concurrency,
      waitMs: options.waitMs,
      diagnostics: display,
      primaryDiagnosticsCount: primaryDisplay.length,
      auxiliaryDiagnosticsCount: auxiliaryDisplay.length,
      totalDiagnostics: total,
      truncated,
      cleanFiles: clean,
      unconfirmedFiles: unconfirmed,
      timedOutFiles: timedOut > 0 ? timedOut : undefined,
      outcomes: results.map((result) => ({
        file: result.file,
        outcome: result.outcome,
        reason: result.inconclusiveReason ?? result.error ?? result.unavailable,
        primaryDiagnosticsCount: result.diagnostics.filter(
          (diagnostic) => diagnostic.source === result.primaryServerId,
        ).length,
        auxiliaryDiagnosticsCount: result.diagnostics.filter(
          (diagnostic) => diagnostic.source !== result.primaryServerId,
        ).length,
      })),
      outcomeCounts,
      incompleteFiles: incompleteFiles > 0 ? incompleteFiles : undefined,
      fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
      lspHealthWarnings: lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
    },
  };
}

async function runDirectoryDiagnostics(
  absPath: string,
  severity: string,
  lspService: NonNullable<ReturnType<typeof getLSPService>>,
  options: BatchOptions,
) {
  let extension: string | undefined;
  let collectedFiles: string[] = [];

  const isIgnored = projectIgnorePredicate(absPath);
  for (const [ext, exts] of Object.entries(LANG_EXTENSIONS)) {
    collectedFiles = await collectFiles(absPath, exts, MAX_FILES + 1, isIgnored);
    if (collectedFiles.length > 0) {
      extension = ext;
      break;
    }
  }

  if (!extension || collectedFiles.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No supported source files found in: ${absPath}`,
        },
      ],
      details: {
        filePath: absPath,
        mode: "directory",
        severity,
        filesScanned: 0,
      },
    };
  }

  const wasCapped = collectedFiles.length > MAX_FILES;
  const filesToProcess = collectedFiles.slice(0, MAX_FILES);
  const {
    fileErrors,
    lspHealthWarnings,
    total,
    truncated,
    display,
    primaryDisplay,
    auxiliaryDisplay,
    clean,
    unconfirmed,
    timedOut,
  } = await collectBatchDiagnostics(filesToProcess, severity, lspService, options);

  let text: string;
  if (total === 0) {
    const cleanLine =
      unconfirmed > 0
        ? `${clean} clean · ${unconfirmed} unconfirmed: ` +
          `${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`
        : "No diagnostics found.";
    text = [
      `Directory: ${absPath}`,
      `Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
      ...(lspHealthWarnings.length > 0
        ? ["LSP unavailable for one or more files:", ...lspHealthWarnings.slice(0, 10)]
        : [cleanLine]),
    ].join("\n");
  } else {
    const lines: string[] = [
      `Directory: ${absPath}`,
      `Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
      `Files with errors: ${new Set(display.map((d) => d.file)).size}`,
      `Total diagnostics: ${total}`,
      ...(lspHealthWarnings.length > 0
        ? ["", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10)]
        : []),
      ...(unconfirmed > 0
        ? [
            "",
            `${clean} other file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
              unconfirmedReasonClause(unconfirmed, timedOut),
          ]
        : []),
      "",
    ];
    const toRelative = (d: FileDiag): FileDiag => ({
      ...d,
      file: path.relative(absPath, d.file),
    });
    if (primaryDisplay.length > 0) {
      lines.push(`Primary findings (${primaryDisplay.length}):`);
      lines.push(...primaryDisplay.map(toRelative).map(formatDisplayDiag));
      lines.push("");
    }
    if (auxiliaryDisplay.length > 0) {
      lines.push(`Auxiliary findings (${auxiliaryDisplay.length}):`);
      lines.push(...auxiliaryDisplay.map(toRelative).map(formatDisplayDiag));
    }
    if (truncated) {
      lines.push("", `... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`);
    }
    text = lines.join("\n");
  }

  return {
    content: [{ type: "text" as const, text }],
    details: {
      filePath: absPath,
      mode: "directory",
      severity,
      serverScope: options.serverScope ?? "all",
      filesScanned: filesToProcess.length,
      capped: wasCapped,
      diagnostics: display.map((d) => ({
        file: path.relative(absPath, d.file),
        line: d.line,
        character: d.character,
        severity: d.severity,
        message: d.message,
        source: d.source,
        code: d.code,
      })),
      primaryDiagnosticsCount: primaryDisplay.length,
      auxiliaryDiagnosticsCount: auxiliaryDisplay.length,
      totalDiagnostics: total,
      truncated,
      cleanFiles: clean,
      unconfirmedFiles: unconfirmed,
      timedOutFiles: timedOut > 0 ? timedOut : undefined,
      fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
      lspHealthWarnings: lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
      concurrency: options.concurrency,
      waitMs: options.waitMs,
    },
  };
}

function applySeverityFilter<T extends { severity: number }>(diags: T[], severity: string): T[] {
  if (severity === "all") return diags;
  interface MaximumSeverityLevel {
    [severity: string]: number;
  }
  const maxLevel: MaximumSeverityLevel = {
    error: 1,
    warning: 2,
    information: 3,
    hint: 4,
  };
  const max = maxLevel[severity] ?? 0;
  if (max === 0) return diags;
  return diags.filter((d) => (d.severity ?? 3) <= max);
}

function formatDisplayDiag(d: FileDiag): string {
  const sevName = SEVERITY_NAMES[d.severity] ?? "unknown";
  const loc = d.line !== undefined ? `${d.file}:${d.line + 1}:${(d.character ?? 0) + 1}` : d.file;
  const src = d.source ? `[${d.source}]` : "";
  const code = d.code ? ` (${d.code})` : "";
  return `${loc}: ${sevName}${src}${code}: ${d.message}`;
}

function formatDiag(diag: LSPDiagnostic): string {
  const loc =
    diag.range?.start?.line !== undefined
      ? `L${diag.range.start.line + 1}:${(diag.range.start.character ?? 0) + 1}`
      : "";
  const src = diag.source ? `[${diag.source}]` : "";
  const code = diag.code ? ` (${diag.code})` : "";
  const sevName = SEVERITY_NAMES[diag.severity] ?? "unknown";
  return `${loc}: ${sevName}${src}${code}: ${diag.message}`;
}
