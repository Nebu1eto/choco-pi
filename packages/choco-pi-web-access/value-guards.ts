import { compile, bool, num, str } from "@earendil-works/pi-schema";

// anti-slop/no-runtime-typeof forbids typeof, so primitive guards use compiled pi-schema checks.
export const isStringValue = compile(str()).check;
// pi-schema num() admits NaN and ±Infinity; the former TypeBox Number check rejected them.
export const isNumberValue = compile(
  num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
).check;
export const isBooleanValue = compile(bool()).check;
