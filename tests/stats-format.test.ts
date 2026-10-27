import { formatTokens } from "../.pi/extensions/lib/session-usage.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregateStats, dayKey } from "../.pi/extensions/lib/stats/aggregate.ts";
import {
  fitLabel,
  shortenToFit,
  fitLabels,
  formatStats,
  seriesToken,
  SERIES_TOKENS,
  sparkline,
  sparklineAxis,
  STATS_DEFAULT_WIDTH,
} from "../.pi/extensions/lib/stats/format.ts";
import {
  formatModelId,
  modelRowLabel,
  providerDisplayName,
} from "../.pi/extensions/lib/stats/names.ts";
import {
  CODE_MODE_BROWSER,
  CODE_MODE_EXEC,
  CODE_MODE_FILES,
  CODE_MODE_LSP,
  CODE_MODE_SCRIPT,
  FEATURE_CODE_MODE,
} from "../.pi/extensions/lib/stats/features.ts";
import type { CallRecord } from "../.pi/extensions/lib/stats/records.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

const style = {
  fg: (color: string, text: string) => `\u001b[3${color.length}m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

function record(overrides: Partial<CallRecord> & { key: string }): CallRecord {
  return {
    sessionId: "s1",
    file: "/sessions/s1.jsonl",
    cwd: "/work/app",
    at: NOW - DAY,
    kind: "assistant",
    provider: "anthropic",
    model: "claude-opus-5-5",
    tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 },
    cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.05, total: 0.4 },
    durationMs: 2000,
    ttftMs: 300,
    stopReason: "stop",
    responseModel: undefined,
    fastRequested: undefined,
    feature: "conversation",
    nestedCalls: [],
    isSubagent: false,
    failed: false,
    ...overrides,
  };
}

const longModel = "a-very-long-provider-name/an-even-longer-model-identifier-that-overflows";
const records: CallRecord[] = [
  record({ key: "a" }),
  record({
    key: "b",
    at: NOW - 3 * DAY,
    feature: "code mode",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
  }),
  record({
    key: "c",
    provider: longModel.split("/")[0] ?? "",
    model: longModel.split("/")[1] ?? "",
    feature: `tools: ${"x".repeat(60)}`,
  }),
  record({
    key: "mcp",
    feature: "MCP: github",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    record({
      key: `t${index}`,
      feature: `tools: tool_${index}`,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    }),
  ),
  record({
    key: "fail",
    failed: true,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }),
];

const scan = { sessions: 3, files: 4, calls: 12, duplicates: 2 };

test("every rendered row fits the requested width at 40, 54, 80, and 140 columns", () => {
  const report = aggregateStats(records);
  for (const width of [40, 54, 80, 140]) {
    for (const expanded of [false, true]) {
      for (const themed of [undefined, style]) {
        const body = formatStats(report, {
          period: "30d",
          scope: "all",
          expanded,
          style: themed,
          now: NOW,
          scan,
          width,
        });
        for (const row of body.split("\n")) {
          assert.ok(
            visibleWidth(row) <= width,
            `${visibleWidth(row)} columns at ${width}: ${row.replace(ANSI, "")}`,
          );
        }
        if (themed === undefined)
          assert.ok(!body.includes("\u001b"), "plain output carries no escape codes");
        else assert.ok(body.includes("\u001b[1m"), "styled output uses the theme");
      }
    }
  }
});

test("narrow layouts drop columns instead of wrapping and wide layouts add in/out", () => {
  const report = aggregateStats(records);
  const at = (width: number) =>
    formatStats(report, { period: "all", scope: "all", expanded: false, now: NOW, scan, width });
  const models = (body: string) => body.split("By model")[1]?.split("By feature")[0] ?? "";
  assert.ok(
    !/\d[km]?\s+\$/.test(models(at(40))),
    "the token column is dropped at 40 columns, cost stays",
  );
  assert.ok(
    !/\bp90\b/.test(at(54).split("\nThroughput")[1] ?? ""),
    "the speed table drops gen/p90 below 64 columns",
  );
  const wide = at(140);
  assert.match(
    wide,
    /^\s+share\s+tokens\s+in\s+out\s+cost$/m,
    "140 columns adds in/out columns with a header",
  );
  const bar = /█+░*/.exec(models(wide))?.[0] ?? "";
  assert.equal(bar.length, 32, "wide layouts use the full 32-cell bar");
  assert.equal(
    formatStats(report, { period: "all", scope: "all", expanded: false, now: NOW, scan }),
    at(STATS_DEFAULT_WIDTH),
  );
});

test("the header states period, scope, scanned sessions, calls, and skipped copies", () => {
  const body = formatStats(aggregateStats(records), {
    period: "7d",
    scope: "project",
    expanded: false,
    now: NOW,
    scan,
  });
  const [header, scanned] = body.split("\n");
  assert.equal(header, "Statistics · Last 7 days · this project");
  assert.equal(scanned, "Scanned 3 sessions (4 files) · 12 calls");
  assert.ok(!body.includes("fork/rewind"), "dedup bookkeeping stays out of the tab");
  assert.match(body, /Calls 12 · Failed 1 · Sessions 1 · Active days 2/);
  assert.match(body, /Cache read 3,?000|Cache read 3\.0k/);
});

test("concise view folds surplus per-tool rows into one row and the expanded view lists them with details", () => {
  const report = aggregateStats(records);
  const concise = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
  });
  assert.match(
    concise,
    /more \([\d.]+% · \$[\d.]+\) · Ctrl\+O shows all/,
    "the trailing rows are counted, not listed",
  );
  assert.ok(!concise.includes("tools: tool_7"));
  assert.match(
    concise,
    /^  ● MCP: github\s+/m,
    "an MCP server with tiny usage keeps its own concise row",
  );
  assert.ok(!concise.includes("Not counted:"));
  const expanded = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
  });
  assert.ok(expanded.includes("tools: tool_7"));
  assert.match(expanded, /^    1 calls · in 100 · out 50 · cache 1\.0k read \/ 200 write$/m);
  assert.ok(expanded.includes("Not counted:"));
});

test("sparkline scales to the busiest day and dots empty days", () => {
  const days = [
    { day: dayKey(NOW), tokens: 800, cost: 0, calls: 1 },
    { day: dayKey(NOW - 2 * DAY), tokens: 100, cost: 0, calls: 1 },
  ];
  assert.equal(sparkline(days, 4, NOW), "·▁·█");
  assert.equal(sparkline([{ day: dayKey(NOW), tokens: 1, cost: 0, calls: 1 }], 1, NOW), "█");
  assert.equal(sparkline([], 3, NOW), "···");
});

test("estimated and unpriced costs are called out next to the total", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const report = aggregateStats(
    [
      record({ key: "e", cost: zero, provider: "openai-codex", model: "daybreak" }),
      record({ key: "n", cost: zero, provider: "apex", model: "free" }),
    ],
    {
      priceLookup: (provider) =>
        provider === "openai-codex"
          ? { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
          : undefined,
    },
  );
  const body = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
  });
  assert.match(body, /Cost \$0\.00$/m);
  assert.match(body, /^  \$0\.00 of it estimated at current list prices \(1 calls\)$/m);
  assert.match(body, /^  1 calls have no known price \(1\.4k tokens\)$/m);
});

test("the speed table shows generation tok/s with TTFT percentiles", () => {
  const timed = [record({ key: "a" }), record({ key: "b", ttftMs: 1000, durationMs: 3000 })];
  const body = formatStats(aggregateStats(timed), {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 80,
  });
  assert.match(body, /^  ● Anthropic\s+2\s+27\.0\s+300ms\s+1000ms\s+\(low sample\)$/m);
  assert.match(
    body,
    /^  ● Claude Opus 5\.5( \(Anthropic\))?\s+2\s+27\.0/m,
    "the by-model table uses the friendly name",
  );
});

test("narrow layouts keep the label, shrink then hide the bar, and drop the provider suffix first", () => {
  const report = aggregateStats(records);
  const at = (width: number) =>
    formatStats(report, { period: "all", scope: "all", expanded: false, now: NOW, scan, width });
  const models = (body: string) => body.split("By model")[1]?.split("By feature")[0] ?? "";
  assert.match(
    models(at(40)),
    /^  ● Claude Opus 5\.5\s+\d+\.\d%\s+\$[\d.]+$/m,
    "40 columns: no bar, provider suffix dropped, model name whole",
  );
  assert.ok(!/█|░/.test(models(at(40))), "no bar below 48 columns");
  const mid = models(at(54));
  assert.match(
    mid,
    /^  ● Claude Opus 5\.5\s+[█░]{4,6}\s+\d+\.\d%\s+[\d.]+[km]?\s+\$[\d.]+$/m,
    "54 columns: six-cell bar after a readable label",
  );
  assert.ok(
    !/\(Anthropic\)|\(OpenAI Codex\)/.test(models(at(80))),
    "one over-long name drops the suffix for the whole table",
  );
  const short = aggregateStats([
    record({ key: "a" }),
    record({ key: "g", provider: "xai", model: "grok-4.7" }),
  ]);
  const shortAt = (width: number) =>
    formatStats(short, { period: "all", scope: "all", expanded: false, now: NOW, scan, width });
  assert.match(
    models(shortAt(80)),
    /^  ● Claude Opus 5\.5 \(Anthropic\)\s+[█░]+/m,
    "80 columns keeps the suffix when every row fits",
  );
  assert.match(models(shortAt(80)), /^  ● Grok 4\.7 \(xAI\)\s+[█░]+/m);
  const narrowModels = models(shortAt(54));
  assert.match(narrowModels, /^  ● Claude Opus 5\.5\s+[█░]/m);
  assert.ok(
    !narrowModels.includes("(xAI)"),
    "a short name drops its suffix too once another row had to",
  );
  assert.equal(fitLabel("Claude Opus 5.5 (Anthropic)", 27), "Claude Opus 5.5 (Anthropic)");
  assert.equal(fitLabel("Claude Opus 5.5 (Anthropic)", 16, true), "Claude Opus 5.5 ");
  assert.equal(fitLabel("Claude Opus 5.5 (Anthropic)", 10, true), "Claude Op…");
  assert.equal(
    fitLabel("subagents (orchestration)", 12),
    "subagents (…",
    "feature labels are cut at the end",
  );
  assert.deepEqual(fitLabels(["Grok 4.7 (xAI)", "Claude Opus 5.5 (Anthropic)"], 18, "keep"), [
    "Grok 4.7          ",
    "Claude Opus 5.5   ",
  ]);
  assert.deepEqual(fitLabels(["Grok 4.7 (xAI)", "GPT-6 Astra (OpenAI Codex)"], 30, "keep"), [
    "Grok 4.7 (xAI)                ",
    "GPT-6 Astra (OpenAI Codex)    ",
  ]);
  assert.deepEqual(
    fitLabels(["subagents (orchestration)", "browser"], 12, "none"),
    ["subagents (…", "browser     "],
    "feature tables never strip",
  );
});

test("friendly model names come from the registry when it knows the model and from the id otherwise", () => {
  assert.equal(formatModelId("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(formatModelId("gpt-6-astra"), "GPT-6 Astra");
  assert.equal(formatModelId("gpt-6.1-sol"), "GPT-6.1 Sol");
  assert.equal(formatModelId("grok-4.7"), "Grok 4.7");
  assert.equal(modelRowLabel("openai-codex", "gpt-6-astra"), "GPT-6 Astra (OpenAI Codex)");
  assert.equal(modelRowLabel("xai", "grok-4.7"), "Grok 4.7 (xAI)");
  assert.equal(
    modelRowLabel("anthropic", "claude-opus-5-5", (p, m) =>
      p === "anthropic" && m === "claude-opus-5-5" ? "Registry Name" : undefined,
    ),
    "Registry Name (Anthropic)",
  );
  assert.equal(providerDisplayName("anthropic"), "Anthropic");
  const body = formatStats(aggregateStats([record({ key: "a" })]), {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
    modelNames: () => "Registry Name",
  });
  assert.match(body, /^  ● Registry Name \(Anthropic\)\s+/m);
});

test("the throughput table shows timing columns only when a row has a figure", () => {
  const untimed = aggregateStats([
    record({ key: "a", ttftMs: undefined }),
    record({
      key: "x",
      provider: "xai",
      model: "grok-4.7",
      ttftMs: undefined,
      tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 },
      durationMs: 1000,
    }),
  ]);
  const body = formatStats(untimed, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 80,
  });
  const speed = body.split("\nThroughput")[1] ?? "";
  assert.match(speed, /no timed calls yet and too few to estimate/);
  assert.match(
    speed,
    /^  ● Grok 4\.7( \(xAI\))? (· )?fast\?\s+1\s+n\/a\s+n\/a\s+\(low sample\)\s*$/m,
    "an unpriced xAI call is fast?; a one-call row says n/a (low sample)",
  );
  assert.match(
    speed,
    /^  ● Claude Opus 5\.5( \(Anthropic\))?\s+1\s+n\/a\s+n\/a\s+\(low sample\)\s*$/m,
    "Anthropic rows carry no Fast tag",
  );
  assert.match(speed, /\n\n  By provider\n/, "the provider table follows in the expanded view");
  assert.match(speed, /^  ● xAI\s+1\s+n\/a/m);

  const collapsed = formatStats(untimed, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  assert.ok(!collapsed.includes("  By provider\n"), "collapsed view shows models only");
  const timed = formatStats(aggregateStats([record({ key: "t" })]), {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  assert.match(
    timed.split("\nThroughput")[1] ?? "",
    /tok\/s\s+TTFT\s+p90/,
    "one timed call brings the recorded columns back",
  );
  assert.ok(!timed.includes("no timed calls yet"));
  assert.ok(!timed.includes("Provider Throughput"), "the section is named Throughput");
});

test("estimated rows are marked est., low samples say so, recorded timings win, and Fast splits a model", () => {
  // 30 Codex calls priced at twice the list output rate (Fast applied), 30 at list.
  const prices = (provider: string, model: string) =>
    provider === "openai-codex" && model === "gpt-6-astra"
      ? { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
      : undefined;
  const codex = (key: string, index: number, fast: boolean): CallRecord => {
    const output = 100 + index * 40;
    const rate = fast ? 100 : 50;
    return record({
      key,
      provider: "openai-codex",
      model: "gpt-6-astra",
      ttftMs: undefined,
      tokens: { input: 10, output, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: (output * rate) / 1e6, cacheRead: 0, cacheWrite: 0, total: 1 },
      durationMs: 2000 + output * (fast ? 20 : 40),
    });
  };
  const records = [
    ...Array.from({ length: 30 }, (_, i) => codex(`f${i}`, i, true)),
    ...Array.from({ length: 30 }, (_, i) => codex(`s${i}`, i, false)),
    ...Array.from({ length: 6 }, (_, i) =>
      record({
        key: `a${i}`,
        ttftMs: undefined,
        tokens: { input: 1, output: 50 + i * 10, cacheRead: 0, cacheWrite: 0 },
        durationMs: 500 + (50 + i * 10) * 10,
      }),
    ),
    record({ key: "timed", provider: "xai", model: "grok-4.7", fastRequested: false }),
  ];
  const body = formatStats(aggregateStats(records, { priceLookup: prices }), {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 120,
  });
  const speed = body.split("\nThroughput")[1] ?? "";
  assert.match(
    speed,
    /^  ● GPT-6 Astra · fast\s+30\s+50\.0\s+2000ms\s+est\.\s*$/m,
    "the Fast row recovers 50 tok/s and 2.0s TTFT",
  );
  assert.match(
    speed,
    /^  ● GPT-6 Astra · standard\s+30\s+25\.0\s+2000ms\s+est\.\s*$/m,
    "the standard row recovers 25 tok/s",
  );
  assert.match(
    speed,
    /^  ● Claude Opus 5\.5\s+6\s+100\.0\s+500ms\s+est\. \(low sample\)$/m,
    "six calls fit but are marked low confidence",
  );
  assert.match(
    speed,
    /^  ● Grok 4\.7 · standard\s+1\s+[\d.]+\s+300ms\s+300ms\s+\(low sample\)\s*$/m,
    "a recorded TTFT shows plain with p90; fast requested off is standard",
  );
  assert.match(speed, /est\. = fitted from request timing/);
  assert.doesNotMatch(speed, /~/, "no tilde shorthand");
  const fastIndex = speed.indexOf("· fast");
  const standardIndex = speed.indexOf("· standard");
  assert.ok(
    fastIndex >= 0 && fastIndex < standardIndex,
    "Fast row precedes the standard row of the same model",
  );
  for (const row of body.split("\n")) assert.ok(visibleWidth(row) <= 120);
});

test("the tokens-per-day chart plots the top models with a legend and falls back to a sparkline when narrow", () => {
  const report = aggregateStats(records);
  const wide = formatStats(report, {
    period: "30d",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  const chart = wide.split("Tokens per day")[1]?.split("By model")[0] ?? "";
  assert.match(chart, /^\s+0 ┤/m, "the baseline is labelled 0");
  assert.match(chart, /┤.*[╭╮╰╯]/, "the chart is a step line");
  assert.match(chart, /└.*today$/m, "ticks end with today");
  assert.match(
    chart,
    /^  ● Total · ● Claude Opus 5\.5 · ● An Even Longer Model[^·]*… · ● GPT-6\.1 Sol$/m,
    "legend leads with Total, then friendly names without the provider suffix, in rank order",
  );
  assert.doesNotMatch(chart, /● other/, "no other line when the top models cover every call");
  const busiest = Math.max(...report.byDay.map((bucket) => bucket.tokens));
  assert.match(
    chart,
    new RegExp(`^\\s*${formatTokens(busiest)} ┤`, "m"),
    "the axis peaks at the busiest day total",
  );
  assert.match(chart, /┤.*[━┃┏┓┗┛]/, "the total is drawn heavy");
  assert.match(chart, /total and per model/, "the heading names both");
  for (const row of chart.split("\n")) assert.ok(visibleWidth(row) <= 80);
  const many = aggregateStats(
    Array.from({ length: 5 }, (_, i) => record({ key: `m${i}`, model: `model-${i}` })),
  );
  const withOther = formatStats(many, {
    period: "30d",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  assert.match(withOther, /● other/, "a fourth model and beyond become the other line");
  const narrow = formatStats(report, {
    period: "30d",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 40,
  });
  assert.ok(!narrow.includes("┤"), "40 columns falls back to the sparkline");
  assert.ok(
    !narrow.includes("● Total"),
    "the sparkline carries the total itself, without a legend",
  );
  assert.match(narrow, /[▁▂▃▄▅▆▇█]/, "the sparkline is drawn");
  assert.match(narrow, /^  Sep 28\s+today$/m);
  assert.equal(sparklineAxis(7, NOW), "Oct 21 today");
});

test("a model keeps one colour across the chart legend, By model, and throughput by model", () => {
  const report = aggregateStats(records);
  const paints: Array<[string, string]> = [];
  const body = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 80,
    style: {
      fg: (name, text) => {
        paints.push([name, text]);
        return text;
      },
      bold: (text) => text,
    },
  });
  const swatches = paints
    .filter(([, text]) => text === "  ●" || text === "●")
    .map(([name]) => name);
  const models = report.byModel.map((row) => row.key);
  // By model swatches (rank order), then feature swatches, then provider, then by-model throughput swatches.
  const first = swatches.slice(0, models.length);
  const chartLegend = paints
    .filter(([, text]) => text === "●")
    .map(([name]) => name)
    .slice(0, 3);
  assert.deepEqual(chartLegend, first.slice(0, 3), "legend dots match the By model swatches");
  assert.equal(new Set(first).size, models.length, "no two models in the table share a colour");
  assert.deepEqual(
    SERIES_TOKENS.slice(0, 4),
    ["accent", "warning", "success", "error"],
    "neighbouring ranks alternate hue families",
  );
  assert.ok(body.includes("● Claude Opus 5.5"));
});

test("collapsed view shows the top rows and names the rest; series colours are stable theme tokens", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    record({
      key: `m${index}`,
      model: `model-${index}`,
      tokens: { input: 1 + index, output: 1, cacheRead: 0, cacheWrite: 0 },
    }),
  );
  const report = aggregateStats(many);
  const collapsed = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  const models = collapsed.split("By model")[1]?.split("By feature")[0] ?? "";
  assert.equal((models.match(/^  ● Model /gm) ?? []).length, 5, "five rows collapsed");
  assert.match(models, /^  4 more \(\d+\.\d% · \$[\d.]+\) · Ctrl\+O shows all$/m);
  assert.ok(!models.includes("  other "), "collapsed rows are counted, not folded");
  assert.match(collapsed, /Ctrl\+O expands rows, details and notes/);
  const expanded = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 80,
  });
  assert.equal(
    (
      expanded
        .split("By model")[1]
        ?.split("By feature")[0]
        ?.match(/^  ● Model /gm) ?? []
    ).length,
    9,
  );
  assert.ok(!expanded.includes("more · Ctrl+O"));
  assert.equal(seriesToken(0), "accent");
  assert.notEqual(seriesToken(0), seriesToken(1));
  assert.equal(seriesToken(SERIES_TOKENS.length), seriesToken(0), "the palette wraps");
  assert.ok(SERIES_TOKENS.includes(seriesToken(123)));
  const fg: string[] = [];
  formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
    style: {
      fg: (name, text) => {
        fg.push(name);
        return text;
      },
      bold: (text) => text,
    },
  });
  assert.ok(fg.includes("warning"), "key totals and the second series use the warning token");
  assert.ok(
    fg.every((name) => ["accent", "text", "dim", "warning", ...SERIES_TOKENS].includes(name)),
    "only theme tokens are used",
  );
});

test("legend names shrink longest-first only until the row fits", () => {
  assert.deepEqual(shortenToFit(["Claude Opus 5.5", "Grok 4.7"], 100), [
    "Claude Opus 5.5",
    "Grok 4.7",
  ]);
  assert.deepEqual(shortenToFit(["Claude Opus 5.5", "Grok 4.7"], 20), ["Claude Opus…", "Grok 4.7"]);
  assert.deepEqual(
    shortenToFit(["abcdefgh", "abcdefgh"], 14),
    ["abcdef…", "abcdef…"],
    "equal names shrink alternately",
  );
  assert.deepEqual(shortenToFit(["abc"], 1), ["abc"], "never below four columns");
  assert.deepEqual(
    shortenToFit(["abcdef"], -1),
    ["abcdef"],
    "a negative budget leaves names alone",
  );
});

test("the label column grows to show the longest model name whole at 54 columns, squeezing the bar", () => {
  const report = aggregateStats([
    record({ key: "a" }),
    record({
      key: "f",
      model: "claude-fable-5-1",
      tokens: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0 },
    }),
  ]);
  const body = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 54,
  });
  const models = body.split("By model")[1]?.split("By feature")[0] ?? "";
  assert.match(models, /^  ● Claude Fable 5\.1\s+[█░]{4,6}\s+/m, "the longest name shows whole");
  assert.ok(!models.includes("…"), "nothing is truncated");
  for (const row of body.split("\n")) assert.ok(visibleWidth(row) <= 54);
  assert.match(
    body,
    /busiest day Oct 2\d · [\d.]+k tokens/,
    "the peak line names the day and the all-model total",
  );
});

test("code mode nests what its scripts executed: top rows collapsed, all rows expanded, split by result size", () => {
  const codeCall = (key: string, nestedCalls: CallRecord["nestedCalls"]) =>
    record({
      key,
      feature: FEATURE_CODE_MODE,
      nestedCalls,
      tokens: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
    });
  const report = aggregateStats([
    codeCall("c1", [
      { name: "exec_command", size: 900 },
      { name: "read", size: 100 },
    ]),
    codeCall("c2", [
      { name: "lsp_diagnostics", size: 0 },
      { name: "act_ui", size: 0 },
    ]),
    codeCall("c3", [{ name: "mcp__linear__get_issue", size: 50 }]),
    codeCall("c4", []),
    record({ key: "chat", tokens: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const rows = new Map(report.byCodeMode.map((row) => [row.key, row]));
  assert.deepEqual(
    [...rows.keys()],
    [
      "MCP: linear",
      CODE_MODE_SCRIPT,
      CODE_MODE_EXEC,
      CODE_MODE_BROWSER,
      CODE_MODE_LSP,
      CODE_MODE_FILES,
    ],
    "ordered by share, then cost, then name",
  );
  assert.equal(rows.get(CODE_MODE_EXEC)?.tokens.output, 900);
  assert.equal(rows.get(CODE_MODE_FILES)?.tokens.output, 100);
  assert.equal(rows.get(CODE_MODE_LSP)?.tokens.output, 500, "empty results split evenly");
  assert.equal(rows.get(CODE_MODE_SCRIPT)?.tokens.output, 1000);
  const total = report.byCodeMode.reduce((sum, row) => sum + row.tokens.output, 0);
  assert.equal(total, 4000, "the split reconciles with the code-mode row");
  assert.ok(Math.abs(report.byCodeMode.reduce((sum, row) => sum + row.cost, 0) - 4) < 1e-9);
  const collapsed = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 80,
  });
  const features = collapsed.split("By feature")[1]?.split("\nThroughput")[0] ?? "";
  assert.match(features, /^  ● code mode\s+[█░]+\s+80\.0%/m);
  assert.match(features, /^    └ exec\/shell\s+[█░]+\s+18\.0%\s+900\s+\$0\.90$/m);
  assert.match(features, /^    └ MCP: linear\s+[█░]+\s+20\.0%/m);
  assert.match(features, /^    └ script only\s+[█░]+\s+20\.0%/m);
  assert.match(
    features,
    /^      3 more \(22\.0% · \$1\.10\)$/m,
    "collapsed shows three nested rows and counts the rest",
  );
  assert.doesNotMatch(features, /└ LSP/);
  const expanded = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 80,
  });
  const all = expanded.split("By feature")[1]?.split("\nThroughput")[0] ?? "";
  for (const key of [CODE_MODE_LSP, CODE_MODE_BROWSER, CODE_MODE_FILES])
    assert.match(all, new RegExp(`^    └ ${key}\\s`, "m"));
  assert.doesNotMatch(all, /more \(/);
  assert.match(
    expanded.replace(/\n/g, " "),
    /split across what its script executed in proportion to each nested result/,
  );
  for (const width of [40, 54, 80, 140])
    for (const row of formatStats(report, {
      period: "all",
      scope: "all",
      expanded: true,
      now: NOW,
      scan,
      width,
    }).split("\n"))
      assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
});

test("Context & Compaction lays out aligned rows and lists providers when expanded", () => {
  const big = (key: string, cacheRead: number) =>
    record({ key, tokens: { input: 100, output: 10, cacheRead, cacheWrite: 0 } });
  const report = aggregateStats(
    [big("a", 50_000), big("b", 150_000), big("c", 250_000), big("d", 450_000)],
    {
      compactions: [
        {
          key: "c1",
          sessionId: "s",
          cwd: "/w",
          at: NOW,
          provider: "anthropic",
          method: "built-in",
          strategy: "local-reconciled",
          trigger: "manual",
          triggerRecorded: true,
          tokensBefore: 500_000,
          candidateId: "x",
        },
        {
          key: "c2",
          sessionId: "s",
          cwd: "/w",
          at: NOW,
          provider: "openai-codex",
          method: "server-side",
          strategy: "openai-responses-compaction-v2",
          trigger: "unknown",
          triggerRecorded: false,
          tokensBefore: undefined,
          candidateId: undefined,
        },
      ],
      laneEvents: [
        {
          key: "l1",
          sessionId: "s",
          cwd: "/w",
          at: NOW,
          provider: "anthropic",
          event: "fallback",
          from: "anthropic-native",
          reason: "no-legal-cut",
          detail: "nothing-to-summarize",
          route: "manual",
          trigger: undefined,
          candidateId: "y",
        },
      ],
    },
  );
  const collapsed = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: false,
    now: NOW,
    scan,
    width: 100,
  });
  const section = collapsed.split("Context & Compaction")[1]?.split("\nThroughput")[0] ?? "";
  assert.match(section, /^  ● ≥100K\s+█+░*\s+75\.0%\s+3 calls$/m, "share bar, percent, calls");
  assert.match(section, /^  ● ≥200K\s+[█░]+\s+50\.0%\s+2 calls$/m);
  assert.match(section, /^  ● ≥400K\s+[█░]+\s+25\.0%\s+1 calls$/m);
  assert.match(section, /^  Median context 150k · p90 450k$/m);
  assert.match(section, /^  Compactions    2 · built-in 1 · server-side 1$/m);
  assert.match(section, /^  Trigger        manual 1 · auto 0 · unknown 1$/m);
  assert.match(
    section,
    /^                 0 native→built-in fallbacks · 1 no-ops \(nothing to summarize\)$/m,
  );
  const barStart = (line: string) =>
    line.indexOf("█") >= 0 ? line.indexOf("█") : line.indexOf("░");
  const bars = section
    .split("\n")
    .filter((line) => line.includes("●"))
    .map(barStart);
  assert.equal(new Set(bars).size, 1, "bars start in one column");
  const modelBar =
    (collapsed.split("By model")[1] ?? "").split("\n").find((line) => line.includes("●")) ?? "";
  assert.equal(bars[0], barStart(modelBar), "aligned with the By model bars");

  assert.doesNotMatch(section, /By provider/);
  const expanded = formatStats(report, {
    period: "all",
    scope: "all",
    expanded: true,
    now: NOW,
    scan,
    width: 100,
  });
  const table = expanded.split("Context & Compaction")[1]?.split("\nThroughput")[0] ?? "";
  assert.match(table, /By provider\n\s+built-in\s+server\s+host\s+unknown\s+fallbk\s+no-op\n/);
  assert.match(table, /^  ● Anthropic\s+1\s+0\s+0\s+0\s+0\s+1$/m);
  assert.match(table, /^  ● OpenAI Codex\s+0\s+1\s+0\s+0\s+0\s+0$/m);
  assert.match(table.replace(/\n/g, " "), /trigger from the checkpoint's recorded trigger/);
  for (const width of [40, 54, 80, 140])
    for (const row of formatStats(report, {
      period: "all",
      scope: "all",
      expanded: true,
      now: NOW,
      scan,
      width,
    }).split("\n"))
      assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
});

test("low-sample wording is long when the labels still fit, short otherwise; thin rows dim; labels show whole", () => {
  const thin = aggregateStats([
    record({ key: "a", model: "claude-sonnet-5-5" }),
    ...Array.from({ length: 30 }, (_, i) =>
      record({
        key: `b${i}`,
        ttftMs: undefined,
        tokens: { input: 1, output: 100 + i * 10, cacheRead: 0, cacheWrite: 0 },
        durationMs: 1000 + (100 + i * 10) * 10,
      }),
    ),
  ]);
  const names = (_provider: string, model: string) =>
    model === "claude-sonnet-5-5" ? "Claude Sonnet 5.5" : "Claude Opus 5.5";
  const at = (width: number, themed?: typeof style) =>
    formatStats(thin, {
      period: "all",
      scope: "all",
      expanded: false,
      now: NOW,
      scan,
      width,
      modelNames: names,
      style: themed,
    });
  const table = (body: string) => body.split("\nThroughput")[1]?.split("\n\n")[0] ?? "";
  assert.match(
    table(at(80)),
    /^  ● Claude Sonnet 5\.5( \(Anthropic\))?\s+1\s+[\d.]+\s+300ms\s+300ms\s+\(low sample\)$/m,
    "80 columns has room for the long wording",
  );
  assert.match(table(at(80)), /\(low sample\) = fewer than 25 calls/);
  assert.match(
    table(at(54)),
    /^  ● Claude Sonnet 5\.5\s+1\s+[\d.]+\s+300ms\s+\(low n\)$/m,
    "54 columns shows the whole name and shortens the note",
  );
  assert.match(table(at(54)), /\(low n\) under 25 calls/);
  assert.doesNotMatch(table(at(54)), /\(low sample\)/, "the legend matches the markers shown");
  assert.doesNotMatch(table(at(40)), /low/, "no timing column, no low-sample legend at 40");
  const styled = at(80, style);
  const rows = styled.split("\n").filter((line) => line.includes("ms"));
  const thinRow = rows.find((line) => line.includes("Sonnet")) ?? "";
  const fullRow = rows.find((line) => line.includes("Opus")) ?? "";
  assert.ok(thinRow.length > 0 && fullRow.length > 0);
  // The thin row's call count is dimmed; the confident row's is not.
  // The test style encodes a colour token as its name length: "dim" is 3, "text" is 4.
  const dimOne = "\u001b[33m" + "1".padStart(5) + "\u001b[0m";
  assert.ok(thinRow.includes(dimOne), "thin row numbers are dim");
  const plainThirty = "\u001b[34m" + "30".padStart(5) + "\u001b[0m";
  assert.ok(fullRow.includes(plainThirty), "confident row numbers stay plain text");
});

test("Context & Compaction never wraps at 40, 54, 80, or 140 columns", () => {
  const big = (key: string, cacheRead: number) =>
    record({ key, tokens: { input: 100, output: 10, cacheRead, cacheWrite: 0 } });
  const event = (
    key: string,
    provider: string,
    method: "built-in" | "server-side",
    trigger: "manual" | "threshold" | "unknown",
  ) => ({
    key,
    sessionId: "s",
    cwd: "/w",
    at: NOW,
    provider,
    method,
    strategy: undefined,
    trigger,
    triggerRecorded: trigger !== "unknown",
    tokensBefore: undefined,
    candidateId: undefined,
  });
  const lane = (key: string, detail: string | undefined) => ({
    key,
    sessionId: "s",
    cwd: "/w",
    at: NOW,
    provider: "anthropic",
    event: "fallback",
    from: "anthropic-native",
    reason: "oversized",
    detail,
    route: "manual",
    trigger: undefined,
    candidateId: key,
  });
  const report = aggregateStats(
    [big("a", 50_000), big("b", 150_000), big("c", 250_000), big("d", 450_000)],
    {
      compactions: [
        event("c1", "anthropic", "built-in", "manual"),
        event("c2", "openai-codex", "server-side", "threshold"),
        event("c3", "xai", "server-side", "unknown"),
      ],
      laneEvents: [lane("l1", undefined), lane("l2", "nothing-to-summarize")],
    },
  );
  for (const width of [40, 54, 80, 140])
    for (const expanded of [false, true])
      for (const themed of [undefined, style]) {
        const body = formatStats(report, {
          period: "all",
          scope: "all",
          expanded,
          now: NOW,
          scan,
          width,
          style: themed,
        });
        const section = body.split("Context & Compaction")[1]?.split("\nThroughput")[0] ?? "";
        for (const line of section.split("\n").slice(1)) {
          assert.ok(visibleWidth(line) <= width, `${width}/${expanded}: ${line}`);
          // Every line is an indented row, never a wrapped tail at column 0.
          assert.ok(
            line === "" || line.startsWith("  ") || line.startsWith("\u001b"),
            `${width}/${expanded} wrapped: ${line}`,
          );
        }
      }
});

test("Throughput has no bars and keeps headers over right-aligned values at 40, 54, 80, and 140", () => {
  const report = aggregateStats([
    record({ key: "a" }),
    record({
      key: "b",
      model: "claude-sonnet-5-5",
      tokens: { input: 1, output: 5000, cacheRead: 0, cacheWrite: 0 },
    }),
    record({ key: "c", provider: "xai", model: "grok-4.7", fastRequested: true }),
  ]);
  for (const width of [40, 54, 80, 140])
    for (const expanded of [false, true]) {
      const body = formatStats(report, {
        period: "all",
        scope: "all",
        expanded,
        now: NOW,
        scan,
        width,
      });
      const section = body.split("\nThroughput")[1]?.split("\nCost is")[0] ?? "";
      const lines = section.split("\n").slice(1);
      for (const line of lines) {
        assert.ok(!/[█░]/.test(line), `${width}/${expanded} bar glyph: ${line}`);
        assert.ok(visibleWidth(line) <= width, `${width}/${expanded} wide: ${line}`);
      }
      // Every table: the header's "calls" and "tok/s" end where the row values end.
      const headers = lines.filter((line) => /\bcalls\s+tok\/s/.test(line));
      assert.ok(headers.length >= 1);
      for (const header of headers) {
        const at = lines.indexOf(header);
        const rows = lines
          .slice(at + 1)
          .filter(
            (line, index, all) =>
              line.startsWith("  ●") && all.slice(0, index).every((l) => l.startsWith("  ●")),
          );
        assert.ok(rows.length >= 1, `${width}/${expanded} rows under header`);
        const callsEnd = header.indexOf("calls") + 5;
        const rateEnd = header.indexOf("tok/s") + 5;
        for (const row of rows) {
          const calls = /\s(\d[\d,]*)\s/.exec(row.slice(0, callsEnd + 1));
          assert.ok(calls, `${width}: calls in ${row}`);
          assert.equal(
            (calls.index ?? 0) + calls[0].length - 1,
            callsEnd,
            `${width}: calls right-aligned under header in ${row}`,
          );
          const rate = row.slice(callsEnd, rateEnd);
          assert.match(rate, /\d\.\d$/, `${width}: tok/s ends under its header in ${row}`);
        }
      }
      // Names and tags survive at every width.
      assert.match(section, /● Claude Sonnet 5\.5/, `${width}: whole model name`);
      assert.match(section, /● Grok 4\.7( \(xAI\))? (· )?fast\?/, `${width}: fast tag`);
    }
});

test("By model and Throughput agree on provider suffixes at 40, 54, 80, 100, and 140", () => {
  const report = aggregateStats([
    record({ key: "a" }),
    record({
      key: "b",
      model: "claude-fable-5-1",
      tokens: { input: 1, output: 500, cacheRead: 0, cacheWrite: 0 },
    }),
    record({ key: "c", provider: "xai", model: "grok-4.7", fastRequested: false }),
    record({ key: "d", provider: "openai-codex", model: "gpt-6-astra", fastRequested: true }),
  ]);
  const names = (_provider: string, model: string) =>
    ({
      "claude-opus-5-5": "Claude Opus 5.5",
      "claude-fable-5-1": "Claude Fable 5.1",
      "grok-4.7": "Grok 4.7",
      "gpt-6-astra": "GPT-6 Astra",
    })[model];
  const seen: Record<number, boolean> = {};
  for (const width of [40, 54, 80, 100, 140])
    for (const expanded of [false, true]) {
      const body = formatStats(report, {
        period: "all",
        scope: "all",
        expanded,
        now: NOW,
        scan,
        width,
        modelNames: names,
      });
      const models = body.split("By model")[1]?.split("\nBy feature")[0] ?? "";
      const speed = body.split("\nThroughput")[1]?.split("\n\n")[0] ?? "";
      const modelRows = models.split("\n").filter((line) => line.startsWith("  ●"));
      const speedRows = speed.split("\n").filter((line) => line.startsWith("  ●"));
      assert.ok(modelRows.length >= 3 && speedRows.length >= 3, `${width}: rows present`);
      const suffixIn = (rows: string[]) =>
        rows.map((row) => /\((Anthropic|xAI|OpenAI Codex)\)/.test(row));
      const inModels = suffixIn(modelRows);
      const inSpeed = suffixIn(speedRows);
      assert.equal(new Set(inModels).size, 1, `${width}/${expanded}: By model is uniform`);
      assert.equal(new Set(inSpeed).size, 1, `${width}/${expanded}: Throughput is uniform`);
      assert.equal(inModels[0], inSpeed[0], `${width}/${expanded}: both tables agree`);
      seen[width] = inModels[0] ?? false;
    }
  assert.equal(seen[140], true, "140 shows providers");
  assert.equal(seen[54], false, "54 omits providers");
  assert.equal(
    seen[80],
    false,
    "80 omits providers: the widest tagged label would not fit the column",
  );
});
