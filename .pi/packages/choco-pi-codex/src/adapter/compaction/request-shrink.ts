import { JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { NativeCompactionRequestBody, ResponsesInputItem } from "./serializer.ts";
import { supportsResponsesLiteModel } from "../../providers/openai-codex/responses-lite-model.ts";

export const COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";
export const OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS = 872_000;
const CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

export type NativeCompactionShrinkResult = {
  request: NativeCompactionRequestBody;
  rewrittenOutputs: number;
  /** Oldest conversation items dropped to fit; compaction items are never dropped. */
  droppedItems: number;
};

export type ShrinkNativeCompactionRequestOptions = {
  budgetTokens?: number | null | undefined;
  tokensBefore: number;
  /**
   * Shrink by the local estimate even when `tokensBefore` fits the budget. Set
   * after the provider rejected the request as over its context window, when
   * the host's estimate is known to have been too low.
   */
  force?: boolean | undefined;
};

export type NativeCompactionBudgetOptions = {
  codexTransport: boolean;
  model: string;
  contextWindow?: number | null | undefined;
};

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

type TokenEncoder = { encode(value: string): ArrayLike<BoundaryValue> };
let tokenEncoderPromise: Promise<TokenEncoder> | undefined;

function getTokenEncoder(): Promise<TokenEncoder> {
  // Fork note: upstream imported the full js-tiktoken bundle (all encodings,
  // ~11 MB). Only o200k_base is ever used, so load it through the lite entry;
  // getEncoding("o200k_base") is equivalent to new Tiktoken(o200k_base ranks).
  tokenEncoderPromise ??= Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]).then(([{ Tiktoken }, { default: o200kBase }]) => new Tiktoken(o200kBase));
  return tokenEncoderPromise;
}

function estimateTokenCount(value: BoundaryValue, encoding: TokenEncoder): number {
  const serialized = Value.Check(Type.String(), value) ? value : (JSON.stringify(value) ?? "");
  try {
    return encoding.encode(serialized).length;
  } catch {
    return Math.ceil(serialized.length / 2);
  }
}

type RewrittenToolOutputItem =
  | { recognized: false; item: ResponsesInputItem }
  | { recognized: true; item: ResponsesInputItem };

function rewriteToolOutputItem(item: ResponsesInputItem): RewrittenToolOutputItem {
  if (!isRecord(item)) return { recognized: false, item };
  const record: JsonObject = item;
  if (record["type"] === "function_call_output" || record["type"] === "custom_tool_call_output") {
    if (record["output"] === COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE)
      return { recognized: true, item };
    return {
      recognized: true,
      // SAFETY: The parsed output-item discriminator permits replacing only its string output field.
      item: { ...record, output: COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE } as ResponsesInputItem,
    };
  }
  if (record["type"] === "tool_search_output") {
    if (Array.isArray(record["tools"]) && record["tools"].length === 0)
      return { recognized: true, item };
    const rewritten = { ...record, tools: [] };
    // SAFETY: The tool_search_output discriminator was parsed above; replacing only its tools array preserves the Responses item variant.
    return { recognized: true, item: rewritten as ResponsesInputItem };
  }
  return { recognized: false, item };
}

export function resolveNativeCompactionRequestBudget(
  options: NativeCompactionBudgetOptions,
): number | undefined {
  if (options.codexTransport && supportsResponsesLiteModel(options.model)) {
    return OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS;
  }
  const contextWindow = options.contextWindow;
  if (
    !Value.Check(Type.Number(), contextWindow) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  )
    return undefined;
  return Math.floor((contextWindow * CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100);
}

/**
 * Input budget for a compaction request: the endpoint budget, bounded by the
 * effective window of the model the request is sent to. The Responses Lite
 * endpoint budget (872k) exceeds the 272k/372k windows of the Codex models it
 * applies to, and the endpoint rejects input over the model's window, so the
 * endpoint budget alone never shrinks a request that cannot fit.
 */
export function resolveNativeCompactionInputBudget(
  options: NativeCompactionBudgetOptions,
): number | undefined {
  const endpointBudget = resolveNativeCompactionRequestBudget(options);
  const windowBudget = resolveNativeCompactionRequestBudget({ ...options, codexTransport: false });
  if (endpointBudget === undefined) return windowBudget;
  if (windowBudget === undefined) return endpointBudget;
  return Math.min(endpointBudget, windowBudget);
}

function compactRequestBudget(options: ShrinkNativeCompactionRequestOptions): number | undefined {
  const budgetTokens = options.budgetTokens;
  if (
    !Value.Check(Type.Number(), budgetTokens) ||
    !Number.isFinite(budgetTokens) ||
    budgetTokens <= 0
  )
    return undefined;
  return Math.floor(budgetTokens);
}

/** Tokens the request carries besides its input items: instructions and tool declarations. */
function estimateFixedTokens(request: NativeCompactionRequestBody, encoding: TokenEncoder): number {
  return (
    estimateTokenCount(request.instructions ?? "", encoding) +
    (request.tools && request.tools.length > 0 ? estimateTokenCount(request.tools, encoding) : 0)
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "local_shell_call",
  "custom_tool_call",
  "tool_search_call",
]);
const OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

function stringField(item: ResponsesInputItem, key: string): string | undefined {
  if (!isRecord(item)) return undefined;
  const record: JsonObject = item;
  const value = record[key];
  return Value.Check(Type.String(), value) ? value : undefined;
}
function isCompactionItem(item: ResponsesInputItem): boolean {
  const type = stringField(item, "type");
  return type === "compaction" || type === "compaction_summary";
}
/** A user turn boundary: every tool call before it has already been answered. */
function isUserMessage(item: ResponsesInputItem): boolean {
  if (!isRecord(item)) return false;
  const record: JsonObject = item;
  const type = record["type"];
  return (type === undefined || type === "message") && record["role"] === "user";
}

/**
 * Indices kept when every non-compaction item before `cut` is dropped; an
 * output whose call was dropped is dropped too, so each kept output still
 * follows its call.
 */
function keptFromCut(input: readonly ResponsesInputItem[], cut: number): number[] {
  const kept: number[] = [];
  const calls = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const item = input[index]!;
    if (index < cut) {
      if (isCompactionItem(item)) kept.push(index);
      continue;
    }
    const type = stringField(item, "type") ?? "";
    const id = stringField(item, "call_id");
    if (CALL_TYPES.has(type) && id !== undefined) calls.add(id);
    if (OUTPUT_TYPES.has(type) && (id === undefined || !calls.has(id))) continue;
    kept.push(index);
  }
  return kept;
}

