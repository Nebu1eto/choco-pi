import { conditionalProperties } from "../adapter/runtime-values.ts";
import { JsonObjectSchema } from "../adapter/runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../adapter/runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export interface CodexUsageWindow {
  usedPercent?: number | undefined;
  windowMinutes?: number | undefined;
  resetsAt?: number | undefined;
}

export interface CodexUsageLimit {
  limitId: string;
  limitName?: string | undefined;
  primary?: CodexUsageWindow | undefined;
  secondary?: CodexUsageWindow | undefined;
}

export interface CodexUsageSnapshot {
  planType?: string | undefined;
  limits: CodexUsageLimit[];
  resetCredits?: CodexRateLimitResetCredits | undefined;
  raw: BoundaryValue;
}

export interface CodexRateLimitResetCredit {
  id?: string | undefined;
  resetType?: string | undefined;
  status?: string | undefined;
  grantedAt?: string | undefined;
  expiresAt?: string | undefined;
  redeemStartedAt?: string | undefined;
  redeemedAt?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
  credits: CodexRateLimitResetCredit[];
  raw: BoundaryValue;
}

export type CodexRateLimitResetConsumeOutcome =
  | "reset"
  | "already_redeemed"
  | "nothing_to_reset"
  | "no_credit"
  | "unknown";

export interface CodexRateLimitResetConsumeResult {
  outcome: CodexRateLimitResetConsumeOutcome;
  windowsReset?: number | undefined;
  raw: BoundaryValue;
}

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function numberValue(value: BoundaryValue): number | undefined {
  return Value.Check(Type.Number(), value) && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: BoundaryValue): string | undefined {
  return Value.Check(Type.String(), value) && value.trim().length > 0 ? value : undefined;
}

function integerValue(value: BoundaryValue): number | undefined {
  if (Value.Check(Type.Number(), value) && Number.isFinite(value))
    return Math.max(0, Math.trunc(value));
  if (!Value.Check(Type.String(), value) || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function parseResetCredit(value: BoundaryValue): CodexRateLimitResetCredit | undefined {
  if (!isRecord(value)) return undefined;
  return {
    id: stringValue(value["id"]!),
    resetType: stringValue(value["reset_type"]!),
    status: stringValue(value["status"]!),
    grantedAt: stringValue(value["granted_at"]!),
    expiresAt: stringValue(value["expires_at"]!),
    redeemStartedAt: stringValue(value["redeem_started_at"]!),
    redeemedAt: stringValue(value["redeemed_at"]!),
    title: stringValue(value["title"]!),
    description: stringValue(value["description"]!),
  };
}

export function parseCodexRateLimitResetCreditsPayload(
  payload: BoundaryValue,
): CodexRateLimitResetCredits | undefined {
  const root = isRecord(payload) ? payload : undefined;
  if (!root) return undefined;
  const availableCount = integerValue(root["available_count"]!);
  if (availableCount === undefined) return undefined;
  const credits = Array.isArray(root["credits"]!)
    ? root["credits"]!.map(parseResetCredit).filter((credit): credit is CodexRateLimitResetCredit =>
        Boolean(credit),
      )
    : [];
  return { availableCount, credits, raw: payload };
}

function parseCodexRateLimitResetCreditsSummary(
  value: BoundaryValue,
): CodexRateLimitResetCredits | undefined {
  if (!isRecord(value)) return undefined;
  const availableCount = integerValue(value["available_count"]!);
  return availableCount === undefined ? undefined : { availableCount, credits: [], raw: value };
}

function parseWindow(value: BoundaryValue): CodexUsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberValue(value["used_percent"]!);
  const limitWindowSeconds = numberValue(value["limit_window_seconds"]!);
  const windowMinutes =
    numberValue(value["window_minutes"]!) ??
    (limitWindowSeconds === undefined ? undefined : Math.ceil(limitWindowSeconds / 60));
  const resetsAt = numberValue(value["resets_at"]!) ?? numberValue(value["reset_at"]!);
  return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
    ? undefined
    : { usedPercent, windowMinutes, resetsAt };
}

interface ParsedRateLimit {
  primary?: CodexUsageWindow | undefined;
  secondary?: CodexUsageWindow | undefined;
}

function parseRateLimit(value: BoundaryValue): ParsedRateLimit {
  if (!isRecord(value)) return {} satisfies ParsedRateLimit;
  const primary = parseWindow(value["primary_window"]!) ?? parseWindow(value["primary"]!);
  const secondary = parseWindow(value["secondary_window"]!) ?? parseWindow(value["secondary"]!);
  if (primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary) {
    return { secondary: primary } satisfies ParsedRateLimit;
  }
  return { primary, secondary } satisfies ParsedRateLimit;
}

export function parseCodexUsagePayload(payload: BoundaryValue): CodexUsageSnapshot {
  const root = isRecord(payload) ? payload : {};
  const limits: CodexUsageLimit[] = [];
  const addLimit = (limitId: string, limitName: string | undefined, source: BoundaryValue) => {
    const rateLimit = isRecord(source) && "rate_limit" in source ? source["rate_limit"]! : source;
    const parsed = parseRateLimit(rateLimit);
    limits.push({
      limitId,
      ...conditionalProperties(Boolean(limitName), { limitName }),
      ...conditionalProperties(Boolean(parsed.primary), { primary: parsed.primary }),
      ...conditionalProperties(Boolean(parsed.secondary), { secondary: parsed.secondary }),
    });
  };
  addLimit("codex", undefined, root["rate_limit"]!);
  if (Array.isArray(root["additional_rate_limits"]!)) {
    for (const item of root["additional_rate_limits"]!) {
      if (!isRecord(item)) continue;
      addLimit(
        stringValue(item["metered_feature"]!) ?? "additional",
        stringValue(item["limit_name"]!),
        item,
      );
    }
  }
  return {
    planType: stringValue(root["plan_type"]!),
    limits,
    resetCredits: parseCodexRateLimitResetCreditsSummary(root["rate_limit_reset_credits"]!),
    raw: payload,
  };
}

export function codexWeeklyUsageLeft(snapshot: CodexUsageSnapshot): number | undefined {
  const limit = snapshot.limits.find(({ limitId }) => limitId === "codex");
  const weekly = [limit?.primary, limit?.secondary].find(
    ({ windowMinutes } = {}) => windowMinutes === WEEKLY_WINDOW_MINUTES,
  );
  if (weekly?.usedPercent === undefined) return undefined;
  return 100 - Math.max(0, Math.min(100, weekly.usedPercent));
}

export function parseCodexRateLimitResetConsumePayload(
  payload: BoundaryValue,
): CodexRateLimitResetConsumeResult {
  const root = isRecord(payload) ? payload : {};
  const code = stringValue(root["code"]!);
  const outcome: CodexRateLimitResetConsumeOutcome =
    code === "reset" ||
    code === "already_redeemed" ||
    code === "nothing_to_reset" ||
    code === "no_credit"
      ? code
      : "unknown";
  return { outcome, windowsReset: integerValue(root["windows_reset"]!), raw: payload };
}
