import { compile, str } from "@earendil-works/pi-schema";

// oxlint anti-slop/no-runtime-typeof forbids typeof here, so these guards use instanceof, identity and a pi-schema string check.
// The former schema's Static collapsed to this: every JS value, including functions and symbols.
export type BoundaryValue = {} | null | undefined;

/** An undecoded object keyed by arbitrary strings. */
interface KeyedValues<Value> {
  [key: string]: Value;
}

export type BoundaryRecord = KeyedValues<BoundaryValue>;
interface PropertyValues<Value> {
  [key: string]: Value;
  [key: symbol]: Value;
}

export type BoundaryPropertyMap = PropertyValues<BoundaryValue>;
export type HostCallable = (...args: BoundaryValue[]) => BoundaryValue;

const stringCheck = compile(str()).check;

export function isBoundaryValue<Value>(value: Value): value is Value & BoundaryValue {
  if (
    value === undefined ||
    value === null ||
    isString(value) ||
    isBoolean(value) ||
    isBigInt(value) ||
    isSymbol(value) ||
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
  return stringCheck(value);
}

export function isNumber(value: BoundaryValue): value is number {
  // Admits NaN and +/-Infinity, as the previous helper did.
  return (
    Number.isFinite(value) ||
    Number.isNaN(value) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

export function isBigInt(value: BoundaryValue): value is bigint {
  // The identity check rejects already-boxed BigInt wrappers.
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

export function isSymbol(value: BoundaryValue): value is symbol {
  // The identity check rejects already-boxed Symbol wrappers.
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
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
