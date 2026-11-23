import { logExtension } from "../extension-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileKind } from "../file-kinds.ts";
import { recordRunner } from "../widget-state.ts";
import { detectFileKind } from "../file-kinds.ts";
import { detectFileRole } from "../file-role.ts";
import { isTestFile } from "../file-utils.ts";
import { getPrimaryDispatchGroup } from "../language-policy.ts";
import { resolveLanguageRootForFile } from "../language-profile.ts";
import { logLatency } from "../latency-logger.ts";
import { isSpawnableCommand } from "../installer/index.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { loadPiLensProjectConfig } from "../project-lsp-config.ts";
import { RUNTIME_CONFIG, getRunnerTimeoutFloorMs } from "../runtime-config.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";
import { classifyDiagnostic } from "./diagnostic-taxonomy.ts";
import {
  classifyProbeFailure,
  logAvailabilityDecision,
  startHostStallSampler,
  transientRetryDelayMs,
} from "./runners/utils/availability-policy.ts";
import type { FactStore } from "./fact-store.ts";
import { applyDispositions } from "../diagnostic-dispositions.ts";
import { applyInlineSuppressions } from "./inline-suppressions.ts";
import { getToolPlan } from "./plan.ts";
import { resolveRunnerPath } from "./runner-context.ts";
import { applyRulePolicy, rulePolicyMapFromConfig } from "./rule-policy.ts";
import { getToolProfile } from "./tool-profile.ts";
import type {
  Diagnostic,
  DispatchContext,
  DispatchResult,
  OutputSemantic,
  PiAgentAPI,
  RunnerDefinition,
  RunnerGroup,
  RunnerRegistry as RunnerRegistryContract,
  RunnerResult,
} from "./types.ts";
import { formatDiagnostics } from "./utils/format-utils.ts";

export class RunnerRegistry implements RunnerRegistryContract {
  private readonly runners = new Map<string, RunnerDefinition>();

  register(runner: RunnerDefinition): void {
    if (this.runners.has(runner.id)) return;
    this.runners.set(runner.id, runner);
  }

  get(id: string): RunnerDefinition | undefined {
    return this.runners.get(id);
  }

  getForKind(kind: FileKind, filePath?: string): RunnerDefinition[] {
    const matching: RunnerDefinition[] = [];
    const isTest = filePath ? isTestFile(filePath) : false;

    for (const runner of this.runners.values()) {
      if (isTest && runner.skipTestFiles) continue;
      if (runner.appliesTo.includes(kind) || runner.appliesTo.length === 0) {
        matching.push(runner);
      }
    }

    return matching.sort((a, b) => a.priority - b.priority);
  }

  list(): RunnerDefinition[] {
    return Array.from(this.runners.values());
  }

  clear(): void {
    this.runners.clear();
  }
}

export function normalizeCacheKey(cmd: string): string {
  const normalized = cmd.replace(/\.(cmd|exe)$/i, "").toLowerCase();
  return `session.toolCache.${normalized}`;
}

const TOOL_PROBE_TIMEOUT_MS = 5000;

function transientRetryKey(command: string): string {
  return `${normalizeCacheKey(command)}.retryAt`;
}

function transientAttemptsKey(command: string): string {
  return `${normalizeCacheKey(command)}.transientAttempts`;
}

