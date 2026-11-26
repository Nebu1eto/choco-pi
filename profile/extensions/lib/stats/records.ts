import { isJsonRecord, isNumber, isString, type RuntimeValue } from "../runtime-values.ts";

export type CallTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type CallCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

import type { NestedCall } from "./features.ts";

export type CallKind = "assistant" | "compaction" | "branch_summary" | "usage" | "tool";

export type CallRecord = {
  key: string;
  sessionId: string;
  file: string;
  cwd: string;
  at: number;
  kind: CallKind;
  provider: string;
  model: string;
  tokens: CallTokens;
  cost: CallCost;
  durationMs: number | undefined;
  ttftMs: number | undefined;
  stopReason: string | undefined;
  responseModel: string | undefined;
  fastRequested: boolean | undefined;
  nestedCalls: readonly NestedCall[];
  feature: string;
  isSubagent: boolean;
  failed: boolean;
};

export function totalTokens(tokens: CallTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export function recordedModelId(
  provider: string,
  model: string | undefined,
  responseModel: string | undefined,
): string | undefined {
  if (provider === "synthetic") return model ?? responseModel;
  return responseModel ?? model;
}

export function readCallUsage(
  value: RuntimeValue,
): { tokens: CallTokens; cost: CallCost } | undefined {
  if (!isJsonRecord(value)) return undefined;
  const cost = value["cost"];
  if (!isJsonRecord(cost)) return undefined;
  const buckets = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const tokens = buckets.map((bucket) => value[bucket]);
  const costs = buckets.map((bucket) => cost[bucket]);
  const total = cost["total"];
  if (!isNumber(total) || !tokens.every(isNumber) || !costs.every(isNumber)) return undefined;
  const [input, output, cacheRead, cacheWrite] = tokens;
  const [costInput, costOutput, costCacheRead, costCacheWrite] = costs;
  return {
    tokens: { input, output, cacheRead, cacheWrite },
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total,
    },
  };
}

export function stringField(record: RuntimeValue, key: string): string | undefined {
  if (!isJsonRecord(record)) return undefined;
  const value = record[key];
  return isString(value) ? value : undefined;
}

export function numberField(record: RuntimeValue, key: string): number | undefined {
  if (!isJsonRecord(record)) return undefined;
  const value = record[key];
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}
