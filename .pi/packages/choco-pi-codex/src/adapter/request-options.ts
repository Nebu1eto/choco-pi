import { conditionalProperties } from "./runtime-values.ts";
import type { BoundaryValue } from "./runtime-values.ts";
import { isObject, type CodexConversionConfig } from "./activation/config.ts";

export function applyCodexRequestOptions(
  payload: BoundaryValue,
  config: CodexConversionConfig,
  options: { serviceTier?: boolean | undefined; verbosity?: boolean | undefined } = {
    serviceTier: true,
    verbosity: true,
  },
): BoundaryValue {
  if (!isObject(payload)) return payload;
  const text = isObject(payload["text"]!) ? payload["text"]! : {};
  return {
    ...payload,
    ...conditionalProperties(Boolean(options.serviceTier && config.openai.fast), {
      service_tier: "priority",
    }),
    ...conditionalProperties(Boolean(options.verbosity), {
      text: { ...text, verbosity: config.openai.verbosity },
    }),
  };
}
