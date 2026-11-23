import { isFiniteNumber } from "./runtime-guards.ts";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { demotePastEofDiagnostics, type LineCountCache } from "./diagnostic-line-freshness.ts";
import { visibleWidth } from "./deps/pi-tui.ts";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.ts";
import { fitLine } from "./tui-fit.ts";
import { WriteOrderingGuard } from "./write-ordering-guard.ts";
import { collectForwardImportMtimes, MTIME_DRIFT_TOLERANCE_MS } from "./blocker-freshness.ts";
import { PAST_EOF_STALE_MARKER } from "./diagnostic-line-freshness.ts";
import { STALE_LINE_MARKER } from "./stale-marker.ts";

type CountDiagnosticsResultContract = {
  blocking: number;
  errors: number;
  warnings: number;
};

function fileMapKey(filePath: string): string {
  return normalizeEphemeralMapKey(filePath);
}

export interface WidgetDiagnostic {
  severity: string;
  semantic?: string;
  message: string;
  line?: number;
  col?: number;
  rule?: string;
  tool?: string;
  uri?: string;
  flagged?: boolean;
  observedAt?: number;
  stale?: boolean;
  staleReason?: string;
}

export function isBlocking(d: WidgetDiagnostic): boolean {
  if (d.stale) return false;
  if (d.semantic === "blocking") return true;
  if (d.semantic == null && d.severity === "error") return true;
  return false;
}

interface FileRecord {
  filePath: string;
  runners: Map<string, { status: string; count: number; durationMs?: number }>;
  formatters: Map<string, { changed: boolean; success: boolean }>;
  diagnostics: WidgetDiagnostic[];
  allDiagnostics: WidgetDiagnostic[];
  diagnosticCounts: {
    blocking: number;
    errors: number;
    warnings: number;
  };
  hasFinalDiagnosticsSnapshot: boolean;
  touchedAt: number;
}

interface LspRecord {
  serverId: string;
  root: string;
  status: "spawning" | "ready" | "failed";
  durationMs?: number;
}

const files = new Map<string, FileRecord>();
const lspServers = new Map<string, LspRecord>();
let sessionLanguages: string[] = [];
let requestRenderFn: (() => void) | null = null;

const diagnosticsWriteGuard = new WriteOrderingGuard<string, number>();
const runnerWriteGuard = new WriteOrderingGuard<string, number>();

const MAX_STORED_DIAGNOSTICS_PER_FILE = 12;
const MAX_INACTIVE_FILE_RECORDS = 1024;
const ACTIVE_FILE_IDLE_MS = 30 * 60_000;
const MAX_LSP_SERVER_RECORDS = 128;
let nextInactivePruneSize = MAX_INACTIVE_FILE_RECORDS + 1;

function pruneInactiveFileRecords(now = Date.now()): void {
  if (files.size <= MAX_INACTIVE_FILE_RECORDS) return;
  const victims = [...files.entries()]
    .filter(([, rec]) => now - rec.touchedAt > ACTIVE_FILE_IDLE_MS && !hasLiveDiagnostic(rec))
    .sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
  for (const [key] of victims) {
    if (files.size <= MAX_INACTIVE_FILE_RECORDS) break;
    files.delete(key);
  }
}

function maybePruneInactiveFileRecords(): void {
  if (files.size < nextInactivePruneSize) return;
  pruneInactiveFileRecords();
  nextInactivePruneSize = Number.POSITIVE_INFINITY;
}

export function setRenderCallback(fn: () => void): void {
  requestRenderFn = fn;
}

export function clearWidgetState(): void {
  files.clear();
  lspServers.clear();
  sessionLanguages = [];
  requestRenderFn = null;
  diagnosticsWriteGuard.clear();
  runnerWriteGuard.clear();
  nextInactivePruneSize = MAX_INACTIVE_FILE_RECORDS + 1;
}

export const WIDGET_STATE_VERSION = 3;