export async function checkToolAvailability(command: string, facts: FactStore): Promise<boolean> {
  const key = normalizeCacheKey(command);
  const cached = facts.getSessionFact<boolean>(key);
  if (cached !== undefined) {
    return cached;
  }
  const retryAt = facts.getSessionFact<number>(transientRetryKey(command));
  if (retryAt !== undefined && Date.now() < retryAt) return false;
  if (!(await isSpawnableCommand(command))) {
    facts.setSessionFact(key, false);
    return false;
  }
  try {
    const sampler = startHostStallSampler();
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
    let hostStallMs: number;
    try {
      result = await safeSpawnAsync(command, ["--version"], {
        timeout: TOOL_PROBE_TIMEOUT_MS,
      });
    } finally {
      hostStallMs = sampler.stop();
    }
    const elapsedMs = Date.now() - startedAt;
    if (result.status === 0) {
      facts.setSessionFact(key, true);
      facts.setSessionFact(transientRetryKey(command), 0);
      facts.setSessionFact(transientAttemptsKey(command), 0);
      logAvailabilityDecision({
        tool: command,
        verdict: "available",
        outcome: "success",
        cause: "ok",
        elapsedMs,
        latched: true,
        hostStallMs,
        budgetMs: TOOL_PROBE_TIMEOUT_MS,
      });
      return true;
    }
    const { outcome, cause, evidence } = classifyProbeFailure(result, {
      hostStallMs,
      unclassifiedFailureOutcome: "missing",
    });
    let retryAfterMs: number | undefined;
    if (outcome === "transient") {
      const attempts = (facts.getSessionFact<number>(transientAttemptsKey(command)) ?? 0) + 1;
      facts.setSessionFact(transientAttemptsKey(command), attempts);
      retryAfterMs = transientRetryDelayMs(attempts, cause);
      facts.setSessionFact(transientRetryKey(command), Date.now() + retryAfterMs);
    } else {
      facts.setSessionFact(key, false);
      facts.setSessionFact(transientAttemptsKey(command), 0);
    }
    logAvailabilityDecision({
      tool: command,
      verdict: "unavailable",
      outcome,
      cause,
      elapsedMs,
      latched: outcome !== "transient",
      hostStallMs,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      budgetMs: TOOL_PROBE_TIMEOUT_MS,
      classifiedBy: "probe",
      evidence,
    });
    return false;
  } catch {
    facts.setSessionFact(key, false);
    return false;
  }
}

function readFilePrefix(filePath: string, maxBytes = 4096): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function createDispatchContext(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  facts: FactStore,
  blockingOnly?: boolean,
  modifiedRanges?: import("./types.ts").ModifiedRange[],
  projectRoot?: string,
  writeIndex?: number,
  telemetryModel?: string,
  telemetryProvider?: string,
): DispatchContext {
  const absoluteFilePath = resolveRunnerPath(cwd, filePath);
  const normalizedProjectRoot = normalizeMapKey(path.resolve(projectRoot ?? cwd));
  const normalizedCwd = normalizeMapKey(resolveLanguageRootForFile(absoluteFilePath, cwd));
  const normalizedFilePath = normalizeMapKey(absoluteFilePath);
  const kind = detectFileKind(normalizedFilePath);
  const fileRole = detectFileRole(normalizedFilePath, readFilePrefix(normalizedFilePath));
  const projectConfig = loadPiLensProjectConfig(normalizedCwd);

  return {
    filePath: normalizedFilePath,
    projectRoot: normalizedProjectRoot,
    cwd: normalizedCwd,
    kind,
    fileRole,
    pi,
    autofix: false,
    deltaMode: !pi.getFlag("no-delta"),
    facts,
    projectConfig,
    blockingOnly,
    modifiedRanges,
    writeIndex,
    telemetryModel,
    telemetryProvider,

    async hasTool(command: string): Promise<boolean> {
      return checkToolAvailability(command, facts);
    },

    log(message: string): void {
      logExtension({
        subsystem: "dispatch",
        message,
        metadata: { filePath: normalizedFilePath, kind },
      });
    },
  };
}

function filterDelta<T extends { id: string }>(
  after: T[],
  before: T[] | undefined,
  keyFn: (d: T) => string,
) {
  const beforeSet = new Set((before ?? []).map(keyFn));
  const afterSet = new Set(after.map(keyFn));

  const fixed = (before ?? []).filter((d) => !afterSet.has(keyFn(d)));
  const newItems = after.filter((d) => !beforeSet.has(keyFn(d)));

  return { new: newItems, fixed };
}

function semanticRank(semantic: OutputSemantic): number {
  if (semantic === "blocking") return 4;
  if (semantic === "warning") return 3;
  if (semantic === "fixed") return 2;
  if (semantic === "silent") return 1;
  return 0;
}

function toolPriority(tool: string, defectClass: string): number {
  return getToolProfile(tool, defectClass).dedupPriority;
}

function dedupeOverlappingDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>();

  for (const d of diagnostics) {
    const defectClass = d.defectClass ?? classifyDiagnostic(d);
    const line = d.line ?? 1;
    const column = d.column ?? 1;
    const ruleKey = d.rule || d.id || "unknown";
    const key = `${d.filePath}:${line}:${column}:${defectClass}:${ruleKey}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...d, defectClass });
      continue;
    }

    const currScore =
      semanticRank(current.semantic) * 100 + toolPriority(current.tool, defectClass);
    const nextScore = semanticRank(d.semantic) * 100 + toolPriority(d.tool, defectClass);
    if (nextScore > currScore) {
      byKey.set(key, { ...d, defectClass });
    }
  }

  return [...byKey.values()];
}

function suppressLintOverlapsWithLsp(diagnostics: Diagnostic[]): Diagnostic[] {
  const lspBySpanClass = new Set<string>();
  const lspByLine = new Set<string>();
  const isLintTool = (tool: string): boolean => {
    return getToolProfile(tool).lintLike;
  };

  for (const d of diagnostics) {
    if (d.tool !== "lsp") continue;
    const line = d.line ?? 1;
    const defectClass = d.defectClass ?? classifyDiagnostic(d);
    lspBySpanClass.add(`${d.filePath}:${line}:${defectClass}`);
    lspByLine.add(`${d.filePath}:${line}`);
  }

  if (lspByLine.size === 0) return diagnostics;

  return diagnostics.filter((d) => {
    if (d.tool === "lsp") return true;
    if (!isLintTool(d.tool)) return true;
    if (d.semantic === "blocking" || d.severity === "error") return true;

    const line = d.line ?? 1;
    const defectClass = d.defectClass ?? classifyDiagnostic(d);
    const key = `${d.filePath}:${line}:${defectClass}`;
    if (lspBySpanClass.has(key)) return false;

    if (defectClass === "unknown") {
      return !lspByLine.has(`${d.filePath}:${line}`);
    }

    return true;
  });
}

export function suppressTrivyConfigDockerOverlap(diagnostics: Diagnostic[]): Diagnostic[] {
  const hadolintLines = new Set<string>();
  for (const d of diagnostics) {
    if (d.tool === "hadolint") {
      hadolintLines.add(`${d.filePath}:${d.line ?? 1}`);
    }
  }
  if (hadolintLines.size === 0) return diagnostics;
  return diagnostics.filter(
    (d) => d.tool !== "trivy-config" || !hadolintLines.has(`${d.filePath}:${d.line ?? 1}`),
  );
}

function isUnusedValueDiagnostic(d: Diagnostic): boolean {
  const raw = `${d.id ?? ""} ${d.rule ?? ""} ${d.message ?? ""}`.toLowerCase();
  if (raw.includes("no-unused")) return true;
  if (/\b(6133|6192|6196)\b/.test(raw)) return true;

  const rule = String(d.rule ?? "").toLowerCase();
  if (rule.includes("unused")) return true;

  const message = d.message.toLowerCase();
  return (
    message.includes("is declared but its value is never read") ||
    message.includes("is assigned a value but never used") ||
    message.includes("declared but never used") ||
    message.includes("unused")
  );
}

function promoteDeltaUnusedToBlockers(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => {
    if (!isUnusedValueDiagnostic(d)) return d;
    if (d.semantic === "blocking" || d.severity === "error") return d;
    return {
      ...d,
      severity: "error",
      semantic: "blocking",
      fixSuggestion:
        d.fixSuggestion ??
        "Remove the unused declaration or rename with '_' prefix if intentionally unused.",
    };
  });
}

export type RunnerResultSink = (runnerId: string, result: RunnerResult) => void;

export interface RunnerLatency {
  runnerId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: "succeeded" | "failed" | "skipped" | "when_skipped";
  diagnosticCount: number;
  semantic: string;
}

export interface DispatchLatencyReport {
  filePath: string;
  fileKind: string | undefined;
  overallStartMs: number;
  overallEndMs: number;
  totalDurationMs: number;
  runners: RunnerLatency[];
  stoppedEarly: boolean;
  totalDiagnostics: number;
  blockers: number;
  warnings: number;
}

function buildCoverageNotice(
  ctx: DispatchContext,
  runnerLatencies: RunnerLatency[],
): Diagnostic | undefined {
  if (!ctx.kind) return undefined;
  const lspEnabled = !ctx.pi.getFlag("no-lsp");
  const primary = getPrimaryDispatchGroup(ctx.kind, lspEnabled);
  if (!primary || primary.runnerIds.length === 0) return undefined;

  const relevant = runnerLatencies.filter((r) => primary.runnerIds.includes(r.runnerId));
  if (relevant.length === 0) return undefined;

  const primaryHasCoverage = relevant.some(
    (r) => r.status === "succeeded" || r.status === "failed",
  );
  if (primaryHasCoverage) return undefined;

  const allPrimarySkipped = relevant.every(
    (r) => r.status === "skipped" || r.status === "when_skipped",
  );
  if (!allPrimarySkipped) return undefined;

  const plan = getToolPlan(ctx.kind);
  const fallbackRunnerIds = new Set(
    (plan?.groups ?? [])
      .filter((group) => !group.runnerIds.every((runnerId) => primary.runnerIds.includes(runnerId)))
      .flatMap((group) => group.runnerIds)
      .filter((runnerId) => !primary.runnerIds.includes(runnerId)),
  );

  const STRUCTURAL_RUNNERS = new Set([
    "tree-sitter",
    "ast-grep-napi",
    "spellcheck",
    "fact-rules",
    "opengrep",
  ]);
  const anyLinterHasCoverage = runnerLatencies.some(
    (r) =>
      fallbackRunnerIds.has(r.runnerId) &&
      !STRUCTURAL_RUNNERS.has(r.runnerId) &&
      (r.status === "succeeded" || r.status === "failed"),
  );
  if (anyLinterHasCoverage) return undefined;

  const onceKey = `${ctx.kind}:${normalizeMapKey(ctx.filePath)}`;
  if (coverageNoticeSeen.has(onceKey)) return undefined;
  coverageNoticeSeen.add(onceKey);

  return {
    id: `coverage-unavailable:${ctx.kind}:${path.basename(ctx.filePath)}`,
    message: `Pi-lens ${ctx.kind} analysis unavailable — language tools are missing or the LSP server isn't ready yet, so this file was not fully checked (not a clean result).`,
    filePath: ctx.filePath,
    severity: "warning",
    semantic: "warning",
    tool: "choco-pi-lsp",
  };
}

