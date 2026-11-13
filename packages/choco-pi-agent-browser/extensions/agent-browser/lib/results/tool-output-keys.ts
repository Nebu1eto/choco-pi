import { isRecord } from "../parsing.ts";

/** Model-visible JSON value produced by the wrapper itself. */
export type ToolOutputValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | ToolOutputValue[]
  | { [key: string]: ToolOutputValue };

/** Converts one camelCase key to the snake_case tool-output spelling. */
export function toSnakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isPlainRecord<Value>(value: Value): value is Value & Record<string, ToolOutputValue> {
  if (!isRecord(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Renames plain-object keys of a wrapper-built value to snake_case at the model-visible boundary.
 * Values, arrays, and non-plain objects are preserved; upstream CLI payloads must not pass through here.
 */
export function toSnakeCaseKeys<Value>(value: Value): Value | ToolOutputValue {
  if (Array.isArray(value)) return value.map((item: ToolOutputValue) => toSnakeCaseKeys(item));
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [toSnakeCaseKey(key), toSnakeCaseKeys(entry)]),
  );
}

/** Wrapper-added keys that may be merged into an upstream data object. */
const WRAPPER_DATA_KEYS = new Set(["alreadyEnabled", "frameFormat", "noMovement", "wsUrl"]);

/**
 * Converts the wrapper-owned parts of a presentation data value for model-visible JSON.
 * Wrapper-compacted payloads are fully wrapper-built; otherwise only known wrapper-added
 * top-level keys are renamed and upstream CLI keys stay verbatim.
 */
export function toModelVisibleData<Value>(data: Value): Value | ToolOutputValue {
  if (!isPlainRecord(data)) return data;
  if (data.compacted === true) return toSnakeCaseKeys(data);
  return Object.fromEntries(
    Object.entries(data).map(([key, entry]) => [
      WRAPPER_DATA_KEYS.has(key) ? toSnakeCaseKey(key) : key,
      entry,
    ]),
  );
}
