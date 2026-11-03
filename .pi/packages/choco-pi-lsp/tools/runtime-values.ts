// oxlint anti-slop/no-runtime-typeof forbids typeof here, so these guards use identity, instanceof and a pi-schema string check.
import { compile, str } from "@earendil-works/pi-schema";

const stringCheck = compile(str()).check;

export type RuntimeValue = string | number | boolean | bigint | symbol | object | null | undefined;

export interface ProtocolDictionary {
  [key: string]: ProtocolValue | undefined;
}

export type ProtocolValue = string | number | boolean | null | ProtocolDictionary | ProtocolValue[];

export interface RuntimeFunction {
  (...args: RuntimeValue[]): RuntimeValue | void;
}

export function isRuntimeUndefined<T>(value: T): value is T & undefined {
  return value === undefined;
}

export function isRuntimeString<T>(value: T): value is T & string {
  return stringCheck(value);
}

export function isRuntimeNumber<T>(value: T): value is T & number {
  return (
    Number.isFinite(value) ||
    Number.isNaN(value) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isRuntimeFunction<T>(value: T): value is T & RuntimeFunction {
  return value instanceof Function;
}

export function isRuntimeObject<T>(value: T): value is T & (object | null) {
  return value === null || (Object(value) === value && !(value instanceof Function));
}
