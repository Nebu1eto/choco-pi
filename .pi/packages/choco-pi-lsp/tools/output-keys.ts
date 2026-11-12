import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "./runtime-values.ts";

/**
 * Model-visible tool output uses snake_case keys (choco-pi tool I/O policy).
 * Internal objects keep their camelCase shape; convert only where tool result
 * text is serialized. Values are never rewritten.
 */

export type SnakeJsonValue = string | number | boolean | null | SnakeJsonValue[] | SnakeJsonObject;

export interface SnakeJsonObject {
  [key: string]: SnakeJsonValue;
}

export interface SnakeCaseKeyOptions {
  /**
   * Keys whose values are external pass-through data (LSP protocol objects,
   * diagnostics). The key itself is converted; everything below it keeps the
   * exact keys it was received with.
   */
  readonly verbatimKeys?: ReadonlySet<string>;
}

const CAMEL_CASE_KEY = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const NO_VERBATIM_KEYS: ReadonlySet<string> = new Set();

/** `startLine` -> `start_line`; keys that are not camelCase identifiers are returned unchanged. */
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
  // Only plain records we built are renamed; Map/class instances keep their keys.
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

/**
 * JSON-compatible copy of `value` with every plain-object key converted to
 * snake_case. Mirrors JSON.stringify value handling: undefined/functions are
 * dropped from objects and become null inside arrays, non-finite numbers
 * become null.
 */
export function toSnakeCaseKeys<T extends RuntimeValue>(
  value: T,
  options: SnakeCaseKeyOptions = {},
): SnakeJsonValue {
  return convert(value, true, options.verbatimKeys ?? NO_VERBATIM_KEYS) ?? null;
}

/** `JSON.stringify` of {@link toSnakeCaseKeys}; compact, like the existing tool payloads. */
export function stringifySnakeCase<T extends RuntimeValue>(
  value: T,
  options: SnakeCaseKeyOptions = {},
): string {
  return JSON.stringify(toSnakeCaseKeys(value, options));
}
