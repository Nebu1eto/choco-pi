import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCost, formatTokens, type SessionInfoStyle } from "../session-usage.ts";
import {
  dayKey,
  periodDays,
  periodLabel,
  scopeLabel,
  type Breakdown,
  type DayBucket,
  type Period,
  type Scope,
  type SpeedRow,
  type StatsReport,
} from "./aggregate.ts";
import {
  isMcpFeature,
  isNamedToolFeature,
  FEATURE_CODE_MODE,
  FEATURE_OTHER_TOOLS,
} from "./features.ts";
import { modelRowLabel, providerDisplayName, type ModelNameLookup } from "./names.ts";
import { MIN_CONFIDENT_SAMPLES } from "./estimate.ts";
import { lineChart, type ChartSeries } from "./chart.ts";
import { totalTokens } from "./records.ts";

/** Narrowest layout the body is designed for; below it columns are dropped further but rows still fit. */
export const STATS_MIN_WIDTH = 40;
/** Width used when a caller renders without a terminal (RPC text, tests). */
export const STATS_DEFAULT_WIDTH = 80;

const MIN_BAR = 6;
/** How far the share bar shrinks to let the longest model name show whole. */
const MIN_BAR_SQUEEZED = 4;
const MAX_BAR = 32;
/** Label width the layout protects before it lets the bar grow. */
const PREFERRED_LABEL = 24;
const MAX_LABEL = 36;
const MAX_SPEED_LABEL = 40;
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** Rows a collapsed breakdown shows; Ctrl+O shows the rest, as the Context tab does with its inventories. */
const COLLAPSED_ROWS = 5;
/** Width of the token scale printed left of the daily chart. */
const CHART_GUTTER = 7;

/**
 * Theme foreground tokens that read as distinct series colours on the
 * bundled themes, ordered so that neighbouring ranks alternate hue families
 * (blue, yellow, green, red, purple, orange, cyan, …): the first row of a
 * table is drawn in the first token, the second in the second, and so on.
 */
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

/** The theme token the row at `rank` (0-based) of a table is drawn in. */
export function seriesToken(rank: number): (typeof SERIES_TOKENS)[number] {
  return (
    SERIES_TOKENS[((rank % SERIES_TOKENS.length) + SERIES_TOKENS.length) % SERIES_TOKENS.length] ??
    "accent"
  );
}

/**
 * Column plan for one width. Fixed-width numeric columns come first, the label
 * takes a share of what is left and the bar the rest; at narrow widths the
 * least useful columns are dropped so that no row ever wraps.
 */
type Layout = {
  width: number;
  label: number;
  /** Share bar width; 0 hides the bar. */
  bar: number;
  tokens: boolean;
  cost: boolean;
  /** Show in/out token columns next to each bar row (wide layouts only). */
  inOut: boolean;
  /** Throughput table: show the TTFT p90 column. */
  speedWide: boolean;
  /** Put one fact per line in the summary and header so nothing wraps. */
  compact: boolean;
  /** Daily chart height in rows; 0 falls back to the sparkline. */
  chartRows: number;
  /** Columns a breakdown row occupies; the chart ends at the same edge. */
  tableWidth: number;
};

/**
 * `wantLabel` is the widest label the tables would like to show whole (swatch
 * included); the bar gives up cells down to a floor so that it fits.
 */
