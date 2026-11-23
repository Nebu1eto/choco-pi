import type { RuntimeValue } from "./runtime-values.ts";

const CAPITAL = /[A-Z]/g;

function isPlainRecord(value: RuntimeValue): value is { [key: string]: RuntimeValue } {
  if (value === null || value === undefined) return false;
  if (Object(value) !== value) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function snakeCaseKey(key: string): string {
  return key.replace(CAPITAL, (capital) => "_" + capital.toLowerCase());
}

export function toSnakeCaseKeys(value: RuntimeValue): RuntimeValue {
  if (Array.isArray(value)) return value.map((item) => toSnakeCaseKeys(item));
  if (!isPlainRecord(value)) return value;
  const converted: { [key: string]: RuntimeValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    converted[snakeCaseKey(key)] = toSnakeCaseKeys(entry);
  }
  return converted;
}
