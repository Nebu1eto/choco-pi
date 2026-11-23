import { num } from "@earendil-works/pi-schema";
import {
  isBoolean,
  isJsonRecord,
  isString,
  type JsonRecord,
  type RuntimeValue,
} from "./runtime-values.ts";

type NumOptions = NonNullable<Parameters<typeof num>[0]>;

export function finiteNum(options: NumOptions = {}) {
  return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, ...options });
}

export function isFiniteNumber(value: RuntimeValue): value is number {
  return Number.isFinite(value);
}

export function isRecord(value: RuntimeValue): value is JsonRecord {
  return isJsonRecord(value);
}

export function isStringArray(value: RuntimeValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

export function stringValue(value: RuntimeValue): string | undefined {
  return isString(value) ? value : undefined;
}

export function errorMessage(error: RuntimeValue): string {
  if (error instanceof Error) return error.message;
  if (isString(error)) return error;
  return String(error);
}

export function errorCode(error: RuntimeValue): string | undefined {
  if (!isRecord(error)) return undefined;
  return isString(error.code) ? error.code : undefined;
}

export { isBoolean, isString };
