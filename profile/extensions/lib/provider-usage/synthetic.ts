import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeValue } from "../runtime-values.ts";
import { fetchUsageJson, identityKey, type UsageCache } from "../usage-cache.ts";
import {
  currencyValue,
  dateValue,
  formatNumber,
  isRecord,
  numberValue,
  providerToken,
  stringValue,
  usageCache,
  withCacheNote,
} from "./helpers.ts";
import {
  clampPercent,
  USAGE_POLICY,
  type ProviderUsage,
  type UsageProviderAdapter,
  type UsageWindow,
} from "./types.ts";

/**
 * Shortest gap between two Synthetic readings worth reading a pace from. Below
 * it a single request dominates the difference and the verdict would flicker.
 */
const MIN_PACE_INTERVAL_MS = 30_000;

/** One reading of a bucket that refills instead of resetting. */
type RefillReading = { capacity: number; remaining: number };

type SyntheticReadings = { weekly?: RefillReading };

export function syntheticReadings(payload: RuntimeValue): SyntheticReadings {
  if (!isRecord(payload)) return {};
  const readings: SyntheticReadings = {};
  const plan = isRecord(payload.planWeeklyLimit) ? payload.planWeeklyLimit : undefined;
  const planRemaining = plan ? numberValue(plan.percentRemaining) : undefined;
  if (planRemaining !== undefined) {
    readings.weekly = { capacity: 100, remaining: planRemaining };
    return readings;
  }
  const weekly = isRecord(payload.weeklyTokenLimit) ? payload.weeklyTokenLimit : undefined;
  const maxCredits = weekly ? stringValue(weekly.maxCredits) : undefined;
  const remainingCredits = weekly ? stringValue(weekly.remainingCredits) : undefined;
  if (maxCredits && remainingCredits) {
    const weeklyCapacity = currencyValue(maxCredits);
    if (weeklyCapacity > 0) {
      readings.weekly = {
        capacity: weeklyCapacity,
        remaining: currencyValue(remainingCredits),
      };
    }
  }
  return readings;
}

export function refillPace(
  current: RefillReading | undefined,
  previous: RefillReading | undefined,
  elapsedMs: number,
): UsageWindow["pace"] {
  if (!current || !previous) return undefined;
  if (previous.capacity !== current.capacity) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_PACE_INTERVAL_MS) return undefined;
  return current.remaining < previous.remaining
    ? { health: "over", label: "spending faster than it refills" }
    : { health: "under", label: "refill keeping up" };
}

export function normalizeSyntheticUsage(
  payload: RuntimeValue,
  previous?: { payload: RuntimeValue; storedAt: number },
  payloadAt = Date.now(),
): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const windows: UsageWindow[] = [];
  const readings = syntheticReadings(payload);
  const priorReadings = previous ? syntheticReadings(previous.payload) : {};
  const elapsedMs = previous ? payloadAt - previous.storedAt : Number.NaN;

  const plan = isRecord(payload.planWeeklyLimit) ? payload.planWeeklyLimit : undefined;
  const planRemaining = plan ? numberValue(plan.percentRemaining) : undefined;
  if (planRemaining !== undefined) {
    const regenPercent = numberValue(plan?.nextRegenPercent);
    const window: UsageWindow = {
      label: "Weekly",
      percent: clampPercent(100 - planRemaining),
      qualifier: "used",
      eventAt: dateValue(plan?.nextRegenAt),
      eventLabel:
        regenPercent === undefined
          ? "regenerates"
          : `regenerates ${formatNumber(regenPercent, 0)}%`,
    };
    const pace = refillPace(readings.weekly, priorReadings.weekly, elapsedMs);
    if (pace) window.pace = pace;
    windows.push(window);
    return { name: "Synthetic", windows };
  }

  const weekly = isRecord(payload.weeklyTokenLimit) ? payload.weeklyTokenLimit : undefined;
  const remainingPercent = weekly ? numberValue(weekly.percentRemaining) : undefined;
  if (remainingPercent !== undefined) {
    const nextRegenCredits = stringValue(weekly?.nextRegenCredits);
    const maxCredits = stringValue(weekly?.maxCredits);
    const regenPercent =
      nextRegenCredits && maxCredits
        ? (currencyValue(nextRegenCredits) / currencyValue(maxCredits)) * 100
        : undefined;
    const regenDescription = nextRegenCredits
      ? `regenerates${regenPercent !== undefined && Number.isFinite(regenPercent) ? ` ${formatNumber(regenPercent, 0)}%` : ""} (${nextRegenCredits})`
      : "regenerates";
    const window: UsageWindow = {
      label: "Weekly credits",
      percent: clampPercent(100 - remainingPercent),
      qualifier: "used",
      eventAt: dateValue(weekly?.nextRegenAt),
      eventLabel: regenDescription,
      detail: stringValue(weekly?.remainingCredits)
        ? `${weekly?.remainingCredits} remaining`
        : undefined,
    };
    const pace = refillPace(readings.weekly, priorReadings.weekly, elapsedMs);
    if (pace) window.pace = pace;
    windows.push(window);
  }

  return { name: "Synthetic", windows };
}

export async function readSyntheticUsage(
  token: string,
  cache: UsageCache = usageCache,
): Promise<ProviderUsage> {
  const usage = await cache.request(
    `synthetic:usage:${identityKey(token)}`,
    () => fetchUsageJson("https://api.synthetic.new/v2/quotas", token, {}),
    USAGE_POLICY,
  );
  return withCacheNote(
    normalizeSyntheticUsage(usage.payload, usage.previous, usage.payloadAt),
    usage,
  );
}

export async function syntheticUsage(
  ctx: ExtensionContext,
  cache: UsageCache,
): Promise<ProviderUsage | undefined> {
  const token = await providerToken(ctx, "synthetic");
  if (!token) return undefined;
  return readSyntheticUsage(token, cache);
}

export const syntheticUsageProviderAdapter: UsageProviderAdapter = {
  id: "synthetic",
  displayName: "Synthetic",
  order: 50,
  providerIds: ["synthetic"],
  readUsage: syntheticUsage,
  readSnapshot: async (ctx, _provider, cache) => {
    const token = await providerToken(ctx, "synthetic");
    if (!token) return undefined;
    return readSyntheticUsage(token, cache);
  },
  resolveAccountId: async (ctx) => {
    const token = await providerToken(ctx, "synthetic");
    return token ? identityKey(token) : undefined;
  },
};