const latencyReports: DispatchLatencyReport[] = [];
const coverageNoticeSeen = new Set<string>();

export function getLatencyReports(): DispatchLatencyReport[] {
  return [...latencyReports];
}

export function clearLatencyReports(): void {
  latencyReports.length = 0;
}

export function clearCoverageNoticeState(): void {
  coverageNoticeSeen.clear();
}

export function formatLatencyReport(report: DispatchLatencyReport): string {
  const lines: string[] = [];
  lines.push(`\n═══════════════════════════════════════════════════════════════`);
  lines.push(`📊 DISPATCH LATENCY REPORT: ${report.filePath.split("/").pop()}`);
  lines.push(`   Kind: ${report.fileKind || "unknown"} | Total: ${report.totalDurationMs}ms`);
  lines.push(`───────────────────────────────────────────────────────────────`);
  lines.push(`Runner                          Duration  Status    Issues  Semantic`);
  lines.push(`───────────────────────────────────────────────────────────────`);

  for (const r of report.runners) {
    const name = r.runnerId.padEnd(30);
    const dur = `${r.durationMs}ms`.padStart(8);
    const status = r.status.padStart(9);
    const issues = String(r.diagnosticCount).padStart(6);
    const sem = r.semantic.padStart(8);
    const slowMarker = r.durationMs > 500 ? " 🔥" : r.durationMs > 100 ? " ⚡" : "";
    lines.push(`${name}${dur}${status}${issues}${sem}${slowMarker}`);
  }

  lines.push(`───────────────────────────────────────────────────────────────`);
  lines.push(`Total: ${report.runners.length} runners | Stopped early: ${report.stoppedEarly}`);
  lines.push(
    `Diagnostics: ${report.totalDiagnostics} (${report.blockers} blockers, ${report.warnings} warnings)`,
  );

  const sorted = [...report.runners].sort((a, b) => b.durationMs - a.durationMs);
  if (sorted.length > 0 && sorted[0].durationMs > 100) {
    lines.push(`\n🐌 Slowest runners:`);
    for (const r of sorted.slice(0, 3)) {
      if (r.durationMs > 50) {
        lines.push(`   ${r.runnerId}: ${r.durationMs}ms (${r.status})`);
      }
    }
  }

  lines.push(`═══════════════════════════════════════════════════════════════`);
  return lines.join("\n");
}

interface GroupResult {
  diagnostics: Diagnostic[];
  latencies: RunnerLatency[];
  hadBlocker: boolean;
}

