import { num } from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";

/** Any value an event bus or decoded payload may hand to a guard. */
export type BoundaryValue = {} | null | undefined;

/**
 * A finite number. pi-schema `num()` accepts NaN and ±Infinity, which the
 * previous TypeBox `Number` rejected; the bounds keep that rejection for
 * in-process values (JSON.parse output can never contain them anyway).
 */
export function finiteNum(): Schema<number> {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
}
