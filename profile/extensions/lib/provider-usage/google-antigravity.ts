import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAntigravityApiKey } from "../../../../packages/choco-pi-provider-google-antigravity/src/auth/oauth.ts";
import {
  readQuotaSummary,
  readTier,
} from "../../../../packages/choco-pi-provider-google-antigravity/src/client/quota.ts";
import { SIGN_IN_HINT as GOOGLE_SIGN_IN_HINT } from "../../../../packages/choco-pi-provider-google-antigravity/src/config.ts";
import { AntigravityError } from "../../../../packages/choco-pi-provider-google-antigravity/src/errors.ts";
import { recordOf, type RuntimeValue } from "../runtime-values.ts";
import { identityKey, UsageHttpError, type UsageCache } from "../usage-cache.ts";
import {
  dateValue,
  formatCredits,
  isRecord,
  numberValue,
  providerConfigured,
  providerToken,
  providerUsesOAuth,
  stringValue,
  usageCache,
  usageWindowPeriodLabel,
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

export const GOOGLE_ANTIGRAVITY_USAGE_NAME = "Google";
const GOOGLE_ANTIGRAVITY_PROVIDER = "google";
export const GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS = "no quota summary for this plan";

const ANTIGRAVITY_WINDOW_SECONDS = recordOf<string, number>()({
  weekly: 7 * DAY_SECONDS,
  "5h": 5 * HOUR_SECONDS,
});

function antigravityGroupRank(groupName: string | undefined): number {
  return groupName !== undefined && /gemini/i.test(groupName) ? 0 : 1;
}

function antigravityWindowRank(windowName: string): number {
  const normalized = windowName.toLowerCase();
  if (normalized === "5h") return 0;
  if (normalized === "weekly") return 1;
  return 2;
}

export function normalizeGoogleAntigravityUsage(payload: RuntimeValue): ProviderUsage {
  if (isRecord(payload) && payload.kind === "no_quota_for_tier") {
    return {
      name: GOOGLE_ANTIGRAVITY_USAGE_NAME,
      status: GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS,
      windows: [],
    };
  }
  const groups = isRecord(payload) && Array.isArray(payload.groups) ? payload.groups : [];
  const normalizedGroups: Array<{
    rank: number;
    windows: Array<{ rank: number; window: UsageWindow }>;
  }> = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = stringValue(group.displayName);
    const groupWindows: Array<{ rank: number; window: UsageWindow }> = [];
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || bucket.disabled === true) continue;
      const remaining = numberValue(bucket.remainingFraction);
      const windowName = stringValue(bucket.window) ?? stringValue(bucket.displayName);
      if (remaining === undefined || windowName === undefined) continue;
      const windowLabel = usageWindowPeriodLabel(windowName);
      const window: UsageWindow = {
        label: groupName === undefined ? windowLabel : `${groupName} ${windowLabel}`,
        percent: clampPercent((1 - remaining) * 100),
        qualifier: "used",
        eventAt: dateValue(bucket.resetTime),
        eventLabel: "resets",
      };
      const windowSeconds = ANTIGRAVITY_WINDOW_SECONDS[windowName];
      if (windowSeconds !== undefined) window.windowSeconds = windowSeconds;
      if (groupName !== undefined) window.scope = groupName;
      groupWindows.push({ rank: antigravityWindowRank(windowName), window });
    }
    if (groupWindows.length > 0) {
      groupWindows.sort((a, b) => a.rank - b.rank);
      normalizedGroups.push({
        rank: antigravityGroupRank(groupName),
        windows: groupWindows,
      });
    }
  }
  normalizedGroups.sort((a, b) => a.rank - b.rank);
  const windows = normalizedGroups.flatMap((group) => group.windows.map((entry) => entry.window));
  return { name: GOOGLE_ANTIGRAVITY_USAGE_NAME, windows };
}

export type GoogleAntigravityPlan = { plan?: string; credits?: string };

export function googleAntigravityPlan(payload: RuntimeValue): GoogleAntigravityPlan {
  if (!isRecord(payload)) return {};
  const result: GoogleAntigravityPlan = {};
  const plan = stringValue(payload.planLabel);
  if (plan !== undefined) result.plan = plan;
  const credits = Array.isArray(payload.credits) ? payload.credits : [];
  const amounts = credits.flatMap((credit) => {
    const amount = isRecord(credit) ? formatCredits(credit.creditAmount) : undefined;
    return amount === undefined ? [] : [amount];
  });
  if (amounts.length > 0) result.credits = `${amounts.join(" + ")} AI credits`;
  return result;
}

async function antigravityRequest<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AntigravityError && error.status !== undefined) {
      throw new UsageHttpError(error.status, error.retryAfterMs);
    }
    if (error instanceof AntigravityError) throw new Error(`Google Antigravity ${error.kind}`);
    throw error;
  }
}

export async function googleAntigravityUsage(
  ctx: ExtensionContext,
  cache: UsageCache = usageCache,
): Promise<ProviderUsage | undefined> {
  if (!providerConfigured(ctx, GOOGLE_ANTIGRAVITY_PROVIDER)) return undefined;
  const oauth = providerUsesOAuth(ctx, GOOGLE_ANTIGRAVITY_PROVIDER);
  if (oauth === false) return undefined;
  const apiKey = await providerToken(ctx, GOOGLE_ANTIGRAVITY_PROVIDER);
  if (!apiKey) return undefined;
  const credential = readAntigravityApiKey(apiKey);
  if (credential === undefined) {
    if (oauth === true) {
      throw new Error(`Google Antigravity credential is unusable; ${GOOGLE_SIGN_IN_HINT}`);
    }
    return undefined;
  }
  const { token, projectId, accountKey } = credential;
  const slot = accountKey === undefined ? "" : `:${identityKey(accountKey)}`;
  const [usage, tier] = await Promise.allSettled([
    cache.request(
      `google:quota${slot}`,
      () =>
        antigravityRequest(async () => {
          const summary = await readQuotaSummary({ token, projectId });
          return summary.kind === "summary" ? summary : { kind: summary.kind };
        }),
      USAGE_POLICY,
    ),
    cache.request(
      `google:profile${slot}`,
      async () => {
        const { planLabel, credits } = await antigravityRequest(() => readTier({ token }));
        return {
          planLabel,
          credits: (credits ?? []).map((credit) => ({
            creditType: credit.creditType,
            creditAmount: credit.creditAmount,
          })),
        };
      },
      PROFILE_POLICY,
    ),
  ]);
  if (usage.status === "rejected") throw usage.reason;
  const reading = normalizeGoogleAntigravityUsage(usage.value.payload);
  const { plan, credits } =
    tier.status === "fulfilled" ? googleAntigravityPlan(tier.value.payload) : {};
  const status = [reading.status, credits].filter(Boolean).join(" · ");
  const row: ProviderUsage = { ...reading };
  if (plan !== undefined) row.plan = plan;
  if (status) row.status = status;
  else delete row.status;
  return withCacheNote(row, usage.value);
}

export const googleAntigravityUsageProviderAdapter: UsageProviderAdapter = {
  id: "google",
  displayName: GOOGLE_ANTIGRAVITY_USAGE_NAME,
  order: 30,
  providerIds: ["google"],
  readUsage: googleAntigravityUsage,
};
