import { compile, bool, num, str } from "@earendil-works/pi-schema";

export const isStringValue = compile(str()).check;
export const isNumberValue = compile(
  num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
).check;
export const isBooleanValue = compile(bool()).check;

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
