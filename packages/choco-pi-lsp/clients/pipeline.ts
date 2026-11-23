import { isFiniteNumber, isFunction, type LspDictionaryValue } from "./runtime-guards.ts";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { PiLensFlagSource } from "./lsp-config.ts";
import { findNearestContaining, normalizeEphemeralMapKey } from "./path-utils.ts";
import {
  recordFromDispatchDiagnostic,
  type ActionableWarningRecord,
} from "./actionable-warnings.ts";
import {
  recordFromCodeQualityDiagnostic,
  type CodeQualityWarningRecord,
} from "./code-quality-warnings.ts";
import type { BiomeClient } from "./biome-client.ts";
import { recordDiagnostics } from "./widget-state.ts";
import { getDiagnosticLogger } from "./diagnostic-logger.ts";
import { getDiagnosticTracker } from "./diagnostic-tracker.ts";
import { loadDispatchIntegration } from "./dispatch/lazy.ts";
import { toRunnerDisplayPath } from "./dispatch/runner-context.ts";
import {
  type AvailabilityLatch,
  classifyProbeFailure,
  createAvailabilityChecker,
  createAvailabilityLatch,
  describeProbeEvidence,
  logAvailabilityDecision,
  startHostStallSampler,
  resolveAvailableOrInstall,
  resolveCommandArgsWithInstallFallback,
  resolveToolCommand,
  resolveToolCommandWithInstallFallback,
} from "./dispatch/runners/utils/runner-helpers.ts";
import { findDetektConfig } from "./dispatch/runners/detekt.ts";
import type { Diagnostic, PiAgentAPI } from "./dispatch/types.ts";
import { detectFileKind, getFileKindLabel } from "./file-kinds.ts";
import {
  detectFileChangedAfterCommand,
  getProjectIgnoreMatcher,
  isExcludedDirName,
} from "./file-utils.ts";
import type { FormatService } from "./format-service.ts";
import { logLatency } from "./latency-logger.ts";
import { emitLensAnalysisComplete } from "./lsp-events.ts";
import { publishFilesTouched } from "./bus-publish.ts";
import {
  publishDiagnostics,
  wasPreviouslyReportedDirty,
  type PilensDiagnosticEntry,
} from "./diagnostics-publish.ts";
import { loadLspService } from "./lsp-lazy.ts";
import type { MetricsClient } from "./metrics-client.ts";
import { clearGraphCache } from "./review-graph/builder.ts";
import { BoundedLruCache } from "./bounded-cache.ts";
import type { RuffClient } from "./ruff-client.ts";
import { RUNTIME_CONFIG } from "./runtime-config.ts";
import type { WordIndex } from "./word-index.ts";
import { getAmbientAbortSignal, safeSpawnAsync } from "./safe-spawn.ts";
import { combineAbortSignals } from "./deadline-utils.ts";
import { recordDegradationOnce } from "./degradation-ledger.ts";
import {
  getAutofixPolicyForFile,
  getPreferredAutofixTools,
  getRubocopCommand,
  hasBiomeConfig,
  hasDetektConfig,
  hasEslintConfig,
  hasGolangciConfig,
  hasKtfmtConfig,
  hasKtlintConfig,
  hasOxlintConfig,
  hasRubocopConfig,
  hasSqlfluffConfig,
  hasStylelintConfig,
  markdownlintConfigArgs,
} from "./tool-policy.ts";
import type { PathSetLike } from "./runtime-coordinator.ts";

type ExceedsLspSyncLimitsResultContract = {
  tooLarge: boolean;
  reason: string;
};

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const LSP_SPAWN_BUDGET_MS = RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs;
const AUTOFIX_CHANGED_FILE_SCAN_LIMIT = 5000;

function lspSyncBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_SYNC_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

type FileSnapshot = Map<string, { mtimeMs: number; size: number }>;

const SNAPSHOT_YIELD_EVERY = 500;

