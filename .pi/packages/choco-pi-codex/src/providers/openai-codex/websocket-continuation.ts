import { Type } from "typebox";
import { Check } from "typebox/value";
import type {
  CachedWebSocketContinuationState,
  CachedWebSocketRequestBodyResult,
  ProtocolObject,
  ProtocolPropertyValue,
  ProtocolValue,
  ResponsesBody,
  WebSocketContinuationDecision,
} from "./types.ts";

const CanonicalRecordSchema = Type.Unsafe<ProtocolObject>({ type: "object" });
const FunctionCallSchema = Type.Object({
  type: Type.Union([Type.Literal("function_call"), Type.Literal("custom_tool_call")]),
  call_id: Type.String(),
});
const FunctionCallOutputSchema = Type.Object({
  type: Type.Union([Type.Literal("function_call_output"), Type.Literal("custom_tool_call_output")]),
  call_id: Type.String(),
});

type ContinuationComparableBody = Omit<
  ResponsesBody,
  "input" | "previous_response_id" | "client_metadata"
>;

export function requestBodyForWebSocketContinuationComparison(
  body: ResponsesBody,
): ContinuationComparableBody {
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    // Request metadata may carry per-turn transport fields such as the
    // Responses Lite marker. It does not change conversation continuity.
    client_metadata: _clientMetadata,
    ...rest
  } = body;
  return rest;
}

export function responseInputsEqual(
  a: readonly ProtocolValue[] | undefined,
  b: readonly ProtocolValue[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((item, index) => responsesValuesEqual(item, right[index]))
  );
}

function canonicalResponseValue(value: ProtocolPropertyValue): ProtocolPropertyValue {
  if (Array.isArray(value)) return value.map(canonicalResponseValue);
  if (!Check(CanonicalRecordSchema, value)) return value;
  const canonical: ProtocolObject = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "internal_chat_message_metadata_passthrough") continue;
    if (
      key === "logprobs" &&
      value["type"] === "output_text" &&
      Array.isArray(value[key]) &&
      value[key].length === 0
    )
      continue;
    if (
      key === "status" &&
      value[key] === "completed" &&
      (value["type"] === "function_call" || value["type"] === "custom_tool_call")
    )
      continue;
    canonical[key] = canonicalResponseValue(value[key]);
  }
  return canonical;
}

function responsesValuesEqual(a: ProtocolValue, b: ProtocolValue | undefined): boolean {
  return JSON.stringify(canonicalResponseValue(a)) === JSON.stringify(canonicalResponseValue(b));
}

function requestBodiesMatchExceptInput(a: ResponsesBody, b: ResponsesBody): boolean {
  return responsesValuesEqual(
    requestBodyForWebSocketContinuationComparison(a),
    requestBodyForWebSocketContinuationComparison(b),
  );
}

function getFunctionCallId<T>(item: T): string | undefined {
  return Check(FunctionCallSchema, item) ? item.call_id : undefined;
}

function getFunctionCallOutputId<T>(item: T): string | undefined {
  return Check(FunctionCallOutputSchema, item) ? item.call_id : undefined;
}

function getPendingToolOutputDelta(
  body: ResponsesBody,
  continuation: CachedWebSocketContinuationState,
): ProtocolValue[] | undefined {
  const pendingCallIds = continuation.lastResponseItems
    .map(getFunctionCallId)
    .filter((id): id is string => id !== undefined);
  if (pendingCallIds.length === 0) return undefined;

  const pending = new Set(pendingCallIds);
  const currentInput = body.input ?? [];
  let firstOutputIndex: number | undefined;
  for (const [index, item] of currentInput.entries()) {
    const callId = getFunctionCallOutputId(item);
    if (!callId || !pending.has(callId)) continue;
    firstOutputIndex ??= index;
    pending.delete(callId);
  }

  return pending.size === 0 && firstOutputIndex !== undefined
    ? currentInput.slice(firstOutputIndex)
    : undefined;
}

interface CachedWebSocketInputDelta {
  delta?: ProtocolValue[] | undefined;
  decision: WebSocketContinuationDecision;
}

function getCachedWebSocketInputDelta(
  body: ResponsesBody,
  continuation: CachedWebSocketContinuationState,
): CachedWebSocketInputDelta {
  if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
    return { decision: "body_mismatch" };
  }

  const currentInput = body.input ?? [];
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if (currentInput.length < baseline.length) {
    return { decision: "input_shorter_than_baseline" };
  }

  const prefix = currentInput.slice(0, baseline.length);
  if (!responseInputsEqual(prefix, baseline)) {
    const pendingToolOutputDelta = getPendingToolOutputDelta(body, continuation);
    if (pendingToolOutputDelta) {
      return { delta: pendingToolOutputDelta, decision: "delta" };
    }
    return { decision: "input_prefix_mismatch" };
  }

  return { delta: currentInput.slice(baseline.length), decision: "delta" };
}

export function buildCachedWebSocketRequestBody(
  continuation: CachedWebSocketContinuationState | undefined,
  body: ResponsesBody,
): CachedWebSocketRequestBodyResult {
  if (!continuation) {
    return { body, decision: "no_continuation" };
  }

  const { delta, decision } = getCachedWebSocketInputDelta(body, continuation);
  if (!delta) {
    return { body, decision };
  }
  if (!continuation.lastResponseId) {
    return { body, decision: "missing_previous_response_id" };
  }

  return {
    body: {
      ...body,
      previous_response_id: continuation.lastResponseId,
      input: delta,
    },
    decision: "delta",
  };
}
