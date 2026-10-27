import { isJsonRecord, isNumber, isString, type RuntimeValue } from "../runtime-values.ts";

/** Token buckets of one billed call, as the provider reported them. */
export type CallTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Dollar buckets of one billed call, at the list price in force when it ran. */
export type CallCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/** Which persisted entry carried the usage. */
import type { NestedCall } from "./features.ts";

export type CallKind = "assistant" | "compaction" | "branch_summary" | "usage" | "tool";

/**
 * One billed model call, reduced to what the Statistics tab aggregates. The
 * `key` identifies the entry across session files: a fork copies entries
 * verbatim, so the same key in two files is the same call.
 */
export type CallRecord = {
  key: string;
  sessionId: string;
  file: string;
  /** Project directory from the session header. */
  cwd: string;
  /** Request start in epoch ms (the message timestamp), or the entry's append time. */
  at: number;
  kind: CallKind;
  provider: string;
  model: string;
  tokens: CallTokens;
  cost: CallCost;
  durationMs: number | undefined;
  ttftMs: number | undefined;
  stopReason: string | undefined;
  /** The model id the server answered with, when the message records one (xAI Fast variants). */
  responseModel: string | undefined;
  /** Fast mode requested in the session when the call ran; undefined when the log never said. */
  fastRequested: boolean | undefined;
  /** For a code-mode call: what the script executed, from the tool result's traces. */
  nestedCalls: readonly NestedCall[];
  /** Feature bucket chosen by the trigger rule (lib/stats/features.ts). */
  feature: string;
  /** True when the session file belongs to a persisted subagent child. */
  isSubagent: boolean;
  /** An assistant turn that ended with no tokens and no cost (error or abort). */
  failed: boolean;
};

export function totalTokens(tokens: CallTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** Read a usage record out of parsed session JSON, or reject it. */
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

/** A string field of a parsed JSON record, or undefined. */
export function stringField(record: RuntimeValue, key: string): string | undefined {
  if (!isJsonRecord(record)) return undefined;
  const value = record[key];
  return isString(value) ? value : undefined;
}

/** A finite number field of a parsed JSON record, or undefined. */
export function numberField(record: RuntimeValue, key: string): number | undefined {
  if (!isJsonRecord(record)) return undefined;
  const value = record[key];
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}
