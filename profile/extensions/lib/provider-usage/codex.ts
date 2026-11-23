import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCodexResetClient, runCodexResetFlow } from "../codex-resets.ts";
import { recordOf, type RuntimeValue } from "../runtime-values.ts";
import { fetchUsageJson, identityKey, type UsageCache } from "../usage-cache.ts";
import {
  dateValue,
  formatCredits,
  isRecord,
  numberValue,
  parseJwtPayload,
  providerConfigured,
  providerToken,
  providerUsesOAuth,
  stringValue,
  titleCase,
  usageCache,
  usageWindowPeriodLabel,
  withCacheNote,
} from "./helpers.ts";
import {
  clampPercent,
  DAY_SECONDS,
  HOUR_SECONDS,
  USAGE_POLICY,
  type ProviderUsage,
  type UsageProviderAdapter,
  type UsageWindow,
} from "./types.ts";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export const CHATGPT_USAGE_NAME = "ChatGPT";
export const OPENAI_SIGNED_IN_STATUS = "signed in; quota window not available on api.openai.com";
export const OPENAI_API_KEY_STATUS = "API key; no subscription quota window";
const CODEX_RESET_SIGNED_OUT = "ChatGPT Codex login (openai-codex) is not signed in.";

export function codexAccountId(token: string): string | undefined {
  const payload = parseJwtPayload(token);
  const auth = payload?.[OPENAI_AUTH_CLAIM];
  return isRecord(auth) ? stringValue(auth.chatgpt_account_id) : undefined;
}

function codexWindow(value: RuntimeValue, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = numberValue(value.used_percent);
  if (percent === undefined) return undefined;
  const seconds = numberValue(value.limit_window_seconds);
  const rawLabel =
    seconds === undefined
      ? label
      : seconds % DAY_SECONDS === 0
        ? `${seconds / DAY_SECONDS}d`
        : seconds % HOUR_SECONDS === 0
          ? `${seconds / HOUR_SECONDS}h`
          : label;
  const resolvedLabel = usageWindowPeriodLabel(rawLabel);
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
  prolite: "Pro 100",
  pro: "Pro 200",
  promax: "Pro 500",
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

export function codexPlanLabel(planType: string | undefined): string | undefined {
  if (!planType) return undefined;
  const key = planType.toLowerCase();
  return CODEX_PLAN_LABELS[key] ?? titleCase(planType);
}

export function normalizeCodexUsage(payload: RuntimeValue): ProviderUsage {
  if (!isRecord(payload)) throw new Error("Unexpected response");
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const windows = [
    codexWindow(rateLimit.primary_window, "5-hours"),
    codexWindow(rateLimit.secondary_window, "Weekly"),
  ].filter((window): window is UsageWindow => window !== undefined);
  const plan = codexPlanLabel(stringValue(payload.plan_type));
  const credits = isRecord(payload.credits) ? payload.credits : undefined;
  const balance = credits ? formatCredits(credits.balance) : undefined;
  const resetCredits = isRecord(payload.rate_limit_reset_credits)
    ? payload.rate_limit_reset_credits
    : undefined;
  const resetCount = numberValue(resetCredits?.available_count);
  const resets =
    resetCount !== undefined && Number.isSafeInteger(resetCount) && resetCount >= 0
      ? `${resetCount} saved reset${resetCount === 1 ? "" : "s"} available`
      : undefined;
  return {
    name: CHATGPT_USAGE_NAME,
    plan,
    status:
      [balance === undefined ? undefined : `${balance} credits`, resets]
        .filter(Boolean)
        .join(" · ") || undefined,
    windows,
  };
}

type ChatGPTProvider = "openai" | "openai-codex";

export function chatgptUsageProvider(ctx: ExtensionContext): ChatGPTProvider | undefined {
  const active = ctx.model?.provider;
  if ((active === "openai" || active === "openai-codex") && providerConfigured(ctx, active)) {
    return active;
  }
  if (providerConfigured(ctx, "openai-codex")) return "openai-codex";
  if (providerConfigured(ctx, "openai")) return "openai";
  return undefined;
}

export function openaiUsage(ctx: ExtensionContext): ProviderUsage {
  const notConnected: ProviderUsage = {
    name: CHATGPT_USAGE_NAME,
    status: "not connected",
    windows: [],
  };
  if (!providerConfigured(ctx, "openai")) return notConnected;
  const oauth = providerUsesOAuth(ctx, "openai");
  return {
    name: CHATGPT_USAGE_NAME,
    status: oauth === false ? OPENAI_API_KEY_STATUS : OPENAI_SIGNED_IN_STATUS,
    windows: [],
  };
}

export async function readCodexUsage(
  token: string,
  accountId: string,
  refresh = false,
  cache: UsageCache = usageCache,
): Promise<ProviderUsage> {
  const usage = await cache.request(
    `openai-codex:usage:${identityKey(accountId)}`,
    () =>
      fetchUsageJson("https://chatgpt.com/backend-api/wham/usage", token, {
        "chatgpt-account-id": accountId,
        originator: "pi",
      }),
    USAGE_POLICY,
    refresh,
  );
  return withCacheNote(normalizeCodexUsage(usage.payload), usage);
}

export async function chatgptUsage(
  ctx: ExtensionContext,
  cache: UsageCache,
): Promise<ProviderUsage | undefined> {
  const selected = chatgptUsageProvider(ctx);
  if (selected === undefined) return undefined;
  if (selected !== "openai-codex") return openaiUsage(ctx);
  const token = await providerToken(ctx, "openai-codex");
  const accountId = token ? codexAccountId(token) : undefined;
  if (!token || !accountId) {
    return providerConfigured(ctx, "openai") ? openaiUsage(ctx) : undefined;
  }
  return readCodexUsage(token, accountId, false, cache);
}

export async function resetCodexUsage(
  ctx: ExtensionContext,
  isCurrent: () => boolean,
): Promise<string | undefined> {
  const registry = ctx.modelRegistry;
  if (!registry.getProviderAuthStatus("openai-codex").configured) return CODEX_RESET_SIGNED_OUT;
  const token = await registry.getApiKeyForProvider("openai-codex");
  if (!isCurrent()) return;
  if (!token) return CODEX_RESET_SIGNED_OUT;
  const accountId = codexAccountId(token);
  if (!accountId) return "OAuth account ID is unavailable.";
  return runCodexResetFlow({
    client: createCodexResetClient(token, accountId),
    select: (title, choices) => ctx.ui.select(title, choices),
    isCurrent,
    refresh: async () => {
      const usage = await readCodexUsage(token, accountId, true);
      if (usage.cached) throw new Error("Usage refresh returned a cached snapshot.");
    },
  });
}

export const chatgptUsageProviderAdapter: UsageProviderAdapter = {
  id: "chatgpt",
  displayName: CHATGPT_USAGE_NAME,
  order: 20,
  providerIds: ["openai-codex"],
  readUsage: chatgptUsage,
  readSnapshot: async (ctx, _provider, cache) => {
    const token = await providerToken(ctx, "openai-codex");
    if (!token) return undefined;
    const accountId = codexAccountId(token);
    if (!accountId) return undefined;
    return readCodexUsage(token, accountId, false, cache);
  },
  resolveAccountId: async (ctx) => {
    const token = await providerToken(ctx, "openai-codex");
    return token ? codexAccountId(token) : undefined;
  },
};
