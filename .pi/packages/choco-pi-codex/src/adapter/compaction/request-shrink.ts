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
};

export type ShrinkNativeCompactionRequestOptions = {
  budgetTokens?: number | null | undefined;
  tokensBefore: number;
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

function estimateCompactContextTokens(
  request: NativeCompactionRequestBody,
  encoding: TokenEncoder,
): number {
  return (
    estimateTokenCount(request.instructions ?? "", encoding) +
    estimateTokenCount(request.input, encoding)
  );
}

export async function shrinkNativeCompactionRequestForEndpoint(
  request: NativeCompactionRequestBody,
  options: ShrinkNativeCompactionRequestOptions,
): Promise<NativeCompactionShrinkResult> {
  const budgetTokens = compactRequestBudget(options);
  if (
    budgetTokens === undefined ||
    !Number.isFinite(options.tokensBefore) ||
    options.tokensBefore <= budgetTokens
  ) {
    return { request, rewrittenOutputs: 0 };
  }

  const encoding = await getTokenEncoder();
  const estimatedTokensBefore = estimateCompactContextTokens(request, encoding);
  if (estimatedTokensBefore <= budgetTokens) {
    return { request, rewrittenOutputs: 0 };
  }

  let rewrittenOutputs = 0;
  let estimatedTokensAfter = estimatedTokensBefore;
  let input: ResponsesInputItem[] | undefined;

  for (
    let index = request.input.length - 1;
    index >= 0 && estimatedTokensAfter > budgetTokens;
    index--
  ) {
    const item = (input ?? request.input)[index]!;
    const rewrite = rewriteToolOutputItem(item);
    if (!rewrite.recognized) break;
    if (rewrite.item === item) continue;

    input ??= [...request.input];
    input[index] = rewrite.item;
    rewrittenOutputs++;
    estimatedTokensAfter +=
      estimateTokenCount(rewrite.item, encoding) - estimateTokenCount(item, encoding);
  }

  return {
    request: input ? { ...request, input } : request,
    rewrittenOutputs,
  };
}