async function snapshotDirInto(
  dir: string,
  ignoreMatcher: ReturnType<typeof getProjectIgnoreMatcher>,
  stack: string[],
  snapshot: FileSnapshot,
  counter: { n: number },
): Promise<void> {
  let entries: nodeFs.Dirent[];
  try {
    entries = await nodeFs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDirName(entry.name) && !ignoreMatcher.isIgnored(fullPath, true)) {
        stack.push(fullPath);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoreMatcher.isIgnored(fullPath, false)) continue;
    try {
      const stat = await nodeFs.promises.stat(fullPath);
      snapshot.set(path.resolve(fullPath), {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
    if (++counter.n % SNAPSHOT_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

export async function snapshotProjectFiles(root: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  const projectRoot = path.resolve(root);
  const ignoreMatcher = getProjectIgnoreMatcher(projectRoot);
  await ignoreMatcher.ensureTrackedIndex();
  const stack = [projectRoot];
  const counter = { n: 0 };
  while (stack.length > 0 && snapshot.size < AUTOFIX_CHANGED_FILE_SCAN_LIMIT) {
    await snapshotDirInto(stack.pop()!, ignoreMatcher, stack, snapshot, counter);
  }
  return snapshot;
}

async function diffProjectSnapshot(root: string, before: FileSnapshot): Promise<string[]> {
  const after = await snapshotProjectFiles(root);
  const changed = new Set<string>();
  for (const [filePath, next] of after) {
    const prev = before.get(filePath);
    if (prev?.mtimeMs !== next.mtimeMs || prev?.size !== next.size) {
      changed.add(filePath);
    }
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort((a, b) => a.localeCompare(b));
}

function exceedsLspSyncLimits(
  _filePath: string,
  content: string,
): ExceedsLspSyncLimitsResultContract {
  const sizeBytes = Buffer.byteLength(content, "utf-8");
  if (sizeBytes > LSP_MAX_FILE_BYTES) {
    return {
      tooLarge: true,
      reason: `${Math.round(sizeBytes / 1024)}KB exceeds ${Math.round(LSP_MAX_FILE_BYTES / 1024)}KB`,
    };
  }

  const lineCount = content.split("\n").length;
  if (lineCount > LSP_MAX_FILE_LINES) {
    return {
      tooLarge: true,
      reason: `${lineCount} lines exceeds ${LSP_MAX_FILE_LINES}`,
    };
  }

  return { tooLarge: false, reason: "" };
}

export interface PipelineContext {
  filePath: string;
  cwd: string;
  projectRoot?: string;
  toolName: string;
  autofixMode?: "immediate" | "deferred";
  modifiedRanges?: { start: number; end: number }[];
  telemetry?: {
    model: string;
    sessionId: string;
    turnIndex: number;
    writeIndex: number;
    modelId?: string;
    provider?: string;
  };
  getFlag: (name: string, filePath?: string) => boolean | string | undefined;
  getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
  dbg: (msg: string) => void;
  seqState?: {
    projectSeq: () => number;
    getFilesChangedSince: (seq: number) => string[];
  };
  turnEndCascadeSettleStart?: () => number | undefined;
  wordIndex?: WordIndex | null;
  onWordIndexUpdated?: (index: WordIndex) => void;
}

export interface PipelineDeps {
  biomeClient: BiomeClient;
  ruffClient: RuffClient;
  metricsClient: MetricsClient;
  getFormatService: () => FormatService;
  fixedThisTurn: PathSetLike;
}

export interface PipelineResult {
  output: string;
  hasBlockers: boolean;
  cascadePromise?: Promise<import("./cascade-types.ts").CascadeRun>;
  isError: boolean;
  fileModified: boolean;
  changedFiles?: string[];
  inlineBlockerSummary?: string;
  inlineBlockerSources?: string[];
  inlineBlockerLines?: number[];
  actionableWarnings?: ActionableWarningRecord[];
  codeQualityWarnings?: CodeQualityWarningRecord[];
  diagnostics?: Diagnostic[];
  formattersUsed?: string[];
  fixedCount?: number;
  autofixTools?: string[];
  postMutation?: { filePath: string; content: string; source: "autofix" };
}

interface PhaseTracker {
  start(name: string): void;

  end(name: string, metadata?: Record<string, LspDictionaryValue>): void;
}

function createPhaseTracker(toolName: string, filePath: string): PhaseTracker {
  const phases: Array<{
    name: string;
    startTime: number;
    ended: boolean;
  }> = [];

  return {
    start(name: string) {
      phases.push({ name, startTime: Date.now(), ended: false });
    },

    end(name: string, metadata?: Record<string, LspDictionaryValue>) {
      const p = phases.find((x) => x.name === name && !x.ended);
      if (p) {
        p.ended = true;
        logLatency({
          type: "phase",
          toolName,
          filePath,
          phase: name,
          durationMs: Date.now() - p.startTime,
          metadata,
        });
      }
    },
  };
}

export { hasEslintConfig, hasRubocopConfig, hasSqlfluffConfig, hasStylelintConfig };

const ESLINT_FIX_PROBE_BUDGET_MS = 5000;

const _eslintCache = new BoundedLruCache<string, { latch: AvailabilityLatch; bin: string | null }>(
  32,
);

async function tryEslintFix(filePath: string, cwd: string): Promise<number> {
  const userHasConfig = hasEslintConfig(cwd);
  if (!userHasConfig) return 0;
  const cacheKey = `${path.resolve(cwd)}|${process.env.PATH ?? ""}`;
  let cached = _eslintCache.get(cacheKey);
  if (!cached) {
    cached = { latch: createAvailabilityLatch(), bin: null };
    _eslintCache.set(cacheKey, cached);
  }
  if (cached.latch.read() === null) {
    const candidate = resolveToolCommand(cwd, "eslint") ?? "eslint";
    const stallSampler = startHostStallSampler();
    const startedAt = Date.now();
    let check: Awaited<ReturnType<typeof safeSpawnAsync>>;
    let hostStallMs: number;
    try {
      check = await safeSpawnAsync(candidate, ["--version"], {
        timeout: ESLINT_FIX_PROBE_BUDGET_MS,
        cwd,
      });
    } finally {
      hostStallMs = stallSampler.stop();
    }
    const elapsedMs = Date.now() - startedAt;
    const decisionCwd = path.resolve(cwd);
    if (!check.error && check.status === 0) {
      cached.bin = candidate;
      cached.latch.noteAvailable();
      logAvailabilityDecision(
        {
          tool: "eslint",
          verdict: "available",
          outcome: "success",
          cause: "ok",
          elapsedMs,
          latched: true,
          hostStallMs,
          budgetMs: ESLINT_FIX_PROBE_BUDGET_MS,
          classifiedBy: "probe",
          evidence: describeProbeEvidence(check, "eslint"),
        },
        decisionCwd,
      );
    } else {
      cached.bin = null;
      const { outcome, cause, evidence } = classifyProbeFailure(check, {
        hostStallMs,
        command: "eslint",
      });
      const retryAfterMs = cached.latch.noteUnavailable(outcome, cause);
      logAvailabilityDecision(
        {
          tool: "eslint",
          verdict: "unavailable",
          outcome,
          cause,
          elapsedMs,
          latched: retryAfterMs === 0,
          hostStallMs,
          ...(retryAfterMs > 0 && { retryAfterMs }),
          budgetMs: ESLINT_FIX_PROBE_BUDGET_MS,
          classifiedBy: "probe",
          evidence,
        },
        decisionCwd,
      );
    }
  }
  if (cached.latch.read() !== true || !cached.bin) return 0;
  const cmd = cached.bin;

  return detectFileChangedAfterCommand(
    filePath,
    cmd,
    ["--fix", "--no-error-on-unmatched-pattern", filePath],
    cwd,
    [1],
  );
}

async function tryStylelintFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveToolCommandWithInstallFallback(cwd, "stylelint");
  if (!cmd) return 0;

  return detectFileChangedAfterCommand(
    filePath,
    cmd,
    ["--fix", "--allow-empty-input", filePath],
    cwd,
    [2],
  );
}

async function trySqlfluffFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveToolCommandWithInstallFallback(cwd, "sqlfluff");
  if (!cmd) return 0;

  const args = ["fix", "--force", filePath];
  if (!hasSqlfluffConfig(cwd)) {
    args.splice(2, 0, "--dialect", "ansi");
  }
  return detectFileChangedAfterCommand(filePath, cmd, args, cwd);
}

async function tryRubocopFix(filePath: string, cwd: string): Promise<number> {
  const resolved = await resolveCommandArgsWithInstallFallback(
    getRubocopCommand(cwd),
    "rubocop",
    cwd,
    ["--version"],
    10000,
  );
  if (!resolved) return 0;

  return detectFileChangedAfterCommand(
    filePath,
    resolved.cmd,
    [...resolved.args, "-a", "--no-color", filePath],
    cwd,
    [1],
  );
}

async function tryKtlintFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");
  if (!cmd) return 0;

  return detectFileChangedAfterCommand(filePath, cmd, ["-F", filePath], cwd, [1]);
}

const golangciAutofixChecker = createAvailabilityChecker("golangci-lint", ".exe");
const detektAutofixChecker = createAvailabilityChecker("detekt", ".bat");
const ktfmtAutofixChecker = createAvailabilityChecker("ktfmt", ".bat");

async function tryKtfmtFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveAvailableOrInstall(ktfmtAutofixChecker, "ktfmt", cwd);
  if (!cmd) return 0;
  const absPath = path.resolve(cwd, filePath);
  return detectFileChangedAfterCommand(filePath, cmd, [absPath], cwd, [0]);
}

async function tryGolangciLintFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveAvailableOrInstall(golangciAutofixChecker, "golangci-lint", cwd);
  if (!cmd) return 0;
  return detectFileChangedAfterCommand(filePath, cmd, ["run", "--fix", filePath], cwd, [1, 7]);
}

async function tryDetektFix(filePath: string, cwd: string): Promise<number> {
  const configPath = findDetektConfig(cwd);
  if (!configPath) return 0;
  if (!(await detektAutofixChecker.isAvailableAsync(cwd))) return 0;
  const cmd = detektAutofixChecker.getCommand(cwd);
  if (!cmd) return 0;
  const absPath = path.resolve(cwd, filePath);
  return detectFileChangedAfterCommand(
    filePath,
    cmd,
    ["--auto-correct", "--input", absPath, "--config", configPath],
    cwd,
    [1, 2],
  );
}

async function tryMarkdownlintFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveToolCommandWithInstallFallback(cwd, "markdownlint");
  if (!cmd) return 0;
  return detectFileChangedAfterCommand(
    filePath,
    cmd,
    [...markdownlintConfigArgs(cwd), "--fix", filePath],
    cwd,
    [1],
  );
}

