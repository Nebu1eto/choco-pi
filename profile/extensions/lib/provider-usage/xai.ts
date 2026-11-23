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

/** Display name of the xAI Grok subscription entry (provider `xai`). */
export const GROK_USAGE_NAME = "Grok";
/** Status of `xai` configured with an API key, which has no subscription window. */
export const GROK_API_KEY_STATUS = OPENAI_API_KEY_STATUS;

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const GROK_PERIOD_PREFIX = "USAGE_PERIOD_TYPE_";

/**
 * The one field read from the Grok `/v1/user` response. The response also
 * carries personal data (email, names, ids), which is never read or kept.
 */
const GrokUserSchema = obj({ subscriptionTier: opt(str()) }, { open: true });
const isGrokUser = compile(GrokUserSchema).check;
/** The subscription part of a Grok `/v1/user` response, the only part kept. */
export type GrokSubscription = Static<typeof GrokUserSchema>;

/** Display labels of the `/v1/user` subscription tiers Grok Build recognises. */
const GROK_PLAN_LABELS = new Map([
  ["GrokPro", "SuperGrok"],
  ["SuperGrokLite", "SuperGrok Lite"],
  ["SuperGrokPlus", "SuperGrok Plus"],
  ["SuperGrokPro", "SuperGrok Pro"],
  ["XBasic", "X Basic"],
  ["XPremium", "X Premium"],
  ["XPremiumPlus", "X Premium+"],
]);

/** Plan label of a `/v1/user` subscription tier; an unknown tier is shown verbatim. */
export function grokPlanLabel(tier: string | undefined): string | undefined {
  const trimmed = tier?.trim();
  if (!trimmed) return undefined;
  return GROK_PLAN_LABELS.get(trimmed) ?? trimmed;
}

/** Display labels of the billing `productUsage` keys Grok Build reports. */
const GROK_PRODUCT_LABELS = new Map([
  ["GrokBot", "Bot"],
  ["Api", "API"],
  ["GrokBuild", "Build"],
]);

/** Label of a billing `productUsage` key; an unknown key is shown verbatim. */
export function grokProductLabel(product: string | undefined): string | undefined {
  const trimmed = product?.trim();
  if (!trimmed) return undefined;
  return GROK_PRODUCT_LABELS.get(trimmed) ?? trimmed;
}

/**
 * Reduces a `/v1/user` response to its subscription tier, so only that field
 * reaches the shared cache file. A response of any other shape yields `{}`.
 */
export function grokSubscription(payload: RuntimeValue): GrokSubscription {
  const subscription: GrokSubscription = {};
  if (isGrokUser(payload) && payload.subscriptionTier !== undefined) {
    subscription.subscriptionTier = payload.subscriptionTier;
  }
  return subscription;
}

/**
 * Label of the Grok credit window, from the period type the billing endpoint
 * reports (`USAGE_PERIOD_TYPE_WEEKLY` -> "Weekly"). An unrecognised type keeps
 * its own name, and a missing or unspecified one falls back to "Credits".
 */
export function grokPeriodLabel(type: string | undefined): string {
  if (!type) return "Credits";
  const name = type.startsWith(GROK_PERIOD_PREFIX) ? type.slice(GROK_PERIOD_PREFIX.length) : type;
  const key = name.toLowerCase();
  if (key.length === 0 || key === "unspecified") return "Credits";
  return usageWindowPeriodLabel(titleCase(key));
}

/** Prepaid balance in cents; proto int64 values may arrive as numeric strings. */
function grokCents(value: RuntimeValue): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value.val;
  const cents = isString(raw) && raw.trim().length > 0 ? Number(raw) : numberValue(raw);
  return cents !== undefined && Number.isFinite(cents) ? cents : undefined;
}

/**
 * Normalizes the private Grok Build billing response
 * (`/v1/billing?format=credits`): one credit window for the current period,
 * with per-product usage as its detail and a positive prepaid balance as the
 * status. A valid period without `creditUsagePercent` reads as 0% used; without
 * a valid period that reading stays unknown and no window is drawn. Throws on a
 * response without a `config` object.
 */
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
  // Fail closed: only a confirmed OAuth sign-in is sent to the private endpoint.
  if (providerUsesOAuth(ctx, "xai") !== true) {
    return { name: GROK_USAGE_NAME, status: GROK_API_KEY_STATUS, windows: [] };
  }
  const token = await providerToken(ctx, "xai");
  if (!token) return undefined;
  const [usage, user] = await Promise.allSettled([
    cache.request("xai:usage", () => fetchUsageJson(GROK_BILLING_URL, token, {}), USAGE_POLICY),
    // The plan only changes with the subscription, so it is cached like Claude's profile.
    cache.request(
      "xai:profile",
      async () => grokSubscription(await fetchUsageJson(GROK_USER_URL, token, {})),
      PROFILE_POLICY,
    ),
  ]);
  if (usage.status === "rejected") throw usage.reason;
  const reading = normalizeGrokUsage(usage.value.payload);
  // Best effort: a failed or unrecognised `/v1/user` read only omits the plan.
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
