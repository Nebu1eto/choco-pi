import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeUsageProviderAdapter } from "./lib/provider-usage/claude.ts";
import { chatgptUsageProviderAdapter } from "./lib/provider-usage/codex.ts";
import { formatUsageReport, usageFailureMessage } from "./lib/provider-usage/format.ts";
import { googleAntigravityUsageProviderAdapter } from "./lib/provider-usage/google-antigravity.ts";
import { usageCache } from "./lib/provider-usage/helpers.ts";
import {
  findUsageProviderAdapter,
  getUsageProviders,
  registerUsageProvider,
} from "./lib/provider-usage/registry.ts";
import { syntheticUsageProviderAdapter } from "./lib/provider-usage/synthetic.ts";
import type {
  ProviderUsageReading,
  ProviderUsageReport,
  ProviderUsageSnapshot,
  UsageStyle,
  UsageWindow,
} from "./lib/provider-usage/types.ts";
import { xaiUsageProviderAdapter } from "./lib/provider-usage/xai.ts";
import type { UsageCache } from "./lib/usage-cache.ts";

export {
  quotaHealth,
  windowElapsedPercent,
  type ProviderUsage,
  type ProviderUsageReading,
  type ProviderUsageReport,
  type ProviderUsageSnapshot,
  type QuotaHealth,
  type UsageProviderAdapter,
  type UsageStyle,
  type UsageWindow,
  type UsageWindowSummary,
} from "./lib/provider-usage/types.ts";
export { providerUsesOAuth } from "./lib/provider-usage/helpers.ts";
export {
  findUsageProviderAdapter,
  getUsageProviders,
  registerUsageProvider,
  USAGE_PROVIDER_REGISTRY_SYMBOL,
} from "./lib/provider-usage/registry.ts";
export { claudePlanLabel, normalizeClaudeUsage } from "./lib/provider-usage/claude.ts";
export {
  CHATGPT_USAGE_NAME,
  chatgptUsageProvider,
  codexPlanLabel,
  normalizeCodexUsage,
  OPENAI_API_KEY_STATUS,
  OPENAI_SIGNED_IN_STATUS,
  openaiUsage,
  resetCodexUsage,
} from "./lib/provider-usage/codex.ts";
export {
  GOOGLE_ANTIGRAVITY_NO_QUOTA_STATUS,
  GOOGLE_ANTIGRAVITY_USAGE_NAME,
  googleAntigravityPlan,
  googleAntigravityUsage,
  normalizeGoogleAntigravityUsage,
  type GoogleAntigravityPlan,
} from "./lib/provider-usage/google-antigravity.ts";
export {
  GROK_API_KEY_STATUS,
  GROK_USAGE_NAME,
  grokPeriodLabel,
  grokPlanLabel,
  grokProductLabel,
  grokSubscription,
  grokUsage,
  normalizeGrokUsage,
  type GrokSubscription,
} from "./lib/provider-usage/xai.ts";
export {
  normalizeSyntheticUsage,
  refillPace,
  syntheticReadings,
} from "./lib/provider-usage/synthetic.ts";
export {
  cachedLabel,
  describeUsageWindow,
  formatProviderUsage,
  formatUsageReport,
  usageFailureMessage,
} from "./lib/provider-usage/format.ts";

const BUILTIN_ADAPTERS = [
  claudeUsageProviderAdapter,
  chatgptUsageProviderAdapter,
  googleAntigravityUsageProviderAdapter,
  xaiUsageProviderAdapter,
  syntheticUsageProviderAdapter,
] as const;

for (const adapter of BUILTIN_ADAPTERS) {
  registerUsageProvider(adapter);
}

/**
 * Reads the quota windows of `provider` via its registered adapter. Resolves
 * `undefined` when the provider is unknown or not connected, or when no
 * reading can be obtained; it never rejects.
 */
export async function providerUsageSnapshot(
  ctx: ExtensionContext,
  provider: string,
): Promise<ProviderUsageSnapshot | undefined> {
  try {
    const adapter = findUsageProviderAdapter(provider);
    if (!adapter?.readSnapshot) return undefined;
    const usage = await adapter.readSnapshot(ctx, provider, usageCache);
    if (!usage) return undefined;
    return {
      windows: usage.windows,
      observedAt: usage.cached?.at.getTime() ?? Date.now(),
    };
  } catch {
    return undefined;
  }
}

/** Quota windows of `provider`, or `undefined` when none can be read. Never rejects. */
export async function providerUsageWindows(
  ctx: ExtensionContext,
  provider: string,
): Promise<UsageWindow[] | undefined> {
  return (await providerUsageSnapshot(ctx, provider))?.windows;
}

/**
 * Stable account identity for closing a provider per account via its
 * registered adapter. Resolves `undefined` when it cannot be derived; never
 * rejects.
 */
export async function providerAccountId(
  ctx: ExtensionContext,
  provider: string,
): Promise<string | undefined> {
  try {
    const adapter = findUsageProviderAdapter(provider);
    if (!adapter?.resolveAccountId) return undefined;
    return await adapter.resolveAccountId(ctx, provider, usageCache);
  } catch {
    return undefined;
  }
}

/**
 * Queries every registered usage provider adapter in display order once.
 * A provider without a credential is listed in `absent` instead of producing
 * a reading; a signed-in provider that fails becomes a reading with its
 * failure message, so this never rejects.
 */
export async function readProviderUsages(
  ctx: ExtensionContext,
  options: { cache?: UsageCache } = {},
): Promise<ProviderUsageReport> {
  const cache = options.cache ?? usageCache;
  const adapters = getUsageProviders();
  const settled = await Promise.allSettled(
    adapters.map((adapter) => adapter.readUsage(ctx, cache)),
  );
  const providers: ProviderUsageReading[] = [];
  const absent: string[] = [];
  settled.forEach((result, index) => {
    const name = adapters[index].displayName;
    if (result.status === "rejected") {
      providers.push({
        ok: false,
        name,
        error: usageFailureMessage(result.reason),
      });
    } else if (result.value === undefined) {
      absent.push(name);
    } else {
      providers.push({ ok: true, usage: result.value });
    }
  });
  return { observedAt: new Date(), providers, absent };
}

export async function usageReport(ctx: ExtensionContext, style?: UsageStyle): Promise<string> {
  return formatUsageReport(await readProviderUsages(ctx), style);
}

// Command registration lives in status-commands.ts; this module only fetches
// and formats the Usage tab body.
export default function providerUsage(): void {}
