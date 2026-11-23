import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCost, formatTokens } from "../session-usage.ts";
import type { DayBucket } from "./aggregate.ts";
import { FEATURE_CODE_MODE } from "./features.ts";
import {
  levelRows,
  sparklineAxis,
  sparklineRows,
  throughputTrendLines,
  timelineAxis,
  tokensPerDayChart,
} from "./format-charts.ts";
import {
  bar,
  CHART_GUTTER,
  clockHour,
  COLLAPSED_ROWS,
  count,
  fit,
  MIN_FITTED_CHART_ROWS,
  packedDim,
  percent,
  right,
  rowLabel,
  shortDay,
  STATS_SECTION_ROWS,
  type SectionContext,
  type StatsSection,
} from "./format-layout.ts";
import { breakdownRows, LOW_SAMPLE_LONG, LOW_SAMPLE_SHORT, speedTable } from "./format-tables.ts";
import { providerDisplayName } from "./names.ts";
import { totalTokens } from "./records.ts";

function summaryLines(ctx: SectionContext): string[] {
  const { report, options, layout, p, timeline } = ctx;
  const { heading, dim } = p;
  const lines: string[] = [];
  const facts = (items: string[]): string[] =>
    layout.compact
      ? items.map((item) => p.text(`  ${item}`))
      : [p.text(`  ${items.join(dim(" · "))}`)];
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

  const hourly = timeline.unit === "hour";
  const window = timeline.keys.length;
  lines.push(
    heading(hourly ? "Tokens per hour" : "Tokens per day") +
      dim(
        ` (${hourly ? "last 24 hours" : `last ${window} days`}${layout.chartRows > 0 ? ", total and per model" : ""})`,
      ),
  );
  const buckets = hourly ? [...report.timeline.totals.values()] : report.byDay;
  const peak = buckets.reduce<DayBucket | undefined>(
    (best, bucket) => (best === undefined || bucket.tokens > best.tokens ? bucket : best),
    undefined,
  );
  if (layout.chartRows > 0 && window <= layout.tableWidth - CHART_GUTTER) {
    lines.push(...tokensPerDayChart(report, timeline, layout, p, ctx.names, ctx.modelColours));
  } else if (hourly) {
    const values = timeline.keys.map((key) => report.timeline.totals.get(key)?.tokens ?? 0);
    for (const row of levelRows(values, Math.max(0, ...values), 3, p)) lines.push(`  ${row}`);
    lines.push(dim(`  ${timelineAxis(timeline, window, options.now)}`));
  } else {
    const sparkWindow = Math.min(window, layout.width - 2);
    for (const row of sparklineRows(report.byDay, sparkWindow, options.now, 3, p))
      lines.push(`  ${row}`);
    lines.push(dim(`  ${sparklineAxis(sparkWindow, options.now)}`));
  }
  const busiest =
    peak === undefined
      ? "  no activity"
      : hourly
        ? `  busiest hour ${clockHour(Number(peak.day))}`
        : `  busiest day ${shortDay(peak.day)}`;
  lines.push(
    dim(
      peak === undefined
        ? busiest
        : `${busiest} · ${formatTokens(peak.tokens)} tokens${layout.compact ? "" : ` · ${count(peak.calls)} calls`}`,
    ),
  );
  return lines;
}

function modelLines(ctx: SectionContext, collapsedRows = COLLAPSED_ROWS): string[] {
  const { report, options, layout, p } = ctx;
  return [
    p.heading("By Model") + p.dim(" (share of tokens)"),
    ...breakdownRows(
      report.byModel,
      options.expanded,
      p,
      layout,
      ctx.names,
      true,
      ctx.modelColours,
      new Map(),
      ctx.providerSuffix,
      collapsedRows,
    ),
  ];
}

