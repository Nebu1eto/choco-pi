import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface AgentsFileEntry {
	/** Path shown to the model, relative to the session cwd when possible. */
	path: string;
	content: string;
}

/**
 * Per-file and total size caps for injected AGENTS.md content. The reference
 * implementation this package replaces has no equivalent cap (each AGENTS.md
 * is injected at full size, once). Repo AGENTS.md files are normally small,
 * but an uncapped injection is a latent context-blowup risk for large or
 * accidentally-committed files, so this package adds a deliberate cap that
 * the reference does not have.
 */
export const MAX_FILE_CHARS = 12_000;
export const MAX_TOTAL_APPENDIX_CHARS = 40_000;

const TRUNCATION_MARKER = "\n...[truncated by pi-choco-agents-md size cap]";

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Truncate an individual AGENTS.md file's content to the per-file cap. */
export function capFileContent(content: string): string {
	if (content.length <= MAX_FILE_CHARS) return content;
	return `${content.slice(0, MAX_FILE_CHARS)}${TRUNCATION_MARKER}`;
}

/**
 * Enforce the total appendix size cap by dropping the root-most (least
 * specific, earliest in the root-to-leaf chain) files first. The file
 * closest to the touched path is kept longest because it is the most
 * directly relevant guidance for the current tool call.
 */
export function capTotalAppendixSize(files: AgentsFileEntry[]): AgentsFileEntry[] {
	const kept = [...files];
	let total = kept.reduce((sum, file) => sum + file.content.length, 0);
	while (total > MAX_TOTAL_APPENDIX_CHARS && kept.length > 1) {
		const dropped = kept.shift();
		if (!dropped) break;
		total -= dropped.content.length;
	}
	return kept;
}

/**
 * Append a `<subdirectory_agents_context>` block listing the applicable
 * AGENTS.md files to a tool result's content array. Returns `content`
 * unchanged when there is nothing to inject.
 */
export function appendAgentsContext(
	content: (TextContent | ImageContent)[],
	files: AgentsFileEntry[],
): (TextContent | ImageContent)[] {
	if (!files.length) return content;
	const appendix = [
		"<subdirectory_agents_context>",
		"AGENTS.md context relevant to this tool result.",
		...files.map((file) => `<agents_file path="${escapeXml(file.path)}">\n${escapeXml(file.content)}\n</agents_file>`),
		"</subdirectory_agents_context>",
	].join("\n");
	return [...content, { type: "text", text: appendix }];
}
