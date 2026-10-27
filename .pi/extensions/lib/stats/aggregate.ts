import { codeModeSplit, FEATURE_CODE_MODE, FEATURE_SUBAGENTS } from "./features.ts";
import { type CallRecord, type CallTokens, totalTokens } from "./records.ts";
import {
  isAutoTrigger,
  isNativeFallback,
  isNoOpFallback,
  type CompactionEvent,
  type LaneEvent,
} from "./compaction.ts";
import { estimateSpeed, type SpeedEstimate, type SpeedSample } from "./estimate.ts";
import {
  baseModelId,
  fastPriceMultiplier,
  fastStateOf,
  tierRates,
  type FastState,
  type ModelPrices,
  type PriceLookup,
} from "./fast.ts";

export type Period = "30d" | "7d" | "all";
/** The order `r` cycles through. */
export const PERIODS: readonly Period[] = ["30d", "7d", "all"];
export const DEFAULT_PERIOD: Period = "30d";

export type Scope = "all" | "project";
export const DEFAULT_SCOPE: Scope = "all";

/** The period and scope the Statistics tab shows. */
export type StatsSelection = { period: Period; scope: Scope };

export function nextPeriod(period: Period): Period {
  const index = PERIODS.indexOf(period);
  return PERIODS[(index + 1) % PERIODS.length] ?? DEFAULT_PERIOD;
}

export function periodLabel(period: Period): string {
  if (period === "7d") return "Last 7 days";
  if (period === "30d") return "Last 30 days";
  return "All time";
}

export function periodDays(period: Period): number | undefined {
  if (period === "7d") return 7;
  if (period === "30d") return 30;
  return undefined;
}

export function toggleScope(scope: Scope): Scope {
  return scope === "all" ? "project" : "all";
}

export function scopeLabel(scope: Scope): string {
  return scope === "all" ? "all projects" : "this project";
}

/**
 * Inclusive lower bound of the period in epoch ms, or undefined for all time.
 * "Last N days" means the N local calendar days ending today, so the bound is
 * local midnight of today minus N-1 days (date arithmetic, so DST days count
 * as one day), matching the chart buckets and the active-day count.
 */
export function periodStart(period: Period, now: number): number | undefined {
  const days = periodDays(period);
  if (days === undefined) return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * Drop every record whose key was already seen. Records must arrive with
 * parent sessions before their forks so the original file keeps the call.
 */
export type DedupedRecords = { records: CallRecord[]; duplicates: number };

export function dedupeRecords(records: readonly CallRecord[]): DedupedRecords {
  const seen = new Set<string>();
  const kept: CallRecord[] = [];
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.key)) {
      duplicates += 1;
      continue;
    }
    seen.add(record.key);
    kept.push(record);
  }
  return { records: kept, duplicates };
}

export type RecordFilter = {
  period: Period;
  scope: Scope;
  /**
   * Directories the "project" scope keeps: the current directory and, in a
   * git repository, every worktree of it, so a checkout and its worktrees
   * read as one project.
   */
  projectDirs: readonly string[];
  now: number;
};

/** A directory path with its trailing separator removed, for header comparisons. */
export function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : dir;
}

export function filterRecords(records: readonly CallRecord[], filter: RecordFilter): CallRecord[] {
  const start = periodStart(filter.period, filter.now);
  const dirs = new Set(filter.projectDirs.map(normalizeDir));
  return records.filter((record) => {
    if (start !== undefined && record.at < start) return false;
    if (filter.scope === "project" && !dirs.has(normalizeDir(record.cwd))) return false;
    return true;
  });
}

/** Per-million-token list prices of a model, as the model registry exposes them. */
export type { ModelPrices, PriceLookup } from "./fast.ts";

export type Breakdown = {
  key: string;
  calls: number;
  tokens: CallTokens;
  /** Recorded plus estimated dollars. */
  cost: number;
  /** Share of all tokens in the report, 0..1. */
  share: number;
};