async function tryOxlintFix(filePath: string, cwd: string): Promise<number> {
  const cmd = await resolveToolCommandWithInstallFallback(cwd, "oxlint");
  if (!cmd) return 0;
  return detectFileChangedAfterCommand(filePath, cmd, ["--fix", filePath], cwd, [1]);
}

async function tryRustClippyFix(filePath: string): Promise<string[]> {
  const check = await safeSpawnAsync("cargo", ["--version"], { timeout: 5000 });
  if (check.error || check.status !== 0) return [];

  const cargoDir = findNearestContaining(path.dirname(path.resolve(filePath)), ["Cargo.toml"]);
  if (!cargoDir) return [];

  const before = await snapshotProjectFiles(cargoDir);
  const result = await safeSpawnAsync(
    "cargo",
    ["clippy", "--fix", "--allow-dirty", "--allow-staged", "-q"],
    { timeout: 30000, cwd: cargoDir },
  );
  if (result.error || result.status !== 0) return [];
  return diffProjectSnapshot(cargoDir, before);
}

async function tryDartFix(filePath: string): Promise<string[]> {
  const check = await safeSpawnAsync("dart", ["--version"], { timeout: 5000 });
  if (check.error || check.status !== 0) return [];

  const pubspecDir = findNearestContaining(path.dirname(path.resolve(filePath)), ["pubspec.yaml"]);
  if (!pubspecDir) return [];

  const before = await snapshotProjectFiles(pubspecDir);
  const result = await safeSpawnAsync("dart", ["fix", "--apply"], {
    timeout: 30000,
    cwd: pubspecDir,
  });
  if (result.error || result.status !== 0) return [];
  return diffProjectSnapshot(pubspecDir, before);
}

