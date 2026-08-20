import * as path from "node:path";

export interface DispatchableToolResult {
	toolName: "edit" | "write";
	input: { path: string } & Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function contentItems(
	value: unknown,
): Array<{ type: string; text?: string }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item) => {
		const record = objectRecord(item);
		return Boolean(
			record &&
				typeof record["type"] === "string" &&
				(record["text"] === undefined || typeof record["text"] === "string"),
		);
	});
	return items as Array<{ type: string; text?: string }>;
}

function absolutePath(filePath: string, cwd: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/**
 * Expand completed mutation tools recorded by Pi code mode inside an outer
 * `exec` result. Synthetic paths are absolute because nested traces do not have
 * their own host `tool_call` event from which path attribution can be recorded.
 */
export function codeModeMutationToolResults(
	event: { details?: unknown },
	cwd: string,
): DispatchableToolResult[] {
	const details = objectRecord(event.details);
	if (details?.["codeMode"] !== true || !Array.isArray(details["traces"])) {
		return [];
	}

	const events: DispatchableToolResult[] = [];
	for (const value of details["traces"]) {
		const trace = objectRecord(value);
		if (trace?.["status"] !== "done" || typeof trace["name"] !== "string") {
			continue;
		}
		const result = objectRecord(trace["result"]);
		const content = contentItems(result?.["content"]);
		if (!result || !content) continue;

		if (trace["name"] === "edit" || trace["name"] === "write") {
			const input = objectRecord(trace["input"]);
			if (!input || typeof input["path"] !== "string") continue;
			events.push({
				toolName: trace["name"],
				input: { ...input, path: absolutePath(input["path"], cwd) },
				content,
				details: result["details"],
				isError: result["isError"] === true,
			});
			continue;
		}

		if (trace["name"] !== "apply_patch") continue;
		const patchDetails = objectRecord(result["details"]);
		if (patchDetails?.["status"] !== "success") continue;
		const patchResult = objectRecord(patchDetails["result"]);
		if (!patchResult) continue;
		const created = new Set(
			Array.isArray(patchResult["createdFiles"])
				? patchResult["createdFiles"].filter(
						(filePath): filePath is string => typeof filePath === "string",
					)
				: [],
		);
		const changed = Array.isArray(patchResult["changedFiles"])
			? patchResult["changedFiles"].filter(
					(filePath): filePath is string => typeof filePath === "string",
				)
			: [];
		for (const filePath of new Set([...changed, ...created])) {
			events.push({
				toolName: created.has(filePath) ? "write" : "edit",
				input: { path: absolutePath(filePath, cwd) },
				content,
				details: patchDetails,
			});
		}
	}
	return events;
}
