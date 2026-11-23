import { isRecord } from "../parsing.ts";

export type ToolOutputValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | ToolOutputValue[]
  | { [key: string]: ToolOutputValue };

export function toSnakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isPlainRecord<Value>(value: Value): value is Value & Record<string, ToolOutputValue> {
  if (!isRecord(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toSnakeCaseKeys<Value>(value: Value): Value | ToolOutputValue {
  if (Array.isArray(value)) return value.map((item: ToolOutputValue) => toSnakeCaseKeys(item));
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [toSnakeCaseKey(key), toSnakeCaseKeys(entry)]),
  );
}

const WRAPPER_DATA_KEYS = new Set(["alreadyEnabled", "frameFormat", "noMovement", "wsUrl"]);

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
