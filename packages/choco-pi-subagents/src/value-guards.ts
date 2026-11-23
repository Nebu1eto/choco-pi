import { bool, compile, str } from "@earendil-works/pi-schema";
import { finiteNum } from "@choco-pi/shared/value-guards";

export { finiteNum };

export const isString = compile(str()).check;
export const isNonEmptyString = compile(str({ minLength: 1 })).check;
export const isBoolean = compile(bool()).check;
export const isFiniteNumber = compile(finiteNum()).check;
export const isNonNegativeFiniteNumber = compile(finiteNum({ minimum: 0 })).check;

export type HostValue = {} | null | undefined;

export function isHostObject<Value extends HostValue>(value: Value): value is Value & {} {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}
