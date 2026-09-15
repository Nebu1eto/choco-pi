import {
  JsonSchema,
  type TSchemaOptions,
  type TUnsafe,
  withoutSchemaDescription,
} from "./json-schema.ts";

export type StringEnumBuilder = typeof StringEnum;

export function StringEnum<const Values extends readonly string[]>(
  values: Values,
  options?: TSchemaOptions,
): TUnsafe<Values[number]> {
  return JsonSchema.Unsafe<Values[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export function CompactStringEnum<const Values extends readonly string[]>(
  values: Values,
  options?: TSchemaOptions,
): TUnsafe<Values[number]> {
  return StringEnum(values, withoutSchemaDescription(options));
}
