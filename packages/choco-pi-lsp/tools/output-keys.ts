import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "./runtime-values.ts";

export type SnakeJsonValue = string | number | boolean | null | SnakeJsonValue[] | SnakeJsonObject;

export interface SnakeJsonObject {
  [key: string]: SnakeJsonValue;
}

export interface SnakeCaseKeyOptions {
  readonly verbatimKeys?: ReadonlySet<string>;
}

const CAMEL_CASE_KEY = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const NO_VERBATIM_KEYS: ReadonlySet<string> = new Set();

export function snakeCaseKey(key: string): string {
  if (!CAMEL_CASE_KEY.test(key)) return key;
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isPlainRecord<T>(value: T): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convert(
  value: RuntimeValue,
  renameKeys: boolean,
  verbatimKeys: ReadonlySet<string>,
): SnakeJsonValue | undefined {
  if (value === null) return null;
  if (isRuntimeString(value)) return value;
  if (value === true || value === false) return value;
  if (isRuntimeNumber(value)) return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item: RuntimeValue) => convert(item, renameKeys, verbatimKeys) ?? null);
  }
  if (value instanceof Date) return value.toJSON();
  if (!isRuntimeObject(value)) return undefined;
  const rename = renameKeys && isPlainRecord(value);
  const out: SnakeJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const childValue: RuntimeValue = child;
    const converted = convert(childValue, rename && !verbatimKeys.has(key), verbatimKeys);
    if (converted === undefined) continue;
    out[rename ? snakeCaseKey(key) : key] = converted;
  }
  return out;
}

export function toSnakeCaseKeys<T extends RuntimeValue>(
  value: T,
  options: SnakeCaseKeyOptions = {},
): SnakeJsonValue {
  return convert(value, true, options.verbatimKeys ?? NO_VERBATIM_KEYS) ?? null;
}

export function stringifySnakeCase<T extends RuntimeValue>(
  value: T,
  options: SnakeCaseKeyOptions = {},
): string {
  return JSON.stringify(toSnakeCaseKeys(value, options));
}
