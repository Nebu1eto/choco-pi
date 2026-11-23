import { codeModeSplit, FEATURE_CODE_MODE, FEATURE_SUBAGENTS } from "./features.ts";
import { type CallRecord, type CallTokens, totalTokens } from "./records.ts";
import {
  isAutoTrigger,
  isNativeFallback,
  isNoOpFallback,
  type CompactionEvent,
  type LaneEvent,
} from "./compaction.ts";
import {
  estimateSpeed,
  MIN_ESTIMATE_SAMPLES,
  type SpeedEstimate,
  type SpeedSample,
} from "./estimate.ts";
import {
  baseModelId,
  fastPriceMultiplier,
  fastStateOf,
  tierRates,
  type FastState,
  type ModelPrices,
  type PriceLookup,
} from "./fast.ts";

export type Period = "24h" | "3d" | "7d" | "30d" | "all";
export const PERIODS: readonly Period[] = ["24h", "3d", "7d", "30d", "all"];
export const DEFAULT_PERIOD: Period = "30d";

export function isPeriod(value: string): value is Period {
  return PERIODS.some((period) => period === value);
}

export type Scope = "all" | "project";
export const DEFAULT_SCOPE: Scope = "all";

export type StatsSelection = { period: Period; scope: Scope };

export function nextPeriod(period: Period): Period {
  const index = PERIODS.indexOf(period);
  return PERIODS[(index + 1) % PERIODS.length] ?? DEFAULT_PERIOD;
}

export function periodLabel(period: Period): string {
  if (period === "24h") return "Last 24 hours";
  if (period === "3d") return "Last 3 days";
  if (period === "7d") return "Last 7 days";
  if (period === "30d") return "Last 30 days";
  return "All time";
}

export function periodDays(period: Period): number | undefined {
  if (period === "3d") return 3;
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

const HOUR_MS = 3_600_000;

export function periodStart(period: Period, now: number): number | undefined {
  if (period === "24h") return now - HOUR_MS * 24;
  const days = periodDays(period);
  if (days === undefined) return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

export const ALL_TIME_CHART_DAYS = 60;

export type BucketUnit = "day" | "hour";

export function bucketUnitOf(period: Period): BucketUnit {
  return period === "24h" ? "hour" : "day";
}

export function hourStart(at: number): number {
  const date = new Date(at);
  return at - (date.getMinutes() * 60_000 + date.getSeconds() * 1000 + date.getMilliseconds());
}

export function bucketKey(unit: BucketUnit, at: number): string {
  return unit === "day" ? dayKey(at) : String(hourStart(at));
}

export type Timeline = { unit: BucketUnit; keys: string[] };

export function timelineOf(period: Period, now: number): Timeline {
  const unit = bucketUnitOf(period);
  const keys: string[] = [];
  if (unit === "hour") {
    const first = hourStart(now - HOUR_MS * 24);
    for (let at = hourStart(now); at >= first; at = hourStart(at - 1)) keys.unshift(String(at));
    return { unit, keys };
  }
  const days = periodDays(period) ?? ALL_TIME_CHART_DAYS;
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    keys.push(dayKey(date.getTime()));
  }
  return { unit, keys };
}

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
  projectDirs: readonly string[];
  now: number;
};

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

export type { ModelPrices, PriceLookup } from "./fast.ts";

export type Breakdown = {
  key: string;
  calls: number;
  tokens: CallTokens;
  cost: number;
  share: number;
};

export type SpeedRow = {
  key: string;
  model: string;
  fast: FastState | undefined;
  calls: number;
  outputTokens: number;
  timedCalls: number;
  generationTokPerSec: number | undefined;
  ttftMedianMs: number | undefined;
  ttftP90Ms: number | undefined;
  estimate: SpeedEstimate | undefined;
};

export type DayBucket = { day: string; tokens: number; cost: number; calls: number };

export type TimelineData = {
  unit: BucketUnit;
  totals: Map<string, DayBucket>;
  byModel: Map<string, Map<string, number>>;
  speed: Map<string, Map<string, SpeedAccumulator>>;
};