export interface PersistedWidgetState {
  version: number;
  sessionLanguages: string[];
  files: Array<{
    filePath: string;
    runners: Array<[string, { status: string; count: number; durationMs?: number }]>;
    formatters: Array<[string, { changed: boolean; success: boolean }]>;
    diagnostics: WidgetDiagnostic[];
    allDiagnostics: WidgetDiagnostic[];
    diagnosticCounts: { blocking: number; errors: number; warnings: number };
    hasFinalDiagnosticsSnapshot: boolean;
    touchedAt: number;
  }>;
}

export function exportWidgetState(): PersistedWidgetState {
  return {
    version: WIDGET_STATE_VERSION,
    sessionLanguages: [...sessionLanguages],
    files: [...files.values()].map((rec) => ({
      filePath: rec.filePath,
      runners: [...rec.runners.entries()],
      formatters: [...rec.formatters.entries()],
      diagnostics: rec.diagnostics,
      allDiagnostics: rec.allDiagnostics,
      diagnosticCounts: rec.diagnosticCounts,
      hasFinalDiagnosticsSnapshot: rec.hasFinalDiagnosticsSnapshot,
      touchedAt: rec.touchedAt,
    })),
  };
}

function migrateEntryStamps(
  entries: WidgetDiagnostic[] | undefined,
  recordTouchedAt: number,
): WidgetDiagnostic[] {
  return (entries ?? []).map((d) => {
    const { stale: _stale, ...rest } = d;
    return rest.observedAt == null ? { ...rest, observedAt: recordTouchedAt } : rest;
  });
}

export function importWidgetState(state: PersistedWidgetState | undefined): boolean {
  if (
    !state ||
    !isFiniteNumber(state.version) ||
    state.version < 1 ||
    state.version > WIDGET_STATE_VERSION
  ) {
    return false;
  }
  files.clear();
  diagnosticsWriteGuard.clear();
  runnerWriteGuard.clear();
  for (const f of state.files ?? []) {
    const recordTouchedAt = f.touchedAt ?? Date.now();
    const migratedAllDiagnostics = migrateEntryStamps(f.allDiagnostics, recordTouchedAt);
    files.set(fileMapKey(f.filePath), {
      filePath: f.filePath,
      runners: new Map(f.runners ?? []),
      formatters: new Map((f.formatters ?? []).filter(([, outcome]) => outcome?.success !== false)),
      diagnostics: migrateEntryStamps(f.diagnostics, recordTouchedAt),
      allDiagnostics: migratedAllDiagnostics,
      diagnosticCounts: countDiagnostics(migratedAllDiagnostics),
      hasFinalDiagnosticsSnapshot: f.hasFinalDiagnosticsSnapshot ?? false,
      touchedAt: recordTouchedAt,
    });
  }
  pruneInactiveFileRecords();
  sessionLanguages = state.sessionLanguages ?? [];
  requestRenderFn?.();
  return true;
}

export function setSessionLanguages(langs: string[]): void {
  sessionLanguages = langs;
  requestRender();
}

export function getSessionLanguages(): string[] {
  return [...sessionLanguages];
}

export function getFailedLspServerIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rec of lspServers.values()) {
    if (rec.status !== "failed" || seen.has(rec.serverId)) continue;
    seen.add(rec.serverId);
    ids.push(rec.serverId);
  }
  return ids;
}

export function recordFormatter(
  filePath: string,
  formatter: string,
  changed: boolean,
  success: boolean,
): void {
  const rec = getOrCreate(filePath);
  rec.formatters.set(formatter, { changed, success });
  rec.touchedAt = Date.now();
  files.set(fileMapKey(filePath), rec);
  requestRender();
}

export function recordRunner(
  filePath: string,
  runnerId: string,
  status: string,
  diagnosticCount: number,
  durationMs?: number,
  writeIndex?: number,
): void {
  const key = fileMapKey(filePath);
  if (!runnerWriteGuard.shouldWrite(key, writeIndex)) return;
  diagnosticsWriteGuard.shouldWrite(key, writeIndex);
  const rec = getOrCreate(filePath);
  rec.runners.set(runnerId, { status, count: diagnosticCount, durationMs });
  rec.hasFinalDiagnosticsSnapshot = false;
  rec.touchedAt = Date.now();
  files.set(fileMapKey(filePath), rec);
  requestRender();
}

function toSingleLineMessage(message: string | undefined): string {
  return (message ?? "").replace(/\s+/g, " ").trim();
}

