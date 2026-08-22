import { hasRuntimeType, isRecord } from "../parsing.ts";
import { SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES, SOURCE_LOOKUP_MAX_WORKSPACE_FILES } from "./types.ts";

/** A JSON-compatible value before an input-mode parser assigns it a domain type. */
export type InputValue = string | number | boolean | null | undefined | InputValue[] | InputRecord;

/** A JSON object at the structured-input or external-result boundary. */
export interface InputRecord {
	[key: string]: InputValue;
}

export interface ValueValidationResult<Value> {
	error?: string;
	value?: Value;
}

export interface CompilationResult<Compiled> {
	compiled?: Compiled;
	error?: string;
}

export type SelectValuesResult =
	| { error: string }
	| { values: string[] };

export function isInputRecord<Value>(value: Value): value is Value & InputRecord {
	return isRecord(value);
}

export function isString<Value>(value: Value): value is Value & string {
	return hasRuntimeType(value, "string");
}

export function isNumber<Value>(value: Value): value is Value & number {
	return hasRuntimeType(value, "number");
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
	return hasRuntimeType(value, "boolean");
}

export function isNonEmptyString<Value>(value: Value): value is Value & string {
	return isString(value) && value.trim().length > 0;
}

export function isStringArray<Value>(value: Value): value is Value & string[] {
	return Array.isArray(value) && value.every(isString);
}

export function parseStringArray<Value>(value: Value): string[] | undefined {
	return Array.isArray(value) && value.every(isString) ? value : undefined;
}

export function isOneOf<Value, const Values extends readonly string[]>(value: Value, values: Values): value is Value & Values[number] {
	return isString(value) && values.includes(value);
}

export function getSelectValues(input: InputRecord, context: string): SelectValuesResult {
	const rawValue = input.value;
	const rawValues = input.values;
	if (rawValue !== undefined && rawValues !== undefined) {
		return { error: `${context}.value and ${context}.values cannot both be provided for select.` };
	}
	if (rawValues !== undefined) {
		if (!isStringArray(rawValues) || rawValues.length === 0 || rawValues.some((value) => value.trim().length === 0)) {
			return { error: `${context}.values must be a non-empty array of non-empty strings for select.` };
		}
		return { values: rawValues };
	}
	if (isNonEmptyString(rawValue)) {
		return { values: [rawValue] };
	}
	return { error: `${context}.value or ${context}.values is required for select.` };
}

export function getBatchResultItems<Data>(data: Data): InputRecord[] {
	return Array.isArray(data) ? data.filter(isInputRecord) : [];
}

export function getCommandNameFromBatchItem(item: InputRecord): string | undefined {
	const command = item.command;
	return Array.isArray(command) && isString(command[0]) ? command[0] : undefined;
}

export function validateLookupMaxWorkspaceFiles<Value>(value: Value, fieldName: string): ValueValidationResult<number> {
	if (value === undefined) return { value: SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES };
	if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
		return { error: `${fieldName} must be a positive integer when provided.` };
	}
	if (value > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
		return { error: `${fieldName} must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
	}
	return { value };
}
