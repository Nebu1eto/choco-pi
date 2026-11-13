// The repository lint rule anti-slop/no-runtime-typeof forbids typeof, so primitive guards are
// compiled pi-schema validators.
import { compile, num, str } from "@earendil-works/pi-schema";

/**
 * A finite number. pi-schema `num()` accepts NaN and +/-Infinity; the previous TypeBox `Number`
 * rejected them, so the bounds keep that rejection for in-process values.
 */
export const finiteNumber = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });

export const isString = compile(str()).check;

export const isFiniteNumber = compile(finiteNumber).check;