export function recordDiagnostics(
  filePath: string,
  diagnostics: Array<{
    tool?: string;
    rule?: string;
    id?: string;
    message?: string;
    line?: number;
    column?: number;
    severity?: string;
    semantic?: string;
  }>,
  writeIndex?: number,
  observedAt?: number,
): void {
  const key = fileMapKey(filePath);
  if (!diagnosticsWriteGuard.shouldWrite(key, writeIndex)) return;
  runnerWriteGuard.shouldWrite(key, writeIndex);

  const observedTs = observedAt ?? Date.now();
  const rec = getOrCreate(filePath, key);
  commitDiagnostics(
    rec,
    filePath,
    normalizeDiagnostics(filePath, diagnostics, observedTs),
    observedTs,
    key,
  );
}

function normalizeDiagnostics(
  filePath: string,
  diagnostics: Array<{
    tool?: string;
    rule?: string;
    id?: string;
    message?: string;
    line?: number;
    column?: number;
    severity?: string;
    semantic?: string;
  }>,
  observedTs: number,
): WidgetDiagnostic[] {
  const base = pathToFileURL(filePath).href;
  return diagnostics.map((d) => {
    const rule = d.rule ?? d.id;
    const uri =
      d.line != null ? `${base}#L${d.line}${d.column != null ? `:${d.column}` : ""}` : base;
    return {
      severity: d.severity ?? "info",
      semantic: d.semantic,
      message: toSingleLineMessage(d.message),
      line: d.line,
      col: d.column,
      rule,
      tool: d.tool,
      uri,
      observedAt: observedTs,
    } satisfies WidgetDiagnostic;
  });
}

function commitDiagnostics(
  rec: FileRecord,
  filePath: string,
  normalized: WidgetDiagnostic[],
  observedAt: number | undefined,
  key = fileMapKey(filePath),
): void {
  rec.diagnosticCounts = countDiagnostics(normalized);
  rec.diagnostics = capStoredDiagnostics(normalized);
  rec.allDiagnostics = normalized;
  rec.hasFinalDiagnosticsSnapshot = true;
  rec.touchedAt = freshestObservation(normalized, observedAt ?? Date.now());
  files.set(key, rec);
  requestRender();
}

function countDiagnostics(diags: WidgetDiagnostic[]): CountDiagnosticsResultContract {
  let blocking = 0;
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diags) {
    if (isBlocking(diagnostic)) blocking++;
    if (diagnostic.stale && (diagnostic.staleReason ?? "past-eof") === "past-eof") continue;
    if (diagnostic.severity === "error") errors++;
    else if (
      diagnostic.severity === "warning" ||
      diagnostic.severity === "hint" ||
      diagnostic.severity === "info"
    )
      warnings++;
  }

  return { blocking, errors, warnings };
}

function applyPastEofGate(rec: FileRecord, lineCountCache?: LineCountCache): void {
  if (rec.allDiagnostics.length === 0) return;
  const { diagnostics } = demotePastEofDiagnostics({
    store: "widget-state",
    cwd: process.cwd(),
    filePath: rec.filePath,
    diagnostics: rec.allDiagnostics,
    lineCountCache,
  });
  rec.allDiagnostics = diagnostics;
  rec.diagnostics = capStoredDiagnostics(diagnostics);
  rec.diagnosticCounts = countDiagnostics(diagnostics);
}

function freshestObservation(diags: WidgetDiagnostic[], fallback: number): number {
  let newest: number | undefined;
  for (const d of diags) {
    if (d.observedAt != null && (newest === undefined || d.observedAt > newest)) {
      newest = d.observedAt;
    }
  }
  return newest ?? fallback;
}

function isLspErrorEntry(d: WidgetDiagnostic): boolean {
  return d.tool === "lsp" && (d.semantic === "blocking" || d.severity === "error");
}

