/**
 * value-guards.ts — primitive runtime guards for decoded JSON and host values.
 *
 * The repository lint rule `anti-slop/no-runtime-typeof` forbids `typeof`, so
 * primitive checks go through compiled pi-schema validators.
 */

import { bool, compile, str } from "@earendil-works/pi-schema";
import { finiteNum } from "@choco-pi/shared/value-guards";

/**
 * A finite number schema; pi-schema `num()` accepts NaN and +/-Infinity, which
 * the previous TypeBox `Number` rejected. The canonical bounded copy lives in
 * `@choco-pi/shared/value-guards`.
 */
export { finiteNum };

export const isString = compile(str()).check;
export const isNonEmptyString = compile(str({ minLength: 1 })).check;
export const isBoolean = compile(bool()).check;
export const isFiniteNumber = compile(finiteNum()).check;
export const isNonNegativeFiniteNumber = compile(finiteNum({ minimum: 0 })).check;

/** Any value read from a process-global slot or host boundary before validation. */
export type HostValue = {} | null | undefined;

/** A non-null, non-array, non-callable object (the shape TypeBox `Object` accepted). */
export function isHostObject<Value extends HostValue>(value: Value): value is Value & {} {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}