/**
 * Drop the oldest conversation turns until the request fits, cutting only at a
 * user message and keeping every earlier compaction item. The latest cut is
 * used when none fits; undefined when the input has no cut that drops anything.
 */
function trimOldestTurns(
  input: readonly ResponsesInputItem[],
  itemTokens: readonly number[],
  fixedTokens: number,
  budgetTokens: number,
): ResponsesInputItem[] | undefined {
  let kept: number[] | undefined;
  for (let cut = 1; cut < input.length; cut++) {
    if (!isUserMessage(input[cut]!)) continue;
    kept = keptFromCut(input, cut);
    if (fixedTokens + sum(kept.map((index) => itemTokens[index]!)) <= budgetTokens) break;
  }
  if (!kept || kept.length === input.length) return undefined;
  return kept.map((index) => input[index]!);
}

export async function shrinkNativeCompactionRequestForEndpoint(
  request: NativeCompactionRequestBody,
  options: ShrinkNativeCompactionRequestOptions,
): Promise<NativeCompactionShrinkResult> {
  const budgetTokens = compactRequestBudget(options);
  if (
    budgetTokens === undefined ||
    (options.force !== true &&
      (!Number.isFinite(options.tokensBefore) || options.tokensBefore <= budgetTokens))
  ) {
    return { request, rewrittenOutputs: 0, droppedItems: 0 };
  }

  const encoding = await getTokenEncoder();
  const fixedTokens = estimateFixedTokens(request, encoding);
  const itemTokens = request.input.map((item) => estimateTokenCount(item, encoding));
  let estimatedTokensAfter = fixedTokens + sum(itemTokens);
  if (estimatedTokensAfter <= budgetTokens) {
    return { request, rewrittenOutputs: 0, droppedItems: 0 };
  }

  let rewrittenOutputs = 0;
  const input = [...request.input];
  /** Rewrites one tool output in place; false when the item is not a tool output. */
  const rewriteAt = (index: number): boolean => {
    const item = input[index]!;
    const rewrite = rewriteToolOutputItem(item);
    if (!rewrite.recognized) return false;
    if (rewrite.item === item) return true;
    input[index] = rewrite.item;
    rewrittenOutputs++;
    const tokens = estimateTokenCount(rewrite.item, encoding);
    estimatedTokensAfter += tokens - itemTokens[index]!;
    itemTokens[index] = tokens;
    return true;
  };

  // Upstream pass: the trailing run of tool outputs, newest first.
  let trailingStart = input.length;
  while (trailingStart > 0 && estimatedTokensAfter > budgetTokens && rewriteAt(trailingStart - 1))
    trailingStart--;
  // choco-pi: earlier tool outputs, oldest first; calls and outputs stay paired.
  for (let index = 0; index < trailingStart && estimatedTokensAfter > budgetTokens; index++)
    rewriteAt(index);
  // choco-pi: still over, so drop the oldest turns at a user-message cut.
  const trimmed =
    estimatedTokensAfter > budgetTokens
      ? trimOldestTurns(input, itemTokens, fixedTokens, budgetTokens)
      : undefined;

  return {
    request:
      rewrittenOutputs > 0 || trimmed !== undefined
        ? { ...request, input: trimmed ?? input }
        : request,
    rewrittenOutputs,
    droppedItems: trimmed ? input.length - trimmed.length : 0,
  };
}
