import { bool, compile, str } from "@earendil-works/pi-schema";
import type { BoundaryValue } from "../adapter/runtime-values.ts";

// Runtime guards for values that come from provider payloads and live host objects. They replace
// the former TypeBox primitive schemas: compiled once at module scope, they never throw.
const stringValidator = compile(str());
const booleanValidator = compile(bool());

type Callable = (...args: never[]) => BoundaryValue;

export function isString<Value>(value: Value): value is Value & string {
  return stringValidator.check(value);
}

/** Finite number only: the TypeBox number check this replaces rejected NaN and +/-Infinity. */
export function isNumber<Value>(value: Value): value is Value & number {
  return Number.isFinite(value);
}

/** Integer >= 0; the TypeBox integer check this replaces also rejected NaN and +/-Infinity. */
export function isRevision<Value>(value: Value): value is Value & number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return booleanValidator.check(value);
}

/** Callable check; the TypeBox function schema ignored parameter and return types the same way. */
export function isFunction<Value>(value: Value): value is Value & Callable {
  return value instanceof Function;
}
