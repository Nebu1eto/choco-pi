import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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
const ShallowBoundaryValueSchema = Type.Unsafe<BoundaryValue>({});

export function isBoundaryValue<T>(value: T): value is T & BoundaryValue {
  return Value.Check(ShallowBoundaryValueSchema, value);
}

export interface JsonObject {
  [key: string]: BoundaryValue;
}

/** Shallow object validation avoids enumerating live Pi values or invoking their getters. */
export const JsonObjectSchema = Type.Unsafe<JsonObject>({ type: "object" });

type PresentProperties<T extends object> = {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
};

export function conditionalProperties<T extends object>(condition: boolean, properties: T) {
  const result: PresentProperties<T> = {};
  if (condition) Object.assign(result, properties);
  return result;
}

/** Return the same primitive category names as JavaScript's `typeof` for boundary values. */
export function jsonValueType(
  value: BoundaryValue,
): "bigint" | "boolean" | "function" | "number" | "object" | "string" | "symbol" | "undefined" {
  if (Value.Check(Type.String(), value)) return "string";
  if (Value.Check(Type.Number(), value)) return "number";
  if (Value.Check(Type.BigInt(), value)) return "bigint";
  if (Value.Check(Type.Boolean(), value)) return "boolean";
  if (Value.Check(Type.Symbol(), value)) return "symbol";
  if (Value.Check(Type.Function([], Type.Unknown()), value)) return "function";
  if (Value.Check(Type.Undefined(), value)) return "undefined";
  return "object";
}
