import {
  isBoolean,
  isFunction,
  isString,
  type RuntimeValue,
} from "@choco-pi/shared/runtime-values";
import { finiteNum, isRecord } from "@choco-pi/shared/value-guards";
import { compile, int, str } from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";

export { finiteNum, isBoolean, isFunction, isRecord, isString, type RuntimeValue };

export function nonNegative(): Schema<number> {
  return finiteNum({ minimum: 0 });
}

export function finiteInt(minimum?: number): Schema<number> {
  return int({ minimum: minimum ?? -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}

export function nonEmptyStr(): Schema<string> {
  return str({ minLength: 1 });
}

const nonNegativeIntegerCheck = compile(finiteInt(0)).check;

export function isNonEmptyString<Value>(value: Value): value is Value & string {
  return isString(value) && value.length > 0;
}

export function isNonNegativeInteger<Value>(value: Value): value is Value & number {
  return nonNegativeIntegerCheck(value);
}

export function isOptional<Value, Narrowed extends Value>(
  value: Value | undefined,
  check: (candidate: Value) => candidate is Narrowed,
): value is Narrowed | undefined {
  return value === undefined || check(value);
}

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

export function hasProperty<Value>(value: Value, key: string): boolean {
  return isRecord(value) && key in value;
}

export function hasMethods<Value>(value: Value, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isFunction(readProperty(value, key)));
}