export type SpeedRow = {
  /** Row key: the provider, or the model key with a Fast suffix ("|on", "|off", "|unknown") when split. */
  key: string;
  /** The model key (provider/model) the row belongs to; the provider for provider rows. */
  model: string;
  /** Fast state when the provider supports Fast and the row is a model row. */
  fast: FastState | undefined;
  /** Successful calls with output and a duration. */
  calls: number;
  outputTokens: number;
  /** Calls that also carry a recorded TTFT. */
  timedCalls: number;
  /**
   * Generation speed: output tokens per second after the first token, over the
   * timed calls only. Rows without timed calls take the fitted estimate.
   */
  generationTokPerSec: number | undefined;
  ttftMedianMs: number | undefined;
  ttftP90Ms: number | undefined;
  /** TTFT and generation rate fitted from request timing when no TTFT was recorded. */
  estimate: SpeedEstimate | undefined;
};

export type DayBucket = { day: string; tokens: number; cost: number; calls: number };

export type StatsReport = {
  calls: number;
  failedCalls: number;
  sessions: number;
  tokens: CallTokens;
  /** Dollars recorded with the calls. */
  recordedCost: number;
  /** Dollars estimated at current list prices for calls recorded at zero. */
  estimatedCost: number;
  estimatedCalls: number;
  /** Calls with tokens but neither a recorded nor an estimable price. */
  unpricedCalls: number;
  unpricedTokens: number;
  byModel: Breakdown[];
  byFeature: Breakdown[];
  /** What code-mode scripts executed, the code-mode rows' tokens and cost split by result size. */
  byCodeMode: Breakdown[];
  byDay: DayBucket[];
  /** Tokens per model key per local day, for the daily chart series. */
  byModelDay: Map<string, Map<string, number>>;
  speed: { byProvider: SpeedRow[]; byModel: SpeedRow[] };
  context: ContextStats;
  compaction: CompactionSummary;
  firstAt: number | undefined;
  lastAt: number | undefined;
};

function emptyTokens(): CallTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(into: CallTokens, tokens: CallTokens): void {
  into.input += tokens.input;
  into.output += tokens.output;
  into.cacheRead += tokens.cacheRead;
  into.cacheWrite += tokens.cacheWrite;
}

/** Local calendar day of an epoch ms value, as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function featureOf(record: CallRecord): string {
  return record.isSubagent ? FEATURE_SUBAGENTS : record.feature;
}

/**
 * List price of a call whose log carries no cost: the tier the context fell
 * in, times the Fast multiplier when the call is classified fast (the same
 * multiples the Codex and xAI integrations apply before persisting). A
 * "fast?" call prices at the standard rate.
 */
export function estimateCost(
  record: CallRecord,
  prices: ModelPrices,
  fast: FastState | undefined,
): number {
  const rates = tierRates(prices, record);
  const tokens = record.tokens;
  const list =
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
    1_000_000;
  return fast === "on"
    ? list * fastPriceMultiplier(record.provider, baseModelId(record.model))
    : list;
}

