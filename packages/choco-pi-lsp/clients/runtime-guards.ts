import { compile, num, str, unknown, type Static } from "@earendil-works/pi-schema";

const stringCheck = compile(str()).check;

const boundarySchema = unknown();
export type LspBoundaryValue = Static<typeof boundarySchema>;
export type LspDictionaryValue = Static<typeof boundarySchema>;

export function isString<T>(value: T): value is T & string {
  return stringCheck(value);
}

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

export function isObjectRecord<T>(value: T): value is T & Record<string, LspBoundaryValue> {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

export function finite() {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}

export function hasErrorCode<T>(value: T): value is T & { code?: string } {
  return isObjectRecord(value) && (value.code === undefined || isString(value.code));
}

export function isStringArray<T>(value: T): value is T & string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}
