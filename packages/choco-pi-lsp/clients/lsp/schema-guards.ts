import { bool, compile, num } from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";

/**
 * A JSON number that is finite. pi-schema `num()` accepts NaN and the infinities (TypeBox rejected them), and
 * `JSON.parse` yields `Infinity` for overflowing literals such as `1e999`, so parsed external output is bounded the
 * same way the previous validators behaved.
 */
export function finiteNum(): Schema<number> {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}

/** Type guard for a finite JSON number (rejects NaN and the infinities, like TypeBox `Type.Number()`). */
export const isFiniteNumber = compile(finiteNum()).check;

/** Type guard for a boolean. */
export const isBooleanValue = compile(bool()).check;