function percentile(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

type SpeedAccumulator = {
  model: string;
  fast: FastState | undefined;
  samples: SpeedSample[];
  calls: number;
  outputTokens: number;
  timedCalls: number;
  timedOutputTokens: number;
  generationMs: number;
  ttfts: number[];
};

function fastOrder(fast: FastState | undefined): number {
  return fast === "on" ? 0 : fast === "off" ? 1 : 2;
}

function newSpeed(model: string, fast: FastState | undefined): SpeedAccumulator {
  return {
    model,
    fast,
    samples: [],
    calls: 0,
    outputTokens: 0,
    timedCalls: 0,
    timedOutputTokens: 0,
    generationMs: 0,
    ttfts: [],
  };
}

function addSpeed(into: SpeedAccumulator, record: CallRecord): void {
  const duration = record.durationMs;
  if (duration === undefined || duration <= 0 || record.tokens.output <= 0) return;
  into.calls += 1;
  into.outputTokens += record.tokens.output;
  if (!record.failed && record.stopReason !== "error" && record.stopReason !== "aborted")
    into.samples.push({ output: record.tokens.output, durationMs: duration });
  const ttft = record.ttftMs;
  if (ttft === undefined || ttft < 0 || ttft >= duration) return;
  into.timedCalls += 1;
  into.timedOutputTokens += record.tokens.output;
  into.generationMs += duration - ttft;
  into.ttfts.push(ttft);
}

function finishSpeed(key: string, speed: SpeedAccumulator): SpeedRow {
  const sorted = [...speed.ttfts].sort((a, b) => a - b);
  return {
    key,
    model: speed.model,
    fast: speed.fast,
    calls: speed.calls,
    outputTokens: speed.outputTokens,
    timedCalls: speed.timedCalls,
    generationTokPerSec:
      speed.generationMs > 0 ? speed.timedOutputTokens / (speed.generationMs / 1000) : undefined,
    ttftMedianMs: percentile(sorted, 0.5),
    ttftP90Ms: percentile(sorted, 0.9),
    estimate: estimateSpeed(speed.samples),
  };
}

type BreakdownAccumulator = { calls: number; tokens: CallTokens; cost: number };

function accumulate(
  map: Map<string, BreakdownAccumulator>,
  key: string,
  tokens: CallTokens,
  cost: number,
  weight = 1,
): void {
  const entry = map.get(key) ?? { calls: 0, tokens: emptyTokens(), cost: 0 };
  entry.calls += weight;
  addTokens(entry.tokens, scaleTokens(tokens, weight));
  entry.cost += cost * weight;
  map.set(key, entry);
}

function scaleTokens(tokens: CallTokens, weight: number): CallTokens {
  if (weight === 1) return tokens;
  // Whole tokens: the split is approximate anyway and the tables print integers.
  return {
    input: Math.round(tokens.input * weight),
    output: Math.round(tokens.output * weight),
    cacheRead: Math.round(tokens.cacheRead * weight),
    cacheWrite: Math.round(tokens.cacheWrite * weight),
  };
}

function toBreakdown(map: Map<string, BreakdownAccumulator>, allTokens: number): Breakdown[] {
  return [...map]
    .map(([key, entry]) => ({
      key,
      calls: entry.calls,
      tokens: entry.tokens,
      cost: entry.cost,
      share: allTokens > 0 ? totalTokens(entry.tokens) / allTokens : 0,
    }))
    .sort((a, b) => b.share - a.share || b.cost - a.cost || a.key.localeCompare(b.key));
}

/** Share of calls made at large context, from input + cache read + cache write. */
export type ContextStats = {
  calls: number;
  over100k: number;
  over200k: number;
  over400k: number;
  medianContext: number | undefined;
  p90Context: number | undefined;
};

export type CompactionProviderRow = {
  provider: string;
  builtIn: number;
  serverSide: number;
  host: number;
  unknown: number;
  /** Lane fallbacks from a native lane that did compact something (built-in took over). */
  fallbacks: number;
  /** Fallbacks that found nothing to summarize; no checkpoint followed. */
  noOps: number;
};

export type CompactionSummary = {
  total: number;
  manual: number;
  auto: number;
  /** The automatic triggers broken down, for the expanded view. */
  autoBy: { threshold: number; overflow: number; idle: number; contextCap: number };
  unknownTrigger: number;
  byProvider: CompactionProviderRow[];
  fallbacks: number;
  noOps: number;
};

export function contextStats(records: readonly CallRecord[]): ContextStats {
  const sizes = records
    .filter((record) => record.kind === "assistant" && !record.failed)
    .map((record) => record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite)
    .sort((a, b) => a - b);
  return {
    calls: sizes.length,
    over100k: sizes.filter((size) => size >= 100_000).length,
    over200k: sizes.filter((size) => size >= 200_000).length,
    over400k: sizes.filter((size) => size >= 400_000).length,
    medianContext: percentile(sizes, 0.5),
    p90Context: percentile(sizes, 0.9),
  };
}

export function compactionSummary(
  compactions: readonly CompactionEvent[],
  lanes: readonly LaneEvent[],
): CompactionSummary {
  const rows = new Map<string, CompactionProviderRow>();
  const row = (provider: string): CompactionProviderRow => {
    const existing = rows.get(provider);
    if (existing !== undefined) return existing;
    const created = {
      provider,
      builtIn: 0,
      serverSide: 0,
      host: 0,
      unknown: 0,
      fallbacks: 0,
      noOps: 0,
    };
    rows.set(provider, created);
    return created;
  };
  let manual = 0;
  let auto = 0;
  const autoBy = { threshold: 0, overflow: 0, idle: 0, contextCap: 0 };
  for (const event of compactions) {
    const target = row(event.provider);
    if (event.method === "built-in") target.builtIn += 1;
    else if (event.method === "server-side") target.serverSide += 1;
    else if (event.method === "host") target.host += 1;
    else target.unknown += 1;
    if (event.trigger === "manual") manual += 1;
    else if (isAutoTrigger(event.trigger)) {
      auto += 1;
      if (event.trigger === "threshold") autoBy.threshold += 1;
      else if (event.trigger === "overflow") autoBy.overflow += 1;
      else if (event.trigger === "idle") autoBy.idle += 1;
      else autoBy.contextCap += 1;
    }
  }
  let fallbacks = 0;
  let noOps = 0;
  for (const lane of lanes) {
    if (!isNativeFallback(lane)) continue;
    const target = row(lane.provider);
    if (isNoOpFallback(lane)) {
      target.noOps += 1;
      noOps += 1;
    } else {
      target.fallbacks += 1;
      fallbacks += 1;
    }
  }
  const byProvider = [...rows.values()].sort(
    (a, b) =>
      b.builtIn +
        b.serverSide +
        b.host +
        b.unknown -
        (a.builtIn + a.serverSide + a.host + a.unknown) || a.provider.localeCompare(b.provider),
  );
  return {
    total: compactions.length,
    manual,
    auto,
    autoBy,
    unknownTrigger: compactions.length - manual - auto,
    byProvider,
    fallbacks,
    noOps,
  };
}

/** Keep the events inside the period and scope, dropping fork copies by key. */
export function filterEvents<Event extends { key: string; at: number; cwd: string }>(
  events: readonly Event[],
  filter: RecordFilter,
): Event[] {
  const start = periodStart(filter.period, filter.now);
  const dirs = new Set(filter.projectDirs.map(normalizeDir));
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    if (start !== undefined && event.at < start) return false;
    if (filter.scope === "project" && !dirs.has(normalizeDir(event.cwd))) return false;
    return true;
  });
}

