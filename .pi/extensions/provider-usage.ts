import { isNumber, isObject, isString, recordOf, type RuntimeValue } from "./lib/runtime-values.ts";
import {
  createFileUsageCacheStorage,
  createUsageCache,
  fetchUsageJson,
  identityKey,
  UsageThrottledError,
  type UsageRequestPolicy,
  type UsageRequestResult,
} from "./lib/usage-cache.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const USAGE_BAR_WIDTH = 50;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
/**
 * Shortest gap between two Synthetic readings worth reading a pace from. Below
 * it a single request dominates the difference and the verdict would flicker.
 */
const MIN_PACE_INTERVAL_MS = 30_000;

/**
 * Quota windows move slowly, so one live read per minute per endpoint is enough
 * for an open Usage tab while leaving the provider's rate limit alone. A stored
 * snapshot stays on screen for an hour of failures before the tab admits it has
 * nothing current to show.
 */
const USAGE_POLICY: UsageRequestPolicy = { minIntervalMs: 60_000, maxStaleMs: 60 * 60_000 };

/** The plan only changes when the subscription does, so it is read far less often. */
const PROFILE_POLICY: UsageRequestPolicy = {
  minIntervalMs: 30 * 60_000,
  maxStaleMs: 7 * 24 * 60 * 60_000,
};

const ANTHROPIC_HEADERS = { "anthropic-beta": "oauth-2025-04-20" };

const usageCache = createUsageCache({ storage: createFileUsageCacheStorage() });

type UsageWindow = {
  label: string;
  percent: number;
  qualifier: "used" | "remaining";
  eventAt?: Date;
  eventLabel?: string;
  detail?: string;
  precision?: number;
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
};

type ProviderUsage = {
  name: string;
  plan?: string;
  status?: string;
  /** Set when the report comes from the store instead of a live response. */
  cached?: { at: Date; reason?: string };
  windows: UsageWindow[];
};

type QuotaWindow = {
  utilization?: number;
  resets_at?: string;
};

/**
 * How a quota window is doing against its own clock: `over` means quota is
 * being spent faster than the window replaces it, `under` means slower, and
 * `unknown` means nothing measurable was reported.
 */
