import { bool, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "@choco-pi/shared/value-guards";

export { finiteNum };

export const isFiniteNumber = compile(finiteNum()).check;

export const isBooleanValue = compile(bool()).check;