async function runGroup(
  ctx: DispatchContext,
  group: RunnerGroup,
  registry: RunnerRegistryContract,
  onRunnerResult?: RunnerResultSink,
): Promise<GroupResult> {
  const diagnostics: Diagnostic[] = [];
  const latencies: RunnerLatency[] = [];
  let hadBlocker = false;

  const runnerIds = group.filterKinds
    ? group.runnerIds.filter((id) => {
        const runner = registry.get(id);
        return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
      })
    : group.runnerIds;

  const semantic = group.semantic ?? "warning";

  for (const runnerId of runnerIds) {
    const runnerStart = Date.now();
    const runner = registry.get(runnerId);

    if (!runner) {
      latencies.push({
        runnerId,
        startTime: runnerStart,
        endTime: Date.now(),
        durationMs: 0,
        status: "skipped",
        diagnosticCount: 0,
        semantic: "unknown",
      });
      logLatency({
        type: "runner",
        filePath: ctx.filePath,
        runnerId,
        durationMs: 0,
        status: "not_registered",
        diagnosticCount: 0,
        semantic: "unknown",
      });
      continue;
    }

    let shouldRun = true;
    if (runner.when) {
      try {
        shouldRun = await runner.when(ctx);
      } catch (error) {
        ctx.log(`Runner ${runner.id} precondition failed: ${error}`);
        shouldRun = false;
      }
    }
    if (!shouldRun) {
      latencies.push({
        runnerId,
        startTime: runnerStart,
        endTime: Date.now(),
        durationMs: Date.now() - runnerStart,
        status: "when_skipped",
        diagnosticCount: 0,
        semantic: runner.id,
      });
      logLatency({
        type: "runner",
        filePath: ctx.filePath,
        runnerId,
        durationMs: 0,
        status: "when_skipped",
        diagnosticCount: 0,
        semantic: "when_condition",
      });
      continue;
    }

    const result = await runRunner(ctx, runner, semantic);
    onRunnerResult?.(runnerId, result);
    const runnerEnd = Date.now();
    const duration = runnerEnd - runnerStart;

    latencies.push({
      runnerId,
      startTime: runnerStart,
      endTime: runnerEnd,
      durationMs: duration,
      status: result.status,
      diagnosticCount: result.diagnostics.length,
      semantic: result.semantic ?? semantic,
    });
    logLatency({
      type: "runner",
      filePath: ctx.filePath,
      runnerId,
      startedAt: new Date(runnerStart).toISOString(),
      durationMs: duration,
      status: result.status,
      diagnosticCount: result.diagnostics.length,
      semantic: result.semantic ?? semantic,
      diagnostics:
        result.diagnostics.length > 0
          ? result.diagnostics.map((d) => ({
              rule: d.rule,
              message: d.message.slice(0, 120),
              line: d.line,
              semantic: d.semantic,
            }))
          : undefined,
      metadata:
        result.status === "failed" && result.failureKind
          ? {
              failureKind: result.failureKind,
              failureMessage: result.failureMessage,
            }
          : undefined,
    });
    recordRunner(
      ctx.filePath,
      runnerId,
      result.status,
      result.diagnostics.length,
      duration,
      ctx.writeIndex,
    );

    diagnostics.push(...result.diagnostics);

    const resultSemantic = result.semantic ?? semantic;
    if (
      (resultSemantic === "blocking" && result.diagnostics.length > 0) ||
      result.diagnostics.some((d) => d.semantic === "blocking")
    ) {
      hadBlocker = true;
    }

    if (group.mode === "fallback" && result.status === "succeeded") {
      break;
    }
  }

  return { diagnostics, latencies, hadBlocker };
}

