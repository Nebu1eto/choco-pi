import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionInfoStyle } from "../session-usage.ts";
import type { Period, Scope, StatsReport, Timeline } from "./aggregate.ts";
import { modelRowLabel, type ModelNameLookup } from "./names.ts";

export const STATS_MIN_WIDTH = 40;
export const STATS_DEFAULT_WIDTH = 80;
const MIN_BAR = 6;
const MIN_BAR_SQUEEZED = 4;
const MAX_BAR = 32;
const PREFERRED_LABEL = 24;
const MAX_LABEL = 36;
export const MAX_SPEED_LABEL = 40;
export const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
export const COLLAPSED_ROWS = 6;
export const EXPANDED_FOLD_ROWS = 12;
export const STATS_SECTION_ROWS = 25;
export const MIN_FITTED_CHART_ROWS = 5;
export const CHART_GUTTER = 7;

export const SERIES_TOKENS = [
  "accent",
  "warning",
  "success",
  "error",
  "syntaxNumber",
  "bashMode",
  "mdLink",
  "mdHeading",
] as const;

export function seriesToken(rank: number): (typeof SERIES_TOKENS)[number] {
  return (
    SERIES_TOKENS[((rank % SERIES_TOKENS.length) + SERIES_TOKENS.length) % SERIES_TOKENS.length] ??
    "accent"
  );
}

export type Layout = {
  width: number;
  label: number;
  bar: number;
  tokens: boolean;
  cost: boolean;
  inOut: boolean;
  speedWide: boolean;
  compact: boolean;
  chartRows: number;
  tableWidth: number;
};

export function layoutFor(width: number, wantLabel = 0): Layout {
  const cost = width >= 40;
  const tokens = width >= 48;
  const inOut = width >= 120;
  const fixed = 2 + 1 + 6 + (tokens ? 8 : 0) + (cost ? 11 : 0) + (inOut ? 16 : 0);
  const free = Math.max(13, width - fixed);
  let bar = width < 48 ? 0 : Math.max(MIN_BAR, Math.min(MAX_BAR, Math.floor((free - 1) * 0.4)));
  if (bar > 0 && free - 1 - bar < PREFERRED_LABEL)
    bar = Math.max(MIN_BAR, free - 1 - PREFERRED_LABEL);
  const wanted = Math.min(MAX_LABEL, wantLabel);
  if (bar > 0 && free - 1 - bar < wanted) bar = Math.max(MIN_BAR_SQUEEZED, free - 1 - wanted);
  const label = Math.max(8, Math.min(MAX_LABEL, bar > 0 ? free - 1 - bar : free));
  const chartRows = width < 48 ? 0 : width < 64 ? 5 : width < 80 ? 7 : 9;
  const tableWidth = 2 + label + (bar > 0 ? 1 + bar : 0) + (fixed - 2);
  return {
    width,
    label,
    bar,
    tokens,
    cost,
    inOut,
    speedWide: width >= 64,
    compact: width < 64,
    chartRows,
    tableWidth,
  };
}

export type Palette = {
  heading: (text: string) => string;
  text: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  strong: (text: string) => string;
  key: (text: string) => string;
  series: (rank: number, text: string) => string;
};

export function paletteOf(style: SessionInfoStyle | undefined): Palette {
  if (!style) {
    const id = (text: string): string => text;
    return {
      heading: id,
      text: id,
      dim: id,
      accent: id,
      strong: id,
      key: id,
      series: (_rank, t) => t,
    };
  }
  return {
    heading: (text) => style.bold(style.fg("accent", text)),
    text: (text) => style.fg("text", text),
    dim: (text) => style.fg("dim", text),
    accent: (text) => style.fg("accent", text),
    strong: (text) => style.bold(style.fg("text", text)),
    key: (text) => style.bold(style.fg("warning", text)),
    series: (rank, text) => style.fg(seriesToken(rank), text),
  };
}

export type StatsScanSummary = {
  sessions: number;
  files: number;
  calls: number;
  duplicates: number;
};

export type ColourMap = ReadonlyMap<string, number>;

export function colourMapOf(keys: readonly string[]): ColourMap {
  return new Map(keys.map((key, rank) => [key, rank]));
}

export type StatsSection = "summary" | "models" | "features" | "context" | "throughput";

export const STATS_SECTIONS: ReadonlyArray<{ id: StatsSection; title: string }> = [
  { id: "summary", title: "Summary" },
  { id: "models", title: "By Model" },
  { id: "features", title: "By Feature" },
  { id: "context", title: "Context & Compaction" },
  { id: "throughput", title: "Throughput" },
];

export const DEFAULT_STATS_SECTION: StatsSection = "summary";

export function isStatsSection(value: string): value is StatsSection {
  return STATS_SECTIONS.some((section) => section.id === value);
}

export function stepStatsSection(section: StatsSection, delta: 1 | -1): StatsSection {
  const index = STATS_SECTIONS.findIndex((entry) => entry.id === section);
  const count_ = STATS_SECTIONS.length;
  return STATS_SECTIONS[(index + delta + count_) % count_]?.id ?? DEFAULT_STATS_SECTION;
}

const SECTION_BAR_LEAD = "  ";
const SECTION_BAR_SEPARATOR = " / ";