export type QuotaHealth = "exhausted" | "over" | "under" | "unknown";

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

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function numberValue(value: RuntimeValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: RuntimeValue): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function dateValue(value: RuntimeValue, unixSeconds = false): Date | undefined {
  if (unixSeconds && isNumber(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (!isString(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseJwtPayload(token: string): Record<string, RuntimeValue> | undefined {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return undefined;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function codexAccountId(token: string): string | undefined {
  const payload = parseJwtPayload(token);
  const auth = payload?.[OPENAI_AUTH_CLAIM];
  return isRecord(auth) ? stringValue(auth.chatgpt_account_id) : undefined;
}

function quotaWindow(value: RuntimeValue): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  return {
    utilization: numberValue(value.utilization),
    resets_at: stringValue(value.resets_at),
  };
}

function structuredClaudeWindow(value: RuntimeValue): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = numberValue(value.percent);
  const kind = stringValue(value.kind);
  if (percent === undefined || !kind) return undefined;

  let label: string;
  let windowSeconds: number;
  if (kind === "session") {
    label = "5h";
    windowSeconds = 5 * HOUR_SECONDS;
  } else if (kind === "weekly_all") {
    label = "7d";
    windowSeconds = 7 * DAY_SECONDS;
  } else if (kind === "weekly_scoped") {
    const scope = isRecord(value.scope) ? value.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    label = `${stringValue(model?.display_name) ?? "Scoped"} 7d`;
    windowSeconds = 7 * DAY_SECONDS;
  } else {
    return undefined;
  }

  return {
    label,
    percent: clampPercent(percent),
    qualifier: "used",
    eventAt: dateValue(value.resets_at),
    eventLabel: "resets",
    windowSeconds,
  };
}

const CLAUDE_RATE_LIMIT_TIERS = recordOf<string, string>()({
  default_claude_pro: "Pro",
  default_claude_max_5x: "Max (5x)",
  default_claude_max_20x: "Max (20x)",
});

const CLAUDE_SUBSCRIPTION_LABELS = recordOf<string, string>()({
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
});

/**
 * Derives the plan label from the `/api/oauth/profile` response. Team and
 * Enterprise organizations keep a Max rate-limit tier, so the organization
 * type decides those labels before the tier is consulted.
 */
export function claudePlanLabel(
  profile: RuntimeValue,
  fallbackSubscription?: string,
): string | undefined {
  const record = isRecord(profile) ? profile : undefined;
  const organization = record && isRecord(record.organization) ? record.organization : undefined;
  const account = record && isRecord(record.account) ? record.account : undefined;
  const organizationType = organization ? stringValue(organization.organization_type) : undefined;
  if (organizationType === "claude_team") {
    const seat = organization ? (stringValue(organization.seat_tier) ?? "") : "";
    return seat.toLowerCase().includes("premium") ? "Team Premium" : "Team";
  }
  if (organizationType === "claude_enterprise") return "Enterprise";
  const tier = organization ? stringValue(organization.rate_limit_tier) : undefined;
  const tierLabel = tier ? CLAUDE_RATE_LIMIT_TIERS[tier] : undefined;
  if (tierLabel) return tierLabel;
  if (organizationType?.startsWith("claude_")) {
    return CLAUDE_SUBSCRIPTION_LABELS[organizationType.slice("claude_".length)];
  }
  if (account?.has_claude_max === true) return "Max";
  if (account?.has_claude_pro === true) return "Pro";
  return fallbackSubscription
    ? CLAUDE_SUBSCRIPTION_LABELS[fallbackSubscription.toLowerCase()]
    : undefined;
}

export function normalizeClaudeUsage(payload: RuntimeValue, profile?: RuntimeValue): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const structuredWindows = Array.isArray(payload.limits)
    ? payload.limits.flatMap((value) => {
        const window = structuredClaudeWindow(value);
        return window ? [window] : [];
      })
    : [];
  const definitions: Array<[string, string, number]> = [
    ["five_hour", "5h", 5 * HOUR_SECONDS],
    ["seven_day", "7d", 7 * DAY_SECONDS],
    ["seven_day_sonnet", "Sonnet 7d", 7 * DAY_SECONDS],
    ["seven_day_opus", "Opus 7d", 7 * DAY_SECONDS],
    ["seven_day_fable", "Fable 7d", 7 * DAY_SECONDS],
  ];
  const legacyWindows = definitions.flatMap(([key, label, windowSeconds]) => {
    const value = quotaWindow(payload[key]);
    return value?.utilization === undefined
      ? []
      : [
          {
            label,
            percent: clampPercent(value.utilization),
            qualifier: "used" as const,
            eventAt: dateValue(value.resets_at),
            eventLabel: "resets",
            windowSeconds,
          },
        ];
  });
  const extraUsage = isRecord(payload.extra_usage) ? payload.extra_usage : undefined;
  const extraPercent = extraUsage ? numberValue(extraUsage.utilization) : undefined;
  const status =
    extraUsage?.is_enabled === true
      ? extraPercent === undefined
        ? "extra usage enabled"
        : `extra usage ${extraPercent.toFixed(0)}% used`
      : undefined;
  const plan = claudePlanLabel(profile, stringValue(payload.plan_type));
  return {
    name: "Claude Code",
    plan,
    status,
    windows: structuredWindows.length > 0 ? structuredWindows : legacyWindows,
  };
}

function codexWindow(value: RuntimeValue, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = numberValue(value.used_percent);
  if (percent === undefined) return undefined;
  const seconds = numberValue(value.limit_window_seconds);
  const resolvedLabel =
    seconds === undefined
      ? label
      : seconds % DAY_SECONDS === 0
        ? `${seconds / DAY_SECONDS}d`
        : seconds % HOUR_SECONDS === 0
          ? `${seconds / HOUR_SECONDS}h`
          : label;
  const window: UsageWindow = {
    label: resolvedLabel,
    percent: clampPercent(percent),
    qualifier: "used",
    eventAt: dateValue(value.reset_at, true),
    eventLabel: "resets",
  };
  if (seconds !== undefined && seconds > 0) window.windowSeconds = seconds;
  return window;
}

const CODEX_PLAN_LABELS = recordOf<string, string>()({
  guest: "Guest",
  free: "Free",
  free_workspace: "Free",
  go: "Go",
  plus: "Plus",
  prolite: "Pro (5x)",
  pro: "Pro (20x)",
  team: "Team",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  business: "Business",
  ent26: "Enterprise",
  enterprise: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  hc: "Enterprise",
  edu: "Edu",
  education: "Edu",
  k12: "K12",
  quorum: "Quorum",
});

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Maps the ChatGPT `plan_type` wire value to the label ChatGPT bills under. */
export function codexPlanLabel(planType: string | undefined): string | undefined {
  if (!planType) return undefined;
  const key = planType.toLowerCase();
  return CODEX_PLAN_LABELS[key] ?? titleCase(planType);
}

export function normalizeCodexUsage(payload: RuntimeValue): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const windows = [
    codexWindow(rateLimit.primary_window, "5h"),
    codexWindow(rateLimit.secondary_window, "7d"),
  ].filter((window): window is UsageWindow => window !== undefined);
  const plan = codexPlanLabel(stringValue(payload.plan_type));
  const credits = isRecord(payload.credits) ? payload.credits : undefined;
  const balance = credits
    ? (stringValue(credits.balance) ?? numberValue(credits.balance)?.toString())
    : undefined;
  return {
    name: "OpenAI Codex",
    plan,
    status: balance === undefined ? undefined : `${balance} credits`,
    windows,
  };
}

/** One reading of a bucket that refills instead of resetting. */
type RefillReading = { capacity: number; remaining: number };

type SyntheticReadings = { rolling?: RefillReading; weekly?: RefillReading };

/** The two refilling buckets a `/v2/quotas` response reports, when present. */
export function syntheticReadings(payload: RuntimeValue): SyntheticReadings {
  if (!isRecord(payload)) return {};
  const readings: SyntheticReadings = {};
  const rolling = isRecord(payload.rollingFiveHourLimit) ? payload.rollingFiveHourLimit : undefined;
  const capacity = rolling ? numberValue(rolling.max) : undefined;
  const remaining = rolling ? numberValue(rolling.remaining) : undefined;
  if (capacity !== undefined && capacity > 0 && remaining !== undefined) {
    readings.rolling = { capacity, remaining };
  }
  const weekly = isRecord(payload.weeklyTokenLimit) ? payload.weeklyTokenLimit : undefined;
  const maxCredits = weekly ? stringValue(weekly.maxCredits) : undefined;
  const remainingCredits = weekly ? stringValue(weekly.remainingCredits) : undefined;
  if (maxCredits && remainingCredits) {
    const weeklyCapacity = currencyValue(maxCredits);
    if (weeklyCapacity > 0) {
      readings.weekly = { capacity: weeklyCapacity, remaining: currencyValue(remainingCredits) };
    }
  }
  return readings;
}

/**
 * Pace of a refilling bucket, read from how its level moved between two
 * readings.
 *
 * A bucket that regenerates has no window to run out of, so the clock says
 * nothing about it and a single reading cannot be paced at all: the level alone
 * is both the quota spent and the time needed to earn it back. What can be read
 * is the net movement, which already nets consumption against regeneration — a
 * level that fell was drained faster than it refilled, and a level that held or
 * rose was not. Comparing observed levels also survives the regeneration being
 * granted in discrete ticks, which a continuous refill estimate would report as
 * overspending on every idle gap between ticks.
 *
 * A changed capacity means the subscription tier moved, which is not usage.
 */
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
  const subscription = isRecord(payload.subscription) ? payload.subscription : undefined;
  const rolling = isRecord(payload.rollingFiveHourLimit) ? payload.rollingFiveHourLimit : undefined;
  const rollingMaximum = rolling ? numberValue(rolling.max) : undefined;
  const rollingRemaining = rolling ? numberValue(rolling.remaining) : undefined;
  const subscriptionLimit = subscription ? numberValue(subscription.limit) : undefined;
  const subscriptionRequests = subscription ? numberValue(subscription.requests) : undefined;
  const maximum = rollingMaximum ?? subscriptionLimit;
  const remaining =
    rollingRemaining ??
    (maximum !== undefined && subscriptionRequests !== undefined
      ? maximum - subscriptionRequests
      : undefined);
  if (maximum !== undefined && maximum > 0 && remaining !== undefined) {
    const boundedRemaining = Math.max(0, Math.min(maximum, remaining));
    const requestsUsed =
      rollingMaximum !== undefined && rollingRemaining !== undefined
        ? maximum - boundedRemaining
        : (subscriptionRequests ?? maximum - boundedRemaining);
    const requestDetail =
      requestsUsed === 0 ? "No requests used" : `${boundedRemaining}/${maximum} requests remaining`;
    const detail = `${requestDetail}${rolling?.limited === true ? " · limited" : ""}`;
    const window: UsageWindow = {
      label: "Five-hour requests",
      percent: clampPercent(((maximum - boundedRemaining) / maximum) * 100),
      qualifier: "used",
      eventAt: dateValue(rolling?.nextTickAt ?? subscription?.renewsAt),
      eventLabel: rolling ? "regenerates" : "resets",
      detail,
      precision: 0,
    };
    const pace = refillPace(readings.rolling, priorReadings.rolling, elapsedMs);
    if (pace) window.pace = pace;
    windows.push(window);
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
      ? `regenerates${regenPercent !== undefined && Number.isFinite(regenPercent) ? ` ${formatNumber(regenPercent, 2)}%` : ""} (${nextRegenCredits})`
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
      precision: 2,
    };
    const pace = refillPace(readings.weekly, priorReadings.weekly, elapsedMs);
    if (pace) window.pace = pace;
    windows.push(window);
  }

  return { name: "Synthetic", windows };
}