export function reconcileCascadeNeighborLspErrors(
  filePath: string,
  lspErrorDiagnostics: Array<{
    tool?: string;
    rule?: string;
    id?: string;
    message?: string;
    line?: number;
    column?: number;
    severity?: string;
    semantic?: string;
  }>,
  writeIndex?: number,
  observedAt?: number,
): void {
  const key = fileMapKey(filePath);
  if (!diagnosticsWriteGuard.shouldWrite(key, writeIndex)) return;
  runnerWriteGuard.shouldWrite(key, writeIndex);
  const observedTs = observedAt ?? Date.now();
  const rec = getOrCreate(filePath);
  const incoming = normalizeDiagnostics(filePath, lspErrorDiagnostics, observedTs);
  const preserved = rec.allDiagnostics.filter((d) => !isLspErrorEntry(d));
  commitDiagnostics(rec, filePath, [...incoming, ...preserved], observedTs);
}

export function reconcileScanDiagnostics(
  filePath: string,
  diagnostics: Array<{
    tool?: string;
    rule?: string;
    id?: string;
    message?: string;
    line?: number;
    column?: number;
    severity?: string;
    semantic?: string;
  }>,
  confirmed: boolean,
  writeIndex?: number,
  observedAt?: number,
): void {
  if (!confirmed) return;
  recordDiagnostics(filePath, diagnostics, writeIndex, observedAt);
}

export async function reconcileStaleWidgetFiles(): Promise<number> {
  const entries = [...files.entries()];
  const verdicts = await Promise.all(
    entries.map(async ([mapKey, rec]) => {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(rec.filePath)).mtimeMs;
      } catch {
        return { mapKey, action: "drop" as const };
      }
      if (rec.allDiagnostics.length === 0) {
        return mtimeMs > rec.touchedAt + MTIME_DRIFT_TOLERANCE_MS
          ? { mapKey, action: "drop" as const }
          : { mapKey, action: "keep" as const };
      }
      const survivors = rec.allDiagnostics.filter(
        (d) => !(mtimeMs > (d.observedAt ?? rec.touchedAt) + MTIME_DRIFT_TOLERANCE_MS),
      );
      if (survivors.length === rec.allDiagnostics.length) {
        return { mapKey, action: "keep" as const };
      }
      if (survivors.length === 0) {
        return { mapKey, action: "drop" as const };
      }
      return { mapKey, action: "prune" as const, survivors };
    }),
  );
  let dropped = 0;
  for (const v of verdicts) {
    if (v.action === "keep") continue;
    if (v.action === "drop") {
      files.delete(v.mapKey);
      dropped += 1;
      continue;
    }
    const rec = files.get(v.mapKey);
    if (rec) {
      rec.allDiagnostics = v.survivors;
      rec.diagnostics = capStoredDiagnostics(v.survivors);
      rec.diagnosticCounts = countDiagnostics(v.survivors);
    }
    dropped += 1;
  }
  if (dropped > 0) requestRenderFn?.();
  return dropped;
}

export interface WidgetDependencyBlockerReconcileResult {
  demoted: number;
  truncatedImports: number;
}

export async function reconcileStaleWidgetDependencyBlockers(
  cwd: string,
  turnIndex?: number,
): Promise<WidgetDependencyBlockerReconcileResult> {
  let demoted = 0;
  let truncatedImports = 0;
  for (const [, rec] of files.entries()) {
    if (!rec.allDiagnostics.some((d) => isBlocking(d) && d.tool === "lsp")) continue;
    let importMtimes: Array<{ path: string; mtimeMs: number }> = [];
    try {
      const result = await collectForwardImportMtimes(cwd, rec.filePath, undefined, turnIndex);
      importMtimes = result.mtimes;
      if (result.truncated) truncatedImports += 1;
    } catch {
      importMtimes = [];
    }
    if (importMtimes.length === 0) continue;
    let changed = false;
    for (const d of rec.allDiagnostics) {
      if (!isBlocking(d) || d.tool !== "lsp") continue;
      const baseline = d.observedAt ?? rec.touchedAt;
      if (importMtimes.some((im) => im.mtimeMs > baseline + MTIME_DRIFT_TOLERANCE_MS)) {
        d.stale = true;
        d.staleReason = "dependency-drift";
        changed = true;
        demoted += 1;
      }
    }
    if (changed) {
      rec.diagnosticCounts = countDiagnostics(rec.allDiagnostics);
      rec.diagnostics = capStoredDiagnostics(rec.allDiagnostics);
    }
  }
  if (demoted > 0) requestRenderFn?.();
  return { demoted, truncatedImports };
}

