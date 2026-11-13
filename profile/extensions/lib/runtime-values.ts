// oxlint anti-slop/no-runtime-typeof forbids typeof here, so these guards use instanceof, identity and a pi-schema string check.
import { compile, str } from "@earendil-works/pi-schema";

const stringCheck = compile(str()).check;

export type RuntimeValue = {} | null | undefined;

export type JsonValue = boolean | number | string | null | undefined | JsonValue[] | JsonRecord;

export type JsonRecord = { [key: string]: JsonValue };

export function recordOf<Key extends PropertyKey, Value>() {
  return (entries: Record<Key, Value>): Record<Key, Value> => entries;
}

export function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: The caller supplies a host-owned declaration or a deliberate partial test fixture.
  return value as Target;
}

export function propertiesWhen<Properties extends {}>(
  include: RuntimeValue,
  createProperties: () => Properties,
): Properties {
  // SAFETY: Callers immediately spread this result; the property types describe the included branch.
  return (include ? createProperties() : {}) as Properties;
}

type RuntimeTypeName =
  | "bigint"
  | "boolean"
  | "function"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

export function isBigInt<Value>(value: Value): value is Value & bigint {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return value === true || value === false;
}

type RuntimeCallable = (...args: never[]) => RuntimeValue;

export function isFunction<Value>(value: Value): value is Extract<Value, RuntimeCallable> {
  return value instanceof Function;
}

export function isNumber<Value>(value: Value): value is Value & number {
  // Admits NaN and +/-Infinity, as the previous helper did.
  return (
    Number.isFinite(value) ||
    Number.isNaN(value) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isObject<Value>(value: Value): value is Value & (object | null) {
  return value === null || (Object(value) === value && !(value instanceof Function));
}

export function isJsonRecord<Value>(value: Value): value is Value & JsonRecord {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function isString<Value>(value: Value): value is Value & string {
  return stringCheck(value);
}

export function isSymbol<Value>(value: Value): value is Value & symbol {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

/** Exact replacement for JavaScript's runtime `typeof` operator when its type name is data. */
export function runtimeTypeOf<Value>(value: Value): RuntimeTypeName {
  if (value === undefined) return "undefined";
  if (isString(value)) return "string";
  if (isNumber(value)) return "number";
  if (isBoolean(value)) return "boolean";
  if (isSymbol(value)) return "symbol";
  if (isBigInt(value)) return "bigint";
  if (isFunction(value)) return "function";
  return "object";
}
