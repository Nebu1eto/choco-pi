import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const BoundaryValueSchema = Type.Unknown();
const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();
const BooleanValueSchema = Type.Boolean();
const ObjectValueSchema = Type.Record(Type.String(), BoundaryValueSchema);
const FunctionValueSchema = Type.Function([], BoundaryValueSchema);
const UndefinedValueSchema = Type.Undefined();
const SymbolValueSchema = Type.Symbol();
const BigIntValueSchema = Type.BigInt();

export type BoundaryValue = Static<typeof BoundaryValueSchema>;
export type BoundaryRecord = Static<typeof ObjectValueSchema>;

export function isStringValue(value: BoundaryValue): value is string {
  return Value.Check(StringValueSchema, value);
}

export function isNumberValue(value: BoundaryValue): value is number {
  return Value.Check(NumberValueSchema, value);
}

export function isBooleanValue(value: BoundaryValue): value is boolean {
  return Value.Check(BooleanValueSchema, value);
}

/**
 * Structural, side-effect-free object test.
 *
 * This deliberately does NOT validate against a schema: a `Type.Record` check
 * enumerates the value's properties, which invokes getters on whatever object
 * it is handed. Applied to live host and session objects that is both wasteful
 * and unsafe — lazy getters ran and stalled code-mode turns.
 */
export function isObjectValue(value: BoundaryValue): value is BoundaryRecord {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

export function isFunctionValue(
  value: BoundaryValue,
): value is (...args: never[]) => BoundaryValue {
  return Value.Check(FunctionValueSchema, value);
}

export function isUndefinedValue(value: BoundaryValue): value is undefined {
  return Value.Check(UndefinedValueSchema, value);
}

export function isSymbolValue(value: BoundaryValue): value is symbol {
  return Value.Check(SymbolValueSchema, value);
}

export function isBigIntValue(value: BoundaryValue): value is bigint {
  return Value.Check(BigIntValueSchema, value);
}