function layoutFor(width: number, wantLabel = 0): Layout {
  const cost = width >= 40;
  const tokens = width >= 48;
  const inOut = width >= 120;
  const fixed = 2 + 1 + 6 + (tokens ? 8 : 0) + (cost ? 11 : 0) + (inOut ? 16 : 0);
  const free = Math.max(13, width - fixed);
  // The label comes first: it is what tells rows apart. The bar takes what is
  // left after a readable label, shrinks to MIN_BAR, and disappears below 48.
  let bar = width < 48 ? 0 : Math.max(MIN_BAR, Math.min(MAX_BAR, Math.floor((free - 1) * 0.4)));
  if (bar > 0 && free - 1 - bar < PREFERRED_LABEL)
    bar = Math.max(MIN_BAR, free - 1 - PREFERRED_LABEL);
  const wanted = Math.min(MAX_LABEL, wantLabel);
  if (bar > 0 && free - 1 - bar < wanted) bar = Math.max(MIN_BAR_SQUEEZED, free - 1 - wanted);
  const label = Math.max(8, Math.min(MAX_LABEL, bar > 0 ? free - 1 - bar : free));
  // Odd heights keep the y-axis labels on every other level.
  const chartRows = width < 48 ? 0 : width < 64 ? 5 : width < 80 ? 7 : 9;
  // 2 indent + label + bar + the numeric columns (fixed counts the indent and one separator).
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

/**
 * Row colours. The dialog paints its box in the border colour, so body text
 * must name its own colour the way the Status tab does: facts in `text`,
 * secondary notes in `dim`, headings in `accent`, key totals in `warning`,
 * and each series (model, feature, provider) in its own theme token.
 */
type SpeedFigures = {
  /** Generation speed in output tokens per second (after the first token). */
  gen: number | undefined;
  ttft: number | undefined;
  p90: number | undefined;
  /** Source note beside the timing cells; empty for recorded timings. */
  marker: string;
  /** True when the timing cells come from the fit. */
  fitted?: boolean;
  /** Fewer than 25 calls: the whole row is indicative only. */
  low: boolean;
};

type Palette = {
  heading: (text: string) => string;
  text: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  strong: (text: string) => string;
  key: (text: string) => string;
  series: (rank: number, text: string) => string;
};

function paletteOf(style: SessionInfoStyle | undefined): Palette {
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
  /** Calls counted after deduplication, over every period. */
  calls: number;
  /** Fork or rewind copies dropped by deduplication. */
  duplicates: number;
};

/** Series colour per key, as a rank into SERIES_TOKENS; built once per table family. */
export type ColourMap = ReadonlyMap<string, number>;

/** Ranks keys in the given order; keys past the palette wrap. */
export function colourMapOf(keys: readonly string[]): ColourMap {
  return new Map(keys.map((key, rank) => [key, rank]));
}

export type StatsFormatOptions = {
  period: Period;
  scope: Scope;
  expanded: boolean;
  style?: SessionInfoStyle;
  now: number;
  scan: StatsScanSummary;
  /** Columns available to the body; defaults to STATS_DEFAULT_WIDTH. */
  width?: number;
  /** Display names from the model registry; unknown models get a formatted id. */
  modelNames?: ModelNameLookup;
};

/** Pad or truncate plain text to exactly `width` columns without adding escape codes. */
function fit(text: string, width: number): string {
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

/**
 * A row label that fits `width`: the full label when it fits; a label with a
 * provider suffix (`Claude Opus 5.5 (Anthropic)`) then drops the suffix, and
 * what is left is cut at the end with an ellipsis, so the model name is what
 * survives. Feature labels have no suffix and are cut directly.
 */
export function fitLabel(label: string, width: number, suffixed = false): string {
  if (visibleWidth(label) <= width) return fit(label, width);
  return fit(suffixed ? withoutSuffix(label) : label, width);
}

/** The label without its parenthesised provider suffix, if it has one. */
export function withoutSuffix(label: string): string {
  const paren = label.lastIndexOf(" (");
  return paren > 0 && label.endsWith(")") ? label.slice(0, paren) : label;
}

/**
 * Whether model labels keep their "(Provider)" suffix at this width: only
 * when every suffixed label, with the Fast tag its Throughput row carries,
 * fits the breakdown tables' label column. Decided once per body, so By
 * model and Throughput agree at every width.
 */
export function providerSuffixFits(
  layout: Pick<Layout, "label">,
  labels: readonly { text: string; extra: number }[],
): boolean {
  return labels.every((label) => visibleWidth(label.text) + label.extra <= layout.label - 2);
}

/**
 * Labels of one table fitted to `width` as a set: when the body keeps provider
 * suffixes (`suffixed`) but a label still would not fit, every label in the
 * table drops it, so the column reads uniformly; without suffixes they are
 * dropped up front.
 */
export type SuffixMode =
  /** Labels carry no provider suffix (feature, provider, code-mode rows): fit as written. */
  | "none"
  /** Model labels in a body that keeps suffixes: drop them as a set only if one would not fit. */
  | "keep"
  /** Model labels in a body that omits suffixes. */
  | "drop";

export function fitLabels(labels: readonly string[], width: number, mode: SuffixMode): string[] {
  const dropAll =
    mode === "drop" || (mode === "keep" && labels.some((label) => visibleWidth(label) > width));
  return labels.map((label) => fit(dropAll ? withoutSuffix(label) : label, width));
}

function right(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function rate(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(1);
}

function millis(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

function bar(share: number, width: number, filledStyle: (s: string) => string, p: Palette): string {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width);
  return filledStyle("█".repeat(filled)) + p.dim("░".repeat(width - filled));
}

function shortDay(day: string): string {
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

/** The label a breakdown row shows: a friendly model name for model keys, the feature name otherwise. */
function rowLabel(key: string, names: ModelNameLookup | undefined, isModel: boolean): string {
  if (!isModel) return key;
  const slash = key.indexOf("/");
  if (slash < 0) return key;
  return modelRowLabel(key.slice(0, slash), key.slice(slash + 1), names);
}

/** Fold surplus per-tool rows into one "other" row; MCP server rows are always kept. */
function foldTools(rows: readonly Breakdown[], limit: number): Breakdown[] {
  if (rows.length <= limit) return [...rows];
  const pinned = rows.filter((row, index) => index >= limit && isMcpFeature(row.key));
  const kept = [...rows.slice(0, limit), ...pinned];
  const rest = rows.slice(limit).filter((row) => !isMcpFeature(row.key));
  if (rest.length === 0) return kept;
  const folded: Breakdown = {
    key: rest.every((row) => isNamedToolFeature(row.key)) ? FEATURE_OTHER_TOOLS : "other",
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    share: 0,
  };
  for (const row of rest) {
    folded.calls += row.calls;
    folded.tokens.input += row.tokens.input;
    folded.tokens.output += row.tokens.output;
    folded.tokens.cacheRead += row.tokens.cacheRead;
    folded.tokens.cacheWrite += row.tokens.cacheWrite;
    folded.cost += row.cost;
    folded.share += row.share;
  }
  kept.push(folded);
  return kept;
}

/**
 * A breakdown table. Collapsed, it shows the top rows and names how many are
 * hidden; expanded, every row with a detail line beneath it.
 */
function breakdownRows(
  rows: readonly Breakdown[],
  expanded: boolean,
  p: Palette,
  layout: Layout,
  names: ModelNameLookup | undefined,
  isModel: boolean,
  colours: ColourMap | undefined,
  nested: ReadonlyMap<string, readonly Breakdown[]> = new Map(),
  suffixed = isModel,
): string[] {
  const dim = p.dim;
  if (rows.length === 0) return [dim("  (no calls in this period)")];
  const lines: string[] = [];
  // Collapsed: the top rows plus every MCP server row (the point of the feature
  // view), then one line counting the rest. Expanded: everything, surplus
  // per-tool rows folded into one.
  const shown = expanded
    ? foldTools(rows, 12)
    : rows.filter((row, index) => index < COLLAPSED_ROWS || isMcpFeature(row.key));
  if (layout.inOut) {
    lines.push(
      dim(
        [
          `  ${fit("", layout.label)}`,
          ...(layout.bar > 0 ? [fit("", layout.bar)] : []),
          right("share", 6),
          right("tokens", 7),
          right("in", 7),
          right("out", 7),
          right("cost", 10),
        ].join(" "),
      ),
    );
  }
  const labels = fitLabels(
    shown.map((row) => rowLabel(row.key, names, isModel)),
    layout.label - 2,
    isModel ? (suffixed ? "keep" : "drop") : "none",
  );
  shown.forEach((row, rank) => {
    const tint = (text: string): string => p.series(colours?.get(row.key) ?? rank, text);
    const cells = [tint("  ●") + p.text(` ${labels[rank] ?? ""}`)];
    if (layout.bar > 0) cells.push(bar(row.share, layout.bar, tint, p));
    cells.push(p.text(right(percent(row.share), 6)));
    if (layout.tokens) cells.push(p.text(right(formatTokens(totalTokens(row.tokens)), 7)));
    if (layout.inOut)
      cells.push(
        dim(right(formatTokens(row.tokens.input), 7)),
        dim(right(formatTokens(row.tokens.output), 7)),
      );
    if (layout.cost) cells.push(p.text(right(formatCost(row.cost), 10)));
    lines.push(cells.join(" "));
    if (expanded) {
      const parts = [`${count(row.calls)} calls`];
      if (!layout.inOut)
        parts.push(
          `in ${formatTokens(row.tokens.input)}`,
          `out ${formatTokens(row.tokens.output)}`,
        );
      parts.push(
        `cache ${formatTokens(row.tokens.cacheRead)} read / ${formatTokens(row.tokens.cacheWrite)} write`,
      );
      lines.push(dim(`    ${fit(parts.join(" · "), layout.width - 4).trimEnd()}`));
    }
    const children = nested.get(row.key) ?? [];
    if (children.length > 0) lines.push(...nestedRows(children, expanded, p, layout, tint));
  });
  const rest = rows.filter((row) => !shown.includes(row));
  if (!expanded && rest.length > 0) {
    const share = rest.reduce((sum, row) => sum + row.share, 0);
    const restCost = rest.reduce((sum, row) => sum + row.cost, 0);
    lines.push(
      dim(
        `  ${count(rest.length)} more (${percent(share)} · ${formatCost(restCost)}) · Ctrl+O shows all`,
      ),
    );
  }
  return lines;
}

/** Day keys for the last `window` calendar days ending today, oldest first. */
function windowDays(window: number, now: number): string[] {
  const keys: string[] = [];
  for (let offset = window - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    keys.push(dayKey(date.getTime()));
  }
  return keys;
}

/**
 * One column per day, `rows` cells tall: the busiest day fills every row,
 * quieter days fill from the bottom with ▁▂▃ steps. Empty days render as a
 * dot on the bottom row. Returns top row first.
 */
export function sparklineRows(
  days: readonly DayBucket[],
  window: number,
  now: number,
  rows: number,
  p: Palette = paletteOf(undefined),
): string[] {
  const byDay = new Map(days.map((bucket) => [bucket.day, bucket.tokens]));
  const peak = Math.max(0, ...days.map((bucket) => bucket.tokens));
  const steps = SPARK_CHARS.length;
  const columns = windowDays(window, now).map((key) => {
    const tokens = byDay.get(key) ?? 0;
    return tokens <= 0 || peak <= 0 ? 0 : Math.max(1, Math.ceil((tokens / peak) * rows * steps));
  });
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

/** The single-row sparkline. */
export function sparkline(
  days: readonly DayBucket[],
  window: number,
  now: number,
  p: Palette = paletteOf(undefined),
): string {
  return sparklineRows(days, window, now, 1, p)[0] ?? "";
}

/**
 * Shorten names so their total visible width fits `budget`, trimming the longest
 * name one column at a time (with an ellipsis). A negative budget leaves them.
 */
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

/** The dim axis under the sparkline: first day at the left, "today" at the right. */
export function sparklineAxis(window: number, now: number): string {
  const first = new Date(now);
  first.setDate(first.getDate() - (window - 1));
  const left = shortDay(dayKey(first.getTime()));
  const label = "today";
  const gap = Math.max(1, window - visibleWidth(left) - visibleWidth(label));
  return `${left}${" ".repeat(gap)}${label}`;
}

/** The chart series: the top models of the period by tokens, plus everything else. */
const CHART_SERIES = 3;

/** The model keys the chart draws as their own line, in rank order. */
export function chartModelKeys(report: StatsReport): string[] {
  return report.byModel.slice(0, CHART_SERIES).map((row) => row.key);
}

/**
 * The "Tokens per day" line chart with its legend: one line per top model in
 * that model's colour, a dim "other" line when the remaining models carry
 * tokens, every day of the window plotted (zero days at the baseline).
 */
export function tokensPerDayChart(
  report: StatsReport,
  window: number,
  now: number,
  layout: Layout,
  p: Palette,
  names: ModelNameLookup | undefined,
  colours: ColourMap,
): string[] {
  const keys = windowDays(window, now);
  const tops = chartModelKeys(report);
  const seriesFor = (modelKey: string): number[] => {
    const byDay = report.byModelDay.get(modelKey);
    return keys.map((day) => byDay?.get(day) ?? 0);
  };
  const totals = keys.map((day) => report.byDay.find((bucket) => bucket.day === day)?.tokens ?? 0);
  const other = keys.map((day, index) => {
    const total = totals[index] ?? 0;
    const topSum = tops.reduce((sum, key) => sum + (seriesFor(key)[index] ?? 0), 0);
    return Math.max(0, total - topSum);
  });
  // The all-model total leads: heavy glyphs in the bold text colour, stagger
  // slot 0. It is never below a model line, so it owns every overlap; a model
  // segment it hides is exactly where the total runs.
  const series: ChartSeries[] = [
    { values: totals, paint: p.strong, weight: "heavy" },
    ...tops.map((key) => ({
      values: seriesFor(key),
      paint: (text: string) => p.series(colours.get(key) ?? 0, text),
    })),
  ];
  const hasOther = other.some((value) => value > 0);
  if (hasOther) series.push({ values: other, paint: p.dim });
  const tickEvery = window <= 10 ? 1 : 7;
  // A dated tick every week from the left; the last column is always "today"
  // and the tick before it is dropped when it would crowd the label.
  const ticks = keys.map((day, index) =>
    index === window - 1
      ? "today"
      : index % tickEvery === 0 && index < window - 3
        ? shortDay(day)
        : "",
  );
  const lines = lineChart(series, {
    rows: layout.chartRows,
    width: layout.tableWidth,
    gutter: CHART_GUTTER,
    ticks,
    dim: p.dim,
  });
  // Legend entries share the row: each name gets an equal slice of the width.
  const entries = 1 + tops.length + (hasOther ? 1 : 0);
  // Legend names are shortened only when the joined row would not fit, longest first.
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

/** The Fast tag of a model row, styled: on in the key colour, unknown as a question, off dim. */
function fastTag(row: SpeedRow, p: Palette, compact: boolean): string {
  if (row.fast === undefined) return "";
  const sep = compact ? " " : " · ";
  if (row.fast === "on") return p.dim(sep) + p.key("fast");
  if (row.fast === "unknown") return p.dim(sep) + p.key("fast?");
  return p.dim(sep + (compact ? "std" : "standard"));
}

function fastTagWidth(row: SpeedRow, compact: boolean): number {
  if (row.fast === undefined) return 0;
  const sep = compact ? 1 : 3;
  if (row.fast === "on") return sep + 4;
  if (row.fast === "unknown") return sep + 5;
  return sep + (compact ? 3 : 8);
}

/**
 * What a row shows for tok/s and TTFT: recorded timings when it has any,
 * else the fit, with a marker naming the source. A row under 25 calls says
 * so in words whatever its source ("(low sample)", or the short form the
 * caller passes when the table is tight), so a thin row is never mistaken
 * for a measured one and never silently dropped.
 */
function speedFigures(row: SpeedRow, low: string, narrow: boolean): SpeedFigures {
  const thin = row.calls < MIN_CONFIDENT_SAMPLES;
  if (row.timedCalls > 0)
    return {
      gen: row.generationTokPerSec,
      ttft: row.ttftMedianMs,
      p90: row.ttftP90Ms,
      marker: thin ? low : "",
      low: thin,
    };
  const estimate = row.estimate;
  if (estimate === undefined)
    return { gen: undefined, ttft: undefined, p90: undefined, marker: thin ? low : "", low: thin };
  return {
    gen: estimate.tokPerSec,
    ttft: estimate.ttftMs,
    p90: undefined,
    // Narrow tables keep the parenthetical and let the note line say "fitted".
    marker: thin ? (narrow ? low : `est. ${low}`) : "est.",
    fitted: true,
    low: thin,
  };
}

/** The low-sample wording, long when it fits the table, else short. */
export const LOW_SAMPLE_LONG = "(low sample)";
export const LOW_SAMPLE_SHORT = "(low n)";

/** A rendered throughput table and which markers it used, for the legend. */
type SpeedTable = { lines: string[]; low: string; anyLow: boolean; anyFitted: boolean };

type SpeedColumns = {
  figures: SpeedFigures[];
  ttftColumn: boolean;
  p90Column: boolean;
  markerText: number;
  markerWidth: number;
  labelWidth: number;
  /** Numeric columns sized to their widest value (at least the header), one gap apart. */
  callsWidth: number;
  rateWidth: number;
  ttftWidth: number;
  p90Width: number;
};

/**
 * Column widths for the throughput table given the low-sample wording. The
 * label column wants the widest suffix-dropped label with its Fast tag; the
 * bar gives up cells down to its squeezed minimum for that, as By model does.
 */
function speedColumns(
  rows: readonly SpeedRow[],
  layout: Layout,
  low: string,
  wantLabel: number,
  fullLabel: number,
): SpeedColumns {
  const wide = layout.speedWide;
  const narrow = !wide;
  const figures = rows.map((row) => speedFigures(row, low, narrow));
  const recorded = rows.some((row) => row.timedCalls > 0);
  const estimated = figures.some((figure) => figure.marker !== "");
  const markerText = Math.max(0, ...figures.map((figure) => visibleWidth(figure.marker)));
  // tok/s is the generation speed, so it exists only where TTFT does: recorded
  // or fitted. Below 48 columns only calls and tok/s fit beside a readable
  // label; TTFT stays out until some row has a figure, p90 until one is recorded.
  const timing = recorded || estimated;
  const ttftColumn = layout.width >= 48 && timing;
  const p90Column = wide && recorded;
  const markerWidth = estimated && ttftColumn ? 1 + markerText : 0;
  const callsWidth = Math.max(5, ...rows.map((row) => count(row.calls).length));
  const rateWidth = Math.max(5, ...figures.map((figure) => rate(figure.gen).length));
  const ttftWidth = Math.max(4, ...figures.map((figure) => millis(figure.ttft).length));
  const p90Width = Math.max(
    3,
    ...figures.map((figure) => (figure.fitted === true ? 0 : millis(figure.p90).length)),
  );
  const gap = 2;
  const fixed =
    2 +
    gap +
    callsWidth +
    gap +
    rateWidth +
    (ttftColumn ? gap + ttftWidth : 0) +
    (p90Column ? gap + p90Width : 0) +
    (markerWidth > 0 ? markerWidth + 1 : 0);
  // No bar column: the label takes what the numbers leave, up to the widest
  // full label (provider suffix included) the table has.
  const free = Math.max(13, layout.width - fixed);
  const labelWidth = Math.max(8, Math.min(MAX_SPEED_LABEL, Math.max(wantLabel, fullLabel), free));
  return {
    figures,
    ttftColumn,
    p90Column,
    markerText,
    markerWidth,
    labelWidth,
    callsWidth,
    rateWidth,
    ttftWidth,
    p90Width,
  };
}

/** How many nested code-mode rows the collapsed view shows under their parent. */
const COLLAPSED_NESTED_ROWS = 3;

/**
 * Nested rows under a feature row ("└ exec/shell"): the parent's colour,
 * the same columns, shares of the grand total. Collapsed shows the first few
 * and one line counting the rest; expanded shows every row.
 */
function nestedRows(
  rows: readonly Breakdown[],
  expanded: boolean,
  p: Palette,
  layout: Layout,
  tint: (text: string) => string,
): string[] {
  const dim = p.dim;
  const shown = expanded ? rows : rows.slice(0, COLLAPSED_NESTED_ROWS);
  const labels = fitLabels(
    shown.map((row) => row.key),
    layout.label - 4,
    "none",
  );
  const lines = shown.map((row, index) => {
    const cells = [tint("    └") + p.text(` ${labels[index] ?? ""}`)];
    if (layout.bar > 0) cells.push(bar(row.share, layout.bar, tint, p));
    cells.push(p.text(right(percent(row.share), 6)));
    if (layout.tokens) cells.push(p.text(right(formatTokens(totalTokens(row.tokens)), 7)));
    if (layout.inOut)
      cells.push(
        dim(right(formatTokens(row.tokens.input), 7)),
        dim(right(formatTokens(row.tokens.output), 7)),
      );
    if (layout.cost) cells.push(p.text(right(formatCost(row.cost), 10)));
    return cells.join(" ");
  });
  const rest = rows.slice(shown.length);
  if (rest.length > 0) {
    const share = rest.reduce((sum, row) => sum + row.share, 0);
    const restCost = rest.reduce((sum, row) => sum + row.cost, 0);
    lines.push(
      dim(`      ${count(rest.length)} more (${percent(share)} · ${formatCost(restCost)})`),
    );
  }
  return lines;
}

/**
 * One throughput table. Columns: label (with the Fast tag on model rows), a
 * calls, tok/s (generation speed: output tokens over the time after the first
 * token) and TTFT: recorded timings
 * when the row has any, otherwise the Theil-Sen fit marked "est." ("~est."
 * below the confident sample). A p90 column appears only when some row has
 * recorded timings.
 */
function speedTable(
  rows: readonly SpeedRow[],
  p: Palette,
  layout: Layout,
  label: (row: SpeedRow) => string,
  suffix: SuffixMode,
  colours: ColourMap | undefined,
): SpeedTable {
  const dim = p.dim;
  if (rows.length === 0)
    return {
      lines: [dim("  (no calls with output)")],
      low: LOW_SAMPLE_LONG,
      anyLow: false,
      anyFitted: false,
    };
  const wide = layout.speedWide;
  const narrow = !wide;
  // The widest label the table would like whole: suffix dropped, Fast tag on.
  const wantLabel =
    2 +
    Math.max(
      0,
      ...rows.map(
        (row) => visibleWidth(withoutSuffix(label(row)).trimEnd()) + fastTagWidth(row, !wide),
      ),
    );
  // Long low-sample wording whenever the table still fits its labels; else short.
  const fullLabel =
    2 +
    Math.max(
      0,
      ...rows.map(
        (row) =>
          visibleWidth(suffix === "drop" ? withoutSuffix(label(row)) : label(row)) +
          fastTagWidth(row, false),
      ),
    );
  let columns = speedColumns(rows, layout, LOW_SAMPLE_LONG, wantLabel, fullLabel);
  if (columns.labelWidth < Math.min(MAX_SPEED_LABEL, wantLabel))
    columns = speedColumns(rows, layout, LOW_SAMPLE_SHORT, wantLabel, fullLabel);
  const {
    figures,
    ttftColumn,
    p90Column,
    markerText,
    markerWidth,
    labelWidth,
    callsWidth,
    rateWidth,
    ttftWidth,
    p90Width,
  } = columns;
  const low = figures.some((figure) => figure.marker.includes(LOW_SAMPLE_LONG))
    ? LOW_SAMPLE_LONG
    : LOW_SAMPLE_SHORT;
  // One gap between columns; the header shares every width so it sits over
  // the values.
  const cells = (values: string[]): string => values.join("  ");
  const headerCells = [`  ${fit("", labelWidth)}`];
  headerCells.push(right("calls", callsWidth), right("tok/s", rateWidth));
  if (ttftColumn) headerCells.push(right("TTFT", ttftWidth));
  if (p90Column) headerCells.push(right("p90", p90Width));
  if (markerWidth > 0) headerCells.push(fit("", markerText));
  const lines = [dim(cells(headerCells))];
  const figure = (value: string, width: number, soft: boolean): string =>
    value === "n/a" || soft ? dim(right(value, width)) : p.text(right(value, width));
  // The Fast tag is part of the label column: the name gives way to it, and
  // the short tags are used whenever the column is too narrow for the long ones.
  // Long tags whenever the column has room for every tagged label as written.
  const compactTags =
    narrow ||
    rows.some(
      (row) =>
        visibleWidth(suffix === "drop" ? withoutSuffix(label(row)) : label(row)) +
          fastTagWidth(row, false) >
        labelWidth - 2,
    );
  const labels = fitLabels(
    rows.map((row) => label(row)),
    labelWidth - 2,
    suffix,
  ).map((text, index) => {
    const row = rows[index];
    const tag = row === undefined ? 0 : fastTagWidth(row, compactTags);
    return tag === 0 ? text : fit(withoutSuffix(text).trimEnd(), labelWidth - 2 - tag);
  });
  rows.forEach((row, rank) => {
    const figure_ = figures[rank] ?? speedFigures(row, low, narrow);
    // A thin row dims every number, not only the timing cells.
    const soft = figure_.low;
    const tint = (text: string): string => p.series(colours?.get(row.model) ?? rank, text);
    const name = labels[rank] ?? "";
    const rowCells = [tint("  ●") + p.text(` ${name.trimEnd()}`) + fastTag(row, p, compactTags)];
    // Pad the label cell back to its column width after the styled tag.
    const used = 3 + 1 + visibleWidth(name.trimEnd()) + fastTagWidth(row, compactTags);
    rowCells[0] = (rowCells[0] ?? "") + " ".repeat(Math.max(0, 2 + labelWidth - used));
    rowCells.push(
      figure(count(row.calls), callsWidth, soft),
      figure(rate(figure_.gen), rateWidth, soft),
    );
    if (ttftColumn) rowCells.push(figure(millis(figure_.ttft), ttftWidth, soft));
    // The fit yields no p90; the cell stays blank rather than claiming n/a.
    if (p90Column)
      rowCells.push(
        figure_.fitted === true ? fit("", p90Width) : figure(millis(figure_.p90), p90Width, soft),
      );
    if (markerWidth > 0) rowCells.push(dim(fit(figure_.marker, markerText)));
    lines.push(cells(rowCells));
  });
  return {
    lines,
    low,
    // Only markers the table shows get a legend line.
    anyLow: markerWidth > 0 && figures.some((figure) => figure.low),
    anyFitted: markerWidth > 0 && figures.some((figure) => figure.fitted === true),
  };
}

/**
 * The Statistics tab body laid out for `options.width` columns; no line
 * exceeds it. Collapsed, it reports the totals, the daily chart, the top of
 * each breakdown and throughput by provider; expanded (Ctrl+O), every row
 * with its detail line, throughput by model, and the footnotes, the way the
 * Context tab appends its inventories.
 */
export function formatStats(report: StatsReport, options: StatsFormatOptions): string {
  const width = Math.max(STATS_MIN_WIDTH, Math.floor(options.width ?? STATS_DEFAULT_WIDTH));
  const names = options.modelNames;
  const longestModelName = Math.max(
    0,
    ...report.byModel.map((row) => visibleWidth(withoutSuffix(rowLabel(row.key, names, true)))),
  );
  const layout = layoutFor(width, longestModelName + 2);
  // One decision for every model table in the body (By model, Throughput).
  const providerSuffix = providerSuffixFits(layout, [
    ...report.byModel.map((row) => ({ text: rowLabel(row.key, names, true), extra: 0 })),
    ...report.speed.byModel.map((row) => ({
      text: rowLabel(row.model, names, true),
      extra: fastTagWidth(row, false),
    })),
  ]);
  const p = paletteOf(options.style);
  const { heading, dim } = p;
  const lines: string[] = [];

  const facts = (items: string[]): string[] =>
    layout.compact
      ? items.map((item) => p.text(`  ${item}`))
      : [p.text(`  ${items.join(dim(" · "))}`)];
  lines.push(
    heading("Statistics") + dim(` · ${periodLabel(options.period)} · ${scopeLabel(options.scope)}`),
  );
  const scanned = [
    `Scanned ${count(options.scan.sessions)} sessions (${count(options.scan.files)} files)`,
    `${count(options.scan.calls)} calls`,
  ];
  lines.push(...(layout.compact ? scanned.map((item) => dim(item)) : [dim(scanned.join(" · "))]));
  lines.push("");

  lines.push(heading("Summary"));
  const cost = report.recordedCost + report.estimatedCost;
  lines.push(
    p.text(
      `  Total tokens ${p.key(formatTokens(totalTokens(report.tokens)))}${dim(" · ")}Cost ${p.key(formatCost(cost))}`,
    ),
  );
  if (report.estimatedCalls > 0)
    lines.push(
      dim(
        `  ${formatCost(report.estimatedCost)} of it estimated at current list prices (${count(report.estimatedCalls)} calls)`,
      ),
    );
  if (report.unpricedCalls > 0)
    lines.push(
      dim(
        `  ${count(report.unpricedCalls)} calls have no known price (${formatTokens(report.unpricedTokens)} tokens)`,
      ),
    );
  lines.push(
    ...facts([
      `Input ${formatTokens(report.tokens.input)}`,
      `Output ${formatTokens(report.tokens.output)}`,
      `Cache read ${formatTokens(report.tokens.cacheRead)}`,
      `Cache write ${formatTokens(report.tokens.cacheWrite)}`,
    ]),
  );
  lines.push(
    ...facts([
      `Calls ${count(report.calls)}`,
      `Failed ${count(report.failedCalls)}`,
      `Sessions ${count(report.sessions)}`,
      `Active days ${count(report.byDay.length)}`,
    ]),
  );
  lines.push("");

  const modelColours = colourMapOf(report.byModel.map((row) => row.key));
  const window = periodDays(options.period) ?? 60;
  lines.push(
    heading("Tokens per day") +
      dim(` (last ${window} days${layout.chartRows > 0 ? ", total and per model" : ""})`),
  );
  const peak = report.byDay.reduce<DayBucket | undefined>(
    (best, bucket) => (best === undefined || bucket.tokens > best.tokens ? bucket : best),
    undefined,
  );
  if (layout.chartRows > 0 && window <= layout.tableWidth - CHART_GUTTER) {
    lines.push(...tokensPerDayChart(report, window, options.now, layout, p, names, modelColours));
  } else {
    const sparkWindow = Math.min(window, width - 2);
    for (const row of sparklineRows(report.byDay, sparkWindow, options.now, 3, p))
      lines.push(`  ${row}`);
    lines.push(dim(`  ${sparklineAxis(sparkWindow, options.now)}`));
  }
  lines.push(
    dim(
      peak === undefined
        ? "  no activity"
        : `  busiest day ${shortDay(peak.day)} · ${formatTokens(peak.tokens)} tokens${layout.compact ? "" : ` · ${count(peak.calls)} calls`}`,
    ),
  );
  lines.push("");

  lines.push(heading("By model") + dim(" (share of tokens)"));
  lines.push(
    ...breakdownRows(
      report.byModel,
      options.expanded,
      p,
      layout,
      names,
      true,
      modelColours,
      new Map(),
      providerSuffix,
    ),
  );
  lines.push("");
  lines.push(heading("By feature") + dim(" (what triggered the call)"));
  lines.push(
    ...breakdownRows(
      report.byFeature,
      options.expanded,
      p,
      layout,
      names,
      false,
      undefined,
      new Map([[FEATURE_CODE_MODE, report.byCodeMode]]),
    ),
  );
  lines.push("");

  lines.push(
    heading("Context & Compaction") + dim(layout.compact ? "" : " (input + cache per call)"),
  );
  const context = report.context;
  // Rows share the breakdown tables' label and bar columns so they align.
  const contextRows: Array<[string, number]> = [
    ["≥100K", context.over100k],
    ["≥200K", context.over200k],
    ["≥400K", context.over400k],
  ];
  const contextLabel = layout.label - 2;
  contextRows.forEach(([name, calls], rank) => {
    const share = context.calls > 0 ? calls / context.calls : 0;
    const tint = (text: string): string => p.series(rank, text);
    const cells = [tint("  ●") + p.text(` ${fit(name, contextLabel)}`)];
    if (layout.bar > 0) cells.push(bar(share, layout.bar, tint, p));
    cells.push(
      p.text(right(percent(share), 6)),
      dim(right(layout.bar > 0 ? `${count(calls)} calls` : count(calls), layout.bar > 0 ? 11 : 6)),
    );
    lines.push(cells.join(" "));
  });
  // The remaining rows: a label column as wide as its longest label, then
  // the facts; facts that would overflow continue on an indented line.
  const factLabel = Math.min(contextLabel + 2, 14);
  const factColumn = 2 + factLabel + 1;
  const factRows = (label: string, facts: string[], tone: (text: string) => string): string[] => {
    const out: string[] = [];
    let current = "";
    for (const fact of facts) {
      const next = current === "" ? fact : `${current} · ${fact}`;
      if (current !== "" && factColumn + visibleWidth(next) > layout.width) {
        out.push(current);
        current = fact;
      } else current = next;
    }
    if (current !== "") out.push(current);
    // A single fact longer than the room left is cut rather than wrapped.
    const room = Math.max(8, layout.width - factColumn);
    return out.map((facts_, index) =>
      index === 0
        ? p.text(`  ${fit(label, factLabel)} `) + tone(fit(facts_, room).trimEnd())
        : tone(`${" ".repeat(factColumn)}${fit(facts_, room).trimEnd()}`),
    );
  };
  lines.push(
    ...factRows(
      "Median context",
      [
        p.key(formatTokens(context.medianContext ?? 0)),
        `p90 ${p.key(formatTokens(context.p90Context ?? 0))}`,
      ],
      p.text,
    ),
  );
  const compaction = report.compaction;
  const methods = compaction.byProvider.reduce(
    (sum, row) => ({
      builtIn: sum.builtIn + row.builtIn,
      serverSide: sum.serverSide + row.serverSide,
      host: sum.host + row.host,
      unknown: sum.unknown + row.unknown,
    }),
    { builtIn: 0, serverSide: 0, host: 0, unknown: 0 },
  );
  const methodFacts = [
    `built-in ${count(methods.builtIn)}`,
    `server-side ${count(methods.serverSide)}`,
    ...(methods.host > 0 ? [`pi host ${count(methods.host)}`] : []),
    ...(methods.unknown > 0 ? [`unknown ${count(methods.unknown)}`] : []),
  ];
  // Collapsed: manual · auto · unknown. Expanded: auto broken down by its
  // triggers (only the non-zero ones), unknown only for entries without a
  // recorded trigger.
  const by = compaction.autoBy;
  const autoAll: Array<[string, number]> = [
    ["threshold", by.threshold],
    ["overflow", by.overflow],
    ["idle", by.idle],
    ["context cap", by.contextCap],
  ];
  const autoParts = autoAll.filter(([, n]) => n > 0);
  const autoFact =
    options.expanded && autoParts.length > 0
      ? `auto ${count(compaction.auto)} (${autoParts.map(([name, n]) => `${name} ${count(n)}`).join(", ")})`
      : `auto ${count(compaction.auto)}`;
  const triggerFacts = [
    `manual ${count(compaction.manual)}`,
    autoFact,
    ...(compaction.unknownTrigger > 0 ? [`unknown ${count(compaction.unknownTrigger)}`] : []),
  ];
  lines.push(
    ...factRows("Compactions", [p.key(count(compaction.total)), ...methodFacts.map(dim)], p.text),
  );
  if (compaction.total > 0) lines.push(...factRows("Trigger", triggerFacts, p.text));
  if (compaction.fallbacks + compaction.noOps > 0)
    lines.push(
      ...factRows(
        "",
        [
          `${count(compaction.fallbacks)} native→built-in fallbacks`,
          `${count(compaction.noOps)} no-ops (nothing to summarize)`,
        ],
        dim,
      ),
    );

  if (options.expanded && compaction.byProvider.length > 0) {
    lines.push(p.text("  By provider"));
    const providerLabel = Math.max(10, Math.min(20, layout.label - 2));
    const cols: Array<[string, number]> = [
      ["built-in", 9],
      ["server", 7],
      ["host", 5],
      ["unknown", 8],
      ["fallbk", 7],
      ["no-op", 6],
    ];
    const shownCols = layout.width >= 64 ? cols : cols.slice(0, 2);
    lines.push(
      dim(
        [
          `  ${fit("", providerLabel)}`,
          ...shownCols.map(([name, width]) => right(name, width)),
        ].join(" "),
      ),
    );
    compaction.byProvider.forEach((row, rank) => {
      const values = [row.builtIn, row.serverSide, row.host, row.unknown, row.fallbacks, row.noOps];
      const cells = [
        p.series(rank, "  ●") +
          p.text(` ${fit(providerDisplayName(row.provider), providerLabel - 2)}`),
        ...shownCols.map(([, width], index) =>
          (values[index] ?? 0) > 0
            ? p.text(right(count(values[index] ?? 0), width))
            : dim(right("0", width)),
        ),
      ];
      lines.push(cells.join(" "));
    });
    lines.push(
      ...wrapTextWithAnsi(
        "method from each checkpoint's strategy; trigger from the checkpoint's recorded trigger, else a lane record naming its candidate; unknown = written before triggers were recorded",
        layout.width - 2,
      ).map((line) => dim(`  ${line}`)),
    );
  }
  lines.push("");

  const packedDim = (items: string[]): string[] => {
    const out: string[] = [];
    let current = "";
    for (const item of items) {
      const next = current === "" ? `  ${item}` : `${current} · ${item}`;
      if (current !== "" && visibleWidth(next) > layout.width) {
        out.push(dim(current));
        current = `  ${item}`;
      } else current = next;
    }
    if (current !== "") out.push(dim(current));
    return out;
  };

  const speedRows = report.speed.byModel;
  lines.push(
    heading("Throughput") +
      dim(
        layout.compact
          ? " (per model; generation tok/s)"
          : layout.width >= 80
            ? " (per model and Fast mode; tok/s after the first token, TTFT median)"
            : " (per model and Fast; generation tok/s, TTFT median)",
      ),
  );
  const anyTiming = speedRows.some((row) => row.timedCalls > 0 || row.estimate !== undefined);
  if (!anyTiming && speedRows.length > 0)
    lines.push(dim("  no timed calls yet and too few to estimate · TTFT is recorded from now on"));
  const table = speedTable(
    speedRows,
    p,
    layout,
    (row) => rowLabel(row.model, names, true),
    providerSuffix ? "keep" : "drop",
    modelColours,
  );
  lines.push(...table.lines);
  // The legend names exactly the markers the table used.
  const legend = [
    ...(table.anyFitted
      ? [
          layout.compact
            ? "est. fitted from timing"
            : "est. = fitted from request timing (Theil-Sen)",
        ]
      : []),
    ...(table.anyLow
      ? [
          table.low === LOW_SAMPLE_LONG
            ? `${LOW_SAMPLE_LONG} = fewer than 25 calls`
            : `${LOW_SAMPLE_SHORT} under 25 calls`,
        ]
      : []),
  ];
  if (legend.length > 0) lines.push(...packedDim(legend));
  if (options.expanded) {
    lines.push("");
    lines.push(p.text("  By provider"));
    lines.push(
      ...speedTable(
        report.speed.byProvider,
        p,
        layout,
        (row) => providerDisplayName(row.model),
        "none",
        undefined,
      ).lines,
    );
  }
  lines.push("");

  if (options.expanded) {
    lines.push(
      dim(
        "Cost is the metered list price recorded with each call, also under a subscription. tok/s is the generation speed, output tokens over the request time after the first token: from recorded timings when this profile timed the calls, otherwise fitted from duration against output (est.). Fast is read per call from the recorded price against the list rate, the xAI Fast model id, or the session's requested state (fast? when the log cannot tell). Each call is charged to the tool result it answered; a code-mode call is split across what its script executed in proportion to each nested result's size (evenly when results are empty).",
      ),
    );
    lines.push(
      dim(
        "Not counted: subagents that did not persist a session, side conversations, and the context an earlier tool result keeps occupying.",
      ),
    );
  } else {
    lines.push(dim("Metered list price per call · Ctrl+O expands rows, details and notes"));
  }
  return lines.flatMap((line) => wrapTextWithAnsi(line, width)).join("\n");
}
