import { visibleWidth } from "@earendil-works/pi-tui";
import {
  bucketTokPerSec,
  dayKey,
  type DayBucket,
  type StatsReport,
  type Timeline,
} from "./aggregate.ts";
import { lineChart, type ChartSeries } from "./chart.ts";
import {
  bucketLabel,
  CHART_GUTTER,
  fit,
  packedDim,
  paletteOf,
  rowLabel,
  shortDay,
  shortenToFit,
  SPARK_CHARS,
  timelineTicks,
  withoutSuffix,
  type ColourMap,
  type Layout,
  type Palette,
  type SectionContext,
} from "./format-layout.ts";
import type { ModelNameLookup } from "./names.ts";

const CHART_SERIES = 3;
const TREND_SERIES = CHART_SERIES;

export type TrendSeries = { model: string; values: (number | undefined)[] };

const trendMemo = new WeakMap<StatsReport, Map<string, TrendSeries[]>>();

function windowDays(window: number, now: number): string[] {
  const keys: string[] = [];
  for (let offset = window - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    keys.push(dayKey(date.getTime()));
  }
  return keys;
}

export function levelRows(
  values: readonly number[],
  peak: number,
  rows: number,
  p: Palette,
): string[] {
  const steps = SPARK_CHARS.length;
  const columns = values.map((value) =>
    value <= 0 || peak <= 0 ? 0 : Math.max(1, Math.ceil((value / peak) * rows * steps)),
  );
  const out: string[] = [];
  for (let row = rows - 1; row >= 0; row -= 1) {
    const base = row * steps;
    out.push(
      columns
        .map((level) => {
          if (level <= base) return row === 0 ? p.dim("·") : " ";
          const cell = Math.min(steps, level - base);
          return p.accent(SPARK_CHARS[cell - 1] ?? "█");
        })
        .join(""),
    );
  }
  return out;
}

export function sparklineRows(
  days: readonly DayBucket[],
  window: number,
  now: number,
  rows: number,
  p: Palette = paletteOf(undefined),
): string[] {
  const byDay = new Map(days.map((bucket) => [bucket.day, bucket.tokens]));
  return levelRows(
    windowDays(window, now).map((key) => byDay.get(key) ?? 0),
    Math.max(0, ...days.map((bucket) => bucket.tokens)),
    rows,
    p,
  );
}

export function sparkline(
  days: readonly DayBucket[],
  window: number,
  now: number,
  p: Palette = paletteOf(undefined),
): string {
  return sparklineRows(days, window, now, 1, p)[0] ?? "";
}

export function sparklineAxis(window: number, now: number): string {
  const first = new Date(now);
  first.setDate(first.getDate() - (window - 1));
  const left = shortDay(dayKey(first.getTime()));
  const label = "today";
  const gap = Math.max(1, window - visibleWidth(left) - visibleWidth(label));
  return `${left}${" ".repeat(gap)}${label}`;
}

export function timelineAxis(timeline: Timeline, span: number, now: number): string {
  if (timeline.unit === "day") return sparklineAxis(span, now);
  const left = bucketLabel(timeline, timeline.keys[timeline.keys.length - span] ?? "");
  const label = "now";
  const gap = Math.max(1, span - visibleWidth(left) - visibleWidth(label));
  return `${left}${" ".repeat(gap)}${label}`;
}

export function chartModelKeys(report: StatsReport): string[] {
  return report.byModel.slice(0, CHART_SERIES).map((row) => row.key);
}

export function tokensPerDayChart(
  report: StatsReport,
  timeline: Timeline,
  layout: Layout,
  p: Palette,
  names: ModelNameLookup | undefined,
  colours: ColourMap,
): string[] {
  const keys = timeline.keys;
  const tops = chartModelKeys(report);
  const seriesFor = (modelKey: string): number[] => {
    const byBucket = report.timeline.byModel.get(modelKey);
    return keys.map((key) => byBucket?.get(key) ?? 0);
  };
  const totals = keys.map((key) => report.timeline.totals.get(key)?.tokens ?? 0);
  const other = totals.map((total, index) => {
    const topSum = tops.reduce((sum, key) => sum + (seriesFor(key)[index] ?? 0), 0);
    return Math.max(0, total - topSum);
  });
  const series: ChartSeries[] = [
    { values: totals, paint: p.strong, weight: "heavy" },
    ...tops.map((key) => ({
      values: seriesFor(key),
      paint: (text: string) => p.series(colours.get(key) ?? 0, text),
    })),
  ];
  const hasOther = other.some((value) => value > 0);
  if (hasOther) series.push({ values: other, paint: p.dim });
  const lines = lineChart(series, {
    rows: layout.chartRows,
    width: layout.tableWidth,
    gutter: CHART_GUTTER,
    ticks: timelineTicks(timeline),
    dim: p.dim,
  });
  const entries = 1 + tops.length + (hasOther ? 1 : 0);
  const names_ = tops.map((key) => withoutSuffix(rowLabel(key, names, true)));
  const fixed = 2 + 7 + 2 * tops.length + 3 * (entries - 1) + (hasOther ? 7 : 0);
  const budget = layout.compact ? layout.width - 4 : layout.width - fixed;
  const shortened = shortenToFit(names_, layout.compact ? -1 : budget).map((name) =>
    layout.compact ? fit(name, budget).trimEnd() : name,
  );
  const legend = [
    p.strong("● Total"),
    ...tops.map(
      (key, index) => p.series(colours.get(key) ?? 0, "●") + p.text(" " + (shortened[index] ?? "")),
    ),
  ];
  if (hasOther) legend.push(p.dim("● other"));
  if (legend.length > 0) {
    if (layout.compact) for (const entry of legend) lines.push("  " + entry);
    else lines.push("  " + legend.join(p.dim(" · ")));
  }
  return lines;
}

