import { bool, compile, num, str } from "@earendil-works/pi-schema";

const isStringPrimitive = compile(str()).check;
const isBooleanPrimitive = compile(bool()).check;
// pi-schema number accepts NaN/infinities; the bounds restore finite-only, and isNumberValue re-admits them explicitly.
const isFiniteNumber = compile(
  num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
).check;

function isFunctionValue<Value>(value: Value): boolean {
  return value instanceof Function;
}

function isBigIntValue<Value>(value: Value): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

function isSymbolValue<Value>(value: Value): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

/** Finite numbers plus NaN and the infinities, like the `typeof` operator; boxed numbers are rejected. */
function isNumberValue<Value>(value: Value): boolean {
  return (
    isFiniteNumber(value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export type RuntimeValue = object | string | number | boolean | bigint | symbol | null | undefined;

export interface RuntimeRecord<Value> {
  [key: string]: Value;
}

interface RuntimeTypeMap {
  bigint: bigint;
  boolean: boolean;
  function: Function;
  number: number;
  object: object | null;
  string: string;
  symbol: symbol;
  undefined: undefined;
}

/** Preserve JavaScript's exact `typeof` semantics while exposing the narrowing as a type predicate. */
export function hasRuntimeType<Value, Kind extends keyof RuntimeTypeMap>(
  value: Value,
  kind: Kind,
): value is Value & RuntimeTypeMap[Kind] {
  switch (kind) {
    case "bigint":
      return isBigIntValue(value);
    case "boolean":
      return isBooleanPrimitive(value);
    case "function":
      return isFunctionValue(value);
    case "number":
      return isNumberValue(value);
    case "object":
      return value === null || (Object(value) === value && !isFunctionValue(value));
    case "string":
      return isStringPrimitive(value);
    case "symbol":
      return isSymbolValue(value);
    case "undefined":
      return value === undefined;
  }
}

export function isRecord<Value>(value: Value): value is Value & RuntimeRecord<RuntimeValue> {
  return hasRuntimeType(value, "object") && value !== null;
}

export function isString<Value>(value: Value): value is Value & string {
  return hasRuntimeType(value, "string");
}

export function parsePositiveInteger(rawValue: string | undefined): number | undefined {
  if (!hasRuntimeType(rawValue, "string")) return undefined;
  const normalizedValue = rawValue.trim();
  if (!/^\d+$/.test(normalizedValue)) return undefined;
  const parsedValue = Number(normalizedValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) return undefined;
  return parsedValue;
}