async function providerToken(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
  if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  return ctx.modelRegistry.getApiKeyForProvider(provider);
}

/**
 * Marks a report that was rebuilt from the store, so the tab never presents an
 * old snapshot as a live reading.
 */
function withCacheNote(usage: ProviderUsage, result: UsageRequestResult): ProviderUsage {
  if (result.cachedAt === undefined) return usage;
  return { ...usage, cached: { at: new Date(result.cachedAt), reason: result.reason } };
}

/**
 * Reads the live plan from Anthropic's profile endpoint. The value only changes
 * when the subscription changes, so it is read far less often than the usage
 * windows and never blocks the usage report when it fails.
 */
async function claudeProfile(token: string): Promise<RuntimeValue> {
  try {
    const result = await usageCache.request(
      "anthropic:profile",
      () => fetchUsageJson("https://api.anthropic.com/api/oauth/profile", token, ANTHROPIC_HEADERS),
      PROFILE_POLICY,
    );
    return result.payload;
  } catch {
    return undefined;
  }
}

/**
 * Anthropic's OAuth token is opaque and rotates, and the account only appears in
 * the profile response this key already guards. The provider therefore owns one
 * cache slot: a snapshot from a previous account is replaced by the next live
 * read and is labelled with its age until then.
 */
async function claudeUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "anthropic");
  if (!token) return { name: "Claude Code", status: "not connected", windows: [] };
  const [usage, profile] = await Promise.all([
    usageCache.request(
      "anthropic:usage",
      () => fetchUsageJson("https://api.anthropic.com/api/oauth/usage", token, ANTHROPIC_HEADERS),
      USAGE_POLICY,
    ),
    claudeProfile(token),
  ]);
  return withCacheNote(normalizeClaudeUsage(usage.payload, profile), usage);
}