let staleReconcileTimer: ReturnType<typeof setTimeout> | null = null;
export const STALE_RECONCILE_DEBOUNCE_MS = 1500;
export function scheduleStaleReconcile(): void {
  if (staleReconcileTimer !== null) return;
  staleReconcileTimer = setTimeout(() => {
    staleReconcileTimer = null;
    void reconcileStaleWidgetFiles().catch(() => {});
  }, STALE_RECONCILE_DEBOUNCE_MS);
  staleReconcileTimer?.unref?.();
}

export interface FileDiagnosticSummary {
  filePath: string;
  blocking: number;
  errors: number;
  warnings: number;
  hasFinalSnapshot: boolean;
  diagnostics: WidgetDiagnostic[];
}

export function getFileDiagnosticSummaries(): FileDiagnosticSummary[] {
  return [...files.values()].map((rec) => {
    applyPastEofGate(rec);
    return {
      filePath: rec.filePath,
      blocking: rec.diagnosticCounts.blocking,
      errors: rec.diagnosticCounts.errors,
      warnings: rec.diagnosticCounts.warnings,
      hasFinalSnapshot: rec.hasFinalDiagnosticsSnapshot,
      diagnostics: rec.allDiagnostics.map((d) => ({ ...d })),
    };
  });
}

export function getFileDiagnostics(filePath: string): WidgetDiagnostic[] | undefined {
  const rec = files.get(fileMapKey(filePath));
  if (!rec) return undefined;
  applyPastEofGate(rec);
  return rec.allDiagnostics.map((d) => ({ ...d }));
}

export const __testing = {
  getWidgetStateSnapshot() {
    return {
      files: [...files.values()].map((rec) => ({
        filePath: rec.filePath,
        storedDiagnostics: rec.diagnostics.length,
        blocking: rec.diagnosticCounts.blocking,
        errors: rec.diagnosticCounts.errors,
        warnings: rec.diagnosticCounts.warnings,
      })),
    };
  },
};

export function recordLsp(
  serverId: string,
  root: string,
  status: "spawn_start" | "spawn_success" | "spawn_failed" | "unavailable",
  durationMs?: number,
): void {
  const normalizedRoot = normalizeMapKey(root);
  const key = `${serverId}@${normalizedRoot}`;
  const mapped =
    status === "spawn_start" ? "spawning" : status === "spawn_success" ? "ready" : "failed";
  lspServers.set(key, { serverId, root, status: mapped, durationMs });
  while (lspServers.size > MAX_LSP_SERVER_RECORDS) {
    const oldest = lspServers.keys().next().value;
    if (oldest === undefined) break;
    lspServers.delete(oldest);
  }
  requestRender();
}

const HORIZONTAL_MIN_WIDTH = 70;

