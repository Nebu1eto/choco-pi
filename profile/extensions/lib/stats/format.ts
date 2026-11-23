import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { periodLabel, scopeLabel, timelineOf, type StatsReport } from "./aggregate.ts";
import {
  colourMapOf,
  count,
  layoutFor,
  paletteOf,
  providerSuffixFits,
  rowLabel,
  sectionBar,
  STATS_DEFAULT_WIDTH,
  STATS_MIN_WIDTH,
  STATS_SECTIONS,
  withoutSuffix,
  type SectionContext,
  type StatsFormatOptions,
} from "./format-layout.ts";
import { footerLines, SECTION_LINES, sectionBody } from "./format-sections.ts";
import { fastTagWidth } from "./format-tables.ts";

export {
  colourMapOf,
  DEFAULT_STATS_SECTION,
  fitLabel,
  fitLabels,
  isStatsSection,
  providerSuffixFits,
  SERIES_TOKENS,
  seriesToken,
  shortenToFit,
  STATS_DEFAULT_WIDTH,
  STATS_MIN_WIDTH,
  STATS_SECTION_ROWS,
  STATS_SECTIONS,
  statsSectionAt,
  stepStatsSection,
  withoutSuffix,
  type ColourMap,
  type StatsFormatOptions,
  type StatsScanSummary,
  type StatsSection,
  type SuffixMode,
} from "./format-layout.ts";
export {
  chartModelKeys,
  sparkline,
  sparklineAxis,
  sparklineRows,
  throughputTrend,
  tokensPerDayChart,
} from "./format-charts.ts";
export { LOW_SAMPLE_LONG, LOW_SAMPLE_SHORT } from "./format-tables.ts";

export function formatStats(report: StatsReport, options: StatsFormatOptions): string {
  const width = Math.max(STATS_MIN_WIDTH, Math.floor(options.width ?? STATS_DEFAULT_WIDTH));
  const names = options.modelNames;
  const longestModelName = Math.max(
    0,
    ...report.byModel.map((row) => visibleWidth(withoutSuffix(rowLabel(row.key, names, true)))),
  );
  const layout = layoutFor(width, longestModelName + 2);
  const p = paletteOf(options.style);
  const ctx: SectionContext = {
    report,
    options,
    layout,
    p,
    names,
    providerSuffix: providerSuffixFits(layout, [
      ...report.byModel.map((row) => ({ text: rowLabel(row.key, names, true), extra: 0 })),
      ...report.speed.byModel.map((row) => ({
        text: rowLabel(row.model, names, true),
        extra: fastTagWidth(row, false),
      })),
    ]),
    modelColours: colourMapOf(report.byModel.map((row) => row.key)),
    timeline: timelineOf(options.period, options.now),
  };
  const { heading, dim } = p;
  const lines: string[] = [];
  lines.push(
    heading("Statistics") + dim(` · ${periodLabel(options.period)} · ${scopeLabel(options.scope)}`),
  );
  const scanned = [
    `Scanned ${count(options.scan.sessions)} sessions (${count(options.scan.files)} files)`,
    `${count(options.scan.calls)} calls`,
  ];
  lines.push(...(layout.compact ? scanned.map((item) => dim(item)) : [dim(scanned.join(" · "))]));
  lines.push("");
  if (options.section === undefined) {
    for (const section of STATS_SECTIONS) lines.push(...SECTION_LINES[section.id](ctx), "");
  } else {
    lines.push(sectionBar(options.section, layout.width, p), dim("─".repeat(layout.width)));
    lines.push(...sectionBody(options.section, ctx, lines), "");
  }
  lines.push(...footerLines(ctx));
  return lines.flatMap((line) => wrapTextWithAnsi(line, width)).join("\n");
}