export type StatsReport = {
  calls: number;
  failedCalls: number;
  sessions: number;
  tokens: CallTokens;
  recordedCost: number;
  estimatedCost: number;
  estimatedCalls: number;
  unpricedCalls: number;
  unpricedTokens: number;
  byModel: Breakdown[];
  byFeature: Breakdown[];
  byCodeMode: Breakdown[];
  byDay: DayBucket[];
  timeline: TimelineData;
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

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function featureOf(record: CallRecord): string {
  return record.isSubagent ? FEATURE_SUBAGENTS : record.feature;
}

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

export type SpeedAccumulator = {
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

const TREND_FIT_POINTS = 150;

export function bucketTokPerSec(speed: SpeedAccumulator | undefined): number | undefined {
  if (speed === undefined) return undefined;
  if (speed.generationMs > 0) return speed.timedOutputTokens / (speed.generationMs / 1000);
  if (speed.samples.length < MIN_ESTIMATE_SAMPLES) return undefined;
  return estimateSpeed(speed.samples, TREND_FIT_POINTS)?.tokPerSec;
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
  fallbacks: number;
  noOps: number;
};

export type CompactionSummary = {
  total: number;
  manual: number;
  auto: number;
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

export function aggregateStats(
  records: readonly CallRecord[],
  options: {
    priceLookup?: PriceLookup;
    compactions?: readonly CompactionEvent[];
    laneEvents?: readonly LaneEvent[];
    unit?: BucketUnit;
  } = {},
): StatsReport {
  const unit = options.unit ?? "day";
  const tokens = emptyTokens();
  const sessions = new Set<string>();
  const byModel = new Map<string, BreakdownAccumulator>();
  const byFeature = new Map<string, BreakdownAccumulator>();
  const byCodeMode = new Map<string, BreakdownAccumulator>();
  const byDay = new Map<string, DayBucket>();
  const timelineTotals = new Map<string, DayBucket>();
  const timelineByModel = new Map<string, Map<string, number>>();
  const timelineSpeed = new Map<string, Map<string, SpeedAccumulator>>();
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
    const slot = unit === "day" ? day : bucketKey(unit, record.at);
    const slotTotals = timelineTotals.get(slot) ?? { day: slot, tokens: 0, cost: 0, calls: 0 };
    slotTotals.tokens += total;
    slotTotals.cost += cost;
    slotTotals.calls += 1;
    timelineTotals.set(slot, slotTotals);
    const series = timelineByModel.get(modelKey(record)) ?? new Map<string, number>();
    series.set(slot, (series.get(slot) ?? 0) + total);
    timelineByModel.set(modelKey(record), series);
    if (record.kind === "assistant") {
      const provider = speedByProvider.get(record.provider) ?? newSpeed(record.provider, undefined);
      addSpeed(provider, record);
      speedByProvider.set(record.provider, provider);
      const base = `${record.provider}/${baseModelId(record.model)}`;
      const key = fast === undefined ? base : `${base}|${fast}`;
      const model = speedByModel.get(key) ?? newSpeed(base, fast);
      addSpeed(model, record);
      speedByModel.set(key, model);
      const trend = timelineSpeed.get(base) ?? new Map<string, SpeedAccumulator>();
      const point = trend.get(slot) ?? newSpeed(base, undefined);
      addSpeed(point, record);
      trend.set(slot, point);
      timelineSpeed.set(base, trend);
    }
    if (firstAt === undefined || record.at < firstAt) firstAt = record.at;
    if (lastAt === undefined || record.at > lastAt) lastAt = record.at;
  }

  const allTokens = totalTokens(tokens);
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
    timeline: {
      unit,
      totals: timelineTotals,
      byModel: timelineByModel,
      speed: timelineSpeed,
    },
    speed: { byProvider: speedRows(speedByProvider), byModel: speedRows(speedByModel) },
    firstAt,
    lastAt,
  };
}
