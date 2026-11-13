import { isBoolean, isNumber, isString } from "../../value-guards.ts";
import { jsonValueType, isJsonObject } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import type {
  ResponsesInputContentItem,
  ResponsesInputItem,
  ResponsesInputMessageItem,
} from "../compaction/serializer.ts";

export function isRecord(value: BoundaryValue): value is JsonObject {
  return isJsonObject(value);
}

export function isResponsesInputContentItem(
  value: BoundaryValue,
): value is ResponsesInputContentItem {
  if (!isRecord(value) || !isString(value["type"]!)) return false;
  if (value["type"] === "input_text") return isString(value["text"]!);
  if (value["type"] === "input_image")
    return value["detail"] === "auto" && isString(value["image_url"]!);
  if (value["type"] === "encrypted_content") return isString(value["encrypted_content"]!);
  return false;
}
export function isResponsesInputMessageRole(
  value: BoundaryValue,
): value is ResponsesInputMessageItem["role"] {
  return value === "user" || value === "developer" || value === "system";
}

export function isPreambleRole(
  value: ResponsesInputMessageItem["role"],
): value is "developer" | "system" {
  return value === "developer" || value === "system";
}

export function isResponsesInputMessageItem(
  value: BoundaryValue,
): value is ResponsesInputMessageItem {
  if (!isRecord(value) || !isResponsesInputMessageRole(value["role"]!)) return false;
  const { content } = value;
  return (
    isString(content) || (Array.isArray(content) && content.every(isResponsesInputContentItem))
  );
}

function cloneResponsesInputContentItem(
  item: ResponsesInputContentItem,
): ResponsesInputContentItem {
  if (item.type === "input_text") return { type: "input_text", text: item.text };
  if (item.type === "encrypted_content")
    return { type: "encrypted_content", encrypted_content: item.encrypted_content };
  return { type: "input_image", detail: "auto", image_url: item.image_url };
}

export function cloneResponsesInputMessageItem(
  item: ResponsesInputMessageItem,
): ResponsesInputMessageItem {
  return {
    role: item.role,
    content: isString(item.content)
      ? item.content
      : item.content.map(cloneResponsesInputContentItem),
  };
}

export function cloneStructuredValue(value: BoundaryValue): BoundaryValue {
  if (
    value === undefined ||
    value === null ||
    isString(value) ||
    isNumber(value) ||
    isBoolean(value)
  )
    return value;
  if (Array.isArray(value)) return value.map(cloneStructuredValue);
  if (isRecord(value)) {
    const clone: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) clone[key] = cloneStructuredValue(nested);
    return clone;
  }
  throw new Error(`Unsupported structured value: ${jsonValueType(value)}`);
}

export function cloneOpaqueCompactedWindow(
  compactedWindow: readonly BoundaryValue[],
): BoundaryValue[] | undefined {
  const cloned: BoundaryValue[] = [];
  for (const item of compactedWindow) {
    if (!isRecord(item)) return undefined;
    try {
      cloned.push(cloneStructuredValue(item));
    } catch {
      return undefined;
    }
  }
  return cloned;
}

export function cloneResponsesInputSlice(
  items: readonly BoundaryValue[],
): ResponsesInputItem[] | undefined {
  const cloned: ResponsesInputItem[] = [];
  for (const item of items) {
    try {
      const clonedItem = cloneStructuredValue(item);
      if (!isJsonObject(clonedItem)) return undefined;
      cloned.push(clonedItem);
    } catch {
      return undefined;
    }
  }
  return cloned;
}

export function areEquivalentValues(left: BoundaryValue, right: BoundaryValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!areEquivalentValues(left[index]!, right[index]!)) return false;
    }
    return true;
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!areEquivalentValues(leftKeys, rightKeys)) return false;
    for (const key of leftKeys) {
      if (!areEquivalentValues(left[key]!, right[key]!)) return false;
    }
    return true;
  }
  return false;
}