export function renderWidget(
  width: number,
  theme: {
    fg: (color: string, s: string) => string;
  },
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const red = (s: string) => theme.fg("error", s);
  const yellow = (s: string) => theme.fg("warning", s);
  const green = (s: string) => theme.fg("success", s);
  const cyan = (s: string) => theme.fg("accent", s);
  const w = Math.max(1, width || 80);
  const useHorizontal = w >= HORIZONTAL_MIN_WIDTH;

  if (files.size === 0 && lspServers.size === 0) return [];

  const lines: string[] = [];

  const deduped = dedupeByBasename([...files.values()]);
  const recencySorted = deduped.filter(shouldRenderFile).slice(0, 5);
  const langStr = sessionLanguages.slice(0, 6).join(" ");
  const totalBlocking = countBlockingIn(deduped);
  const totalErrors = countTotalIn("error", deduped);
  const totalWarnings = countTotalIn("warning", deduped);
  const hasPendingAnalysis = deduped.some(isPendingAnalysis);
  const errorChunk = totalErrors > 0 ? (totalBlocking > 0 ? red : yellow)(`●${totalErrors}E`) : "";
  const warningChunk = totalWarnings > 0 ? yellow(`!${totalWarnings}W`) : "";
  const summary = errorChunk
    ? errorChunk + (warningChunk ? " " + warningChunk : "")
    : warningChunk
      ? warningChunk
      : files.size > 0 && !hasPendingAnalysis
        ? green("✓ clean")
        : "";

  const spawning = [...lspServers.values()].filter((s) => s.status === "spawning");
  const lspChip = useHorizontal && spawning.length > 0 ? "  " + dim("LSP↑") : "";

  const header = ` ${cyan("choco-pi-lsp")}${langStr ? "  " + dim(langStr) : ""}${lspChip}${summary ? "  " + summary : ""}`;
  lines.push(fitLine(header, w));

  if (useHorizontal) {
    const displayOrder = sortByTierThenRecency(recencySorted);
    const rowLine = packHorizontalRow(displayOrder, w, theme);
    if (rowLine.length > 0) lines.push(rowLine);
  } else {
    for (const rec of recencySorted) {
      lines.push(fitLine(formatFileRowVertical(rec, theme), w));
    }
  }

  const isBlockingOrDemoted = (d: WidgetDiagnostic) => isBlocking(d) || d.stale === true;
  const withBlocking = recencySorted.filter((r) => r.diagnostics.some(isBlockingOrDemoted));
  if (withBlocking.length > 0) {
    const rec = withBlocking[0];
    applyPastEofGate(rec);
    if (!useHorizontal) {
      lines.push(fitLine(dim("─".repeat(Math.min(w, 60))), w));
      lines.push(fitLine(` ${dim(path.basename(rec.filePath))}`, w));
    }
    const blockers = rec.diagnostics.filter(isBlockingOrDemoted).slice(0, 5);
    for (const d of blockers) {
      const pastEof = d.stale && (d.staleReason ?? "past-eof") === "past-eof";
      const loc = pastEof
        ? PAST_EOF_STALE_MARKER
        : d.line != null
          ? osc8(d.uri ?? "", `L${d.line}`)
          : "";
      const rule = d.rule ? dim(` ${d.rule}`) : "";
      const staleTag = d.stale ? dim(` ${STALE_LINE_MARKER}`) : "";
      const prefix = `   ${d.stale ? dim("○") : red("●")} ${loc}${rule}  `;
      const msgWidth = Math.max(1, w - visibleWidth(prefix) - visibleWidth(staleTag));
      const msg = fitLine(d.message, msgWidth, "…");
      lines.push(fitLine(`${prefix}${msg}${staleTag}`, w));
    }
  }

  if (!useHorizontal && spawning.length > 0) {
    const ids = spawning.map((s) => s.serverId).join(" ");
    lines.push(fitLine(` ${dim(`LSP spawning: ${ids}`)}`, w));
  }

  return lines;
}

type FileTier = "blocking" | "warning" | "clean";

function classifyFileTier(rec: FileRecord): FileTier {
  if (rec.diagnosticCounts.blocking > 0) return "blocking";
  if (rec.diagnosticCounts.errors > 0 || rec.diagnosticCounts.warnings > 0) {
    return "warning";
  }
  return "clean";
}

function sortByTierThenRecency(recs: FileRecord[]): FileRecord[] {
  interface OrderValues extends Record<FileTier, number> {}
  const order: OrderValues = {
    blocking: 0,
    warning: 1,
    clean: 2,
  };
  return [...recs].sort((a, b) => {
    const ta = order[classifyFileTier(a)];
    const tb = order[classifyFileTier(b)];
    if (ta !== tb) return ta - tb;
    return b.touchedAt - a.touchedAt;
  });
}

