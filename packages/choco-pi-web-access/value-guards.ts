import { compile, bool, num, str } from "@earendil-works/pi-schema";

// anti-slop/no-runtime-typeof forbids typeof, so primitive guards use compiled pi-schema checks.
export const isStringValue = compile(str()).check;
// pi-schema num() admits NaN and ±Infinity; the former TypeBox Number check rejected them.
export const isNumberValue = compile(
  num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
).check;
export const isBooleanValue = compile(bool()).check;

/** True when `cause` is an abort/cancellation error (`Error` or `DOMException` named `AbortError`). */
export function isAbortError<Failure>(cause: Failure): boolean {
  if (
    (cause instanceof Error && cause.name === "AbortError") ||
    (cause instanceof DOMException && cause.name === "AbortError")
  ) {
    return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.toLowerCase().includes("abort");
}
