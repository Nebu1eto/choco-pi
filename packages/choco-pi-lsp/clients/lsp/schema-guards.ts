import { bool, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "@choco-pi/shared/value-guards";

export { finiteNum };

/** Type guard for a finite JSON number (rejects NaN and the infinities, like TypeBox `Type.Number()`). */
export const isFiniteNumber = compile(finiteNum()).check;

/** Type guard for a boolean. */
export const isBooleanValue = compile(bool()).check;
