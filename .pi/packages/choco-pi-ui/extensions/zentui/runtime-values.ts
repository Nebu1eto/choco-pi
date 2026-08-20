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
export type BoundaryValue = Static<typeof BoundaryValueSchema>;

export const BoundaryRecordSchema = Type.Record(Type.String(), BoundaryValueSchema);
export type BoundaryRecord = Static<typeof BoundaryRecordSchema>;
export type BoundaryPropertyMap = Record<PropertyKey, BoundaryValue>;

export type HostCallable = (...args: BoundaryValue[]) => BoundaryValue;

const StringSchema = Type.String();
const NumberSchema = Type.Number();
const BooleanSchema = Type.Boolean();
const BigIntSchema = Type.BigInt();
const SymbolSchema = Type.Symbol();

export function isBoundaryValue<Value>(value: Value): value is Value & BoundaryValue {
  if (
    value === undefined ||
    value === null ||
    Check(StringSchema, value) ||
    Check(BooleanSchema, value) ||
    Check(BigIntSchema, value) ||
    Check(SymbolSchema, value) ||
    isNumber(value)
  ) {
    return true;
  }
  return Array.isArray(value) || value instanceof Function || Object(value) === value;
}

export function parseBoundaryValue<Value>(value: Value): BoundaryValue {
  return isBoundaryValue(value) ? value : String(value);
}

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

export function isBoolean(value: BoundaryValue): value is boolean {
  return Check(BooleanSchema, value);
}

export function isBigInt(value: BoundaryValue): value is bigint {
  return Check(BigIntSchema, value);
}

export function isSymbol(value: BoundaryValue): value is symbol {
  return Check(SymbolSchema, value);
}

export function isCallable(value: BoundaryValue): value is HostCallable {
  return value instanceof Function;
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

export function invokeWithReceiver<Receiver, Args extends BoundaryValue[], Result>(
  method: (this: Receiver, ...args: Args) => Result,
  receiver: Receiver,
  args: Args,
): Result {
  return method.apply(receiver, args);
}