export function throughputTrend(report: StatsReport, timeline: Timeline): TrendSeries[] {
  const memoKey = `${timeline.unit}:${timeline.keys.join(",")}`;
  const byWindow = trendMemo.get(report) ?? new Map<string, TrendSeries[]>();
  trendMemo.set(report, byWindow);
  const cached = byWindow.get(memoKey);
  if (cached !== undefined) return cached;
  const models: string[] = [];
  for (const row of report.speed.byModel) if (!models.includes(row.model)) models.push(row.model);
  const series: TrendSeries[] = [];
  for (const model of models) {
    if (series.length >= TREND_SERIES) break;
    const buckets = report.timeline.speed.get(model);
    if (buckets === undefined) continue;
    const values = timeline.keys.map((key) => bucketTokPerSec(buckets.get(key)));
    if (values.some((value) => value !== undefined)) series.push({ model, values });
  }
  byWindow.set(memoKey, series);
  return series;
}

export function throughputTrendLines(ctx: SectionContext): string[] {
  const { report, options, layout, p, timeline } = ctx;
  const hourly = timeline.unit === "hour";
  const window = timeline.keys.length;
  const lines = [
    p.heading(hourly ? "Throughput per hour" : "Throughput per day") +
      p.dim(
        layout.compact
          ? " (tok/s)"
          : ` (${hourly ? "last 24 hours" : `last ${window} days`}, generation tok/s per model)`,
      ),
  ];
  const trend = throughputTrend(report, timeline);
  if (trend.length === 0) {
    lines.push(p.dim("  no timed calls and too few to fit in this period"));
    return lines;
  }
  const tint = (entry: TrendSeries, rank: number, text: string): string =>
    p.series(ctx.modelColours.get(entry.model) ?? rank, text);
  const labels = trend.map((entry) => withoutSuffix(rowLabel(entry.model, ctx.names, true)));
  if (layout.chartRows > 0 && window <= layout.tableWidth - CHART_GUTTER) {
    lines.push(
      ...lineChart(
        trend.map((entry, rank) => ({
          values: entry.values,
          paint: (text: string) => tint(entry, rank, text),
        })),
        {
          rows: layout.chartRows,
          width: layout.tableWidth,
          gutter: CHART_GUTTER,
          ticks: timelineTicks(timeline),
          dim: p.dim,
        },
      ),
    );
    const fixed = 2 + 2 * trend.length + 3 * (trend.length - 1);
    const shortened = layout.compact
      ? labels.map((label) => fit(label, layout.width - 4).trimEnd())
      : shortenToFit(labels, layout.width - fixed);
    const legend = trend.map(
      (entry, rank) => tint(entry, rank, "●") + p.text(` ${shortened[rank] ?? ""}`),
    );
    if (layout.compact) for (const entry of legend) lines.push(`  ${entry}`);
    else lines.push(`  ${legend.join(p.dim(" · "))}`);
  } else {
    const span = Math.min(window, layout.width - 4);
    const peak = Math.max(
      0,
      ...trend.flatMap((entry) => entry.values.slice(-span).filter((value) => value !== undefined)),
    );
    const steps = SPARK_CHARS.length;
    trend.forEach((entry, rank) => {
      lines.push(
        tint(entry, rank, "  ●") +
          p.text(` ${fit(labels[rank] ?? "", layout.width - 4).trimEnd()}`),
      );
      const cells = entry.values.slice(-span).map((value) => {
        if (value === undefined) return p.dim("·");
        const level = peak > 0 ? Math.max(1, Math.ceil((value / peak) * steps)) : 1;
        return tint(entry, rank, SPARK_CHARS[Math.min(steps, level) - 1] ?? "█");
      });
      lines.push(`    ${cells.join("")}`);
    });
    lines.push(p.dim(`    ${timelineAxis(timeline, span, options.now)}`));
  }
  const notes = [`tok/s from recorded timings, else fitted per ${hourly ? "hour" : "day"}`];
  if (trend.some((entry) => entry.values.some((value) => value === undefined)))
    notes.push("gaps: too few calls to fit");
  lines.push(...packedDim(notes, layout, p));
  return lines;
}
