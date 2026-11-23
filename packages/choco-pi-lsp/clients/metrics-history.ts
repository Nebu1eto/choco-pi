import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.ts";
import { writeFileAtomic } from "./atomic-write.ts";

type GetTrendSummaryResultContract = {
  improving: number;
  regressing: number;
  stable: number;
  worstRegressions: Array<{ file: string; miDelta: number }>;
};

export interface MetricSnapshot {
  commit: string;
  timestamp: string;
  mi: number;
  cognitive: number;
  nesting: number;
  lines: number;
  maxCyclomatic: number;
  entropy: number;
}

export interface FileHistory {
  latest: MetricSnapshot;
  history: MetricSnapshot[];
  trend: "improving" | "stable" | "regressing";
}

export interface MetricsHistory {
  version: number;
  files: Record<string, FileHistory>;
  capturedAt: string;
}

export type TrendDirection = "improving" | "stable" | "regressing";

const HISTORY_FILE = "metrics-history.json";
const MAX_HISTORY_PER_FILE = 20;

function isInsideGitRepo(startDir: string): boolean {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function getCurrentCommit(): string {
  if (!isInsideGitRepo(process.cwd())) {
    return "unknown";
  }

  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "unknown";
  }
}

export function loadHistory(): MetricsHistory {
  const historyPath = path.join(getProjectDataDir(process.cwd()), HISTORY_FILE);

  if (!fs.existsSync(historyPath)) {
    return {
      version: 1,
      files: {},
      capturedAt: new Date().toISOString(),
    };
  }

  try {
    const content = fs.readFileSync(historyPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      version: 1,
      files: {},
      capturedAt: new Date().toISOString(),
    };
  }
}

export function saveHistory(history: MetricsHistory): void {
  const historyDir = getProjectDataDir(process.cwd());
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  history.capturedAt = new Date().toISOString();
  const historyPath = path.join(historyDir, "metrics-history.json");
  writeFileAtomic(historyPath, JSON.stringify(history, null, 2));
}

let pendingHistory: MetricsHistory | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 5000;