export async function dispatchForFile(
  ctx: DispatchContext,
  groups: RunnerGroup[],
  registry: RunnerRegistryContract,
  onRunnerResult?: RunnerResultSink,
): Promise<DispatchResult> {
  const _overallStart = Date.now();
  if (ctx.fileRole === "generated") {
    return {
      diagnostics: [],
      blockers: [],
      warnings: [],
      baselineWarningCount: 0,
      fixed: [],
      resolvedCount: 0,
      output: "",
      blockerOutput: "",
      hasBlockers: false,
    };
  }
  const allDiagnostics: Diagnostic[] = [];
  let stopped = false;
  const runnerLatencies: RunnerLatency[] = [];

  const allRunnerIds = groups.flatMap((g) => g.runnerIds);
  logLatency({
    type: "phase",
    filePath: ctx.filePath,
    phase: "dispatch_start",
    durationMs: 0,
    metadata: {
      groupCount: groups.length,
      kind: ctx.kind,
      runners: allRunnerIds.join(","),
    },
  });

  const groupResults = await Promise.all(
    groups.map((group) => runGroup(ctx, group, registry, onRunnerResult)),
  );

  const relativeKey = path.relative(ctx.cwd, ctx.filePath).replace(/\\/g, "/");
  const baselineAbsKey = `session.baseline.${normalizeMapKey(ctx.filePath)}`;
  const baselineRelKey = `session.baseline.${normalizeMapKey(relativeKey)}`;
  const previousBaseline = ctx.deltaMode
    ? (ctx.facts.getSessionFact<Diagnostic[]>(baselineAbsKey) ??
      ctx.facts.getSessionFact<Diagnostic[]>(baselineRelKey))
    : undefined;
  const baselineWarnings = previousBaseline?.filter(
    (d) => d.semantic === "warning" || d.semantic === "none",
  );
  const baselineWarningCount = baselineWarnings?.length ?? 0;

  for (const { diagnostics: groupDiags, latencies, hadBlocker } of groupResults) {
    runnerLatencies.push(...latencies);

    allDiagnostics.push(...groupDiags);
    if (hadBlocker) stopped = true;
  }

  const dedupedDiagnostics = dedupeOverlappingDiagnostics(allDiagnostics);
  const fileContent = ctx.facts.getFileFact<string>(ctx.filePath, "file.content") ?? "";
  const rulePolicy = rulePolicyMapFromConfig(
    loadPiLensProjectConfig(ctx.projectRoot ?? ctx.cwd).rules,
  );
  const applyOutputFilters = (diags: Diagnostic[]): Diagnostic[] => {
    const dockerOverlap = suppressTrivyConfigDockerOverlap(diags);
    const overlap = suppressLintOverlapsWithLsp(dockerOverlap);
    const inline = applyInlineSuppressions(overlap, fileContent);
    const disposition = applyDispositions(
      inline,
      ctx.projectRoot ?? ctx.cwd,
      ctx.filePath,
      fileContent,
    );
    return applyRulePolicy(disposition, rulePolicy);
  };
  let visibleDiagnostics = applyOutputFilters(dedupedDiagnostics);
  let resolvedCount = 0;
  if (ctx.deltaMode && previousBaseline) {
    const filtered = filterDelta(
      visibleDiagnostics,
      applyOutputFilters(previousBaseline),
      (d) => d.id,
    );
    visibleDiagnostics = promoteDeltaUnusedToBlockers(filtered.new);
    resolvedCount = filtered.fixed.length;
  }

  if (ctx.deltaMode) {
    ctx.facts.setSessionFact(baselineAbsKey, [...dedupedDiagnostics]);
    ctx.facts.setSessionFact(baselineRelKey, [...dedupedDiagnostics]);
  }

  const blockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");
  const warnings = visibleDiagnostics.filter(
    (d) => d.semantic === "warning" || d.semantic === "none",
  );
  const fixedItems = visibleDiagnostics.filter((d) => d.semantic === "fixed");

  const worklogIdentity = {
    model: ctx.telemetryModel,
    provider: ctx.telemetryProvider,
  };
  if (fixedItems.length > 0) {
    import("../fix-worklog.ts")
      .then(({ appendToWorklog }) => {
        appendToWorklog(ctx.cwd, fixedItems, true, worklogIdentity);
      })
      .catch(() => {});
  }
  const fixableWarnings = warnings.filter((d) => d.fixable);
  if (fixableWarnings.length > 0) {
    import("../fix-worklog.ts")
      .then(({ appendToWorklog }) => {
        appendToWorklog(ctx.cwd, fixableWarnings, false, worklogIdentity);
      })
      .catch(() => {});
  }

  const inlineBlockers = blockers;
  const inlineFixed = fixedItems;
  const coverageNotice = buildCoverageNotice(ctx, runnerLatencies);

  const blockerOutput = formatDiagnostics(inlineBlockers, "blocking");
  let output = blockerOutput;
  output += formatDiagnostics(inlineFixed, "fixed");
  if (coverageNotice) {
    output += formatDiagnostics([coverageNotice], "warning", 1);
    warnings.push(coverageNotice);
  }

  const overallEnd = Date.now();
  const latencyReport: DispatchLatencyReport = {
    filePath: ctx.filePath,
    fileKind: ctx.kind,
    overallStartMs: _overallStart,
    overallEndMs: overallEnd,
    totalDurationMs: overallEnd - _overallStart,
    runners: runnerLatencies,
    stoppedEarly: stopped,
    totalDiagnostics: visibleDiagnostics.length,
    blockers: blockers.length,
    warnings: warnings.length,
  };

  latencyReports.push(latencyReport);

  if (latencyReports.length > 100) {
    latencyReports.shift();
  }

  const sumMs = runnerLatencies.reduce((s, r) => s + r.durationMs, 0);
  const wallClockMs = latencyReport.totalDurationMs;
  logLatency({
    type: "tool_result",
    filePath: ctx.filePath,
    durationMs: wallClockMs,
    wallClockMs,
    sumMs,
    parallelGainMs: Math.max(0, sumMs - wallClockMs),
    result: "dispatch_complete",
    metadata: {
      runners: runnerLatencies.map((r) => ({
        id: r.runnerId,
        startedAt: new Date(r.startTime).toISOString(),
        duration: r.durationMs,
        status: r.status,
      })),
      totalDiagnostics: visibleDiagnostics.length,
      blockers: blockers.length,
    },
  });

  return {
    diagnostics: visibleDiagnostics,
    blockers,
    warnings,
    baselineWarningCount,
    fixed: fixedItems,
    resolvedCount,
    output,
    blockerOutput,
    hasBlockers: blockers.length > 0,
  };
}

