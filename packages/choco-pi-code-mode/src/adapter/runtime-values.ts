/**
 * JavaScript runtime value universe at the Pi/host boundary (not JSON): it includes undefined,
 * bigint, symbol and functions. Declared explicitly; the former TypeBox cyclic schema produced the
 * same structural type.
 */
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

/** Open string-keyed record; generic so each owner names its own value contract. */
interface KeyedValues<Value> {
  [key: string]: Value;
}

/**
 * Shallow check; every value passes, matching the former `Type.Unsafe<BoundaryValue>({})`. It never
 * walks the value, so live cyclic objects and throwing getters are safe.
 */
export function isBoundaryValue<T>(value: T): value is T & BoundaryValue {
  return Object.is(value, value);
}

export type JsonObject = KeyedValues<BoundaryValue>;

/**
 * Shallow object test: any non-null, non-array, non-function object (class instances, Map, Date and
 * boxed primitives included, as `{ type: "object" }` accepted). It never enumerates properties, so
 * getters on live Pi values are not invoked.
 */
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

// Identity against the wrapper rejects objects (including already-boxed values) and never calls
// user code, so these cannot throw for null-prototype or throwing-toString inputs.
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

/**
 * Return the same primitive category names as JavaScript's `typeof` for boundary values.
 * Old quirk kept: NaN and +/-Infinity were rejected by the TypeBox Number check and so reported
 * "object"; only finite numbers report "number".
 */
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
