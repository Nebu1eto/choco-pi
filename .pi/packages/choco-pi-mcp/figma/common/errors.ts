import type { FigmaValue } from "../src/figma-values.ts";

export interface NormalizedApiError {
	name: string;
	message: string;
	status?: number;
	service?: string;
	code?: string;
	details?: FigmaValue;
}

export class ApiError extends Error {
	public readonly status?: number;
	public readonly details?: FigmaValue;
	public readonly service?: string;
	public readonly code?: string;

	constructor(
		message: string,
		status?: number,
		details?: FigmaValue,
		service?: string,
		code?: string,
	) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.details = details;
		this.service = service;
		this.code = code;
	}
}

export function normalizeApiError(cause: unknown, service?: string): NormalizedApiError {
	if (cause instanceof ApiError) {
		return {
			name: cause.name,
			message: cause.message,
			status: cause.status,
			service: cause.service ?? service,
			code: cause.code,
			details: cause.details,
		};
	}

	if (cause instanceof Error) {
		return { name: cause.name, message: cause.message, service };
	}

	return { name: "Error", message: String(cause), service };
}

export function errorMessage(cause: unknown, service?: string): string {
	const normalized = normalizeApiError(cause, service);
	const prefix = normalized.service ? `${normalized.service} API error` : "API error";
	const status = normalized.status ? ` (${normalized.status})` : "";
	return `${prefix}${status}: ${normalized.message}`;
}