function formatFileRowVertical(
  rec: FileRecord,
  theme: { fg: (color: string, s: string) => string },
): string {
  const dim = (s: string) => theme.fg("dim", s);
  const red = (s: string) => theme.fg("error", s);
  const yellow = (s: string) => theme.fg("warning", s);
  const green = (s: string) => theme.fg("success", s);

  const base = path.basename(rec.filePath);
  const blocking = rec.diagnosticCounts.blocking;
  const errors = rec.diagnosticCounts.errors;
  const warnings = rec.diagnosticCounts.warnings;
  const formatterFailed = hasFailedFormatter(rec);
  const dot =
    blocking > 0
      ? red("●")
      : formatterFailed
        ? red("x")
        : warnings > 0 || errors > 0
          ? yellow("!")
          : green("✓");
  const runnerNames = [...rec.runners.entries()]
    .filter(([, r]) => r.status !== "skipped")
    .map(([id]) => id)
    .join(" ");
  const counts =
    errors > 0
      ? " " +
        (blocking > 0 ? red : yellow)(`${errors}E`) +
        (warnings > 0 ? " " + yellow(`${warnings}W`) : "")
      : warnings > 0
        ? " " + yellow(`${warnings}W`)
        : " " + dim("clean");
  const changedFormatters = [...rec.formatters.entries()]
    .filter(([, f]) => f.changed && f.success)
    .map(([name]) => name);
  const failedFormatters = [...rec.formatters.entries()]
    .filter(([, f]) => !f.success)
    .map(([name]) => name);
  const formatMark =
    (failedFormatters.length > 0 ? red(` fmt-failed:${failedFormatters.join(",")}`) : "") +
    (changedFormatters.length > 0 ? dim(` fmt:${changedFormatters.join(",")}`) : "");
  return ` ${dot} ${base}  ${dim(runnerNames)}${formatMark}${counts}`;
}

function packHorizontalRow(
  recs: FileRecord[],
  totalWidth: number,
  theme: { fg: (color: string, s: string) => string },
): string {
  if (recs.length === 0) return "";
  const dim = (s: string) => theme.fg("dim", s);
  const indent = "   ";
  const sep = "  ";
  const overflowReserve = 4;
  let used = visibleWidth(indent);
  const parts: string[] = [indent];
  const addedTokenWidths: number[] = [];
  let droppedAt = -1;
  for (let i = 0; i < recs.length; i++) {
    const sepWidth = parts.length > 1 ? visibleWidth(sep) : 0;
    const willOverflow = i < recs.length - 1;
    const reserve = willOverflow ? overflowReserve : 0;
    const remaining = totalWidth - used - sepWidth - reserve;
    if (remaining < 4) {
      droppedAt = i;
      break;
    }
    const token = formatFileTokenHorizontal(recs[i], remaining, theme);
    const tokenWidth = visibleWidth(token);
    if (token.length === 0 || used + sepWidth + tokenWidth > totalWidth) {
      droppedAt = i;
      break;
    }
    if (sepWidth > 0) {
      parts.push(sep);
      used += sepWidth;
    }
    parts.push(token);
    used += tokenWidth;
    addedTokenWidths.push(tokenWidth + sepWidth);
  }
  if (droppedAt >= 0) {
    let dropped = recs.length - droppedAt;
    let overflow = " " + dim(`+${dropped}`);
    while (used + visibleWidth(overflow) > totalWidth && addedTokenWidths.length > 0) {
      // SAFETY: The enclosing non-empty queue check guarantees this removal returns an element.
      const lastWidth = addedTokenWidths.pop() as number;
      used -= lastWidth;
      parts.pop();
      if (parts.length > 1) parts.pop();
      dropped++;
      overflow = " " + dim(`+${dropped}`);
    }
    if (used + visibleWidth(overflow) <= totalWidth) {
      parts.push(overflow);
    }
  }
  return fitLine(parts.join(""), totalWidth);
}

