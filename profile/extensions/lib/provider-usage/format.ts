import { recordOf, type RuntimeValue } from "../runtime-values.ts";
import { UsageThrottledError } from "../usage-cache.ts";
import { elapsedTime, formatNumber, relativeTime } from "./helpers.ts";
import {
  clampPercent,
  quotaHealth,
  windowElapsedPercent,
  type ProviderUsage,
  type ProviderUsageReport,
  type QuotaHealth,
  type UsageStyle,
  type UsageWindow,
  type UsageWindowSummary,
} from "./types.ts";

const USAGE_BAR_WIDTH = 50;

type UsagePainter = {
  value: (text: string) => string;
  dim: (text: string) => string;
  label: (text: string) => string;
  head: (text: string) => string;
  health: (health: QuotaHealth, text: string) => string;
};

function usagePainter(style: UsageStyle | undefined): UsagePainter {
  const plain = (text: string): string => text;
  if (!style) {
    return {
      value: plain,
      dim: plain,
      label: plain,
      head: plain,
      health: (_health, t) => t,
    };
  }
  const color = (name: string, text: string): string => {
    try {
      return style.fg(name, text);
    } catch {
      return text;
    }
  };
  const HEALTH_COLORS = recordOf<QuotaHealth, string>()({
    exhausted: "error",
    over: "warning",
    under: "success",
    unknown: "text",
  });
  return {
    value: (text) => color("text", text),
    dim: (text) => color("dim", text),
    label: (text) => color("muted", text),
    head: (text) => color("accent", text),
    health: (health, text) => color(HEALTH_COLORS[health], text),
  };
}

function progressBar(
  percent: number,
  paint: UsagePainter,
  health: QuotaHealth,
  width = USAGE_BAR_WIDTH,
): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return `${paint.health(health, "█".repeat(filled))}${paint.dim("░".repeat(width - filled))}`;
}

export function cachedLabel(cached: { at: Date; reason?: string } | undefined): string | undefined {
  if (!cached) return undefined;
  const age = elapsedTime(cached.at);
  return cached.reason ? `cached ${age} · ${cached.reason}` : `cached ${age}`;
}

export function describeUsageWindow(window: UsageWindow, now = Date.now()): UsageWindowSummary {
  const percent = formatNumber(window.percent, 0);
  const eventTime = relativeTime(window.eventAt, now);
  const event = window.eventLabel && eventTime ? `${window.eventLabel} ${eventTime}` : undefined;
  const elapsed = windowElapsedPercent(window, now);
  const pace =
    window.pace?.label ??
    (elapsed === undefined ? undefined : `${formatNumber(elapsed, 0)}% of window elapsed`);
  return {
    percent,
    detail: [event, pace, window.detail].filter(Boolean).join(" · "),
  };
}

export function formatProviderUsage(
  result: ProviderUsage,
  style?: UsageStyle,
  now = Date.now(),
): string {
  const paint = usagePainter(style);
  const summary = [result.plan, result.status, cachedLabel(result.cached)]
    .filter(Boolean)
    .join(" · ");
  const heading = summary
    ? `${paint.head(result.name)}${paint.dim(" — ")}${paint.value(summary)}`
    : paint.head(result.name);
  if (result.windows.length === 0) {
    return summary ? heading : `${heading}${paint.dim(" — no quota windows")}`;
  }
  const windows = result.windows.flatMap((window) => {
    const health = quotaHealth(window, now);
    const { percent, detail } = describeUsageWindow(window, now);
    return [
      `  ${paint.label(window.label)}`,
      `  ${progressBar(window.percent, paint, health)} ${paint.health(health, `${percent}% ${window.qualifier}`)}`,
      ...(detail ? [`  ${paint.dim(detail)}`] : []),
    ];
  });
  return [heading, ...windows].join("\n");
}

export function usageFailureMessage(reason: RuntimeValue): string {
  if (reason instanceof UsageThrottledError) {
    const retry = relativeTime(new Date(reason.retryAt));
    return retry ? `${reason.message} · retrying ${retry}` : reason.message;
  }
  return reason instanceof Error ? reason.message : "unknown error";
}

export function formatUsageReport(report: ProviderUsageReport, style?: UsageStyle): string {
  const paint = usagePainter(style);
  const blocks = report.providers.map((reading) =>
    reading.ok
      ? formatProviderUsage(reading.usage, style)
      : `${paint.head(reading.name)}${paint.dim(" — ")}${paint.health(
          "exhausted",
          `unavailable (${reading.error})`,
        )}`,
  );
  return blocks.join("\n\n");
}