export function modelKey(record: CallRecord): string {
  return `${record.provider}/${record.model}`;
}

/**
 * Aggregate deduplicated, filtered records. Failed calls count only in
 * `failedCalls`; every other record lands in exactly one model bucket and one
 * feature bucket, so both breakdowns sum to the totals. Breakdown rows are
 * ordered by share of tokens, the metric their bars draw.
 */
export function aggregateStats(
  records: readonly CallRecord[],
  options: {
    priceLookup?: PriceLookup;
    compactions?: readonly CompactionEvent[];
    laneEvents?: readonly LaneEvent[];
  } = {},
): StatsReport {
  const tokens = emptyTokens();
  const sessions = new Set<string>();
  const byModel = new Map<string, BreakdownAccumulator>();
  const byFeature = new Map<string, BreakdownAccumulator>();
  const byCodeMode = new Map<string, BreakdownAccumulator>();
  const byDay = new Map<string, DayBucket>();
  const byModelDay = new Map<string, Map<string, number>>();
  const speedByProvider = new Map<string, SpeedAccumulator>();
  const speedByModel = new Map<string, SpeedAccumulator>();
  let calls = 0;
  let failedCalls = 0;
  let recordedCost = 0;
  let estimatedCost = 0;
  let estimatedCalls = 0;
  let unpricedCalls = 0;
  let unpricedTokens = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;

  for (const record of records) {
    sessions.add(record.sessionId);
    if (record.failed) {
      failedCalls += 1;
      continue;
    }
    calls += 1;
    const total = totalTokens(record.tokens);
    let cost = record.cost.total;
    const fast = fastStateOf(record, options.priceLookup);
    if (cost === 0 && total > 0) {
      const prices = options.priceLookup?.(record.provider, baseModelId(record.model));
      const estimate = prices === undefined ? 0 : estimateCost(record, prices, fast);
      if (estimate > 0) {
        estimatedCost += estimate;
        estimatedCalls += 1;
        cost = estimate;
      } else {
        unpricedCalls += 1;
        unpricedTokens += total;
      }
    } else {
      recordedCost += cost;
    }
    addTokens(tokens, record.tokens);
    accumulate(byModel, modelKey(record), record.tokens, cost);
    const feature = featureOf(record);
    accumulate(byFeature, feature, record.tokens, cost);
    if (feature === FEATURE_CODE_MODE)
      for (const [bucket, weight] of codeModeSplit(record.nestedCalls))
        accumulate(byCodeMode, bucket, record.tokens, cost, weight);
    const day = dayKey(record.at);
    const bucket = byDay.get(day) ?? { day, tokens: 0, cost: 0, calls: 0 };
    bucket.tokens += total;
    bucket.cost += cost;
    bucket.calls += 1;
    byDay.set(day, bucket);
    const series = byModelDay.get(modelKey(record)) ?? new Map<string, number>();
    series.set(day, (series.get(day) ?? 0) + total);
    byModelDay.set(modelKey(record), series);
    if (record.kind === "assistant") {
      const provider = speedByProvider.get(record.provider) ?? newSpeed(record.provider, undefined);
      addSpeed(provider, record);
      speedByProvider.set(record.provider, provider);
      const base = `${record.provider}/${baseModelId(record.model)}`;
      const key = fast === undefined ? base : `${base}|${fast}`;
      const model = speedByModel.get(key) ?? newSpeed(base, fast);
      addSpeed(model, record);
      speedByModel.set(key, model);
    }
    if (firstAt === undefined || record.at < firstAt) firstAt = record.at;
    if (lastAt === undefined || record.at > lastAt) lastAt = record.at;
  }

  const allTokens = totalTokens(tokens);
  // Rows order by output tokens; the Fast and standard rows of one model stay
  // together under the model's total, Fast first.
  const speedRows = (map: Map<string, SpeedAccumulator>): SpeedRow[] => {
    const rows = [...map]
      .map(([key, speed]) => finishSpeed(key, speed))
      .filter((row) => row.calls > 0);
    const perModel = new Map<string, number>();
    for (const row of rows)
      perModel.set(row.model, (perModel.get(row.model) ?? 0) + row.outputTokens);
    return rows.sort(
      (a, b) =>
        (perModel.get(b.model) ?? 0) - (perModel.get(a.model) ?? 0) ||
        a.model.localeCompare(b.model) ||
        fastOrder(a.fast) - fastOrder(b.fast),
    );
  };
  return {
    calls,
    failedCalls,
    sessions: sessions.size,
    tokens,
    recordedCost,
    estimatedCost,
    estimatedCalls,
    unpricedCalls,
    unpricedTokens,
    byModel: toBreakdown(byModel, allTokens),
    byFeature: toBreakdown(byFeature, allTokens),
    byCodeMode: toBreakdown(byCodeMode, allTokens),
    context: contextStats(records),
    compaction: compactionSummary(options.compactions ?? [], options.laneEvents ?? []),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModelDay,
    speed: { byProvider: speedRows(speedByProvider), byModel: speedRows(speedByModel) },
    firstAt,
    lastAt,
  };
}
