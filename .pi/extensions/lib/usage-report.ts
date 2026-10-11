import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cachedLabel,
  describeUsageWindow,
  readProviderUsages,
  type ProviderUsage,
  type ProviderUsageReading,
  type ProviderUsageReport,
  type UsageWindow,
} from "../provider-usage.ts";
import {
  REPORT_SCHEMA_VERSION,
  type ReportFrame,
  type ReportRow,
  type ReportSection,
  type UsageProviderReport,
  type UsageWindowReport,
} from "./host-bridge/report-schema.ts";

/**
 * The structured `/usage` report for RPC hosts (docs/rpc-host-bridge.md,
 * "Structured reports"). It carries what the Usage tab prints — provider name,
 * plan, status, cache note, and quota windows — and nothing that identifies an
 * account: no account ID, token, or credential reaches ProviderUsage.
 */

function windowReport(window: UsageWindow): UsageWindowReport {
  const report: UsageWindowReport = {
    label: window.label,
    percent: window.percent,
    qualifier: window.qualifier,
  };
  if (window.eventAt !== undefined && Number.isFinite(window.eventAt.getTime()))
    report.resetsAt = window.eventAt.toISOString();
  if (window.eventLabel !== undefined) report.resetLabel = window.eventLabel;
  if (window.detail !== undefined) report.detail = window.detail;
  if (window.windowSeconds !== undefined && window.windowSeconds > 0)
    report.windowSeconds = window.windowSeconds;
  if (window.pace !== undefined)
    report.pace = { health: window.pace.health, label: window.pace.label };
  return report;
}

function failedUsage(name: string, error: string): ProviderUsage {
  return { name, status: `unavailable (${error})`, windows: [] };
}

function readingUsage(reading: ProviderUsageReading): ProviderUsage {
  return reading.ok ? reading.usage : failedUsage(reading.name, reading.error);
}

function providerReport(usage: ProviderUsage): UsageProviderReport {
  const report: UsageProviderReport = {
    name: usage.name,
    windows: usage.windows.map(windowReport),
  };
  if (usage.plan !== undefined) report.plan = usage.plan;
  if (usage.status !== undefined) report.status = usage.status;
  if (usage.cached !== undefined) {
    report.cached = { at: usage.cached.at.toISOString() };
    if (usage.cached.reason !== undefined) report.cached.reason = usage.cached.reason;
  }
  return report;
}

/** One section per provider, so a host without the typed renderer still shows a table. */
function providerSection(usage: ProviderUsage, now: number): ReportSection {
  const rows: ReportRow[] = [];
  if (usage.plan !== undefined) rows.push({ label: "Plan", value: usage.plan });
  if (usage.status !== undefined) rows.push({ label: "Status", value: usage.status });
  const cached = cachedLabel(usage.cached);
  if (cached !== undefined) rows.push({ label: "Snapshot", value: cached });
  for (const window of usage.windows) {
    const { percent, detail } = describeUsageWindow(window, now);
    const value = `${percent}% ${window.qualifier}`;
    rows.push(
      detail ? { label: window.label, value, hint: detail } : { label: window.label, value },
    );
  }
  if (rows.length === 0) rows.push({ label: "Quota", value: "no quota windows" });
  return { title: usage.name, rows };
}

/** True when at least one provider reported a quota window, the bar a host would draw. */
export function hasUsageWindows(report: ProviderUsageReport): boolean {
  return report.providers.some((reading) => reading.ok && reading.usage.windows.length > 0);
}

export function usageReportFrame(
  sessionId: string,
  report: ProviderUsageReport,
  at: Date = new Date(),
): ReportFrame {
  const providers = report.providers.map(readingUsage);
  return {
    schema: REPORT_SCHEMA_VERSION,
    kind: "usage",
    at: at.toISOString(),
    sessionId,
    title: "Usage",
    sections: providers.map((usage) => providerSection(usage, at.getTime())),
    usage: {
      observedAt: report.observedAt.toISOString(),
      providers: providers.map(providerReport),
    },
  };
}

/** Queries the providers once and builds the report for the session that asked. */
export async function buildUsageReport(ctx: ExtensionContext): Promise<ReportFrame> {
  const sessionId = ctx.sessionManager.getSessionId();
  return usageReportFrame(sessionId, await readProviderUsages(ctx));
}
