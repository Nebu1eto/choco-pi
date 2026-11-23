import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatTokens } from "../session-usage.ts";
import type { Breakdown, SpeedRow } from "./aggregate.ts";
import { MIN_CONFIDENT_SAMPLES } from "./estimate.ts";
import { FEATURE_OTHER_TOOLS, isMcpFeature, isNamedToolFeature } from "./features.ts";
import {
  bar,
  COLLAPSED_ROWS,
  count,
  EXPANDED_FOLD_ROWS,
  fit,
  fitLabels,
  MAX_SPEED_LABEL,
  millis,
  percent,
  rate,
  right,
  rowLabel,
  withoutSuffix,
  type ColourMap,
  type Layout,
  type Palette,
  type SuffixMode,
} from "./format-layout.ts";
import type { ModelNameLookup } from "./names.ts";
import { totalTokens } from "./records.ts";

export const LOW_SAMPLE_LONG = "(low sample)";
export const LOW_SAMPLE_SHORT = "(low n)";
const COLLAPSED_NESTED_ROWS = 3;

type SpeedFigures = {
  gen: number | undefined;
  ttft: number | undefined;
  p90: number | undefined;
  marker: string;
  fitted?: boolean;
  low: boolean;
};

export type SpeedTable = { lines: string[]; low: string; anyLow: boolean; anyFitted: boolean };

type SpeedColumns = {
  figures: SpeedFigures[];
  ttftColumn: boolean;
  p90Column: boolean;
  markerText: number;
  markerWidth: number;
  labelWidth: number;
  callsWidth: number;
  rateWidth: number;
  ttftWidth: number;
  p90Width: number;
};

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

export function breakdownRows(
  rows: readonly Breakdown[],
  expanded: boolean,
  p: Palette,
  layout: Layout,
  names: ModelNameLookup | undefined,
  isModel: boolean,
  colours: ColourMap | undefined,
  nested: ReadonlyMap<string, readonly Breakdown[]> = new Map(),
  suffixed = isModel,
  collapsedRows = COLLAPSED_ROWS,
): string[] {
  const dim = p.dim;
  if (rows.length === 0) return [dim("  (no calls in this period)")];
  const lines: string[] = [];
  const shown = expanded
    ? foldTools(rows, Math.max(EXPANDED_FOLD_ROWS, collapsedRows))
    : rows.slice(0, collapsedRows);
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

function fastTag(row: SpeedRow, p: Palette, compact: boolean): string {
  if (row.fast === undefined) return "";
  const sep = compact ? " " : " · ";
  if (row.fast === "on") return p.dim(sep) + p.key("fast");
  if (row.fast === "unknown") return p.dim(sep) + p.key("fast?");
  return p.dim(sep + (compact ? "std" : "standard"));
}

export function fastTagWidth(row: SpeedRow, compact: boolean): number {
  if (row.fast === undefined) return 0;
  const sep = compact ? 1 : 3;
  if (row.fast === "on") return sep + 4;
  if (row.fast === "unknown") return sep + 5;
  return sep + (compact ? 3 : 8);
}

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
    marker: thin ? (narrow ? low : `est. ${low}`) : "est.",
    fitted: true,
    low: thin,
  };
}

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

export function speedTable(
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
  const wantLabel =
    2 +
    Math.max(
      0,
      ...rows.map(
        (row) => visibleWidth(withoutSuffix(label(row)).trimEnd()) + fastTagWidth(row, !wide),
      ),
    );
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
  const cells = (values: string[]): string => values.join("  ");
  const headerCells = [`  ${fit("", labelWidth)}`];
  headerCells.push(right("calls", callsWidth), right("tok/s", rateWidth));
  if (ttftColumn) headerCells.push(right("TTFT", ttftWidth));
  if (p90Column) headerCells.push(right("p90", p90Width));
  if (markerWidth > 0) headerCells.push(fit("", markerText));
  const lines = [dim(cells(headerCells))];
  const figure = (value: string, width: number, soft: boolean): string =>
    value === "n/a" || soft ? dim(right(value, width)) : p.text(right(value, width));
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
    const soft = figure_.low;
    const tint = (text: string): string => p.series(colours?.get(row.model) ?? rank, text);
    const name = labels[rank] ?? "";
    const rowCells = [tint("  ●") + p.text(` ${name.trimEnd()}`) + fastTag(row, p, compactTags)];
    const used = 3 + 1 + visibleWidth(name.trimEnd()) + fastTagWidth(row, compactTags);
    rowCells[0] = (rowCells[0] ?? "") + " ".repeat(Math.max(0, 2 + labelWidth - used));
    rowCells.push(
      figure(count(row.calls), callsWidth, soft),
      figure(rate(figure_.gen), rateWidth, soft),
    );
    if (ttftColumn) rowCells.push(figure(millis(figure_.ttft), ttftWidth, soft));
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
    anyLow: markerWidth > 0 && figures.some((figure) => figure.low),
    anyFitted: markerWidth > 0 && figures.some((figure) => figure.fitted === true),
  };
}
