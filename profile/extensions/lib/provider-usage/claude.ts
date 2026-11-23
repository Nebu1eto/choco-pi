import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordOf, type RuntimeValue } from "../runtime-values.ts";
import { fetchUsageJson, type UsageCache } from "../usage-cache.ts";
import {
  dateValue,
  isRecord,
  numberValue,
  providerToken,
  stringValue,
  usageCache,
  withCacheNote,
} from "./helpers.ts";
import {
  clampPercent,
  DAY_SECONDS,
  HOUR_SECONDS,
  PROFILE_POLICY,
  USAGE_POLICY,
  type ProviderUsage,
  type UsageProviderAdapter,
  type UsageWindow,
} from "./types.ts";

const ANTHROPIC_HEADERS = { "anthropic-beta": "oauth-2025-04-20" };

type QuotaWindow = {
  utilization?: number;
  resets_at?: string;
};

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
  let scope: string | undefined;
  if (kind === "session") {
    label = "5-hours";
    windowSeconds = 5 * HOUR_SECONDS;
  } else if (kind === "weekly_all") {
    label = "Weekly";
    windowSeconds = 7 * DAY_SECONDS;
  } else if (kind === "weekly_scoped") {
    const scopeRecord = isRecord(value.scope) ? value.scope : undefined;
    const model = scopeRecord && isRecord(scopeRecord.model) ? scopeRecord.model : undefined;
    const name = stringValue(model?.display_name);
    label = `${name ?? "Scoped"} Weekly`;
    // An unnamed scope still limits only some models; keep it scoped.
    scope = name ?? stringValue(model?.id) ?? "Scoped";
    windowSeconds = 7 * DAY_SECONDS;
  } else {
    return undefined;
  }

  const window: UsageWindow = {
    label,
    percent: clampPercent(percent),
    qualifier: "used",
    eventAt: dateValue(value.resets_at),
    eventLabel: "resets",
    windowSeconds,
  };
  if (scope !== undefined) window.scope = scope;
  return window;
}

const CLAUDE_RATE_LIMIT_TIERS = recordOf<string, string>()({
  default_claude_pro: "Pro",
  default_claude_max_5x: "Max (5x)",
  default_claude_max_20x: "Ultra",
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
  const definitions: Array<[string, string, number, string | undefined]> = [
    ["five_hour", "5-hours", 5 * HOUR_SECONDS, undefined],
    ["seven_day", "Weekly", 7 * DAY_SECONDS, undefined],
    ["seven_day_sonnet", "Sonnet Weekly", 7 * DAY_SECONDS, "Sonnet"],
    ["seven_day_opus", "Opus Weekly", 7 * DAY_SECONDS, "Opus"],
    ["seven_day_fable", "Fable Weekly", 7 * DAY_SECONDS, "Fable"],
  ];
  const legacyWindows = definitions.flatMap(([key, label, windowSeconds, scope]) => {
    const value = quotaWindow(payload[key]);
    if (value?.utilization === undefined) return [];
    const window: UsageWindow = {
      label,
      percent: clampPercent(value.utilization),
      qualifier: "used",
      eventAt: dateValue(value.resets_at),
      eventLabel: "resets",
      windowSeconds,
    };
    if (scope !== undefined) window.scope = scope;
    return [window];
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
    name: "Claude",
    plan,
    status,
    windows: structuredWindows.length > 0 ? structuredWindows : legacyWindows,
  };
}

/**
 * Reads the live plan from Anthropic's profile endpoint. The value only changes
 * when the subscription changes, so it is read far less often than the usage
 * windows and never blocks the usage report when it fails.
 */
export async function claudeProfile(
  token: string,
  cache: UsageCache = usageCache,
): Promise<RuntimeValue> {
  try {
    const result = await cache.request(
      "anthropic:profile",
      () => fetchUsageJson("https://api.anthropic.com/api/oauth/profile", token, ANTHROPIC_HEADERS),
      PROFILE_POLICY,
    );
    return result.payload;
  } catch {
    return undefined;
  }
}

export async function readClaudeUsage(
  token: string,
  cache: UsageCache = usageCache,
): Promise<ProviderUsage> {
  const [usage, profile] = await Promise.all([
    cache.request(
      "anthropic:usage",
      () => fetchUsageJson("https://api.anthropic.com/api/oauth/usage", token, ANTHROPIC_HEADERS),
      USAGE_POLICY,
    ),
    claudeProfile(token, cache),
  ]);
  return withCacheNote(normalizeClaudeUsage(usage.payload, profile), usage);
}

/**
 * Anthropic's OAuth token is opaque and rotates, and the account only appears in
 * the profile response this key already guards. The provider therefore owns one
 * cache slot: a snapshot from a previous account is replaced by the next live
 * read and is labelled with its age until then.
 */
export async function claudeUsage(
  ctx: ExtensionContext,
  cache: UsageCache,
): Promise<ProviderUsage | undefined> {
  const token = await providerToken(ctx, "anthropic");
  if (!token) return undefined;
  return readClaudeUsage(token, cache);
}

export const claudeUsageProviderAdapter: UsageProviderAdapter = {
  id: "anthropic",
  displayName: "Claude",
  order: 10,
  providerIds: ["anthropic"],
  readUsage: claudeUsage,
  readSnapshot: async (ctx, _provider, cache) => {
    const token = await providerToken(ctx, "anthropic");
    if (!token) return undefined;
    return readClaudeUsage(token, cache);
  },
  resolveAccountId: async (ctx, _provider, cache) => {
    const token = await providerToken(ctx, "anthropic");
    if (!token) return undefined;
    const profile = await claudeProfile(token, cache);
    const account = isRecord(profile) && isRecord(profile.account) ? profile.account : undefined;
    return account ? stringValue(account.uuid) : undefined;
  },
};