export async function runAutofix(
  filePath: string,
  cwd: string,
  getFlag: PipelineContext["getFlag"],
  dbg: PipelineContext["dbg"],
  deps: Pick<PipelineDeps, "biomeClient" | "ruffClient" | "fixedThisTurn">,
  getFlagSource?: PipelineContext["getFlagSource"],
): Promise<{
  fixedCount: number;
  autofixTools: string[];
  attemptedTools: string[];
  changedFiles: string[];
  needsContentRefresh: boolean;
  skipReason?: string;
}> {
  const { biomeClient, ruffClient, fixedThisTurn } = deps;
  const noAutofix = getFlag("no-autofix", filePath);
  let fixedCount = 0;
  const autofixTools: string[] = [];
  const attemptedTools: string[] = [];
  const changedFiles = new Set<string>();
  const markTargetChanged = () => changedFiles.add(path.resolve(filePath));
  let needsContentRefresh = false;

  if (fixedThisTurn.has(filePath)) {
    dbg(`autofix: skipped for ${filePath} (already fixed this turn)`);
    return {
      fixedCount,
      autofixTools,
      attemptedTools,
      changedFiles: [],
      needsContentRefresh,
      skipReason: "already_fixed_this_turn",
    };
  }

  if (noAutofix) {
    const source = getFlagSource?.("no-autofix", filePath);
    dbg(`autofix: skipped for ${filePath} (--no-autofix${source ? `, source=${source}` : ""})`);
    return {
      fixedCount,
      autofixTools,
      attemptedTools,
      changedFiles: [],
      needsContentRefresh,
      skipReason: "disabled_by_flag",
    };
  }

  const autofixContext = {
    hasEslintConfig: hasEslintConfig(cwd),
    hasStylelintConfig: hasStylelintConfig(cwd),
    hasSqlfluffConfig: hasSqlfluffConfig(cwd),
    hasRubocopConfig: hasRubocopConfig(cwd),
    hasBiomeConfig: hasBiomeConfig(cwd),
    hasGolangciConfig: hasGolangciConfig(cwd),
    hasDetektConfig: hasDetektConfig(cwd),
    hasKtfmtConfig: hasKtfmtConfig(cwd),
    hasKtlintConfig: hasKtlintConfig(cwd),
    hasOxlintConfig: hasOxlintConfig(cwd),
  };
  const autofixPolicy = getAutofixPolicyForFile(filePath, autofixContext);
  const preferredAutofixTools = autofixPolicy?.safe
    ? getPreferredAutofixTools(filePath, autofixContext)
    : [];

  dbg(
    `autofix: policy for ${filePath} -> ${autofixPolicy?.defaultTool ?? "none"} ` +
      `(preferred: ${preferredAutofixTools.join(",") || "none"}, gate: ${autofixPolicy?.gate ?? "none"}, safe: ${autofixPolicy?.safe ? "yes" : "no"})`,
  );

  if (!autofixPolicy) {
    dbg(`autofix: no policy for ${filePath}`);
    return {
      fixedCount,
      autofixTools,
      attemptedTools,
      changedFiles: [],
      needsContentRefresh,
      skipReason: "no_policy",
    };
  }

  if (!autofixPolicy.safe || preferredAutofixTools.length === 0) {
    dbg(`autofix: no safe preferred tools for ${filePath}`);
    return {
      fixedCount,
      autofixTools,
      attemptedTools,
      changedFiles: [],
      needsContentRefresh,
      skipReason: "no_safe_tools",
    };
  }

  for (const toolName of preferredAutofixTools) {
    attemptedTools.push(toolName);
    if (toolName === "ruff") {
      const ruffReady = ruffClient.isPythonFile(filePath)
        ? await ruffClient.ensureAvailable()
        : false;
      if (!ruffReady) {
        dbg(`autofix: ruff unavailable for ${filePath}`);
        continue;
      }
      const result = await ruffClient.fixFileAsync(filePath, cwd);
      if (result.success && result.fixed > 0) {
        fixedCount += result.fixed;
        autofixTools.push(`ruff:${result.fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: ruff fixed ${result.fixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "biome") {
      const biomeReady = biomeClient.isSupportedFile(filePath)
        ? await biomeClient.ensureAvailable()
        : false;
      if (!biomeReady) {
        dbg(`autofix: biome unavailable or unsupported for ${filePath}`);
        continue;
      }
      const result = await biomeClient.fixFileAsync(filePath, cwd);
      if (result.success && result.fixed > 0) {
        fixedCount += result.fixed;
        autofixTools.push(`biome:${result.fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: biome fixed ${result.fixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "eslint") {
      const eslintFixed = await tryEslintFix(filePath, cwd);
      if (eslintFixed > 0) {
        fixedCount += eslintFixed;
        autofixTools.push(`eslint:${eslintFixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: eslint fixed ${eslintFixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "stylelint") {
      const stylelintFixed = await tryStylelintFix(filePath, cwd);
      if (stylelintFixed > 0) {
        fixedCount += stylelintFixed;
        autofixTools.push(`stylelint:${stylelintFixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: stylelint fixed ${stylelintFixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "sqlfluff") {
      const sqlfluffFixed = await trySqlfluffFix(filePath, cwd);
      if (sqlfluffFixed > 0) {
        fixedCount += sqlfluffFixed;
        autofixTools.push(`sqlfluff:${sqlfluffFixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: sqlfluff fixed ${sqlfluffFixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "rubocop") {
      const rubocopFixed = await tryRubocopFix(filePath, cwd);
      if (rubocopFixed > 0) {
        fixedCount += rubocopFixed;
        autofixTools.push(`rubocop:${rubocopFixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: rubocop fixed ${rubocopFixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "ktlint") {
      const ktlintFixed = await tryKtlintFix(filePath, cwd);
      if (ktlintFixed > 0) {
        fixedCount += ktlintFixed;
        autofixTools.push(`ktlint:${ktlintFixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: ktlint fixed ${ktlintFixed} issue(s) in ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "rust-clippy") {
      const clippyChangedFiles = await tryRustClippyFix(filePath);
      if (clippyChangedFiles.length > 0) {
        fixedCount += clippyChangedFiles.length;
        autofixTools.push(`rust-clippy:${clippyChangedFiles.length}`);
        fixedThisTurn.add(filePath);
        for (const changedFile of clippyChangedFiles) changedFiles.add(changedFile);
        dbg(`autofix: rust-clippy changed ${clippyChangedFiles.length} file(s) from ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "dart-analyze") {
      const dartChangedFiles = await tryDartFix(filePath);
      if (dartChangedFiles.length > 0) {
        fixedCount += dartChangedFiles.length;
        autofixTools.push(`dart-analyze:${dartChangedFiles.length}`);
        fixedThisTurn.add(filePath);
        for (const changedFile of dartChangedFiles) changedFiles.add(changedFile);
        dbg(`autofix: dart fix changed ${dartChangedFiles.length} file(s) from ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "golangci-lint") {
      const fixed = await tryGolangciLintFix(filePath, cwd);
      if (fixed > 0) {
        fixedCount += fixed;
        autofixTools.push(`golangci-lint:${fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: golangci-lint fixed ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "detekt") {
      const fixed = await tryDetektFix(filePath, cwd);
      if (fixed > 0) {
        fixedCount += fixed;
        autofixTools.push(`detekt:${fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: detekt --auto-correct fixed ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "ktfmt") {
      const fixed = await tryKtfmtFix(filePath, cwd);
      if (fixed > 0) {
        fixedCount += fixed;
        autofixTools.push(`ktfmt:${fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: ktfmt formatted ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "markdownlint") {
      const fixed = await tryMarkdownlintFix(filePath, cwd);
      if (fixed > 0) {
        fixedCount += fixed;
        autofixTools.push(`markdownlint:${fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: markdownlint --fix fixed ${filePath}`);
        needsContentRefresh = true;
      }
      continue;
    }

    if (toolName === "oxlint") {
      const fixed = await tryOxlintFix(filePath, cwd);
      if (fixed > 0) {
        fixedCount += fixed;
        autofixTools.push(`oxlint:${fixed}`);
        fixedThisTurn.add(filePath);
        markTargetChanged();
        dbg(`autofix: oxlint --fix fixed ${filePath}`);
        needsContentRefresh = true;
      }
    }
  }

  if (attemptedTools.length > 0 && autofixTools.length === 0) {
    dbg(
      `autofix: attempted ${attemptedTools.join(",")} for ${filePath}, but no fixes were applied`,
    );
  }

  return {
    fixedCount,
    autofixTools,
    attemptedTools,
    changedFiles: [...changedFiles],
    needsContentRefresh,
  };
}

export async function resyncLspFile(
  filePath: string,
  fileContent: string,
  needsContentRefresh: boolean,
  lspSyncCompleted: boolean,
  getFlag: PipelineContext["getFlag"],
  dbg: PipelineContext["dbg"],
): Promise<void> {
  if (getFlag("no-lsp")) return;
  if (!needsContentRefresh && lspSyncCompleted) return;

  const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
  if (limitCheck.tooLarge) return;

  try {
    const lspService = (await loadLspService()).getLSPService();
    if (lspService.supportsLSP(filePath)) {
      const budgetMs = lspSyncBudgetMs();
      const abort = getAmbientAbortSignal();
      if (abort?.aborted) return;
      const bail = combineAbortSignals(abort, AbortSignal.timeout(budgetMs));
      const startedAt = Date.now();
      const touch = lspService
        .touchFile(filePath, fileContent, {
          diagnostics: "none",
          source: "lsp_sync",
          clientScope: "primary",
          maxClientWaitMs: LSP_SPAWN_BUDGET_MS,
        })
        .then(() => "done" as const)
        .catch((err) => {
          dbg(`LSP resync after autofix error: ${err}`);
          return "done" as const;
        });
      const bailed = new Promise<"bailed">((resolve) => {
        if (!bail || bail.aborted) return resolve("bailed");
        bail.addEventListener("abort", () => resolve("bailed"), { once: true });
      });
      const outcome = await Promise.race([touch, bailed]);
      if (outcome === "bailed") {
        const spawnInFlight =
          !abort?.aborted &&
          isFunction(lspService.isSpawnInFlight) &&
          lspService.isSpawnInFlight(filePath);
        const reason = abort?.aborted ? "aborted" : spawnInFlight ? "spawn-in-flight" : "timeout";
        logLatency({
          type: "phase",
          phase: "lsp_sync_abandoned",
          filePath,
          durationMs: Date.now() - startedAt,
          metadata: {
            source: "lsp_sync",
            reason,
            budgetMs,
          },
        });
        const cause = abort?.aborted
          ? "aborted (Escape)"
          : spawnInFlight
            ? `timed out after ${budgetMs}ms; reason: spawn-in-flight (server still cold-spawning)`
            : `timed out after ${budgetMs}ms; server slow/wedged`;
        dbg(`LSP resync ${cause} for ${filePath}`);
      }
    }
  } catch (err) {
    dbg(`LSP resync after autofix error: ${err}`);
  }
}

function toPilensDiagnosticEntry(d: Diagnostic): PilensDiagnosticEntry {
  const entry: PilensDiagnosticEntry = {
    severity: d.severity,
    message: d.message,
    tool: d.tool,
  };
  if (d.rule !== undefined) entry.ruleId = d.rule;
  if (d.line !== undefined) entry.line = d.line;
  if (d.column !== undefined) entry.col = d.column;
  if (d.fixable !== undefined) entry.fixable = d.fixable;
  return entry;
}

type DispatchResult = Awaited<
  ReturnType<(typeof import("./dispatch/integration.ts"))["dispatchLintWithResult"]>
>;
function buildAllClearOutput(
  _dispatchResult: DispatchResult,
  elapsed: number,
  filePath: string,
): string {
  const kind = detectFileKind(filePath);
  const langLabel = kind ? getFileKindLabel(kind) : path.extname(filePath);
  const parts: string[] = [];

  if (kind) {
    parts.push(`${langLabel} clean`);
  }

  parts.push(`${elapsed}ms`);
  return `checkmark ${parts.join(" · ")}`.replace("checkmark", "\u2713");
}

export interface FormatPhaseResult {
  formatChanged: boolean;
  formattersUsed: string[];
  formatFailures: string[];
  fileContent: string | undefined;
}

export async function runFormatPhase(
  filePath: string,
  getFormatService: () => FormatService,
  dbg: PipelineContext["dbg"],
): Promise<FormatPhaseResult> {
  let formatChanged = false;
  let formattersUsed: string[] = [];
  const formatFailures: string[] = [];
  let fileContent: string | undefined;

  const formatService = getFormatService();
  try {
    formatService.recordRead(filePath);
    const result = await formatService.formatFile(filePath);
    formattersUsed = result.formatters.map((f) => f.name);
    if (result.anyChanged) {
      formatChanged = true;
      dbg(
        "autoformat: " +
          result.formatters
            .map((f) => f.name + "(" + (f.changed ? "changed" : "unchanged") + ")")
            .join(", "),
      );
    }
    if (!result.allSucceeded) {
      const failures = result.formatters.filter((f) => !f.success);
      for (const failure of failures) {
        recordDegradationOnce({
          kind: "formatter-failure",
          subject: `${failure.name}:${path.basename(filePath)}`,
          reason: failure.error ?? "unknown error",
        });
      }
      formatFailures.push(...failures.map((f) => `${f.name}: ${f.error ?? "unknown error"}`));
      dbg(
        "autoformat: " +
          failures.map((f) => f.name + " failed: " + (f.error ?? "unknown error")).join("; "),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordDegradationOnce({
      kind: "formatter-failure",
      subject: `format-service:${path.basename(filePath)}`,
      reason: message,
    });
    formatFailures.push(message);
    dbg(`autoformat error: ${err}`);
  }

  try {
    fileContent = nodeFs.readFileSync(filePath, "utf-8");
  } catch {
    fileContent = undefined;
  }

  return { formatChanged, formattersUsed, formatFailures, fileContent };
}

function buildEnrichedBlockerOutput(blockers: Diagnostic[], fileContent: string): string {
  const fileLines = fileContent.split("\n");
  const MAX_SNIPPET = 120;

  let out = `\n\n🔴 STOP — ${blockers.length} issue(s) must be fixed:\n`;
  const shown = blockers.slice(0, 10);

  for (const d of shown) {
    const lineNo = d.line ?? 1;
    const nodeCtx = d.astNodeType ? ` (${d.astNodeType})` : "";
    out += `  L${lineNo}: ${d.message}${nodeCtx}\n`;
    const snippet = d.matchedText
      ? d.matchedText.trim().split("\n")[0]?.slice(0, MAX_SNIPPET)
      : fileLines[lineNo - 1]?.trim().slice(0, MAX_SNIPPET);
    if (snippet) out += `      → ${snippet}\n`;
    if (d.fixSuggestion) out += `      💡 ${d.fixSuggestion}\n`;
  }

  if (blockers.length > 10) {
    out += `  ... and ${blockers.length - 10} more\n`;
  }

  return out;
}

export async function runPipeline(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { filePath, cwd, toolName, getFlag, getFlagSource, dbg } = ctx;
  const { getFormatService } = deps;

  const phase = createPhaseTracker(toolName, filePath);
  const pipelineStart = Date.now();
  clearGraphCache();
  phase.start("total");

  phase.start("read_file");
  let fileContent: string | undefined;
  try {
    fileContent = nodeFs.readFileSync(filePath, "utf-8");
  } catch {}
  phase.end("read_file");

  phase.start("format");
  let formatChanged = false;
  let formattersUsed: string[] = [];
  let formatFailures: string[] = [];
  const piChangedFiles = new Set<string>();
  const autoformatDisabled = !!getFlag("no-autoformat", filePath);
  const immediateFormat = !!getFlag("immediate-format");
  const formatDeferred = !autoformatDisabled && !immediateFormat && !!fileContent;
  if (!autoformatDisabled && immediateFormat && fileContent) {
    const formatResult = await runFormatPhase(filePath, getFormatService, dbg);
    formatChanged = formatResult.formatChanged;
    formattersUsed = formatResult.formattersUsed;
    formatFailures = formatResult.formatFailures;
    fileContent = formatResult.fileContent;
    if (formatChanged) {
      const absPath = path.resolve(filePath);
      piChangedFiles.add(absPath);
      publishFilesTouched({
        reason: "format",
        paths: [absPath],
        cwd,
        dbg,
        fixes: formattersUsed.map((tool) => ({
          path: absPath,
          tool,
          kind: "format",
        })),
      });
    }
  } else if (formatDeferred) {
    dbg(`autoformat: deferred until agent_end for ${filePath}`);
  } else if (autoformatDisabled) {
    const source = getFlagSource?.("no-autoformat", filePath);
    dbg(
      `autoformat: skipped for ${filePath} (--no-autoformat${source ? `, source=${source}` : ""})`,
    );
  }
  phase.end("format", {
    formattersUsed,
    formatChanged,
    deferred: formatDeferred,
  });

  phase.start("autofix");
  let fixedCount = 0;
  let autofixTools: string[] = [];
  let attemptedTools: string[] = [];
  let autofixChangedFiles: string[] = [];
  let fixRefresh = false;
  let autofixSkipReason: string | undefined;
  if (ctx.autofixMode === "deferred") {
    autofixSkipReason = "deferred_to_agent_end";
    dbg(`autofix: deferred until agent_end for ${filePath}`);
  } else
    ({
      fixedCount,
      autofixTools,
      attemptedTools,
      changedFiles: autofixChangedFiles,
      needsContentRefresh: fixRefresh,
      skipReason: autofixSkipReason,
    } = await runAutofix(filePath, cwd, getFlag, dbg, deps, getFlagSource));
  for (const changedFile of autofixChangedFiles) {
    piChangedFiles.add(path.resolve(changedFile));
  }
  if (autofixChangedFiles.length > 0) {
    const absChangedFiles = autofixChangedFiles.map((f) => path.resolve(f));
    const toolNames = autofixTools.map((t) => t.split(":")[0]);
    publishFilesTouched({
      reason: "autofix",
      paths: absChangedFiles,
      cwd,
      dbg,
      fixes: absChangedFiles.flatMap((p) =>
        toolNames.map((tool) => ({ path: p, tool, kind: "autofix" as const })),
      ),
    });
  }
  if (fixRefresh) {
    try {
      fileContent = nodeFs.readFileSync(filePath, "utf-8");
    } catch {
      fileContent = undefined;
    }
  }
  phase.end("autofix", {
    fixedCount,
    tools: autofixTools,
    attemptedTools,
    skipReason: autofixSkipReason,
  });

  phase.start("lsp_sync");
  let lspSyncCompleted = false;
  if (fileContent) {
    await resyncLspFile(filePath, fileContent, true, false, getFlag, dbg);
    lspSyncCompleted = true;
  }
  phase.end("lsp_sync", { completed: lspSyncCompleted, finalContent: true });

  phase.start("dispatch_lint");
  dbg(`dispatch: running lint tools for ${filePath}`);

  const piApi: PiAgentAPI = {
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    getFlag: getFlag as (flag: string) => boolean | string | undefined,
  };
  const { dispatchLintWithResult, computeCascadeForFile } = await loadDispatchIntegration();
  const dispatchResult = await dispatchLintWithResult(
    filePath,
    cwd,
    piApi,
    ctx.modifiedRanges,
    {
      model: ctx.telemetry?.model ?? "unknown",
      sessionId: ctx.telemetry?.sessionId ?? "unknown",
      turnIndex: ctx.telemetry?.turnIndex ?? 0,
      writeIndex: ctx.telemetry?.writeIndex ?? 0,
    },
    {
      projectRoot: ctx.projectRoot,
      writeIndex: ctx.telemetry?.writeIndex,
      telemetryModel: ctx.telemetry?.modelId,
      telemetryProvider: ctx.telemetry?.provider,
    },
  );
  recordDiagnostics(filePath, dispatchResult.diagnostics, ctx.telemetry?.writeIndex);
  {
    const absPath = path.resolve(filePath);
    const wasDirty = wasPreviouslyReportedDirty(absPath);
    if (dispatchResult.diagnostics.length > 0 || wasDirty) {
      publishDiagnostics({
        cwd,
        files: [
          {
            path: absPath,
            diagnostics: dispatchResult.diagnostics.map(toPilensDiagnosticEntry),
          },
        ],
        dbg,
      });
    }
  }
  const hasBlockers = dispatchResult.hasBlockers;
  const actionableWarnings = dispatchResult.warnings
    .map((diagnostic) => recordFromDispatchDiagnostic(diagnostic, cwd))
    .filter((warning): warning is ActionableWarningRecord => Boolean(warning));
  const codeQualityWarnings = dispatchResult.warnings
    .map((diagnostic) => recordFromCodeQualityDiagnostic(diagnostic, cwd))
    .filter((warning): warning is CodeQualityWarningRecord => Boolean(warning));

  if (dispatchResult.diagnostics.length > 0) {
    const logger = getDiagnosticLogger();
    const tracker = getDiagnosticTracker();
    tracker.trackShown(dispatchResult.diagnostics);
    const toKey = (d: (typeof dispatchResult.diagnostics)[number]) =>
      [d.tool || "", d.id || "", d.rule || "", d.filePath || "", d.line || 0, d.column || 0].join(
        "|",
      );
    const inlineKeys = new Set([...dispatchResult.blockers, ...dispatchResult.fixed].map(toKey));
    for (const d of dispatchResult.diagnostics) {
      logger.logCaught(
        d,
        {
          model: ctx.telemetry?.model ?? "unknown",
          sessionId: ctx.telemetry?.sessionId ?? "unknown",
          turnIndex: ctx.telemetry?.turnIndex ?? 0,
          writeIndex: ctx.telemetry?.writeIndex ?? 0,
        },
        inlineKeys.has(toKey(d)),
      );
    }
  }

  if (fixedCount > 0) getDiagnosticTracker().trackAutoFixed(fixedCount);
  if (dispatchResult.resolvedCount > 0)
    getDiagnosticTracker().trackAgentFixed(dispatchResult.resolvedCount);

  let output = "";
  if (dispatchResult.hasBlockers && fileContent) {
    output += buildEnrichedBlockerOutput(dispatchResult.blockers, fileContent);
    const rest = dispatchResult.output.slice(dispatchResult.blockerOutput.length);
    if (rest) output += rest;
  } else if (dispatchResult.output) {
    output += `\n\n${dispatchResult.output}`;
  }
  if (fixedCount > 0) {
    const detail = autofixTools.length > 0 ? ` (${autofixTools.join(", ")})` : "";
    output += `\n\n✅ Auto-fixed ${fixedCount} issue(s)${detail}`;
  }
  if (formatFailures.length > 0) {
    const details = formatFailures.slice(0, 3).join("; ");
    const suffix = formatFailures.length > 3 ? `; ... and ${formatFailures.length - 3} more` : "";
    output += `\n\n⚠️ Auto-format failed: ${details}${suffix}`;
  }
  if (formatChanged || fixedCount > 0) {
    const changedList = [...piChangedFiles].map((changedFile) =>
      toRunnerDisplayPath(cwd, changedFile),
    );
    const topFiles = changedList
      .slice(0, 8)
      .map((f) => "  - " + f)
      .join("\n");
    const overflow =
      changedList.length > 8 ? "\n  - ... and " + (changedList.length - 8) + " more" : "";
    const fileList = changedList.length ? "\nModified files:\n" + topFiles + overflow : "";
    const targetHasAuthoritativeAttachment =
      ctx.autofixMode !== "deferred" &&
      autofixChangedFiles.some(
        (changedFile) => path.resolve(changedFile) === path.resolve(filePath),
      );
    output += targetHasAuthoritativeAttachment
      ? `\n\n⚠️ **The attached full content for ${toRunnerDisplayPath(cwd, filePath)} is authoritative after autofix. You MUST re-read any other modified side-effect files before editing them.**${fileList}`
      : `\n\n⚠️ **File was modified by auto-format/fix. You MUST re-read modified file(s) before making any further edits — the content on disk has changed (whitespace, indentation, quotes, or code). Editing from memory will produce mismatches.**${fileList}`;
  }
  phase.end("dispatch_lint", {
    hasOutput: !!dispatchResult.output,
    diagnosticCount: dispatchResult.diagnostics.length,
  });

  const cascadeOrigin = {
    turnSeq: ctx.telemetry?.turnIndex,
    writeSeq: ctx.telemetry?.writeIndex,
    projectSeq: ctx.seqState?.projectSeq(),
  };
  const cascadePromise = getFlag("no-lsp")
    ? undefined
    : computeCascadeForFile(filePath, cwd, {
        hasBlockers,
        dbg,
        turnSeq: ctx.telemetry?.turnIndex,
        writeSeq: ctx.telemetry?.writeIndex,
        seqState: ctx.seqState,
        turnEndCascadeSettleStart: ctx.turnEndCascadeSettleStart,
        fileContent,
        wordIndex: ctx.wordIndex,
        onWordIndexUpdated: ctx.onWordIndexUpdated,
      })
        .then((run) => ({ ...run, origin: cascadeOrigin }))
        .catch((err): import("./cascade-types.ts").CascadeRun => {
          dbg(`cascade compute failed for ${filePath}: ${err}`);
          return {
            filePath,
            origin: cascadeOrigin,
            result: undefined,
            neighborCount: 0,
            diagnosticCount: 0,
            skipReason: "error",
            indeterminate: {
              reason: "error",
              detail: "cascade computation failed",
            },
          };
        });

  const elapsed = Date.now() - pipelineStart;
  if (!output) {
    output = buildAllClearOutput(dispatchResult, elapsed, filePath);
  }

  phase.end("total", { hasOutput: !!output });

  const fileModified = formatChanged || fixedCount > 0;
  const changedFiles = [...piChangedFiles];
  emitLensAnalysisComplete({
    cwd,
    filePath,
    toolName,
    model: ctx.telemetry?.model ?? "unknown",
    sessionId: ctx.telemetry?.sessionId ?? "unknown",
    turnIndex: ctx.telemetry?.turnIndex ?? 0,
    writeIndex: ctx.telemetry?.writeIndex ?? 0,
    diagnostics: dispatchResult.diagnostics,
    blockers: dispatchResult.blockers,
    warnings: dispatchResult.warnings,
    fixed: dispatchResult.fixed,
    resolvedCount: dispatchResult.resolvedCount,
    hasBlockers,
    fileModified,
    changedFiles,
    durationMs: elapsed,
  });

  return {
    output,
    hasBlockers,
    cascadePromise,
    isError: false,
    fileModified,
    changedFiles,
    inlineBlockerSummary: dispatchResult.hasBlockers
      ? dispatchResult.blockerOutput.trim() || undefined
      : undefined,
    inlineBlockerSources: dispatchResult.hasBlockers
      ? [...new Set(dispatchResult.blockers.map((d) => d.tool?.trim() || "unknown"))]
      : undefined,
    inlineBlockerLines: dispatchResult.hasBlockers
      ? dispatchResult.blockers
          .filter(
            (d) => normalizeEphemeralMapKey(d.filePath) === normalizeEphemeralMapKey(filePath),
          )
          .map((d) => d.line)

          .filter((line): line is number => isFiniteNumber(line))
      : undefined,
    actionableWarnings,
    codeQualityWarnings,
    diagnostics: dispatchResult.diagnostics,
    formattersUsed,
    fixedCount,
    autofixTools,
    postMutation:
      ctx.autofixMode !== "deferred" &&
      autofixChangedFiles.some((f) => path.resolve(f) === path.resolve(filePath)) &&
      fileContent !== undefined
        ? { filePath: path.resolve(filePath), content: fileContent, source: "autofix" }
        : undefined,
  };
}
