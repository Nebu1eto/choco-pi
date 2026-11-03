/**
 * value-guards.ts — primitive runtime guards for decoded JSON and host values.
 *
 * The repository lint rule `anti-slop/no-runtime-typeof` forbids `typeof`, so
 * primitive checks go through compiled pi-schema validators.
 */

import { bool, compile, num, str } from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";

/**
 * A finite number. pi-schema `num()` accepts NaN and +/-Infinity, which the
 * previous TypeBox `Number` rejected; the bounds keep that rejection for
 * in-process values (JSON.parse output can never contain them anyway).
 */
export function finiteNum(options?: { minimum?: number }): Schema<number> {
  return num({
    minimum: Math.max(options?.minimum ?? -Number.MAX_VALUE, -Number.MAX_VALUE),
    maximum: Number.MAX_VALUE,
  });
}

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
