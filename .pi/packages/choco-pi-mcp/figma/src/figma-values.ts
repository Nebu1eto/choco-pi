export type FigmaScalar = string | number | boolean | null | undefined;
export type FigmaValue = FigmaScalar | FigmaValue[] | FigmaRecord;

/** Recursive object shape used by Figma REST payloads and derived tool output. */
export interface FigmaRecord {
	[key: string]: FigmaValue;
}

export function parseFigmaJson(text: string): FigmaValue {
	// JSON.parse can only produce JSON scalars, arrays, and string-keyed objects.
	return JSON.parse(text);
}

export function isFigmaRecord(value: FigmaValue): value is FigmaRecord {
	return Object.prototype.toString.call(value) === "[object Object]";
}

export function asFigmaRecord(value: FigmaValue): FigmaRecord {
	return isFigmaRecord(value) ? value : {};
}

export function isStringValue(value: FigmaValue): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

export function isFiniteNumberValue(value: FigmaValue): value is number {
	return Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(Number(value));
}

export function isObjectValue(value: FigmaValue): value is FigmaRecord | FigmaValue[] {
	return Array.isArray(value) || isFigmaRecord(value);
}

/** JSON objects and arrays both support the property reads used by legacy auth traversal. */
export function isPropertyContainer(value: FigmaValue): value is FigmaRecord {
	return value !== null && Object(value) === value;
}
