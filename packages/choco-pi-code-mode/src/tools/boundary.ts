import type { BoundaryValue as RuntimeBoundaryValue } from "../adapter/runtime-values.ts";

export type BoundaryValue = RuntimeBoundaryValue;

export type BoundaryRecord = KeyedValues<BoundaryValue>;

interface KeyedValues<Value> {
  [key: string]: Value;
}

export function isStringValue(value: BoundaryValue): value is string {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof String;
}

export function isNumberValue(value: BoundaryValue): value is number {
  return Number.isFinite(value);
}

export function isBooleanValue(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

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