export function captureSnapshot(
  filePath: string,
  metrics: {
    maintainabilityIndex: number;
    cognitiveComplexity: number;
    maxNestingDepth: number;
    linesOfCode: number;
    maxCyclomatic: number;
    entropy: number;
  },
): void {
  if (!pendingHistory) {
    pendingHistory = loadHistory();
  }

  const relativePath = path.relative(process.cwd(), filePath);
  const commit = getCurrentCommit();

  const snapshot: MetricSnapshot = {
    commit,
    timestamp: new Date().toISOString(),
    mi: Math.round(metrics.maintainabilityIndex * 10) / 10,
    cognitive: metrics.cognitiveComplexity,
    nesting: metrics.maxNestingDepth,
    lines: metrics.linesOfCode,
    maxCyclomatic: metrics.maxCyclomatic,
    entropy: Math.round(metrics.entropy * 100) / 100,
  };

  const existing = pendingHistory.files[relativePath];

  if (existing) {
    const latest = existing.latest;
    if (latest.commit === commit && latest.mi === snapshot.mi) {
      return;
    }
    existing.history.push(snapshot);
    if (existing.history.length > MAX_HISTORY_PER_FILE) {
      existing.history = existing.history.slice(-MAX_HISTORY_PER_FILE);
    }
    existing.latest = snapshot;
    existing.trend = computeTrend(existing.history);
  } else {
    pendingHistory.files[relativePath] = {
      latest: snapshot,
      history: [snapshot],
      trend: "stable",
    };
  }

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (pendingHistory) {
      saveHistory(pendingHistory);
      pendingHistory = null;
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function captureSnapshots(
  files: Array<{
    filePath: string;
    metrics: {
      maintainabilityIndex: number;
      cognitiveComplexity: number;
      maxNestingDepth: number;
      linesOfCode: number;
      maxCyclomatic: number;
      entropy: number;
    };
  }>,
): MetricsHistory {
  const history = loadHistory();

  for (const file of files) {
    const relativePath = path.relative(process.cwd(), file.filePath);
    const commit = getCurrentCommit();

    const snapshot: MetricSnapshot = {
      commit,
      timestamp: new Date().toISOString(),
      mi: Math.round(file.metrics.maintainabilityIndex * 10) / 10,
      cognitive: file.metrics.cognitiveComplexity,
      nesting: file.metrics.maxNestingDepth,
      lines: file.metrics.linesOfCode,
      maxCyclomatic: file.metrics.maxCyclomatic,
      entropy: Math.round(file.metrics.entropy * 100) / 100,
    };

    const existing = history.files[relativePath];

    if (existing) {
      existing.history.push(snapshot);
      if (existing.history.length > MAX_HISTORY_PER_FILE) {
        existing.history = existing.history.slice(-MAX_HISTORY_PER_FILE);
      }
      existing.latest = snapshot;
      existing.trend = computeTrend(existing.history);
    } else {
      history.files[relativePath] = {
        latest: snapshot,
        history: [snapshot],
        trend: "stable",
      };
    }
  }

  saveHistory(history);
  return history;
}

export function computeTrend(history: MetricSnapshot[]): TrendDirection {
  if (history.length < 2) return "stable";

  const recent = history.slice(-3);
  const first = recent[0];
  const last = recent[recent.length - 1];

  const miDelta = last.mi - first.mi;
  const cogDelta = last.cognitive - first.cognitive;

  if (miDelta > 2) return "improving";
  if (miDelta < -2) return "regressing";

  if (cogDelta < -10) return "improving";
  if (cogDelta > 10) return "regressing";

  return "stable";
}

export function getDelta(history: FileHistory | null): {
  mi: number;
  cognitive: number;
  trend: TrendDirection;
} | null {
  if (!history || history.history.length < 2) return null;

  const current = history.history[history.history.length - 1];
  const previous = history.history[history.history.length - 2];

  return {
    mi: Math.round((current.mi - previous.mi) * 10) / 10,
    cognitive: current.cognitive - previous.cognitive,
    trend: history.trend,
  };
}

export function getTrendEmoji(trend: TrendDirection): string {
  switch (trend) {
    case "improving":
      return "📈";
    case "regressing":
      return "📉";
    default:
      return "➡️";
  }
}

export function getTrendSummary(history: MetricsHistory): GetTrendSummaryResultContract {
  let improving = 0;
  let regressing = 0;
  let stable = 0;
  const regressions: Array<{ file: string; miDelta: number }> = [];

  for (const [file, fileHistory] of Object.entries(history.files)) {
    switch (fileHistory.trend) {
      case "improving":
        improving++;
        break;
      case "regressing": {
        regressing++;
        const delta = getDelta(fileHistory);
        if (delta) {
          regressions.push({ file, miDelta: delta.mi });
        }
        break;
      }
      default:
        stable++;
    }
  }

  regressions.sort((a, b) => a.miDelta - b.miDelta);

  return {
    improving,
    regressing,
    stable,
    worstRegressions: regressions.slice(0, 5),
  };
}

export function formatTrendCell(filePath: string, history: MetricsHistory): string {
  const relativePath = path.relative(process.cwd(), filePath);
  const fileHistory = history.files[relativePath];

  if (!fileHistory || fileHistory.history.length < 2) {
    return "—";
  }

  const delta = getDelta(fileHistory);
  if (!delta) return "—";

  const emoji = getTrendEmoji(delta.trend);
  const miSign = delta.mi > 0 ? "+" : "";
  const miColor = delta.mi > 0 ? "🟢" : delta.mi < 0 ? "🔴" : "⚪";

  return `${emoji} ${miColor}${miSign}${delta.mi}`;
}

export interface ProjectTDI {
  score: number;
  grade: string;
  avgMI: number;
  totalCognitive: number;
  filesAnalyzed: number;
  filesWithDebt: number;
  byCategory: {
    maintainability: number;
    cognitive: number;
    nesting: number;
    maxCyclomatic: number;
    entropy: number;
  };
}

export function computeTDI(history: MetricsHistory): ProjectTDI {
  const files = Object.values(history.files);
  if (files.length === 0) {
    return {
      score: 0,
      grade: "N/A",
      avgMI: 100,
      totalCognitive: 0,
      filesAnalyzed: 0,
      filesWithDebt: 0,
      byCategory: {
        maintainability: 0,
        cognitive: 0,
        nesting: 0,
        maxCyclomatic: 0,
        entropy: 0,
      },
    };
  }

  let totalMI = 0;
  let totalCognitive = 0;
  let _totalNesting = 0;
  let filesWithDebt = 0;
  let debtFromMI = 0;
  let debtFromCognitive = 0;
  let debtFromNesting = 0;
  let debtFromMaxCyclomatic = 0;
  let debtFromEntropy = 0;

  for (const file of files) {
    const snap = file.latest;
    totalMI += snap.mi;
    totalCognitive += snap.cognitive;
    _totalNesting += snap.nesting;

    let fileDebt = 0;

    const miDebt = Math.max(0, (100 - snap.mi) / 100);
    debtFromMI += miDebt;

    const cogDebt = Math.min(1, snap.cognitive / 200);
    debtFromCognitive += cogDebt;

    const nestDebt = Math.min(1, Math.max(0, snap.nesting - 3) / 7);
    debtFromNesting += nestDebt;

    const maxCycDebt = Math.min(1, Math.max(0, snap.maxCyclomatic - 10) / 20);
    debtFromMaxCyclomatic += maxCycDebt;

    const entropyDebt = Math.min(1, Math.max(0, snap.entropy - 4.0) / 3.0);
    debtFromEntropy += entropyDebt;

    fileDebt = miDebt + cogDebt + nestDebt + maxCycDebt + entropyDebt;
    if (fileDebt > 0.5) filesWithDebt++;
  }

  const avgMI = totalMI / files.length;

  const avgMIDebt = debtFromMI / files.length;
  const avgCogDebt = debtFromCognitive / files.length;
  const avgNestDebt = debtFromNesting / files.length;
  const avgMaxCycDebt = debtFromMaxCyclomatic / files.length;
  const avgEntropyDebt = debtFromEntropy / files.length;

  const rawScore =
    avgMIDebt * 45 + avgCogDebt * 30 + avgNestDebt * 10 + avgMaxCycDebt * 10 + avgEntropyDebt * 5;
  const score = Math.round(rawScore * 100) / 100;

  let grade: string;
  if (score <= 15) grade = "A";
  else if (score <= 30) grade = "B";
  else if (score <= 50) grade = "C";
  else if (score <= 70) grade = "D";
  else grade = "F";

  return {
    score,
    grade,
    avgMI: Math.round(avgMI * 10) / 10,
    totalCognitive,
    filesAnalyzed: files.length,
    filesWithDebt,
    byCategory: {
      maintainability: Math.round(avgMIDebt * 100),
      cognitive: Math.round(avgCogDebt * 100),
      nesting: Math.round(avgNestDebt * 100),
      maxCyclomatic: Math.round(avgMaxCycDebt * 100),
      entropy: Math.round(avgEntropyDebt * 100),
    },
  };
}
