import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	formatSkillsForPrompt,
	sessionEntryToContextMessages,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";

const BAR_WIDTH = 40;
const DEFAULT_RESERVE_TOKENS = 16_384;

type Category = {
	label: string;
	tokens: number;
	marker: string;
};

type McpCatalog = {
	total: number;
	servers: Array<{ name: string; count: number }>;
};

function estimate(value: unknown): number {
	return Math.ceil((typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0) / 4);
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${Math.round(tokens)}`;
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

function percent(tokens: number, window: number): string {
	return `${(tokens / Math.max(1, window) * 100).toFixed(1)}%`;
}

function reserveTokens(cwd: string): number {
	try {
		const settings = JSON.parse(readFileSync(path.join(cwd, ".pi/settings.json"), "utf8")) as {
			compaction?: { reserveTokens?: unknown };
		};
		const configured = settings.compaction?.reserveTokens;
		return typeof configured === "number" && configured >= 0 ? configured : DEFAULT_RESERVE_TOKENS;
	} catch {
		return DEFAULT_RESERVE_TOKENS;
	}
}

function toolTokens(tool: ToolInfo): number {
	return estimate({ name: tool.name, description: tool.description, input_schema: tool.parameters });
}

function isMcpTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source.includes("pi-mcp-adapter");
}

function isAgentTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source.includes("pi-subagents");
}

function mcpCatalog(cwd: string): McpCatalog {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
		const configPaths = [path.join(cwd, ".pi", "mcp.json"), path.join(agentDir, "mcp.json")];
		const configPath = configPaths.find((candidate) => {
			try {
				readFileSync(candidate);
				return true;
			} catch {
				return false;
			}
		});
		if (!configPath) return { total: 0, servers: [] };
		const projectConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers?: Record<string, { disabled?: boolean }>;
		};
		const enabledServers = new Set(Object.entries(projectConfig.mcpServers ?? {})
			.filter(([, definition]) => definition.disabled !== true)
			.map(([name]) => name));
		const cache = JSON.parse(readFileSync(path.join(agentDir, "mcp-cache.json"), "utf8")) as {
			version?: number;
			servers?: Record<string, { tools?: unknown[]; resources?: unknown[] }>;
		};
		if (cache.version !== 1 || !cache.servers) return { total: 0, servers: [] };
		const servers = Object.entries(cache.servers)
			.filter(([name]) => enabledServers.has(name))
			.map(([name, entry]) => ({ name, count: (entry.tools?.length ?? 0) + (entry.resources?.length ?? 0) }))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { total: servers.reduce((sum, server) => sum + server.count, 0), servers };
	} catch {
		return { total: 0, servers: [] };
	}
}

function messageTokens(ctx: ExtensionCommandContext): number {
	const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	return estimate(messages);
}

function categoryData(ctx: ExtensionCommandContext, options: BuildSystemPromptOptions, tools: ToolInfo[], activeNames: Set<string>, total: number, messagesEstimate: number): Category[] {
	const activeTools = tools.filter((tool) => activeNames.has(tool.name));
	const mcp = activeTools.filter(isMcpTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
	const agents = activeTools.filter(isAgentTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
	const systemTools = activeTools
		.filter((tool) => !isMcpTool(tool) && !isAgentTool(tool))
		.reduce((sum, tool) => sum + toolTokens(tool), 0);
	const skills = estimate(formatSkillsForPrompt(options.skills ?? []));
	const contextFiles = (options.contextFiles ?? []).reduce((sum, file) => sum + estimate(file.content), 0);
	const prompt = Math.max(0, estimate(ctx.getSystemPrompt()) - skills - contextFiles);
	const known = prompt + systemTools + mcp + agents + contextFiles + skills;
	const messages = Math.max(messagesEstimate, total - known, 0);
	return [
		{ label: "System prompt", tokens: prompt, marker: "S" },
		{ label: "System tools", tokens: systemTools, marker: "T" },
		{ label: "MCP tools", tokens: mcp, marker: "M" },
		{ label: "Custom agents", tokens: agents, marker: "A" },
		{ label: "Context files", tokens: contextFiles, marker: "C" },
		{ label: "Skills", tokens: skills, marker: "K" },
		{ label: "Messages", tokens: messages, marker: "G" },
	];
}

function usageBar(categories: Category[], free: number, reserve: number, window: number): string {
	const segments = [...categories, { label: "Free", tokens: free, marker: "·" }, { label: "Buffer", tokens: reserve, marker: "B" }];
	let used = 0;
	return segments.map((category, index) => {
		const end = index === segments.length - 1
			? BAR_WIDTH
			: Math.min(BAR_WIDTH, Math.round((used + category.tokens) / Math.max(1, window) * BAR_WIDTH));
		const width = Math.max(0, end - Math.round(used / Math.max(1, window) * BAR_WIDTH));
		used += category.tokens;
		return category.marker.repeat(width);
	}).join("").slice(0, BAR_WIDTH).padEnd(BAR_WIDTH, "·");
}

function sourceLabel(tool: ToolInfo): string {
	return tool.sourceInfo.source === "builtin" ? "Pi" : tool.sourceInfo.source.replace(/^npm:/, "");
}

function renderContext(pi: ExtensionAPI, ctx: ExtensionCommandContext, expanded: boolean): string {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const options = ctx.getSystemPromptOptions();
	const tools = pi.getAllTools();
	const activeNames = new Set(pi.getActiveTools());
	const messagesEstimate = messageTokens(ctx);
	const initialEstimate = estimate(ctx.getSystemPrompt())
		+ tools.filter((tool) => activeNames.has(tool.name)).reduce((sum, tool) => sum + toolTokens(tool), 0)
		+ messagesEstimate;
	const total = usage?.tokens && usage.tokens > 0 ? usage.tokens : initialEstimate;
	const reserve = Math.min(reserveTokens(ctx.cwd), window);
	const categories = categoryData(ctx, options, tools, activeNames, total, messagesEstimate);
	const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0);
	const free = Math.max(0, window - categoryTotal - reserve);
	const activeMcp = tools.filter((tool) => activeNames.has(tool.name) && isMcpTool(tool));
	const deferred = tools.filter((tool) => !activeNames.has(tool.name));
	const deferredMcp = deferred.filter(isMcpTool);
	const catalog = mcpCatalog(ctx.cwd);

	const lines = [
		"Context Usage",
		`${usageBar(categories, free, reserve, window)}  ${ctx.model?.id ?? "No model"}`,
		`${formatTokens(total)}/${formatTokens(window)} tokens (${percent(total, window)})`,
		"",
		"Estimated usage by category",
		...categories.map((category) => `${category.marker} ${category.label}: ${formatTokens(category.tokens)} tokens (${percent(category.tokens, window)})`),
		`· Free space: ${formatTokens(free)} tokens (${percent(free, window)})`,
		`B Autocompact buffer: ${formatTokens(reserve)} tokens (${percent(reserve, window)})`,
		"",
		`Auto-compact threshold: ${formatTokens(Math.max(0, window - reserve))} tokens`,
		`Tools: ${activeNames.size} active · ${deferred.length} deferred`,
		`MCP tools: ${activeMcp.length} active · ${deferredMcp.length} deferred · ${catalog.total} cached/searchable`,
		`Context files: ${options.contextFiles?.length ?? 0} · Skills: ${options.skills?.length ?? 0}`,
	];

	if (!expanded) {
		lines.push("", "Run /context all to expand tool, context-file, and skill inventories.");
		return lines.join("\n");
	}

	const groupedActive = Map.groupBy(tools.filter((tool) => activeNames.has(tool.name)), sourceLabel);
	lines.push("", "Active tools");
	for (const [source, sourceTools] of groupedActive) lines.push(`- ${source}: ${sourceTools.map((tool) => tool.name).join(", ")}`);
	lines.push("", "Deferred tools", `- MCP: ${deferredMcp.map((tool) => tool.name).join(", ") || "none"}`);
	lines.push(`- MCP catalog: ${catalog.servers.map((server) => `${server.name} (${server.count})`).join(", ") || "none"}`);
	const otherDeferred = deferred.filter((tool) => !isMcpTool(tool));
	lines.push(`- Other: ${otherDeferred.map((tool) => tool.name).join(", ") || "none"}`);
	lines.push("", "Context files", ...(options.contextFiles?.map((file) => `- ${file.path} (${formatTokens(estimate(file.content))} tokens)`) ?? ["- none"]));
	lines.push("", "Skills", ...(options.skills?.map((skill) => `- ${skill.name}`) ?? ["- none"]));
	return lines.join("\n");
}

export default function contextStatus(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show context usage by prompt, tools, MCP, agents, files, skills, and messages",
		getArgumentCompletions: (prefix) => "all".startsWith(prefix.trim().toLowerCase())
			? [{ value: "all", label: "all", description: "Expand inventories" }]
			: null,
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode && mode !== "all") {
				ctx.ui.notify("Usage: /context [all]", "warning");
				return;
			}
			const report = renderContext(pi, ctx, mode === "all");
			if (ctx.mode !== "tui") {
				ctx.ui.notify(report, "info");
				return;
			}
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const title = theme.fg("accent", theme.bold("Context Usage"));
				const body = report.replace(/^Context Usage\n/, "");
				const component = new Box(1, 1, (text) => theme.fg("border", text));
				component.addChild(new Text(`${title}\n${body}\n\n${theme.fg("dim", "Press Enter or Esc to close")}`, 0, 0));
				const scrollView = new ScrollView(component, {
					primary: true,
					scrollbar: mode === "all" ? "auto" : "hidden",
					scrollbarStyle: (text) => theme.fg("dim", text),
				});
				return {
					render: (width: number) => scrollView.render(width),
					invalidate: () => scrollView.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
						else if (matchesKey(data, "up")) {
							scrollView.scrollBy(-1);
							tui.requestRender();
						} else if (matchesKey(data, "down")) {
							scrollView.scrollBy(1);
							tui.requestRender();
						} else if (matchesKey(data, "pageUp")) {
							scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - 1));
							tui.requestRender();
						} else if (matchesKey(data, "pageDown")) {
							scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - 1));
							tui.requestRender();
						}
					},
				};
			}, { overlay: mode === "all", overlayOptions: mode === "all" ? { width: "90%", maxHeight: "85%", anchor: "center" } : undefined });
		},
	});
}
