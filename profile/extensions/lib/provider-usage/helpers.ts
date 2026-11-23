import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isNumber, isObject, isString, type RuntimeValue } from "../runtime-values.ts";
import {
  createFileUsageCacheStorage,
  createUsageCache,
  type UsageRequestResult,
} from "../usage-cache.ts";
import type { ProviderUsage } from "./types.ts";

export const usageCache = createUsageCache({ storage: createFileUsageCacheStorage() });

export function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function numberValue(value: RuntimeValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: RuntimeValue): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

export function dateValue(value: RuntimeValue, unixSeconds = false): Date | undefined {
  if (unixSeconds && isNumber(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (!isString(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseJwtPayload(token: string): Record<string, RuntimeValue> | undefined {
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

export function usageWindowPeriodLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "5h") return "5-hours";
  if (normalized === "7d" || normalized === "weekly") return "Weekly";
  return raw;
}

export function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function currencyValue(value: string): number {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatNumber(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export function formatCredits(value: RuntimeValue): string | undefined {
  const text = stringValue(value);
  const parsed = text !== undefined ? Number(text) : numberValue(value);
  if (parsed !== undefined && Number.isFinite(parsed)) return String(Math.round(parsed));
  return text;
}

export function relativeTime(date: Date | undefined, at = Date.now()): string | undefined {
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

export function elapsedTime(date: Date, at = Date.now()): string {
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

export async function providerToken(
  ctx: ExtensionContext,
  provider: string,
): Promise<string | undefined> {
  if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  return ctx.modelRegistry.getApiKeyForProvider(provider);
}

export function providerUsesOAuth(ctx: ExtensionContext, provider: string): boolean | undefined {
  try {
    const registry = ctx.modelRegistry;
    const model =
      ctx.model?.provider === provider
        ? ctx.model
        : registry.getAll().find((candidate) => candidate.provider === provider);
    return model ? registry.isUsingOAuth(model) : undefined;
  } catch {
    return undefined;
  }
}

export function providerConfigured(ctx: ExtensionContext, provider: string): boolean {
  try {
    return ctx.modelRegistry.getProviderAuthStatus(provider).configured;
  } catch {
    return false;
  }
}

export function withCacheNote(usage: ProviderUsage, result: UsageRequestResult): ProviderUsage {
  if (result.cachedAt === undefined) return usage;
  return {
    ...usage,
    cached: { at: new Date(result.cachedAt), reason: result.reason },
  };
}
