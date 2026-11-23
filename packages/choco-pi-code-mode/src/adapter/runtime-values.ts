export type BoundaryValue =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | symbol
  | ((...args: []) => BoundaryValue)
  | BoundaryValue[]
  | KeyedValues<BoundaryValue>
  | {};

interface KeyedValues<Value> {
  [key: string]: Value;
}

export function isBoundaryValue<T>(value: T): value is T & BoundaryValue {
  return Object.is(value, value);
}

export type JsonObject = KeyedValues<BoundaryValue>;

export function isJsonObject<T>(value: T): value is T & JsonObject {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

type PresentProperties<T extends object> = {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
};

export function conditionalProperties<T extends object>(condition: boolean, properties: T) {
  const result: PresentProperties<T> = {};
  if (condition) Object.assign(result, properties);
  return result;
}

type JsonValueTypeName =
  | "bigint"
  | "boolean"
  | "function"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

function isPrimitiveString(value: BoundaryValue): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof String;
}

function isPrimitiveBigInt(value: BoundaryValue): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

function isPrimitiveSymbol(value: BoundaryValue): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

export function jsonValueType(value: BoundaryValue): JsonValueTypeName {
  if (isPrimitiveString(value)) return "string";
  if (Number.isFinite(value)) return "number";
  if (isPrimitiveBigInt(value)) return "bigint";
  if (value === true || value === false) return "boolean";
  if (isPrimitiveSymbol(value)) return "symbol";
  if (value instanceof Function) return "function";
  if (value === undefined) return "undefined";
  return "object";
}
