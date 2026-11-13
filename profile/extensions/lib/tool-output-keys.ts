import type { RuntimeValue } from "./runtime-values.ts";

const CAPITAL = /[A-Z]/g;

function isPlainRecord(value: RuntimeValue): value is { [key: string]: RuntimeValue } {
  if (value === null || value === undefined) return false;
  if (Object(value) !== value) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** camelCase -> snake_case by inserting "_" before each capital and lowercasing. */
export function snakeCaseKey(key: string): string {
  return key.replace(CAPITAL, (capital) => "_" + capital.toLowerCase());
}

/**
 * Recursively converts the KEYS of plain objects (and plain objects inside arrays) to
 * snake_case. Values, non-plain objects (Map, Date, class instances) and verbatim external
 * data held in such values are returned untouched.
 */
export function toSnakeCaseKeys(value: RuntimeValue): RuntimeValue {
  if (Array.isArray(value)) return value.map((item) => toSnakeCaseKeys(item));
  if (!isPlainRecord(value)) return value;
  const converted: { [key: string]: RuntimeValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    converted[snakeCaseKey(key)] = toSnakeCaseKeys(entry);
  }
  return converted;
}
