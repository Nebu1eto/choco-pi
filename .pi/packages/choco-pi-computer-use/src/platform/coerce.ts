import { isNumber, isString, type JsonField } from "../json.ts";

export function toBoolean(value: JsonField): boolean {
  return value === true || value === "true" || value === 1;
}

export function toFiniteNumber(value: JsonField, fallback: number): number {
  if (isNumber(value) && Number.isFinite(value)) return value;
  if (isString(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toOptionalString(value: JsonField): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}
