import type { BoundaryValue } from "./runtime-values.ts";
import type { AdapterState } from "./activation/state.ts";
import { isObjectValue, isStringValue, type BoundaryRecord } from "../tools/boundary.ts";

function providerSystemPrompt(payload: BoundaryRecord): string | undefined {
  if (isStringValue(payload["instructions"])) return payload["instructions"];
  const input = payload["input"];
  if (!Array.isArray(input)) return undefined;
  for (const item of input) {
    if (!isObjectValue(item) || item["role"] !== "developer") continue;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => isObjectValue(part) && part["type"] === "input_text")
      .map((part) => (isObjectValue(part) ? part["text"] : undefined))
      .filter((part): part is string => isStringValue(part))
      .join("\n");
    if (text !== "") return text;
  }
  return undefined;
}

export function captureActiveProviderSystemPrompt(
  payload: BoundaryValue,
  state: AdapterState,
): void {
  if (!isObjectValue(payload)) return;
  const instructions = providerSystemPrompt(payload);
  if (instructions !== undefined) state.activeProviderSystemPrompt = instructions;
}
