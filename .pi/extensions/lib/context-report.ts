import { isNumber, isString, recordOf, type RuntimeValue } from "./runtime-values.ts";
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

const GRID_COLUMNS = 10;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const GRID_ROW_WIDTH = GRID_COLUMNS * 2 - 1;
const LEGEND_GAP = 3;
const MAX_REPORT_WIDTH = 78;
const DEFAULT_RESERVE_TOKENS = 16_384;

const USED_CELL = "⛁";
const BOUNDARY_CELL = "⛀";
const FREE_CELL = "⛶";
const BUFFER_CELL = "⛝";
const ANSI_STYLE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const RESET = "\u001b[0m";
const SEGMENT_COLORS = recordOf<string, string>()({
  S: "\u001b[38;5;109m", // system prompt: blue
  T: "\u001b[38;5;116m", // system tools: cyan
  M: "\u001b[38;5;139m", // mcp tools: purple
  A: "\u001b[38;5;179m", // custom agents: yellow
  C: "\u001b[38;5;108m", // context files: green
  K: "\u001b[38;5;173m", // skills: orange
  G: "\u001b[38;5;110m", // messages: light blue
  "·": "\u001b[38;5;240m", // free space: dim gray
  B: "\u001b[38;5;131m", // autocompact buffer: red
});

function paint(marker: string, text: string, colorize: boolean): string {
  if (!colorize || text.length === 0) return text;
  const color = SEGMENT_COLORS[marker];
  return color ? `${color}${text}${RESET}` : text;
}

function cellGlyph(marker: string): string {
  if (marker === "·") return FREE_CELL;
  if (marker === "B") return BUFFER_CELL;
  return USED_CELL;
}

function legendMarker(marker: string, colorize: boolean): string {
  return paint(marker, cellGlyph(marker), colorize);
}

function visibleWidth(value: string): number {
  return value.replace(ANSI_STYLE, "").length;
}

function padToVisibleWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function truncateText(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

type Category = {
  label: string;
  tokens: number;
  marker: string;
};

type McpCatalog = {
  total: number;
  servers: Array<{ name: string; count: number }>;
};

function estimate(value: RuntimeValue): number {
  return Math.ceil((isString(value) ? value.length : (JSON.stringify(value)?.length ?? 0)) / 4);
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

function percent(tokens: number, window: number): string {
  return `${((tokens / Math.max(1, window)) * 100).toFixed(1)}%`;
}

function reserveTokens(cwd: string): number {
  try {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const settings = JSON.parse(readFileSync(path.join(cwd, ".pi/settings.json"), "utf8")) as {
      compaction?: { reserveTokens?: unknown };
    };
    const configured = settings.compaction?.reserveTokens;
    return isNumber(configured) && configured >= 0 ? configured : DEFAULT_RESERVE_TOKENS;
  } catch {
    return DEFAULT_RESERVE_TOKENS;
  }
}

function toolTokens(tool: ToolInfo): number {
  return estimate({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  });
}

function isMcpTool(tool: ToolInfo): boolean {
  return tool.sourceInfo.source.includes("choco-pi-mcp");
}

function isAgentTool(tool: ToolInfo): boolean {
  return tool.sourceInfo.source.includes("subagents");
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
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const projectConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { disabled?: boolean }>;
    };
    const enabledServers = new Set(
      Object.entries(projectConfig.mcpServers ?? {}).flatMap(([name, definition]) =>
        definition.disabled === true ? [] : [name],
      ),
    );
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const cache = JSON.parse(readFileSync(path.join(agentDir, "mcp-cache.json"), "utf8")) as {
      version?: number;
      servers?: Record<string, { tools?: unknown[]; resources?: unknown[] }>;
    };
    if (cache.version !== 1 || !cache.servers) return { total: 0, servers: [] };
    const servers = Object.entries(cache.servers)
      .flatMap(([name, entry]) =>
        enabledServers.has(name)
          ? [{ name, count: (entry.tools?.length ?? 0) + (entry.resources?.length ?? 0) }]
          : [],
      )
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

function categoryData(
  ctx: ExtensionCommandContext,
  options: BuildSystemPromptOptions,
  tools: ToolInfo[],
  activeNames: Set<string>,
  total: number,
  messagesEstimate: number,
): Category[] {
  const activeTools = tools.filter((tool) => activeNames.has(tool.name));
  const mcp = activeTools.filter(isMcpTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
  const agents = activeTools.filter(isAgentTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
  const systemTools = activeTools
    .filter((tool) => !isMcpTool(tool) && !isAgentTool(tool))
    .reduce((sum, tool) => sum + toolTokens(tool), 0);
  const skills = estimate(formatSkillsForPrompt(options.skills ?? []));
  const contextFiles = (options.contextFiles ?? []).reduce(
    (sum, file) => sum + estimate(file.content),
    0,
  );
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

function markerAt(segments: Category[], position: number): string {
  let boundary = 0;
  for (const segment of segments) {
    boundary += Math.max(0, segment.tokens);
    if (position < boundary) return segment.marker;
  }
  return "·";
}

function segmentBoundaries(segments: Category[], window: number): number[] {
  const boundaries: number[] = [];
  let boundary = 0;
  for (const segment of segments.slice(0, -1)) {
    boundary += Math.max(0, segment.tokens);
    if (boundary > 0 && boundary < window) boundaries.push(boundary);
  }
  return boundaries;
}

function gridCells(segments: Category[], window: number, colorize: boolean): string[] {
  if (window <= 0) return Array.from({ length: GRID_CELLS }, () => paint("·", FREE_CELL, colorize));

  const boundaries = segmentBoundaries(segments, window);
  return Array.from({ length: GRID_CELLS }, (_, index) => {
    const start = (index * window) / GRID_CELLS;
    const end = ((index + 1) * window) / GRID_CELLS;
    const marker = markerAt(segments, (start + end) / 2);
    const straddles = boundaries.some((boundary) => boundary > start && boundary < end);
    const glyph = straddles ? BOUNDARY_CELL : cellGlyph(marker);
    return paint(marker, glyph, colorize);
  });
}

/** Render a 10×10 context grid where each cell represents one percent. */
export function usageBar(
  categories: Category[],
  free: number,
  reserve: number,
  window: number,
  colorize: boolean,
): string {
  const safeWindow = Math.max(0, window);
  const safeReserve = Math.min(Math.max(0, reserve), safeWindow);
  const categoryTotal = categories.reduce((sum, category) => sum + Math.max(0, category.tokens), 0);
  const categoryBudget = Math.min(
    categoryTotal,
    Math.max(0, safeWindow - safeReserve - Math.max(0, free)),
  );
  const categoryScale = categoryTotal > 0 ? categoryBudget / categoryTotal : 0;
  const displayedCategories = categories.map((category) => ({
    ...category,
    tokens: Math.max(0, category.tokens) * categoryScale,
  }));
  const effectiveFree = Math.max(0, safeWindow - categoryBudget - safeReserve);
  const segments = [
    ...displayedCategories,
    { label: "Free", tokens: effectiveFree, marker: "·" },
    { label: "Buffer", tokens: safeReserve, marker: "B" },
  ];
  const cells = gridCells(segments, safeWindow, colorize);
  return Array.from({ length: GRID_ROWS }, (_, row) => {
    const start = row * GRID_COLUMNS;
    return cells.slice(start, start + GRID_COLUMNS).join(" ");
  }).join("\n");
}

function gridAndLegend(grid: string, legend: string[]): string[] {
  const gridRows = grid.split("\n");
  const lineCount = Math.max(gridRows.length, legend.length);
  const legendColumn = GRID_ROW_WIDTH + LEGEND_GAP;
  return Array.from({ length: lineCount }, (_, index) => {
    const gridRow = gridRows[index] ?? "";
    const legendLine = legend[index];
    if (legendLine === undefined || legendLine.length === 0) return gridRow;
    return `${padToVisibleWidth(gridRow, legendColumn)}${legendLine}`;
  });
}

function categoryTokens(categories: Category[], label: string): number {
  return categories.find((category) => category.label === label)?.tokens ?? 0;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function sourceLabel(tool: ToolInfo): string {
  return tool.sourceInfo.source === "builtin" ? "Pi" : tool.sourceInfo.source.replace(/^npm:/, "");
}

/**
 * The Context tab body. Concise mode reports the bar, the per-category split,
 * and the counts; expanded mode appends the tool, context-file, and skill
 * inventories those counts summarize.
 */
export function renderContext(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
  ctx: ExtensionCommandContext,
  expanded: boolean,
  colorize: boolean,
): string {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const options = ctx.getSystemPromptOptions();
  const tools = pi.getAllTools();
  const activeNames = new Set(pi.getActiveTools());
  const messagesEstimate = messageTokens(ctx);
  const initialEstimate =
    estimate(ctx.getSystemPrompt()) +
    tools
      .filter((tool) => activeNames.has(tool.name))
      .reduce((sum, tool) => sum + toolTokens(tool), 0) +
    messagesEstimate;
  const total = usage?.tokens && usage.tokens > 0 ? usage.tokens : initialEstimate;
  const reserve = Math.min(reserveTokens(ctx.cwd), window);
  const categories = categoryData(ctx, options, tools, activeNames, total, messagesEstimate);
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0);
  const free = Math.max(0, window - categoryTotal - reserve);
  const deferred = tools.filter((tool) => !activeNames.has(tool.name));
  const deferredMcp = deferred.filter(isMcpTool);
  const activeAgents = tools.filter((tool) => activeNames.has(tool.name) && isAgentTool(tool));
  const catalog = mcpCatalog(ctx.cwd);
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  const sidebarWidth = MAX_REPORT_WIDTH - GRID_ROW_WIDTH - LEGEND_GAP;
  const legend = [
    truncateText(ctx.model?.id ?? "No model", sidebarWidth),
    `${formatTokens(total)}/${formatTokens(window)} tokens (${percent(total, window)})`,
    "",
    "Estimated usage by category",
    ...categories.map(
      (category) =>
        `${legendMarker(category.marker, colorize)} ${category.label}: ${formatTokens(category.tokens)} tokens (${percent(category.tokens, window)})`,
    ),
    `${legendMarker("·", colorize)} Free space: ${formatTokens(free)} tokens (${percent(free, window)})`,
    `${legendMarker("B", colorize)} Autocompact buffer: ${formatTokens(reserve)} tokens (${percent(reserve, window)})`,
  ];
  const grid = usageBar(categories, free, reserve, window, colorize);
  const lines = [
    "Context Usage",
    ...gridAndLegend(grid, legend),
    "",
    `Auto-compact window: ${formatTokens(window)} tokens`,
    `Tools: ${activeNames.size} active · ${deferred.length} deferred`,
    "",
    "MCP tools · /mcp",
    `└ ${countLabel(catalog.servers.length, "server")} · ${countLabel(catalog.total, "tool")} · ${formatTokens(categoryTokens(categories, "MCP tools"))} tokens`,
    "",
    // The figure is the delegation tools' schema cost, not a count of the agent
    // definitions under .pi/agents/, so the source names what was measured.
    "Custom agents · choco-pi-subagents",
    `└ ${countLabel(activeAgents.length, "tool")} · ${formatTokens(categoryTokens(categories, "Custom agents"))} tokens`,
    "",
    "Context files",
    `└ ${countLabel(contextFiles.length, "file")} · ${formatTokens(categoryTokens(categories, "Context files"))} tokens`,
    "",
    // Pi ships no /skills command, and a skill's directory is not on the
    // loaded record, so this line claims no source it cannot show.
    "Skills",
    `└ ${countLabel(skills.length, "skill")} · ${formatTokens(categoryTokens(categories, "Skills"))} tokens`,
  ];

  if (!expanded) return lines.join("\n");

  const groupedActive = Map.groupBy(
    tools.filter((tool) => activeNames.has(tool.name)),
    sourceLabel,
  );
  lines.push("", "Active tools");
  for (const [source, sourceTools] of groupedActive)
    lines.push(`- ${source}: ${sourceTools.map((tool) => tool.name).join(", ")}`);
  lines.push(
    "",
    "Deferred tools",
    `- MCP: ${deferredMcp.map((tool) => tool.name).join(", ") || "none"}`,
  );
  lines.push(
    `- MCP catalog: ${catalog.servers.map((server) => `${server.name} (${server.count})`).join(", ") || "none"}`,
  );
  const otherDeferred = deferred.filter((tool) => !isMcpTool(tool));
  lines.push(`- Other: ${otherDeferred.map((tool) => tool.name).join(", ") || "none"}`);
  lines.push(
    "",
    "Context files",
    ...(contextFiles.length > 0
      ? contextFiles.map(
          (file) => `- ${file.path} (${formatTokens(estimate(file.content))} tokens)`,
        )
      : ["- none"]),
  );
  lines.push(
    "",
    "Skills",
    ...(skills.length > 0 ? skills.map((skill) => `- ${skill.name}`) : ["- none"]),
  );
  return lines.join("\n");
}
