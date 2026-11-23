import type { ProjectionHint, QuotasResponse } from "../types/quotas";
import {
  assessWindow,
  formatTimeRemaining,
  type QuotaWindow,
  type RiskAssessment,
  type RiskSeverity,
  toWindows,
} from "../utils/quotas-severity";

export interface WindowAlertState {
  lastSeverity: RiskSeverity;
}

interface WindowRisk {
  window: QuotaWindow;
  assessment: RiskAssessment;
}

export type NotifyFn = (message: string, level: "warning" | "error") => void;

export class QuotaWarningNotifier {
  private windowAlerts = new Map<string, WindowAlertState>();

  findHighRiskWindows(
    quotas: QuotasResponse,
    projections?: Map<string, ProjectionHint>,
  ): WindowRisk[] {
    const windows = toWindows(quotas);
    return windows
      .map((window) => ({
        window,
        assessment: assessWindow(window, projections?.get(window.id)),
      }))
      .filter((item) => item.assessment.severity !== "none");
  }

  shouldNotify(windowKey: string, severity: RiskSeverity): boolean {
    const state = this.windowAlerts.get(windowKey);

    if (severity === "none") return false;
    if (!state) return true;

    const severityOrder: RiskSeverity[] = ["none", "warning", "high", "critical"];
    const currentIndex = severityOrder.indexOf(severity);
    const lastIndex = severityOrder.indexOf(state.lastSeverity);
    return currentIndex > lastIndex;
  }

  markObserved(windowKey: string, severity: RiskSeverity): void {
    this.windowAlerts.set(windowKey, { lastSeverity: severity });
  }

  formatWarningMessage(windows: WindowRisk[]): string {
    const lines = windows.map(({ window, assessment }) => {
      const status = assessment.severity;
      const statusLabel = status !== "none" ? ` (${status})` : "";
      const projected = Math.round(assessment.projectedPercent);
      const projectionText = formatProjectionText(
        projected,
        assessment.projectionHorizonMs,
        assessment.timeToEmptyMs,
      );
      const used = Math.round(window.usedPercent);
      const timeStr = formatTimeRemaining(window.resetsAt);
      const eventStr = window.nextAmount
        ? `${window.nextAmount} in ${timeStr}`
        : `${window.nextLabel ?? "Resets"} in ${timeStr}`;
      return `- ${window.label}: ${used}% used, ${projectionText}${statusLabel}, ${eventStr}`;
    });
    return `Synthetic quota warning:\n${lines.join("\n")}`;
  }

  clearAlertState(): void {
    this.windowAlerts.clear();
  }

  evaluate(
    quotas: QuotasResponse,
    notify: NotifyFn,
    projections?: Map<string, ProjectionHint>,
  ): void {
    const assessedWindows = toWindows(quotas).map((window) => ({
      window,
      assessment: assessWindow(window, projections?.get(window.id)),
    }));
    const windowsToNotify = assessedWindows.filter(
      ({ window, assessment }) =>
        assessment.severity !== "none" && this.shouldNotify(window.id, assessment.severity),
    );

    for (const { window, assessment } of assessedWindows) {
      this.markObserved(window.id, assessment.severity);
    }

    if (windowsToNotify.length === 0) return;

    const message = this.formatWarningMessage(windowsToNotify);

    const hasCritical = windowsToNotify.some(
      ({ assessment }) => assessment.severity === "critical",
    );
    const hasHigh = windowsToNotify.some(({ assessment }) => assessment.severity === "high");
    const notifyLevel = hasCritical || hasHigh ? "error" : "warning";

    notify(message, notifyLevel);
  }
}

function formatProjectionText(
  projectedPercent: number,
  horizonMs: number | null,
  timeToEmptyMs: number | null,
): string {
  if (!horizonMs) return `projected ${projectedPercent}%`;
  if (timeToEmptyMs !== null && timeToEmptyMs <= horizonMs) {
    return `projected to reach 100% in ${formatProjectionDuration(timeToEmptyMs)}`;
  }

  const horizon = formatProjectionDuration(horizonMs);
  const exhaustion =
    timeToEmptyMs === null ? "" : `; 100% in ${formatProjectionDuration(timeToEmptyMs)}`;
  return `projected ${projectedPercent}% in ${horizon}${exhaustion}`;
}

function formatProjectionDuration(durationMs: number): string {
  if (durationMs <= 0) return "now";
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const remainingAfterDays = totalMinutes % (24 * 60);
  const hours = Math.floor(remainingAfterDays / 60);
  const minutes = remainingAfterDays % 60;
  if (days >= 2) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours === 0) return `${minutes}m`;
  return minutes === 0 ? `${totalHours}h` : `${totalHours}h${minutes}m`;
}
