import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_QUERY_LENGTH = 500;
const DEFAULT_LIMIT = 5;
const ALWAYS_ACTIVE = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"exec",
	"wait",
	"apply_patch",
	"exec_command",
	"write_stdin",
	"tool_search",
]);

type SearchDocument = {
	tool: ToolInfo;
	nameTokens: string[];
	descriptionTokens: string[];
	schemaTokens: string[];
	sourceTokens: string[];
	allTokens: string[];
};

function normalize(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_./:-]+/g, " ")
		.toLowerCase();
}

function tokenize(value: string): string[] {
	return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function schemaText(value: unknown, key = ""): string {
	if (typeof value === "string") return `${key} ${value}`;
	if (Array.isArray(value)) return value.map((item) => schemaText(item, key)).join(" ");
	if (!value || typeof value !== "object") return key;
	return Object.entries(value as Record<string, unknown>)
		.map(([childKey, child]) => schemaText(child, childKey))
		.join(" ");
}

function termFrequency(tokens: string[], term: string): number {
	return tokens.reduce((count, token) => count + (token === term ? 1 : token.startsWith(term) ? 0.5 : 0), 0);
}

function bm25FieldScore(tokens: string[], terms: string[], documentFrequency: Map<string, number>, documentCount: number, averageLength: number): number {
	if (tokens.length === 0) return 0;
	const k1 = 1.2;
	const b = 0.75;
	return terms.reduce((score, term) => {
		const frequency = termFrequency(tokens, term);
		if (frequency === 0) return score;
		const matchingDocuments = documentFrequency.get(term) ?? 0;
		const inverseFrequency = Math.log(1 + (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5));
		const normalizedFrequency = frequency * (k1 + 1)
			/ (frequency + k1 * (1 - b + b * tokens.length / Math.max(1, averageLength)));
		return score + inverseFrequency * normalizedFrequency;
	}, 0);
}

function buildDocuments(tools: ToolInfo[]): SearchDocument[] {
	return tools.map((tool) => {
		const nameTokens = tokenize(tool.name);
		const descriptionTokens = tokenize(tool.description);
		const schemaTokens = tokenize(schemaText(tool.parameters));
		const sourceTokens = tokenize(`${tool.sourceInfo.source} ${tool.sourceInfo.path}`);
		return {
			tool,
			nameTokens,
			descriptionTokens,
			schemaTokens,
			sourceTokens,
			allTokens: [...nameTokens, ...descriptionTokens, ...schemaTokens, ...sourceTokens],
		};
	});
}

function rankTools(documents: SearchDocument[], query: string): ToolInfo[] {
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return [];
	const documentFrequency = new Map<string, number>();
	for (const term of terms) {
		documentFrequency.set(term, documents.filter((document) => document.allTokens.some((token) => token === term || token.startsWith(term))).length);
	}
	const averageLength = documents.reduce((sum, document) => sum + document.allTokens.length, 0) / Math.max(1, documents.length);
	const normalizedQuery = normalize(query).trim();

	return documents
		.map((document) => {
			const coverage = terms.filter((term) => document.allTokens.some((token) => token === term || token.startsWith(term))).length / terms.length;
			const minimumCoverage = terms.length <= 2 ? 1 : 0.6;
			if (coverage < minimumCoverage) return { tool: document.tool, score: 0 };
			const name = normalize(document.tool.name);
			const score =
				bm25FieldScore(document.nameTokens, terms, documentFrequency, documents.length, averageLength) * 5
				+ bm25FieldScore(document.descriptionTokens, terms, documentFrequency, documents.length, averageLength) * 2
				+ bm25FieldScore(document.schemaTokens, terms, documentFrequency, documents.length, averageLength)
				+ bm25FieldScore(document.sourceTokens, terms, documentFrequency, documents.length, averageLength)
				+ (name === normalizedQuery ? 50 : name.includes(normalizedQuery) ? 20 : 0)
				+ coverage * 10;
			return { tool: document.tool, score };
		})
		.filter((match) => match.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.map((match) => match.tool);
}

function compactDescription(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length > 140 ? `${singleLine.slice(0, 137)}...` : singleLine;
}

export default function toolSearch(pi: ExtensionAPI): void {
	let searchableNames = new Set<string>();
	let searchableDocuments: SearchDocument[] = [];
	let allowedNames = new Set<string>();
	const loadedNames = new Set<string>();
	let initializationScheduled = false;
	let sessionStarted = false;
	let mcpCatalogReady = false;

	const applyLeanSurface = (attempt = 0): void => {
		initializationScheduled = false;
		const allTools = pi.getAllTools();
		const allNames = new Set(allTools.map((tool) => tool.name));
		for (const name of pi.getActiveTools()) allowedNames.add(name);
		searchableNames = new Set([...allNames].filter((name) => allowedNames.has(name) && !ALWAYS_ACTIVE.has(name)));
		searchableDocuments = buildDocuments(allTools.filter((tool) => searchableNames.has(tool.name)));
		const active = pi.getActiveTools();
		const leanSurface = active.filter((name) => ALWAYS_ACTIVE.has(name) || loadedNames.has(name));
		pi.setActiveTools([...new Set([...leanSurface, "tool_search"])]);
		if (!mcpCatalogReady && attempt < 4) {
			initializationScheduled = true;
			setTimeout(() => applyLeanSurface(attempt + 1), 25 * (attempt + 1));
		}
	};

	const scheduleLeanSurface = (): void => {
		if (initializationScheduled) return;
		initializationScheduled = true;
		setImmediate(() => applyLeanSurface());
	};

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description: "Search registered but deferred Pi and MCP tools by capability, then load up to five matching definitions for the next model request.",
		promptSnippet: "Search for deferred tools when the active tools cannot perform the task",
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				maxLength: MAX_QUERY_LENGTH,
				description: "Natural-language capability to find, such as 'search Slack messages' or 'render Figma nodes'",
			}),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: DEFAULT_LIMIT })),
		}),
		async execute(_toolCallId, params) {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Tool search query cannot be empty." }],
					isError: true,
					details: { matches: [], added: [] },
				};
			}

			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const matches = rankTools(searchableDocuments, query).slice(0, params.limit ?? DEFAULT_LIMIT);
			const added = matches.map((tool) => tool.name).filter((name) => !activeSet.has(name));
			if (added.length > 0) {
				for (const name of added) loadedNames.add(name);
				pi.setActiveTools([...new Set([...active, ...added])]);
			}

			const lines = matches.map((tool) => `- ${tool.name}: ${compactDescription(tool.description)}`);
			return {
				content: [{
					type: "text",
					text: matches.length === 0
						? `No deferred tools found for: ${query}`
						: `${added.length > 0 ? "Loaded" : "Already active"} ${matches.length} matching tool(s) for the next request:\n${lines.join("\n")}`,
				}],
				details: { matches: matches.map((tool) => tool.name), added },
			};
		},
	});

	pi.events.on("pi-mcp-adapter/status/v1", () => {
		mcpCatalogReady = true;
		if (sessionStarted) scheduleLeanSurface();
	});
	pi.on("session_start", () => {
		sessionStarted = true;
		mcpCatalogReady = false;
		loadedNames.clear();
		allowedNames = new Set(pi.getActiveTools());
		scheduleLeanSurface();
	});
	pi.on("session_shutdown", () => {
		sessionStarted = false;
	});
	pi.on("model_select", scheduleLeanSurface);
}
