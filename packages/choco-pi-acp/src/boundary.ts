export type BoundaryValue =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | symbol
  | ((...args: never[]) => BoundaryValue)
  | BoundaryValue[]
  | BoundaryRecord
  | {};

interface KeyedValues<Value> {
  [key: string]: Value;
}

export type BoundaryRecord = KeyedValues<BoundaryValue>;

export function isString(value: BoundaryValue): value is string {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof String;
}

export function isNumber(value: BoundaryValue): value is number {
  return (
    Number.isFinite(value) ||
    Number.isNaN(value) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isFiniteNumber(value: BoundaryValue): value is number {
  return Number.isFinite(value);
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

export function isObjectValue(value: BoundaryValue): value is object {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

export function isBoundaryRecord(value: BoundaryValue): value is BoundaryRecord {
  return isObjectValue(value);
}

export function isBoundaryArray(value: BoundaryValue): value is BoundaryValue[] {
  return Array.isArray(value);
}

export function errorMessage(error: BoundaryValue): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: BoundaryValue): string | undefined {
  if (!isBoundaryRecord(error)) return undefined;
  const code = error.code;
  return isString(code) ? code : undefined;
}

export function parseJsonLine(text: string): BoundaryValue {
  try {
    const value: BoundaryValue = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}
