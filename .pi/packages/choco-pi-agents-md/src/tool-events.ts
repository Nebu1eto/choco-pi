import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface DiscoveryToolResultEvent {
	toolName: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function contentItems(value: unknown): (TextContent | ImageContent)[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item) => {
		const record = objectRecord(item);
		return Boolean(
			record && typeof record["type"] === "string" && (record["text"] === undefined || typeof record["text"] === "string"),
		);
	});
	return items as (TextContent | ImageContent)[];
}

/**
 * Expand a host tool result into the outer event plus completed nested tools
 * recorded by Pi code mode in `details.traces`.
 */
export function codeModeDiscoveryEvents(event: ToolResultEvent): DiscoveryToolResultEvent[] {
	const events: DiscoveryToolResultEvent[] = [event];
	const details = objectRecord(event.details);
	if (details?.["codeMode"] !== true || !Array.isArray(details["traces"])) return events;

	for (const value of details["traces"]) {
		const trace = objectRecord(value);
		if (trace?.["status"] !== "done" || typeof trace["name"] !== "string") continue;
		const input = objectRecord(trace["input"]);
		const result = objectRecord(trace["result"]);
		const content = contentItems(result?.["content"]);
		if (!input || !content) continue;
		events.push({ toolName: trace["name"], input, content });
	}
	return events;
}