async function codexUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "openai-codex");
  if (!token) return { name: "OpenAI Codex", status: "not connected", windows: [] };
  const accountId = codexAccountId(token);
  if (!accountId) throw new Error("OAuth account ID is unavailable");
  const usage = await usageCache.request(
    `openai-codex:usage:${identityKey(accountId)}`,
    () =>
      fetchUsageJson("https://chatgpt.com/backend-api/wham/usage", token, {
        "chatgpt-account-id": accountId,
        originator: "pi",
      }),
    USAGE_POLICY,
  );
  return withCacheNote(normalizeCodexUsage(usage.payload), usage);
}

async function syntheticUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "synthetic");
  if (!token) return { name: "Synthetic", status: "not connected", windows: [] };
  const usage = await usageCache.request(
    `synthetic:usage:${identityKey(token)}`,
    () => fetchUsageJson("https://api.synthetic.new/v2/quotas", token, {}),
    USAGE_POLICY,
  );
  return withCacheNote(
    normalizeSyntheticUsage(usage.payload, usage.previous, usage.payloadAt),
    usage,
  );
}

function currencyValue(value: string): number {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function relativeTime(date: Date | undefined, at = Date.now()): string | undefined {
  if (!date) return undefined;
  const milliseconds = date.getTime() - at;
  if (milliseconds <= 0) return "soon";
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const value = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    !days && minutes ? `${minutes}m` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `in ${value || "<1m"}`;
}

/** Age of a stored snapshot, rounded down so it never overstates freshness. */
function elapsedTime(date: Date, at = Date.now()): string {
  const totalMinutes = Math.floor(Math.max(0, at - date.getTime()) / 60_000);
  if (totalMinutes < 1) return "just now";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const value = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    !days && minutes ? `${minutes}m` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${value} ago`;
}

/**
 * The usage bar. The filled part carries the window's verdict colour and the
 * empty part stays dim, so a glance at the bar answers the pace question the
 * percentage below it states in words.
 */
function progressBar(
  percent: number,
  paint: UsagePainter,
  health: QuotaHealth,
  width = USAGE_BAR_WIDTH,
): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return `${paint.health(health, "█".repeat(filled))}${paint.dim("░".repeat(width - filled))}`;
}

/** Theme hooks used by a coloured report; omitted when the surface is plain text. */
export type UsageStyle = { fg(color: string, text: string): string };

type UsagePainter = {
  value: (text: string) => string;
  dim: (text: string) => string;
  label: (text: string) => string;
  head: (text: string) => string;
  health: (health: QuotaHealth, text: string) => string;
};

function usagePainter(style: UsageStyle | undefined): UsagePainter {
  const plain = (text: string): string => text;
  if (!style) {
    return { value: plain, dim: plain, label: plain, head: plain, health: (_health, t) => t };
  }
  const color = (name: string, text: string): string => {
    try {
      return style.fg(name, text);
    } catch {
      return text;
    }
  };
  const HEALTH_COLORS = recordOf<QuotaHealth, string>()({
    exhausted: "error",
    over: "warning",
    under: "success",
    unknown: "text",
  });
  return {
    value: (text) => color("text", text),
    dim: (text) => color("dim", text),
    label: (text) => color("muted", text),
    head: (text) => color("accent", text),
    health: (health, text) => color(HEALTH_COLORS[health], text),
  };
}

function cachedLabel(cached: { at: Date; reason?: string } | undefined): string | undefined {
  if (!cached) return undefined;
  const age = elapsedTime(cached.at);
  return cached.reason ? `cached ${age} · ${cached.reason}` : `cached ${age}`;
}

export function formatProviderUsage(
  result: ProviderUsage,
  style?: UsageStyle,
  now = Date.now(),
): string {
  const paint = usagePainter(style);
  const summary = [result.plan, result.status, cachedLabel(result.cached)]
    .filter(Boolean)
    .join(" · ");
  const heading = summary
    ? `${paint.head(result.name)}${paint.dim(" — ")}${paint.value(summary)}`
    : paint.head(result.name);
  if (result.windows.length === 0) {
    return summary ? heading : `${heading}${paint.dim(" — no quota windows")}`;
  }
  const windows = result.windows.flatMap((window) => {
    const health = quotaHealth(window, now);
    const percent = formatNumber(window.percent, window.precision ?? 0);
    const eventTime = relativeTime(window.eventAt, now);
    const event = window.eventLabel && eventTime ? `${window.eventLabel} ${eventTime}` : undefined;
    const elapsed = windowElapsedPercent(window, now);
    const pace =
      window.pace?.label ??
      (elapsed === undefined ? undefined : `${formatNumber(elapsed, 0)}% of window elapsed`);
    const detail = [event, pace, window.detail].filter(Boolean).join(" · ");
    return [
      `  ${paint.label(window.label)}`,
      `  ${progressBar(window.percent, paint, health)} ${paint.health(health, `${percent}% ${window.qualifier}`)}`,
      ...(detail ? [`  ${paint.dim(detail)}`] : []),
    ];
  });
  return [heading, ...windows].join("\n");
}

const PROVIDER_NAMES = ["Claude Code", "OpenAI Codex", "Synthetic"] as const;

/**
 * Describes why a provider produced nothing: a throttled request also reports
 * when the next live request is allowed, so the tab does not look stuck.
 */
export function usageFailureMessage(reason: RuntimeValue): string {
  if (reason instanceof UsageThrottledError) {
    const retry = relativeTime(new Date(reason.retryAt));
    return retry ? `${reason.message} · retrying ${retry}` : reason.message;
  }
  return reason instanceof Error ? reason.message : "unknown error";
}

export async function usageReport(ctx: ExtensionContext, style?: UsageStyle): Promise<string> {
  const paint = usagePainter(style);
  const requests = [claudeUsage(ctx), codexUsage(ctx), syntheticUsage(ctx)];
  const settled = await Promise.allSettled(requests);
  return settled
    .map((result, index) =>
      result.status === "fulfilled"
        ? formatProviderUsage(result.value, style)
        : `${paint.head(PROVIDER_NAMES[index])}${paint.dim(" — ")}${paint.health(
            "exhausted",
            `unavailable (${usageFailureMessage(result.reason)})`,
          )}`,
    )
    .join("\n\n");
}

// Command registration lives in status-commands.ts; this module only fetches
// and formats the Usage tab body.
export default function providerUsage(): void {}
