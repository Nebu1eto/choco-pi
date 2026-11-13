// oxlint anti-slop/no-runtime-typeof forbids typeof here, so these guards use instanceof, identity and pi-schema checks.
import { bool, compile, int, num, str } from "@earendil-works/pi-schema";
import type { NumberBounds, Schema } from "@earendil-works/pi-schema";

/** Any value a host event, slot or decoded payload may hand to a guard. */
export type RuntimeValue = {} | null | undefined;

/**
 * A finite number. pi-schema `num()` accepts NaN and +/-Infinity, which the
 * previous TypeBox `Number` rejected; the bounds keep that rejection for
 * in-process values (JSON.parse output can never contain them anyway).
 */
export function finiteNum(bounds: NumberBounds = {}): Schema<number> {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, ...bounds });
}

/** A finite number of at least zero. */
export function nonNegative(): Schema<number> {
  return finiteNum({ minimum: 0 });
}

/** A finite integer of at least `minimum`; the bounds exclude Infinity, as TypeBox `Integer` did. */
export function finiteInt(minimum?: number): Schema<number> {
  return int({ minimum: minimum ?? -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}

/** A non-empty string. */
export function nonEmptyStr(): Schema<string> {
  return str({ minLength: 1 });
}

const stringCheck = compile(str()).check;
const booleanCheck = compile(bool()).check;
const nonNegativeIntegerCheck = compile(finiteInt(0)).check;

export function isString<Value>(value: Value): value is Value & string {
  return stringCheck(value);
}

export function isNonEmptyString<Value>(value: Value): value is Value & string {
  return stringCheck(value) && value.length > 0;
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return booleanCheck(value);
}

/** An integer of at least zero. */
export function isNonNegativeInteger<Value>(value: Value): value is Value & number {
  return nonNegativeIntegerCheck(value);
}

/** An absent (or undefined) value, or one that satisfies `check`: TypeBox `Optional`. */
export function isOptional<Value, Narrowed extends Value>(
  value: Value | undefined,
  check: (candidate: Value) => candidate is Narrowed,
): value is Narrowed | undefined {
  return value === undefined || check(value);
}

export function isFunction<Value>(value: Value): value is Value & Function {
  return value instanceof Function;
}

/** A non-null, non-function, non-array object (TypeBox `Object` semantics, accessors included). */
export function isRecord<Value>(value: Value): value is Value & object {
  return Object(value) === value && !(value instanceof Function) && !Array.isArray(value);
}

/**
 * `value[key]` with the full [[Get]]: own or inherited data property, or an
 * accessor called on `value` (TypeBox read properties the same way, which a
 * pi-schema validator, seeing only enumerable own properties, does not).
 */
export function readProperty(value: RuntimeValue, key: string): RuntimeValue {
  let owner: RuntimeValue = value;
  while (owner !== null && owner !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      return descriptor.get === undefined ? descriptor.value : descriptor.get.call(value);
    }
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

/** A record that has `key` (own or inherited), even with an undefined value. */
export function hasProperty<Value>(value: Value, key: string): boolean {
  return isRecord(value) && key in value;
}

/** A record whose listed properties (own or inherited) are all callable. */
export function hasMethods<Value>(value: Value, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isFunction(readProperty(value, key)));
}
