import { Type } from "typebox";
import { Check } from "typebox/value";

const UndefinedSchema = Type.Undefined();
const StringSchema = Type.String();
const NumberSchema = Type.Number();
const NullSchema = Type.Null();

export type RuntimeValue = string | number | boolean | bigint | symbol | object | null | undefined;

export interface ProtocolDictionary {
  [key: string]: ProtocolValue | undefined;
}

export type ProtocolValue = string | number | boolean | null | ProtocolDictionary | ProtocolValue[];

export interface RuntimeFunction {
  (...args: RuntimeValue[]): RuntimeValue | void;
}

export function isRuntimeUndefined<T>(value: T): value is T & undefined {
  return Check(UndefinedSchema, value);
}

export function isRuntimeString<T>(value: T): value is T & string {
  return Check(StringSchema, value);
}

export function isRuntimeNumber<T>(value: T): value is T & number {
  return (
    Check(NumberSchema, value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isRuntimeFunction<T>(value: T): value is T & RuntimeFunction {
  return value instanceof Function;
}

export function isRuntimeObject<T>(value: T): value is T & (object | null) {
  return Check(NullSchema, value) || (Object(value) === value && !(value instanceof Function));
}
