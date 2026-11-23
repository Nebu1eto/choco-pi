import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageCache, UsageRequestPolicy } from "../usage-cache.ts";

export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;

export const USAGE_POLICY: UsageRequestPolicy = {
  minIntervalMs: 60_000,
  maxStaleMs: 60 * 60_000,
};

export const PROFILE_POLICY: UsageRequestPolicy = {
  minIntervalMs: 30 * 60_000,
  maxStaleMs: 7 * 24 * 60 * 60_000,
};

export type UsageWindow = {
  label: string;
  percent: number;
  qualifier: "used" | "remaining";
  eventAt?: Date;
  eventLabel?: string;
  detail?: string;
  windowSeconds?: number;
  pace?: { health: "over" | "under"; label: string };
  scope?: string;
};

export type ProviderUsage = {
  name: string;
  plan?: string;
  status?: string;
  cached?: { at: Date; reason?: string };
  windows: UsageWindow[];
};

export type QuotaHealth = "exhausted" | "over" | "under" | "unknown";

export type ProviderUsageSnapshot = {
  windows: UsageWindow[];
  observedAt: number;
};

export type UsageStyle = { fg(color: string, text: string): string };

export type UsageWindowSummary = { percent: string; detail: string };

export type ProviderUsageReading =
  | { ok: true; usage: ProviderUsage }
  | { ok: false; name: string; error: string };

export type ProviderUsageReport = {
  observedAt: Date;
  providers: ProviderUsageReading[];
  absent?: string[];
};

export type UsageProviderAdapter = {
  id: string;
  displayName: string;
  order: number;
  providerIds?: readonly string[];
  readUsage: (ctx: ExtensionContext, cache: UsageCache) => Promise<ProviderUsage | undefined>;
  readSnapshot?: (
    ctx: ExtensionContext,
    provider: string,
    cache: UsageCache,
  ) => Promise<ProviderUsage | undefined>;
  resolveAccountId?: (
    ctx: ExtensionContext,
    provider: string,
    cache: UsageCache,
  ) => Promise<string | undefined>;
};

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function windowElapsedPercent(window: UsageWindow, now: number): number | undefined {
  if (window.windowSeconds === undefined || window.windowSeconds <= 0) return undefined;
  if (window.eventAt === undefined) return undefined;
  const remainingSeconds = (window.eventAt.getTime() - now) / 1000;
  if (!Number.isFinite(remainingSeconds)) return undefined;
  return clampPercent(((window.windowSeconds - remainingSeconds) / window.windowSeconds) * 100);
}

export function quotaHealth(window: UsageWindow, now: number): QuotaHealth {
  if (window.percent >= 100) return "exhausted";
  if (window.pace) return window.pace.health;
  const elapsed = windowElapsedPercent(window, now);
  if (elapsed === undefined) return "unknown";
  return window.percent > elapsed ? "over" : "under";
}
