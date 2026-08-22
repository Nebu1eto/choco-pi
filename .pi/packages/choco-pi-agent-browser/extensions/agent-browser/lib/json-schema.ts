import { hasRuntimeType, type RuntimeRecord, type RuntimeValue } from "./parsing.ts";
import type { TSchema, TSchemaOptions, TUnsafe } from "typebox";

const OPTIONAL_SCHEMA = Symbol("pi-agent-browser-optional-schema");

type SchemaObject = TSchema & { [OPTIONAL_SCHEMA]?: true };
type SchemaProperties = Record<string, TSchema>;

function withOptions(schema: RuntimeRecord<RuntimeValue>, options?: TSchemaOptions): TSchema {
	// SAFETY: callers supply a complete JSON Schema fragment; TSchemaOptions adds only schema keywords.
	return { ...schema, ...options } as TSchema;
}

function literalType<Value>(value: Value): "boolean" | "number" | "string" | undefined {
	if (hasRuntimeType(value, "string")) return "string";
	if (hasRuntimeType(value, "number")) return "number";
	return hasRuntimeType(value, "boolean") ? "boolean" : undefined;
}

function propertySchema(schema: TSchema): TSchema {
	// SAFETY: TypeBox schemas are plain schema records; SchemaObject adds only this module's optional marker.
	const clone = { ...(schema as SchemaObject & RuntimeRecord<RuntimeValue>) };
	delete clone[OPTIONAL_SCHEMA];
	// SAFETY: removing the fork-only optional marker leaves the original TSchema fields unchanged.
	return clone as TSchema;
}

export const JsonSchema = {
	Array(items: TSchema, options?: TSchemaOptions): TSchema {
		return withOptions({ type: "array", items }, options);
	},
	Boolean(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "boolean" }, options);
	},
	Integer(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "integer" }, options);
	},
	Literal(value: RuntimeValue, options?: TSchemaOptions): TSchema {
		const type = literalType(value);
		return withOptions(type ? { type, const: value } : { const: value }, options);
	},
	Number(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "number" }, options);
	},
	Object(properties: SchemaProperties, options?: TSchemaOptions): TSchema {
		// SAFETY: Optional is the sole writer of OPTIONAL_SCHEMA on schemas accepted by this builder.
		const required = globalThis.Object.entries(properties)
			.filter(([, schema]) => (schema as SchemaObject)[OPTIONAL_SCHEMA] !== true)
			.map(([key]) => key);
		const normalizedProperties = globalThis.Object.fromEntries(
			globalThis.Object.entries(properties).map(([key, schema]) => [key, propertySchema(schema)]),
		);
		return required.length > 0
			? withOptions({ type: "object", properties: normalizedProperties, required }, options)
			: withOptions({ type: "object", properties: normalizedProperties }, options);
	},
	Optional(schema: TSchema): TSchema {
		// SAFETY: adding the private optional marker preserves every TSchema field and is removed before emission.
		return { ...(schema as SchemaObject), [OPTIONAL_SCHEMA]: true } as TSchema;
	},
	String(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "string" }, options);
	},
	Union(types: TSchema[], options?: TSchemaOptions): TSchema {
		return withOptions({ anyOf: types }, options);
	},
	Unsafe<Value>(schema: TSchema): TUnsafe<Value> {
		// SAFETY: this mirrors TypeBox Unsafe: the caller owns the Value interpretation of the supplied schema.
		return schema as TUnsafe<Value>;
	},
};

export type JsonSchemaBuilder = typeof JsonSchema;
export type { TSchema, TSchemaOptions, TUnsafe };
