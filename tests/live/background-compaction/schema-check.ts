import { arr, bool, compile, map, num, str, unknown } from "@earendil-works/pi-schema";
import type { Static, Validator } from "@earendil-works/pi-schema";
import type { JsonRecord, RuntimeValue } from "../../../profile/extensions/lib/runtime-values.ts";

const validators = new WeakMap<object, Validator>();

export function matches<S extends object>(schema: S, value: RuntimeValue): value is Static<S> {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = compile(schema);
    validators.set(schema, validator);
  }
  return validator.check(value);
}

export const isString = compile(str()).check;
export const isBoolean = compile(bool()).check;
export const isNumber = compile(
  num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
).check;
export const isArray = compile(arr(unknown())).check;
const recordCheck = compile(map(unknown())).check;
export function isRecord(value: RuntimeValue): value is JsonRecord {
  return recordCheck(value);
}

export function jsonEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  if (isArray(left) || isArray(right)) {
    return (
      isArray(left) &&
      isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return Object.is(left, right) || (left === 0 && right === 0);
}
