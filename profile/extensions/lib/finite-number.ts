import { num } from "@earendil-works/pi-schema";

type NumOptions = NonNullable<Parameters<typeof num>[0]>;

/**
 * Finite number schema for in-process values. pi-schema `num()` accepts NaN and +/-Infinity, which
 * the former TypeBox `Number` rejected; with any bound present the check rejects them, so every
 * live value (registry records, entries about to be serialised) goes through this.
 */
export function finiteNum(options: NumOptions = {}) {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, ...options });
}
