import { bool, compile, obj, str } from "@earendil-works/pi-schema";
import { finiteNum } from "../schema.ts";
import type { QuotasResponse } from "../types/quotas.ts";

export type BillingMode = "subscription" | "pay-as-you-go";

const SubscriptionQuotaSchema = obj(
  { limit: finiteNum(), requests: finiteNum(), renewsAt: str() },
  { open: true },
);
const isSubscriptionQuota = compile(SubscriptionQuotaSchema).check;

const WeeklyTokenLimitSchema = obj(
  {
    nextRegenAt: str(),
    percentRemaining: finiteNum(),
    maxCredits: str(),
    remainingCredits: str(),
    nextRegenCredits: str(),
  },
  { open: true },
);
const isWeeklyTokenLimit = compile(WeeklyTokenLimitSchema).check;

const RollingFiveHourLimitSchema = obj(
  {
    nextTickAt: str(),
    tickPercent: finiteNum(),
    remaining: finiteNum(),
    max: finiteNum(),
    limited: bool(),
  },
  { open: true },
);
const isRollingFiveHourLimit = compile(RollingFiveHourLimitSchema).check;

/**
 * Synthetic subscription accounts expose at least one subscription quota
 * window. PAYG accounts return an empty quota object or legacy tool windows.
 */
export function detectBillingMode(quotas: QuotasResponse | undefined): BillingMode {
  return isSubscriptionQuota(quotas?.subscription) ||
    isWeeklyTokenLimit(quotas?.weeklyTokenLimit) ||
    isRollingFiveHourLimit(quotas?.rollingFiveHourLimit)
    ? "subscription"
    : "pay-as-you-go";
}

export function formatResetTime(renewsAt: string): string {
  const date = new Date(renewsAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs <= 0) return "soon";

  const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 24) return `in ${diffHours}h`;
  if (diffDays < 7) return `in ${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
