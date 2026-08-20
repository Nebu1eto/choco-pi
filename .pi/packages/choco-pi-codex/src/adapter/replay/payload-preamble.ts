import { conditionalProperties } from "../runtime-values.ts";
import type { BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ResponsesCompatibleRequestPayload } from "../compaction/compaction-runtime.ts";
import type { ResponsesInputMessageItem } from "../compaction/serializer.js";
import {
  cloneResponsesInputMessageItem,
  isPreambleRole,
  isResponsesInputMessageItem,
} from "./payload-structured.ts";

export type FreshAuthoritativePreamble = {
  instructions?: string | undefined;
  leadingInput: ResponsesInputMessageItem[];
  trailingInput: ResponsesInputMessageItem[];
};

function isPromptEnvelopeItem(item: BoundaryValue): item is ResponsesInputMessageItem {
  return isResponsesInputMessageItem(item) && isPreambleRole(item.role);
}

export function extractFreshAuthoritativePreamble(
  payload: ResponsesCompatibleRequestPayload,
): FreshAuthoritativePreamble | undefined {
  if (payload.instructions !== undefined && !Value.Check(Type.String(), payload.instructions))
    return undefined;

  let leadingBoundary = 0;
  while (
    leadingBoundary < payload.input.length &&
    isPromptEnvelopeItem(payload.input[leadingBoundary]!)
  )
    leadingBoundary += 1;

  let trailingBoundary = payload.input.length;
  while (
    trailingBoundary > leadingBoundary &&
    isPromptEnvelopeItem(payload.input[trailingBoundary - 1]!)
  )
    trailingBoundary -= 1;

  for (let index = leadingBoundary; index < trailingBoundary; index++) {
    if (isPromptEnvelopeItem(payload.input[index]!)) return undefined;
  }

  return {
    ...conditionalProperties(Boolean(Value.Check(Type.String(), payload.instructions)), {
      instructions: payload.instructions,
    }),
    // SAFETY: The leading-boundary loop accepted every item in this slice as a prompt envelope.
    leadingInput: payload.input
      .slice(0, leadingBoundary)
      .map((item) => cloneResponsesInputMessageItem(item as ResponsesInputMessageItem)),
    // SAFETY: The trailing-boundary loop accepted every item in this slice as a prompt envelope.
    trailingInput: payload.input
      .slice(trailingBoundary)
      .map((item) => cloneResponsesInputMessageItem(item as ResponsesInputMessageItem)),
  };
}
