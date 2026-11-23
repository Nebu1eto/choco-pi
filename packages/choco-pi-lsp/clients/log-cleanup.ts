import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { getRegisteredLogFiles } from "./ndjson-logger.ts";
import { pathsEqual } from "./path-utils.ts";

type CleanupOldLogsResultContract = { deleted: string[]; errors: string[] };
type RotateLogIfNeededResultContract = { rotated: boolean; newFile?: string };
type RunLogCleanupResultContract = {
  cleaned: number;
  rotated: number;
  report: string;
};
type GetLogStorageSummaryResultContract = {
  totalMB: number;
  files: { name: string; sizeMB: number; ageDays: number }[];
};

const LOG_DIR = getGlobalPiLensDir();
const LOGS_SUBDIR = path.join(LOG_DIR, "logs");

export function getManagedLogFiles(dir: string = LOG_DIR): string[] {
  const names = new Set<string>();

  for (const absPath of getRegisteredLogFiles()) {
    if (pathsEqual(path.dirname(absPath), dir)) {
      names.add(path.basename(absPath));
    }
  }

  try {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".log") && !ROTATED_BACKUP_RE.test(entry)) {
          names.add(entry);
        }
      }
    }
  } catch {}

  return [...names].sort((a, b) => a.localeCompare(b));
}

export const ROTATED_BACKUP_RE = /(\.\d{4}-\d{2}-\d{2}T.*\.log|\.log\..+)$/;

export interface LogCleanupConfig {
  retentionDays: number;
  maxSizeMB: number;
}

export function getMaxLogSizeMB(): number {
  return Math.max(1, Number.parseInt(process.env.CHOCO_PI_LSP_MAX_LOG_SIZE_MB ?? "10", 10) || 10);
}

function getConfig(): LogCleanupConfig {
  return {
    retentionDays: Math.max(
      1,
      Number.parseInt(process.env.CHOCO_PI_LSP_LOG_RETENTION_DAYS ?? "7", 10) || 7,
    ),
    maxSizeMB: getMaxLogSizeMB(),
  };
}

function getFileAgeDays(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    const ageMs = Date.now() - stats.mtime.getTime();
    return ageMs / (1000 * 60 * 60 * 24);
  } catch {
    return 0;
  }
}

function getFileSizeMB(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

export function cleanupOldLogs(
  directory: string,
  pattern: RegExp,
  retentionDays?: number,
): CleanupOldLogsResultContract {
  const config = getConfig();
  const maxAge = retentionDays ?? config.retentionDays;
  const deleted: string[] = [];
  const errors: string[] = [];

  try {
    if (!fs.existsSync(directory)) {
      return { deleted, errors };
    }

    const files = fs.readdirSync(directory);
    for (const file of files) {
      if (!pattern.test(file)) continue;

      const filePath = path.join(directory, file);
      const ageDays = getFileAgeDays(filePath);

      if (ageDays > maxAge) {
        try {
          fs.unlinkSync(filePath);
          deleted.push(file);
        } catch (err) {
          errors.push(`${file}: ${err}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Directory read failed: ${err}`);
  }

  return { deleted, errors };
}

export function rotateLogIfNeeded(
  logFile: string,
  maxSizeMB?: number,
): RotateLogIfNeededResultContract {
  const config = getConfig();
  const maxSize = maxSizeMB ?? config.maxSizeMB;
  const sizeMB = getFileSizeMB(logFile);

  if (sizeMB < maxSize) {
    return { rotated: false };
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(logFile);
    const base = logFile.slice(0, -ext.length);
    const backupFile = `${base}.${timestamp}${ext}`;

    fs.renameSync(logFile, backupFile);
    fs.writeFileSync(logFile, "", "utf8");

    return { rotated: true, newFile: backupFile };
  } catch {
    return { rotated: false };
  }
}

export function runLogCleanup(dbg?: (msg: string) => void): RunLogCleanupResultContract {
  const config = getConfig();
  const results = {
    cleaned: 0,
    rotated: 0,
    report: "",
  };

  const dailyLogs = cleanupOldLogs(LOGS_SUBDIR, /\.jsonl$/, config.retentionDays);
  results.cleaned += dailyLogs.deleted.length;

  const rotatedLogs = cleanupOldLogs(LOG_DIR, ROTATED_BACKUP_RE, config.retentionDays);
  results.cleaned += rotatedLogs.deleted.length;

  const mainLogs = getManagedLogFiles().map((name) => path.join(LOG_DIR, name));

  for (const logFile of mainLogs) {
    const rotation = rotateLogIfNeeded(logFile, config.maxSizeMB);
    if (rotation.rotated) {
      results.rotated++;
      if (rotation.newFile) {
        const sizeMB = getFileSizeMB(rotation.newFile);
        dbg?.(
          `log_cleanup: rotated ${path.basename(logFile)} (${sizeMB.toFixed(1)}MB) → ${path.basename(rotation.newFile)}`,
        );
      }
    }
  }

  const parts: string[] = [];
  if (dailyLogs.deleted.length > 0) {
    parts.push(`${dailyLogs.deleted.length} daily logs`);
  }
  if (rotatedLogs.deleted.length > 0) {
    parts.push(`${rotatedLogs.deleted.length} rotated logs`);
  }
  if (results.rotated > 0) {
    parts.push(`${results.rotated} active logs rotated`);
  }

  results.report =
    parts.length > 0
      ? `log_cleanup: removed ${parts.join(", ")} (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`
      : `log_cleanup: no cleanup needed (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`;

  if (dailyLogs.errors.length > 0 || rotatedLogs.errors.length > 0) {
    dbg?.(`log_cleanup errors: ${[...dailyLogs.errors, ...rotatedLogs.errors].join("; ")}`);
  }

  return results;
}

export function getLogStorageSummary(): GetLogStorageSummaryResultContract {
  const files: { name: string; sizeMB: number; ageDays: number }[] = [];
  let totalMB = 0;

  for (const name of getManagedLogFiles()) {
    const filePath = path.join(LOG_DIR, name);
    if (fs.existsSync(filePath)) {
      const sizeMB = getFileSizeMB(filePath);
      const ageDays = getFileAgeDays(filePath);
      files.push({ name, sizeMB, ageDays });
      totalMB += sizeMB;
    }
  }

  try {
    if (fs.existsSync(LOGS_SUBDIR)) {
      const dailyFiles = fs.readdirSync(LOGS_SUBDIR);
      for (const name of dailyFiles) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(LOGS_SUBDIR, name);
        const sizeMB = getFileSizeMB(filePath);
        const ageDays = getFileAgeDays(filePath);
        files.push({ name: `logs/${name}`, sizeMB, ageDays });
        totalMB += sizeMB;
      }
    }
  } catch {}

  return { totalMB, files };
}