function featureLines(ctx: SectionContext, collapsedRows = COLLAPSED_ROWS): string[] {
  const { report, options, layout, p } = ctx;
  return [
    p.heading("By Feature") + p.dim(" (what triggered the call)"),
    ...breakdownRows(
      report.byFeature,
      options.expanded,
      p,
      layout,
      ctx.names,
      false,
      undefined,
      new Map([[FEATURE_CODE_MODE, report.byCodeMode]]),
      undefined,
      collapsedRows,
    ),
  ];
}

function contextLines(ctx: SectionContext): string[] {
  const { report, options, layout, p } = ctx;
  const { heading, dim } = p;
  const lines: string[] = [];
  lines.push(
    heading("Context & Compaction") + dim(layout.compact ? "" : " (input + cache per call)"),
  );
  const context = report.context;
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

  if (compaction.byProvider.length > 0) {
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
    if (options.expanded)
      lines.push(
        ...wrapTextWithAnsi(
          "method from each checkpoint's strategy; trigger from the checkpoint's recorded trigger, else a lane record naming its candidate; unknown = written before triggers were recorded",
          layout.width - 2,
        ).map((line) => dim(`  ${line}`)),
      );
  }
  return lines;
}

function throughputLines(ctx: SectionContext): string[] {
  const { report, options, layout, p, names, providerSuffix, modelColours } = ctx;
  const { heading, dim } = p;
  const lines: string[] = [];
  const allSpeedRows = report.speed.byModel;
  const speedRows = options.expanded ? allSpeedRows : allSpeedRows.slice(0, COLLAPSED_ROWS);
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
  const anyTiming = allSpeedRows.some((row) => row.timedCalls > 0 || row.estimate !== undefined);
  if (!anyTiming && allSpeedRows.length > 0)
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
  const hiddenSpeed = allSpeedRows.length - speedRows.length;
  if (hiddenSpeed > 0) lines.push(dim(`  ${count(hiddenSpeed)} more · Ctrl+O shows all`));
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
  if (legend.length > 0) lines.push(...packedDim(legend, layout, p));
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
  lines.push("", ...throughputTrendLines(ctx));
  return lines;
}

export function footerLines(ctx: SectionContext): string[] {
  const dim = ctx.p.dim;
  if (ctx.options.expanded) return [dim("Metered list price per call")];
  const adds = ctx.options.section === "context" ? "details" : "rows and details";
  return [dim(`Metered list price per call · Ctrl+O expands ${adds}`)];
}

export const SECTION_LINES = {
  summary: summaryLines,
  models: modelLines,
  features: featureLines,
  context: contextLines,
  throughput: throughputLines,
} satisfies Record<StatsSection, (ctx: SectionContext) => string[]>;

export function sectionBody(
  section: StatsSection,
  ctx: SectionContext,
  above: readonly string[],
): string[] {
  const collapsed: SectionContext = { ...ctx, options: { ...ctx.options, expanded: false } };
  const width = ctx.layout.width;
  const rowsOf = (lines: readonly string[]): number =>
    lines.reduce((sum, line) => sum + wrapTextWithAnsi(line, width).length, 0);
  const fixed = rowsOf(above) + 1 + rowsOf(footerLines(collapsed));
  const grow = (
    least: number,
    most: number,
    render: (target: SectionContext, size: number) => string[],
  ): number => {
    let size = least;
    while (size < most && fixed + rowsOf(render(collapsed, size + 1)) <= STATS_SECTION_ROWS)
      size += 1;
    return size;
  };
  if (section === "models" || section === "features") {
    const render = section === "models" ? modelLines : featureLines;
    const total = (section === "models" ? ctx.report.byModel : ctx.report.byFeature).length;
    return render(ctx, grow(COLLAPSED_ROWS, total, render));
  }
  if ((section === "summary" || section === "throughput") && ctx.layout.chartRows > 0) {
    const render = section === "summary" ? summaryLines : throughputLines;
    const tall = (target: SectionContext, chartRows: number): string[] =>
      render({ ...target, layout: { ...target.layout, chartRows } });
    return tall(ctx, grow(MIN_FITTED_CHART_ROWS, STATS_SECTION_ROWS, tall));
  }
  return SECTION_LINES[section](ctx);
}
