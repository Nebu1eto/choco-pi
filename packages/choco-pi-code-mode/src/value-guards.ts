import { finiteNum, isBoolean, isFiniteNumber, isString } from "@choco-pi/shared/value-guards";
import { compile, int, str } from "@earendil-works/pi-schema";
import type { BoundaryValue } from "./adapter/runtime-values.ts";

export { finiteNum, isBoolean, isFiniteNumber, isString };

export const isNonEmptyString = compile(str({ minLength: 1 })).check;
export const isNonNegativeInteger = compile(int({ minimum: 0, maximum: Number.MAX_VALUE })).check;

export type HostValue = {} | null | undefined;

export function isNumber<Value extends HostValue>(value: Value): value is Value & number {
  return isFiniteNumber(value);
}

export function isRevision<Value extends HostValue>(value: Value): value is Value & number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

type Callable = (...args: never[]) => BoundaryValue;

export function isFunction<Value>(value: Value): value is Value & Callable {
  return value instanceof Function;
}

export function isHostObject<Value extends HostValue>(value: Value): value is Value & {} {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}
