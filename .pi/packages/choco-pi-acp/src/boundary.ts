import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const BoundaryValueReference = Type.Ref("BoundaryValue");
export const BoundaryValueSchema = Type.Cyclic(
  {
    BoundaryValue: Type.Union([
      Type.Undefined(),
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.BigInt(),
      Type.String(),
      Type.Symbol(),
      Type.Function([], BoundaryValueReference),
      Type.Array(BoundaryValueReference),
      Type.Record(Type.String(), BoundaryValueReference),
      Type.Object({}),
    ]),
  },
  "BoundaryValue",
);

/** Any value crossing an I/O boundary before it has been decoded into a domain type. */
export type BoundaryValue = Static<typeof BoundaryValueSchema>;

export const BoundaryRecordSchema = Type.Record(Type.String(), BoundaryValueSchema);

/** An undecoded object crossing an I/O boundary, keyed by arbitrary strings. */
export type BoundaryRecord = Static<typeof BoundaryRecordSchema>;

const StringSchema = Type.String();
const NumberSchema = Type.Number();
const BooleanSchema = Type.Boolean();

export function isString(value: BoundaryValue): value is string {
  return Check(StringSchema, value);
}

export function isNumber(value: BoundaryValue): value is number {
  return (
    Check(NumberSchema, value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isFiniteNumber(value: BoundaryValue): value is number {
  return Check(NumberSchema, value) && Number.isFinite(value);
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return Check(BooleanSchema, value);
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

export function isBoundaryArray(value: BoundaryValue): value is BoundaryValue[] {
  return Array.isArray(value);
}

export function errorMessage(error: BoundaryValue): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: BoundaryValue): string | undefined {
  if (!isBoundaryRecord(error)) return undefined;
  const code = error.code;
  return isString(code) ? code : undefined;
}

/**
 * Decode one NDJSON line into an undecoded boundary value.
 *
 * Returns `undefined` for malformed input. JSON text can never decode to
 * `undefined`, so `undefined` unambiguously reports a decode failure and callers
 * can fail closed without catching.
 */
export function parseJsonLine(text: string): BoundaryValue {
  try {
    const value: BoundaryValue = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}