export function sectionBar(active: StatsSection, width: number, p: Palette): string {
  const full = `${SECTION_BAR_LEAD}${STATS_SECTIONS.map((section) => (section.id === active ? p.strong(section.title) : p.dim(section.title))).join(p.dim(SECTION_BAR_SEPARATOR))}`;
  if (visibleWidth(full) <= width) return full;
  const index = STATS_SECTIONS.findIndex((section) => section.id === active);
  const title = STATS_SECTIONS[index]?.title ?? "";
  return `  ${p.strong(title)}${p.dim(` (${index + 1}/${STATS_SECTIONS.length})`)}`;
}

export function statsSectionAt(line: string, x: number): StatsSection | undefined {
  const titles = STATS_SECTIONS.map((section) => section.title);
  const barText = SECTION_BAR_LEAD + titles.join(SECTION_BAR_SEPARATOR);
  if (stripVTControlCharacters(line).trimEnd() !== barText) return undefined;
  let column = SECTION_BAR_LEAD.length;
  for (const section of STATS_SECTIONS) {
    const width = visibleWidth(section.title);
    if (x >= column && x < column + width) return section.id;
    column += width + SECTION_BAR_SEPARATOR.length;
  }
  return undefined;
}

export type StatsFormatOptions = {
  period: Period;
  scope: Scope;
  expanded: boolean;
  style?: SessionInfoStyle;
  now: number;
  scan: StatsScanSummary;
  width?: number;
  modelNames?: ModelNameLookup;
  section?: StatsSection;
};

export type SectionContext = {
  report: StatsReport;
  options: StatsFormatOptions;
  layout: Layout;
  p: Palette;
  names: ModelNameLookup | undefined;
  providerSuffix: boolean;
  modelColours: ColourMap;
  timeline: Timeline;
};

export function fit(text: string, width: number): string {
  let shown = text;
  if (visibleWidth(text) > width) {
    shown = "";
    for (const char of text) {
      if (visibleWidth(shown + char) > width - 1) break;
      shown += char;
    }
    shown += "…";
  }
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
}

export function withoutSuffix(label: string): string {
  const paren = label.lastIndexOf(" (");
  return paren > 0 && label.endsWith(")") ? label.slice(0, paren) : label;
}

export function fitLabel(label: string, width: number, suffixed = false): string {
  if (visibleWidth(label) <= width) return fit(label, width);
  return fit(suffixed ? withoutSuffix(label) : label, width);
}

export function providerSuffixFits(
  layout: Pick<Layout, "label">,
  labels: readonly { text: string; extra: number }[],
): boolean {
  return labels.every((label) => visibleWidth(label.text) + label.extra <= layout.label - 2);
}

export type SuffixMode = "none" | "keep" | "drop";

export function fitLabels(labels: readonly string[], width: number, mode: SuffixMode): string[] {
  const dropAll =
    mode === "drop" || (mode === "keep" && labels.some((label) => visibleWidth(label) > width));
  return labels.map((label) => fit(dropAll ? withoutSuffix(label) : label, width));
}

export function shortenToFit(names: readonly string[], budget: number): string[] {
  const out = [...names];
  if (budget < 0) return out;
  const total = (): number => out.reduce((sum, name) => sum + visibleWidth(name), 0);
  while (total() > budget) {
    let longest = 0;
    out.forEach((name, index) => {
      if (visibleWidth(name) > visibleWidth(out[longest] ?? "")) longest = index;
    });
    const name = out[longest] ?? "";
    if (visibleWidth(name) <= 4) break;
    out[longest] = fit(name, visibleWidth(name) - 1).trimEnd();
  }
  return out;
}

export function right(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function rate(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(1);
}

export function millis(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

export function bar(
  share: number,
  width: number,
  filledStyle: (s: string) => string,
  p: Palette,
): string {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width);
  return filledStyle("█".repeat(filled)) + p.dim("░".repeat(width - filled));
}

export function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  const monthIndex = Number(month) - 1;
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const name = names[monthIndex];
  return name === undefined ? day : `${name} ${Number(date)}`;
}

export function clockHour(at: number): string {
  return `${String(new Date(at).getHours()).padStart(2, "0")}:00`;
}

export function bucketLabel(timeline: Timeline, key: string): string {
  return timeline.unit === "day" ? shortDay(key) : clockHour(Number(key));
}

export function timelineTicks(timeline: Timeline): string[] {
  const window = timeline.keys.length;
  const every = timeline.unit === "hour" ? 6 : window <= 10 ? 1 : 7;
  const last = timeline.unit === "hour" ? "now" : "today";
  return timeline.keys.map((key, index) =>
    index === window - 1
      ? last
      : index % every === 0 && index < window - 3
        ? bucketLabel(timeline, key)
        : "",
  );
}

export function rowLabel(
  key: string,
  names: ModelNameLookup | undefined,
  isModel: boolean,
): string {
  if (!isModel) return key;
  const slash = key.indexOf("/");
  if (slash < 0) return key;
  return modelRowLabel(key.slice(0, slash), key.slice(slash + 1), names);
}

export function packedDim(items: readonly string[], layout: Layout, p: Palette): string[] {
  const out: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current === "" ? `  ${item}` : `${current} · ${item}`;
    if (current !== "" && visibleWidth(next) > layout.width) {
      out.push(p.dim(current));
      current = `  ${item}`;
    } else current = next;
  }
  if (current !== "") out.push(p.dim(current));
  return out;
}
