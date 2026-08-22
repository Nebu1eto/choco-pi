export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}
export type JsonField = JsonValue | undefined;

export function isJsonObject(value: JsonField): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function isString(value: JsonField): value is string {
	return value !== null && value !== undefined && Object(value) !== value && value.constructor === String;
}

export function isNumber(value: JsonField): value is number {
	return value !== null && value !== undefined && Object(value) !== value && value.constructor === Number;
}
