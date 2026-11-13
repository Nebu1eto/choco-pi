// oxlint anti-slop/no-runtime-typeof forbids typeof here, so these guards use identity and a pi-schema string check.
import { compile, str } from "@earendil-works/pi-schema";

/** In-process runtime value universe; deliberately shallow (never deep-walked). */
export type BoundaryValue =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | symbol
  | (() => BoundaryValue)
  | BoundaryValue[]
  | BoundaryRecord
  | {};

/** Record entries exclude the bare `{}` member so the dictionary keeps a concrete value contract. */
export type BoundaryEntry =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | symbol
  | (() => BoundaryValue)
  | BoundaryValue[]
  | BoundaryRecord;

export type BoundaryRecord = { [key: string]: BoundaryEntry };

const stringCheck = compile(str()).check;

export function isString(value: BoundaryValue): value is string {
  return stringCheck(value);
}

export function isNumber(value: BoundaryValue): value is number {
  return (
    Number.isFinite(value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

export function isObjectValue(value: BoundaryValue): value is object {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

export function isBoundaryRecord(value: BoundaryValue): value is BoundaryRecord {
  return isObjectValue(value);
}

export function errorMessage(error: BoundaryValue): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: BoundaryValue): string | undefined {
  if (!isBoundaryRecord(error)) return undefined;
  const code = error.code;
  return isString(code) ? code : undefined;
}