function formatFileTokenHorizontal(
  rec: FileRecord,
  remainingWidth: number,
  theme: { fg: (color: string, s: string) => string },
): string {
  const dim = (s: string) => theme.fg("dim", s);
  const red = (s: string) => theme.fg("error", s);
  const yellow = (s: string) => theme.fg("warning", s);

  const blocking = rec.diagnosticCounts.blocking;
  const errors = rec.diagnosticCounts.errors;
  const warnings = rec.diagnosticCounts.warnings;
  const formatterChanged = hasChangedFormatter(rec);
  const formatterFailed = hasFailedFormatter(rec);

  let dotChar: string;
  if (blocking > 0) dotChar = red("●");
  else if (errors > 0 || warnings > 0) dotChar = yellow("!");
  else if (formatterChanged) dotChar = dim("✎");
  else dotChar = dim("·");

  if (formatterFailed && blocking === 0 && errors === 0 && warnings === 0) {
    dotChar = red("x");
  }

  let countsStyled = "";
  if (errors > 0 && warnings > 0) {
    const eColor = blocking > 0 ? red : yellow;
    countsStyled = " " + eColor(`${errors}E`) + yellow(`${warnings}W`);
  } else if (errors > 0) {
    const eColor = blocking > 0 ? red : yellow;
    countsStyled = " " + eColor(`${errors}E`);
  } else if (warnings > 0) {
    countsStyled = " " + yellow(`${warnings}W`);
  }

  const fullBasename = path.basename(rec.filePath);
  const fixedWidth = visibleWidth(dotChar) + 1 + visibleWidth(countsStyled);
  const basenameBudget = remainingWidth - fixedWidth;
  if (basenameBudget < 3) return "";
  const truncated = truncateBasename(fullBasename, basenameBudget);
  const linked = osc8(pathToFileURL(rec.filePath).href, truncated);
  return `${dotChar} ${linked}${countsStyled}`;
}

function truncateBasename(name: string, maxWidth: number): string {
  if (visibleWidth(name) <= maxWidth) return name;
  if (maxWidth < 2) return "…";
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const keep = maxWidth - ext.length - 1;
  if (keep < 1) {
    return name.slice(0, maxWidth - 1) + "…";
  }
  return stem.slice(0, keep) + "…" + ext;
}

function getOrCreate(filePath: string, key = fileMapKey(filePath)): FileRecord {
  maybePruneInactiveFileRecords();
  return (
    files.get(key) ?? {
      filePath,
      runners: new Map(),
      formatters: new Map(),
      diagnostics: [],
      allDiagnostics: [],
      diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
      hasFinalDiagnosticsSnapshot: false,
      touchedAt: Date.now(),
    }
  );
}

function hasChangedFormatter(rec: FileRecord): boolean {
  return [...rec.formatters.values()].some((f) => f.changed && f.success);
}

function hasFailedFormatter(rec: FileRecord): boolean {
  return [...rec.formatters.values()].some((f) => !f.success);
}

function shouldRenderFile(rec: FileRecord): boolean {
  return rec.hasFinalDiagnosticsSnapshot || hasChangedFormatter(rec) || hasFailedFormatter(rec);
}

function hasLiveDiagnostic(rec: FileRecord): boolean {
  return rec.hasFinalDiagnosticsSnapshot && rec.diagnostics.length > 0;
}

function isPendingAnalysis(rec: FileRecord): boolean {
  return rec.runners.size > 0 && !rec.hasFinalDiagnosticsSnapshot;
}

function capStoredDiagnostics(diagnostics: WidgetDiagnostic[]): WidgetDiagnostic[] {
  if (diagnostics.length <= MAX_STORED_DIAGNOSTICS_PER_FILE) return diagnostics;
  const blockers = diagnostics.filter(isBlocking);
  if (blockers.length >= MAX_STORED_DIAGNOSTICS_PER_FILE) {
    return blockers.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE);
  }
  const rest = diagnostics.filter((d) => !isBlocking(d));
  return [...blockers, ...rest.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE - blockers.length)];
}

function countTotalIn(severity: "error" | "warning", recs: FileRecord[]): number {
  let n = 0;
  for (const rec of recs) {
    if (severity === "error") n += rec.diagnosticCounts.errors;
    else n += rec.diagnosticCounts.warnings;
  }
  return n;
}

function countBlockingIn(recs: FileRecord[]): number {
  let n = 0;
  for (const rec of recs) n += rec.diagnosticCounts.blocking;
  return n;
}

function requestRender(): void {
  requestRenderFn?.();
}

function osc8(uri: string, label: string): string {
  if (!uri) return label;
  return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function dedupeByBasename(recs: FileRecord[]): FileRecord[] {
  const seen = new Map<string, FileRecord>();
  for (const r of [...recs].sort((a, b) => a.touchedAt - b.touchedAt)) {
    seen.set(path.basename(r.filePath), r);
  }
  return [...seen.values()].sort((a, b) => b.touchedAt - a.touchedAt);
}
