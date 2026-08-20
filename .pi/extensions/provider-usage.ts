import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 10_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const USAGE_BAR_WIDTH = 50;
const PROFILE_CACHE_MS = 30 * 60_000;

type UsageWindow = {
  label: string;
  percent: number;
  qualifier: "used" | "remaining";
  eventAt?: Date;
  eventLabel?: string;
  detail?: string;
  precision?: number;
};

type ProviderUsage = {
  name: string;
  plan?: string;
  status?: string;
  windows: UsageWindow[];
};

type QuotaWindow = {
  utilization?: number;
  resets_at?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function dateValue(value: unknown, unixSeconds = false): Date | undefined {
  if (unixSeconds && typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function fetchJson(
  url: string,
  token: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
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

function quotaWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  return {
    utilization: numberValue(value.utilization),
    resets_at: stringValue(value.resets_at),
  };
}

function structuredClaudeWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = numberValue(value.percent);
  const kind = stringValue(value.kind);
  if (percent === undefined || !kind) return undefined;

  let label: string;
  if (kind === "session") {
    label = "5h";
  } else if (kind === "weekly_all") {
    label = "7d";
  } else if (kind === "weekly_scoped") {
    const scope = isRecord(value.scope) ? value.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    label = `${stringValue(model?.display_name) ?? "Scoped"} 7d`;
  } else {
    return undefined;
  }

  return {
    label,
    percent: clampPercent(percent),
    qualifier: "used",
    eventAt: dateValue(value.resets_at),
    eventLabel: "resets",
  };
}

const CLAUDE_RATE_LIMIT_TIERS: Record<string, string> = {
  default_claude_pro: "Pro",
  default_claude_max_5x: "Max (5x)",
  default_claude_max_20x: "Max (20x)",
};

const CLAUDE_SUBSCRIPTION_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

/**
 * Derives the plan label from the `/api/oauth/profile` response. Team and
 * Enterprise organizations keep a Max rate-limit tier, so the organization
 * type decides those labels before the tier is consulted.
 */
export function claudePlanLabel(
  profile: unknown,
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

export function normalizeClaudeUsage(payload: unknown, profile?: unknown): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const structuredWindows = Array.isArray(payload.limits)
    ? payload.limits.flatMap((value) => {
        const window = structuredClaudeWindow(value);
        return window ? [window] : [];
      })
    : [];
  const definitions: Array<[string, string]> = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
    ["seven_day_sonnet", "Sonnet 7d"],
    ["seven_day_opus", "Opus 7d"],
    ["seven_day_fable", "Fable 7d"],
  ];
  const legacyWindows = definitions.flatMap(([key, label]) => {
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

function codexWindow(value: unknown, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = numberValue(value.used_percent);
  if (percent === undefined) return undefined;
  const seconds = numberValue(value.limit_window_seconds);
  const resolvedLabel =
    seconds === undefined
      ? label
      : seconds % 86_400 === 0
        ? `${seconds / 86_400}d`
        : seconds % 3_600 === 0
          ? `${seconds / 3_600}h`
          : label;
  return {
    label: resolvedLabel,
    percent: clampPercent(percent),
    qualifier: "used",
    eventAt: dateValue(value.reset_at, true),
    eventLabel: "resets",
  };
}

const CODEX_PLAN_LABELS: Record<string, string> = {
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
};

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

export function normalizeCodexUsage(payload: unknown): ProviderUsage {
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

export function normalizeSyntheticUsage(payload: unknown): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const windows: UsageWindow[] = [];
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
    windows.push({
      label: "Five-hour requests",
      percent: clampPercent(((maximum - boundedRemaining) / maximum) * 100),
      qualifier: "used",
      eventAt: dateValue(rolling?.nextTickAt ?? subscription?.renewsAt),
      eventLabel: rolling ? "regenerates" : "resets",
      detail,
      precision: 0,
    });
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
    windows.push({
      label: "Weekly credits",
      percent: clampPercent(100 - remainingPercent),
      qualifier: "used",
      eventAt: dateValue(weekly?.nextRegenAt),
      eventLabel: regenDescription,
      detail: stringValue(weekly?.remainingCredits)
        ? `${weekly?.remainingCredits} remaining`
        : undefined,
      precision: 2,
    });
  }

  return { name: "Synthetic", windows };
}

async function providerToken(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
  if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  return ctx.modelRegistry.getApiKeyForProvider(provider);
}

let claudeProfileCache: { at: number; profile: unknown } | undefined;

/**
 * Reads the live plan from Anthropic's profile endpoint. The value only changes
 * when the subscription changes, so it is cached well beyond the usage refresh
 * interval and never blocks the usage report when it fails.
 */
async function claudeProfile(token: string): Promise<unknown> {
  if (claudeProfileCache && Date.now() - claudeProfileCache.at < PROFILE_CACHE_MS) {
    return claudeProfileCache.profile;
  }
  try {
    const profile = await fetchJson("https://api.anthropic.com/api/oauth/profile", token, {
      "anthropic-beta": "oauth-2025-04-20",
    });
    claudeProfileCache = { at: Date.now(), profile };
    return profile;
  } catch {
    return undefined;
  }
}

async function claudeUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "anthropic");
  if (!token) return { name: "Claude Code", status: "not connected", windows: [] };
  const [payload, profile] = await Promise.all([
    fetchJson("https://api.anthropic.com/api/oauth/usage", token, {
      "anthropic-beta": "oauth-2025-04-20",
    }),
    claudeProfile(token),
  ]);
  return normalizeClaudeUsage(payload, profile);
}

async function codexUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "openai-codex");
  if (!token) return { name: "OpenAI Codex", status: "not connected", windows: [] };
  const accountId = codexAccountId(token);
  if (!accountId) throw new Error("OAuth account ID is unavailable");
  const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", token, {
    "chatgpt-account-id": accountId,
    originator: "pi",
  });
  return normalizeCodexUsage(payload);
}

