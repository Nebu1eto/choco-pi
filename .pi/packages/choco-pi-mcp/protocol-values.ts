import { Type } from "typebox";
import { Check } from "typebox/value";

const UndefinedValueSchema = Type.Undefined();
const StringValueSchema = Type.String();
const FiniteNumberValueSchema = Type.Number();
const BigIntValueSchema = Type.BigInt();
const BooleanValueSchema = Type.Boolean();
const SymbolValueSchema = Type.Symbol();
const FunctionValueSchema = Type.Function([], Type.Unknown());

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);

export type McpValue = null | boolean | number | string | undefined | McpValue[] | McpObject;

export interface McpObject {
  [key: string]: McpValue;
}

const McpBoundaryValueSchema = Type.Union([
  JsonValueSchema,
  Type.Undefined(),
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown()),
]);
/** Decode a JSON-RPC value while retaining extension members inside arrays and objects. */
export function parseMcpValue<Value>(value: Value): McpValue {
  if (!Check(McpBoundaryValueSchema, value)) {
    throw new TypeError("Expected a JSON-compatible MCP value");
  }
  // SAFETY: McpBoundaryValueSchema accepts every representation in McpValue.
  return value as Value & McpValue;
}

/** Decode a JSON-RPC property bag while retaining extension members. */
export function parseMcpObject<Value>(value: Value): McpObject {
  if (!isObjectValue(value) || Array.isArray(value)) {
    throw new TypeError("Expected an MCP object");
  }
  // SAFETY: The structural checks established a non-array, non-callable object property bag.
  return value as Value & McpObject;
}

export type RuntimeTypeName =
  | "undefined"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "symbol"
  | "function"
  | "object";

type ObjectPart = object | undefined;
type Mutable<Value> = Value extends object
  ? {
      -readonly [Key in keyof Value]: Value[Key] extends ReadonlyArray<infer Item>
        ? Item[]
        : Value[Key];
    }
  : Value;
type DefinedObjectParts<Parts extends readonly ObjectPart[]> = Mutable<
  Exclude<Parts[number], undefined>
>;
type UnionToIntersection<Value> = (Value extends never ? never : (value: Value) => void) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/** Merge object fragments in order while omitting absent fragments. */
export function mergeObjectParts<const Parts extends readonly ObjectPart[]>(
  ...parts: Parts
): UnionToIntersection<DefinedObjectParts<Parts>> {
  const result = {};
  for (const part of parts) {
    if (part !== undefined) Object.assign(result, part);
  }
  // SAFETY: Every defined member of Parts was assigned to the fresh result object in order.
  return result as UnionToIntersection<DefinedObjectParts<Parts>>;
}

export function isUndefinedValue<Value>(value: Value): value is Value & undefined {
  return Check(UndefinedValueSchema, value);
}

export function isStringValue<Value>(value: Value): value is Value & string {
  return Check(StringValueSchema, value);
}

export function isNumberValue<Value>(value: Value): value is Value & number {
  return (
    Check(FiniteNumberValueSchema, value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

export function isBigIntValue<Value>(value: Value): value is Value & bigint {
  return Check(BigIntValueSchema, value);
}

export function isBooleanValue<Value>(value: Value): value is Value & boolean {
  return Check(BooleanValueSchema, value);
}

export function isSymbolValue<Value>(value: Value): value is Value & symbol {
  return Check(SymbolValueSchema, value);
}

export function isFunctionValue<Value>(value: Value): value is Value & CallableFunction {
  return Check(FunctionValueSchema, value);
}

export function isObjectValue<Value>(value: Value): value is Value & object {
  return value !== null && Object(value) === value && !(value instanceof Function);
}

/** Return the ECMAScript runtime type after schema-based primitive discrimination. */
export function runtimeTypeOf<Value>(value: Value): RuntimeTypeName {
  if (isUndefinedValue(value)) return "undefined";
  if (isStringValue(value)) return "string";
  if (isNumberValue(value)) return "number";
  if (isBigIntValue(value)) return "bigint";
  if (isBooleanValue(value)) return "boolean";
  if (isSymbolValue(value)) return "symbol";
  if (isFunctionValue(value)) return "function";
  return "object";
}
