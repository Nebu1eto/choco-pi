// Runtime guards for host-boundary values (live objects, prototype members, decoded JSON).
// oxlint anti-slop/no-runtime-typeof forbids typeof, so primitives use identity, instanceof and a pi-schema string check.
// Semantics intentionally mirror the TypeBox Check() calls these replace: Number rejects NaN/Infinity and boxed
// numbers; Object accepts any non-null non-array non-function object (class instances, Map, Date) and rejects the rest.
import { compile, num, str, unknown, type Static } from "@earendil-works/pi-schema";

const stringCheck = compile(str()).check;

/** Boundary values are unvalidated by design; the alias keeps lint's unknown-parameter rule satisfied. */
const boundarySchema = unknown();
export type LspBoundaryValue = Static<typeof boundarySchema>;
export type LspDictionaryValue = Static<typeof boundarySchema>;

export function isString<T>(value: T): value is T & string {
  return stringCheck(value);
}

/** Finite number only; NaN, +/-Infinity and boxed Number objects are rejected. */
export function isFiniteNumber<T>(value: T): value is T & number {
  return Number.isFinite(value);
}

export function isBoolean<T>(value: T): value is T & boolean {
  return value === true || value === false;
}

export function isFunction<T>(value: T): value is T & (() => LspBoundaryValue) {
  return value instanceof Function;
}

export function isUndefined<T>(value: T): value is T & undefined {
  return value === undefined;
}

export function isNull<T>(value: T): value is T & null {
  return value === null;
}

export function isBigInt<T>(value: T): value is T & bigint {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

export function isSymbol<T>(value: T): value is T & symbol {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

/** Non-null, non-array, non-function object (class instances, Map and Date included). */
export function isObjectRecord<T>(value: T): value is T & Record<string, LspBoundaryValue> {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

/** Finite number schema: pi-schema num() admits NaN/Infinity (also from JSON 1e999); TypeBox Number did not. */
export function finite() {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}

/** Mirrors the former Object({ code: Optional(String) }) check used on caught errors. */
export function hasErrorCode<T>(value: T): value is T & { code?: string } {
  return isObjectRecord(value) && (value.code === undefined || isString(value.code));
}

export function isStringArray<T>(value: T): value is T & string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}