async function syntheticUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  const token = await providerToken(ctx, "synthetic");
  if (!token) return { name: "Synthetic", status: "not connected", windows: [] };
  const payload = await fetchJson("https://api.synthetic.new/v2/quotas", token, {});
  return normalizeSyntheticUsage(payload);
}

function currencyValue(value: string): number {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function relativeTime(date: Date | undefined): string | undefined {
  if (!date) return undefined;
  const milliseconds = date.getTime() - Date.now();
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

function progressBar(percent: number, width = USAGE_BAR_WIDTH): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatProviderUsage(result: ProviderUsage): string {
  const summary = [result.plan, result.status].filter(Boolean).join(" · ");
  const heading = summary ? `${result.name} — ${summary}` : result.name;
  if (result.windows.length === 0) return summary ? heading : `${heading} — no quota windows`;
  const windows = result.windows.flatMap((window) => {
    const percent = formatNumber(window.percent, window.precision ?? 0);
    const eventTime = relativeTime(window.eventAt);
    const event = window.eventLabel && eventTime ? `${window.eventLabel} ${eventTime}` : undefined;
    const detail = [event, window.detail].filter(Boolean).join(" · ");
    return [
      `  ${window.label}`,
      `  ${progressBar(window.percent)} ${percent}% ${window.qualifier}`,
      ...(detail ? [`  ${detail}`] : []),
    ];
  });
  return [heading, ...windows].join("\n");
}

const PROVIDER_NAMES = ["Claude Code", "OpenAI Codex", "Synthetic"] as const;

export async function usageReport(ctx: ExtensionContext): Promise<string> {
  const requests = [claudeUsage(ctx), codexUsage(ctx), syntheticUsage(ctx)];
  const settled = await Promise.allSettled(requests);
  return settled
    .map((result, index) =>
      result.status === "fulfilled"
        ? formatProviderUsage(result.value)
        : `${PROVIDER_NAMES[index]} — unavailable (${result.reason instanceof Error ? result.reason.message : "unknown error"})`,
    )
    .join("\n\n");
}

// Command registration lives in status-commands.ts; this module only fetches
// and formats the Usage tab body.
export default function providerUsage(): void {}
