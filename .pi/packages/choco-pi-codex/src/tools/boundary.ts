import type { BoundaryValue as RuntimeBoundaryValue } from "../adapter/runtime-values.ts";

/** Any value crossing an I/O boundary before it is decoded: the JavaScript value universe, not JSON. */
export type BoundaryValue = RuntimeBoundaryValue;

/** An undecoded object keyed by arbitrary strings. */
export type BoundaryRecord = KeyedValues<BoundaryValue>;

interface KeyedValues<Value> {
  [key: string]: Value;
}

// Identity against Object(value) rejects every object (boxed wrappers included) before instanceof
// runs, and Object() never calls user code, so these guards cannot throw.
export function isStringValue(value: BoundaryValue): value is string {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof String;
}

/** Finite numbers only: NaN and +/-Infinity are rejected, as the former TypeBox Number check did. */
export function isNumberValue(value: BoundaryValue): value is number {
  return Number.isFinite(value);
}

export function isBooleanValue(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

/**
 * Structural, side-effect-free object test.
 *
 * This deliberately does NOT validate against a schema: a record check enumerates the value's
 * properties, which invokes getters on whatever object it is handed. Applied to live host and
 * session objects that is both wasteful and unsafe — lazy getters ran and stalled code-mode turns.
 */
export function isObjectValue(value: BoundaryValue): value is BoundaryRecord {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

export function isFunctionValue(
  value: BoundaryValue,
): value is (...args: never[]) => BoundaryValue {
  return value instanceof Function;
}

export function isUndefinedValue(value: BoundaryValue): value is undefined {
  return value === undefined;
}

export function isSymbolValue(value: BoundaryValue): value is symbol {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

export function isBigIntValue(value: BoundaryValue): value is bigint {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}
