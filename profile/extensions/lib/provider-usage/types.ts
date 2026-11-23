import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageCache, UsageRequestPolicy } from "../usage-cache.ts";

export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;

/**
 * Quota windows move slowly, so one live read per minute per endpoint is enough
 * for an open Usage tab while leaving the provider's rate limit alone. A stored
 * snapshot stays on screen for an hour of failures before the tab admits it has
 * nothing current to show.
 */
export const USAGE_POLICY: UsageRequestPolicy = {
  minIntervalMs: 60_000,
  maxStaleMs: 60 * 60_000,
};

/** The plan only changes when the subscription does, so it is read far less often. */
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
  /**
   * Full length of the quota window. Set only where the provider states a
   * fixed window, which is what makes `eventAt` measurable as a pace.
   */
  windowSeconds?: number;
  /**
   * Pace decided by the provider rather than by the clock. A refilling bucket
   * has no window to run out of, so its verdict comes from comparing two
   * snapshots against the refill rate.
   */
  pace?: { health: "over" | "under"; label: string };
  /**
   * Provider name of the model group a scoped window limits, such as
   * `"Fable"`. Absent: the window limits every model on the account.
   */
  scope?: string;
};

export type ProviderUsage = {
  name: string;
  plan?: string;
  status?: string;
  /** Set when the report comes from the store instead of a live response. */
  cached?: { at: Date; reason?: string };
  windows: UsageWindow[];
};

/**
 * How a quota window is doing against its own clock: `over` means quota is
 * being spent faster than the window replaces it, `under` means slower, and
 * `unknown` means nothing measurable was reported.
 */
export type QuotaHealth = "exhausted" | "over" | "under" | "unknown";

/**
 * Quota windows of one provider together with the epoch ms they were read. A
 * reading served from the store carries the time it was originally fetched, so
 * a caller can tell a live reading from one that predates an event.
 */
export type ProviderUsageSnapshot = {
  windows: UsageWindow[];
  observedAt: number;
};

/** Theme hooks used by a coloured report; omitted when the surface is plain text. */
export type UsageStyle = { fg(color: string, text: string): string };

/** A window's printed percentage and its secondary line. */
export type UsageWindowSummary = { percent: string; detail: string };

/** One provider's outcome: its report, or why none could be read. */
export type ProviderUsageReading =
  | { ok: true; usage: ProviderUsage }
  | { ok: false; name: string; error: string };

/**
 * Every signed-in provider's outcome from one round of requests, when the
 * round finished, and the names of providers skipped because they have no
 * credential (absent means none were skipped).
 */
export type ProviderUsageReport = {
  observedAt: Date;
  providers: ProviderUsageReading[];
  absent?: string[];
};

/**
 * Pluggable usage provider adapter registered in the global usage-provider
 * registry (`Symbol.for("choco-pi:usage-providers/v1")`).
 */
export type UsageProviderAdapter = {
  /** Unique adapter identifier (e.g. `"anthropic"`, `"chatgpt"`). */
  id: string;
  /** Display name used in Usage reports and absent/error entries. */
  displayName: string;
  /** Display order rank (lower renders first). */
  order: number;
  /** Provider IDs this adapter handles for snapshot and account-id lookups. */
  providerIds?: readonly string[];
  /** Reads usage for the Usage tab; resolves `undefined` when not connected. */
  readUsage: (ctx: ExtensionContext, cache: UsageCache) => Promise<ProviderUsage | undefined>;
  /** Optional snapshot reader for limit corroboration. */
  readSnapshot?: (
    ctx: ExtensionContext,
    provider: string,
    cache: UsageCache,
  ) => Promise<ProviderUsage | undefined>;
  /** Optional stable account ID resolver for per-account limit closures. */
  resolveAccountId?: (
    ctx: ExtensionContext,
    provider: string,
    cache: UsageCache,
  ) => Promise<string | undefined>;
};

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Share of a fixed window already elapsed, which is the pace a subscription
 * window can be judged against: spending exactly this much of the quota keeps
 * the allowance lasting until the window resets.
 */
export function windowElapsedPercent(window: UsageWindow, now: number): number | undefined {
  if (window.windowSeconds === undefined || window.windowSeconds <= 0) return undefined;
  if (window.eventAt === undefined) return undefined;
  const remainingSeconds = (window.eventAt.getTime() - now) / 1000;
  if (!Number.isFinite(remainingSeconds)) return undefined;
  return clampPercent(((window.windowSeconds - remainingSeconds) / window.windowSeconds) * 100);
}

/**
 * A window's colour verdict. An exhausted quota outranks everything; a
 * provider-supplied pace is used where it exists; otherwise the used share is
 * compared against the share of the window that has already passed.
 */
export function quotaHealth(window: UsageWindow, now: number): QuotaHealth {
  if (window.percent >= 100) return "exhausted";
  if (window.pace) return window.pace.health;
  const elapsed = windowElapsedPercent(window, now);
  if (elapsed === undefined) return "unknown";
  return window.percent > elapsed ? "over" : "under";
}