const RUNNER_TIMEOUT_MS = RUNTIME_CONFIG.dispatch.runnerTimeoutMs;

function looksLikeDiagnosticCodePath(value: string): boolean {
  if (!value) return false;
  const text = value.trim();
  if (!text) return false;
  const base = path.basename(text.replace(/\\/g, "/"));
  if (/^lsp:\d+(?::\d+)?$/i.test(text) || /^lsp:\d+(?::\d+)?$/i.test(base)) {
    return true;
  }
  if (/^similarity[-:]/i.test(text) || /^similarity[-:]/i.test(base)) {
    return true;
  }
  if (/^[a-z-]+:\d+(?::\d+)?$/i.test(text) || /^[a-z-]+:\d+(?::\d+)?$/i.test(base)) {
    return true;
  }
  return false;
}

function normalizeDiagnosticFilePath(ctx: DispatchContext, rawPath?: string): string {
  if (rawPath !== undefined && looksLikeDiagnosticCodePath(rawPath)) {
    ctx.log(
      `runner path normalization: ignored diagnostic code-like path '${rawPath}', using current file`,
    );
    return resolveRunnerPath(ctx.cwd, ctx.filePath);
  }

  return resolveRunnerPath(ctx.cwd, rawPath || ctx.filePath);
}

async function runRunner(
  ctx: DispatchContext,
  runner: RunnerDefinition,
  defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
  const timeoutMs = Math.max(runner.timeoutMs ?? RUNNER_TIMEOUT_MS, getRunnerTimeoutFloorMs());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner.run(ctx).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Runner ${runner.id} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    const diagnostics = result.diagnostics.map((d) => ({
      ...d,
      filePath: normalizeDiagnosticFilePath(ctx, d.filePath),
    }));

    return {
      ...result,
      diagnostics,
      semantic: result.semantic ?? defaultSemantic,
    };
  } catch (error) {
    clearTimeout(timer);
    ctx.log(`Runner ${runner.id} failed: ${error}`);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      diagnostics: [],
      semantic: defaultSemantic,
      failureKind: message.includes("timed out") ? "timeout" : "exception",
      failureMessage: message.slice(0, 200),
    };
  }
}

export async function dispatchLint(
  filePath: string,
  cwd: string,
  pi: PiAgentAPI,
  facts: FactStore,
  registry: RunnerRegistryContract,
): Promise<string> {
  const ctx = createDispatchContext(filePath, cwd, pi, facts, true);

  if (!ctx.kind) return "";
  const runners = registry.getForKind(ctx.kind, ctx.filePath);
  if (runners.length === 0) {
    return "";
  }

  const groups: RunnerGroup[] = [
    {
      mode: "fallback",
      runnerIds: runners.map((r) => r.id),
    },
  ];

  const result = await dispatchForFile(ctx, groups, registry);
  return result.output;
}
