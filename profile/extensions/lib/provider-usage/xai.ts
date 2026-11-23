import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { isString, type RuntimeValue } from "../runtime-values.ts";
import { fetchUsageJson, type UsageCache } from "../usage-cache.ts";
import { OPENAI_API_KEY_STATUS } from "./codex.ts";
import {
  dateValue,
  formatNumber,
  isRecord,
  numberValue,
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
  PROFILE_POLICY,
  USAGE_POLICY,
  type ProviderUsage,
  type UsageProviderAdapter,
  type UsageWindow,
} from "./types.ts";

export const GROK_USAGE_NAME = "Grok";
export const GROK_API_KEY_STATUS = OPENAI_API_KEY_STATUS;

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const GROK_PERIOD_PREFIX = "USAGE_PERIOD_TYPE_";

const GrokUserSchema = obj({ subscriptionTier: opt(str()) }, { open: true });
const isGrokUser = compile(GrokUserSchema).check;
export type GrokSubscription = Static<typeof GrokUserSchema>;

const GROK_PLAN_LABELS = new Map([
  ["GrokPro", "SuperGrok"],
  ["SuperGrokLite", "SuperGrok Lite"],
  ["SuperGrokPlus", "SuperGrok Plus"],
  ["SuperGrokPro", "SuperGrok Pro"],
  ["XBasic", "X Basic"],
  ["XPremium", "X Premium"],
  ["XPremiumPlus", "X Premium+"],
]);

export function grokPlanLabel(tier: string | undefined): string | undefined {
  const trimmed = tier?.trim();
  if (!trimmed) return undefined;
  return GROK_PLAN_LABELS.get(trimmed) ?? trimmed;
}

const GROK_PRODUCT_LABELS = new Map([
  ["GrokBot", "Bot"],
  ["Api", "API"],
  ["GrokBuild", "Build"],
]);

export function grokProductLabel(product: string | undefined): string | undefined {
  const trimmed = product?.trim();
  if (!trimmed) return undefined;
  return GROK_PRODUCT_LABELS.get(trimmed) ?? trimmed;
}

export function grokSubscription(payload: RuntimeValue): GrokSubscription {
  const subscription: GrokSubscription = {};
  if (isGrokUser(payload) && payload.subscriptionTier !== undefined) {
    subscription.subscriptionTier = payload.subscriptionTier;
  }
  return subscription;
}

export function grokPeriodLabel(type: string | undefined): string {
  if (!type) return "Credits";
  const name = type.startsWith(GROK_PERIOD_PREFIX) ? type.slice(GROK_PERIOD_PREFIX.length) : type;
  const key = name.toLowerCase();
  if (key.length === 0 || key === "unspecified") return "Credits";
  return usageWindowPeriodLabel(titleCase(key));
}

function grokCents(value: RuntimeValue): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value.val;
  const cents = isString(raw) && raw.trim().length > 0 ? Number(raw) : numberValue(raw);
  return cents !== undefined && Number.isFinite(cents) ? cents : undefined;
}

export function normalizeGrokUsage(payload: RuntimeValue): ProviderUsage {
  if (!isRecord(payload) || !isRecord(payload.config)) throw new Error("Unexpected response");
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const start = dateValue(period?.start);
  const end = dateValue(period?.end);
  const validPeriod = start !== undefined && end !== undefined && end.getTime() > start.getTime();
  const percent = numberValue(config.creditUsagePercent) ?? (validPeriod ? 0 : undefined);
  const products = Array.isArray(config.productUsage)
    ? config.productUsage.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const product = grokProductLabel(stringValue(entry.product));
        const used = numberValue(entry.usagePercent);
        return product && used !== undefined ? [`${product} ${formatNumber(used, 1)}%`] : [];
      })
    : [];
  const windows: UsageWindow[] = [];
  if (percent !== undefined) {
    const window: UsageWindow = {
      label: grokPeriodLabel(stringValue(period?.type)),
      percent: clampPercent(percent),
      qualifier: "used",
      eventAt: end,
      eventLabel: "resets",
    };
    if (products.length > 0) window.detail = products.join(" · ");
    const seconds = start && end ? (end.getTime() - start.getTime()) / 1000 : undefined;
    if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
      window.windowSeconds = seconds;
    }
    windows.push(window);
  }
  const cents = grokCents(config.prepaidBalance);
  const usage: ProviderUsage = { name: GROK_USAGE_NAME, windows };
  if (cents !== undefined && cents > 0)
    usage.status = `$${(cents / 100).toFixed(2)} prepaid balance`;
  return usage;
}

export async function grokUsage(
  ctx: ExtensionContext,
  cache: UsageCache = usageCache,
): Promise<ProviderUsage | undefined> {
  if (!providerConfigured(ctx, "xai")) return undefined;
  if (providerUsesOAuth(ctx, "xai") !== true) {
    return { name: GROK_USAGE_NAME, status: GROK_API_KEY_STATUS, windows: [] };
  }
  const token = await providerToken(ctx, "xai");
  if (!token) return undefined;
  const [usage, user] = await Promise.allSettled([
    cache.request("xai:usage", () => fetchUsageJson(GROK_BILLING_URL, token, {}), USAGE_POLICY),
    cache.request(
      "xai:profile",
      async () => grokSubscription(await fetchUsageJson(GROK_USER_URL, token, {})),
      PROFILE_POLICY,
    ),
  ]);
  if (usage.status === "rejected") throw usage.reason;
  const reading = normalizeGrokUsage(usage.value.payload);
  const plan =
    user.status === "fulfilled"
      ? grokPlanLabel(grokSubscription(user.value.payload).subscriptionTier)
      : undefined;
  return withCacheNote(plan === undefined ? reading : { ...reading, plan }, usage.value);
}

export const xaiUsageProviderAdapter: UsageProviderAdapter = {
  id: "xai",
  displayName: GROK_USAGE_NAME,
  order: 40,
  providerIds: ["xai"],
  readUsage: grokUsage,
};
