import { isRuntimeObject } from "../../tools/runtime-values.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.ts";
import { writeFileAtomic } from "../atomic-write.ts";
import { readJsonCache } from "../json-cache-read.ts";
import { MTIME_DRIFT_TOLERANCE_MS } from "../blocker-freshness.ts";
import type { ProjectDiagnosticsDeltaReport, ProjectDiagnosticsSnapshot } from "./types.ts";

export const PROJECT_DIAGNOSTICS_CACHE_VERSION = 2;
const SNAPSHOT_CACHE_FILE = "project-diagnostics.json";
const DELTA_CACHE_FILE = "project-diagnostics-delta.json";

function cachePath(cwd: string, fileName: string): string {
  return path.join(getProjectDataDir(cwd), "cache", fileName);
}

export function loadProjectDiagnosticsSnapshot(
  cwd: string,
): ProjectDiagnosticsSnapshot | undefined {
  return readJsonCache<ProjectDiagnosticsSnapshot>(
    cachePath(cwd, SNAPSHOT_CACHE_FILE),
    (parsed) => {
      if (!parsed || !isRuntimeObject(parsed)) return undefined;
      // SAFETY: The cache parser establishes this persisted diagnostic shape, and the adjacent validity checks reject malformed entries.
      const snapshot = parsed as ProjectDiagnosticsSnapshot;
      if (snapshot.version !== PROJECT_DIAGNOSTICS_CACHE_VERSION) return undefined;
      if (!Array.isArray(snapshot.diagnostics)) return undefined;
      return snapshot;
    },
  );
}

export function saveProjectDiagnosticsSnapshot(
  cwd: string,
  snapshot: ProjectDiagnosticsSnapshot,
): void {
  const filePath = cachePath(cwd, SNAPSHOT_CACHE_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2));
}

export function loadProjectDiagnosticsDeltaReport(
  cwd: string,
): ProjectDiagnosticsDeltaReport | undefined {
  return readJsonCache<ProjectDiagnosticsDeltaReport>(
    cachePath(cwd, DELTA_CACHE_FILE),
    (parsed) => {
      if (!parsed || !isRuntimeObject(parsed)) return undefined;
      // SAFETY: The cache parser establishes this persisted diagnostic shape, and the adjacent validity checks reject malformed entries.
      const report = parsed as ProjectDiagnosticsDeltaReport;
      if (report.version !== PROJECT_DIAGNOSTICS_CACHE_VERSION) return undefined;
      if (!Array.isArray(report.diagnostics)) return undefined;
      return report;
    },
  );
}

export function writeProjectDiagnosticsDeltaReport(
  cwd: string,
  report: ProjectDiagnosticsDeltaReport,
): void {
  const filePath = cachePath(cwd, DELTA_CACHE_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(report, null, 2));
}

export function reconcileProjectDiagnosticsSnapshot(snapshot: ProjectDiagnosticsSnapshot) {
  const scannedAtMs = Date.parse(snapshot.scannedAt);
  if (!Number.isFinite(scannedAtMs)) return { snapshot, staleDropped: 0 };

  const staleByFile = new Map<string, boolean>();
  const isStale = (filePath: string): boolean => {
    const cached = staleByFile.get(filePath);
    if (cached !== undefined) return cached;
    let stale: boolean;
    try {
      stale = fs.statSync(filePath).mtimeMs > scannedAtMs + MTIME_DRIFT_TOLERANCE_MS;
    } catch {
      stale = true;
    }
    staleByFile.set(filePath, stale);
    return stale;
  };

  const kept = snapshot.diagnostics.filter((d) => !isStale(d.filePath));
  if (kept.length === snapshot.diagnostics.length) {
    return { snapshot, staleDropped: 0 };
  }
  const staleDropped = [...staleByFile.values()].filter(Boolean).length;
  return { snapshot: { ...snapshot, diagnostics: kept }, staleDropped };
}
