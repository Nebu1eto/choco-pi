import { Type } from "typebox";
import { Check } from "typebox/value";

const BigIntValueSchema = Type.BigInt();
const BooleanValueSchema = Type.Boolean();
const FunctionValueSchema = Type.Function([], Type.Unknown());
const NumberValueSchema = Type.Number();
const StringValueSchema = Type.String();
const SymbolValueSchema = Type.Symbol();

export type RuntimeValue = object | string | number | boolean | bigint | symbol | null | undefined;

export interface RuntimeRecord<Value> {
	[key: string]: Value;
}

interface RuntimeTypeMap {
	bigint: bigint;
	boolean: boolean;
	function: Function;
	number: number;
	object: object | null;
	string: string;
	symbol: symbol;
	undefined: undefined;
}

/** Preserve JavaScript's exact `typeof` semantics while exposing the narrowing as a type predicate. */
export function hasRuntimeType<Value, Kind extends keyof RuntimeTypeMap>(
	value: Value,
	kind: Kind,
): value is Value & RuntimeTypeMap[Kind] {
	switch (kind) {
		case "bigint": return Check(BigIntValueSchema, value);
		case "boolean": return Check(BooleanValueSchema, value);
		case "function": return Check(FunctionValueSchema, value);
		case "number": return Check(NumberValueSchema, value)
			|| Object.is(value, Number.NaN)
			|| Object.is(value, Number.POSITIVE_INFINITY)
			|| Object.is(value, Number.NEGATIVE_INFINITY);
		case "object": return value === null
			|| (Object(value) === value && !Check(FunctionValueSchema, value));
		case "string": return Check(StringValueSchema, value);
		case "symbol": return Check(SymbolValueSchema, value);
		case "undefined": return value === undefined;
	}
}

export function isRecord<Value>(value: Value): value is Value & RuntimeRecord<RuntimeValue> {
	return hasRuntimeType(value, "object") && value !== null;
}

export function isString<Value>(value: Value): value is Value & string {
	return hasRuntimeType(value, "string");
}

export function parsePositiveInteger(rawValue: string | undefined): number | undefined {
	if (!hasRuntimeType(rawValue, "string")) return undefined;
	const normalizedValue = rawValue.trim();
	if (!/^\d+$/.test(normalizedValue)) return undefined;
	const parsedValue = Number(normalizedValue);
	if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) return undefined;
	return parsedValue;
}
