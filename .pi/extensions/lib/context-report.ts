import { isNumber, isString, recordOf, type RuntimeValue } from "./runtime-values.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  calculateContextTokens,
  formatSkillsForPrompt,
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { currentProviderPrefixMetrics, type ProviderPrefixMetrics } from "../cache-probe.ts";

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

function contextEntries(ctx: ExtensionCommandContext): SessionEntry[] {
  return ctx.sessionManager.buildContextEntries();
}

function messageTokens(entries: SessionEntry[]): number {
  return estimate(entries.flatMap(sessionEntryToContextMessages));
}

function measuredUsagePredatesCompaction(entries: SessionEntry[]): boolean {
  // buildContextEntries puts the latest compaction first, followed by retained
  // ancestors and then its descendants. Parent links distinguish retained
  // pre-compaction assistant samples from genuinely fresh responses.
  const compaction = entries.find((entry) => entry.type === "compaction");
  if (!compaction) return false;
  const descendants = new Set([compaction.id]);
  for (const entry of entries) {
    if (entry.id === compaction.id || !entry.parentId || !descendants.has(entry.parentId)) continue;
    descendants.add(entry.id);
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason !== "error" &&
      entry.message.stopReason !== "aborted" &&
      entry.message.usage &&
      calculateContextTokens(entry.message.usage) > 0
    ) {
      return false;
    }
  }
  return true;
}

function allocateTokens(values: number[], total: number): number[] {
  const available = Math.max(0, Math.round(total));
  const sum = values.reduce((current, value) => current + Math.max(0, value), 0);
  if (sum === 0) return values.map(() => 0);
  let used = 0;
  const lastPositive = values.findLastIndex((value) => value > 0);
  return values.map((value, index) => {
    if (value <= 0) return 0;
    if (index === lastPositive) return available - used;
    const allocated = Math.floor((value / sum) * available);
    used += allocated;
    return allocated;
  });
}

function categoryData(
  ctx: ExtensionCommandContext,
  options: BuildSystemPromptOptions,
  tools: ToolInfo[],
  activeNames: Set<string>,
  measuredTotal: number | undefined,
  messagesEstimate: number,
  providerMetrics: ProviderPrefixMetrics | undefined,
): Category[] {
  const activeTools = tools.filter((tool) => activeNames.has(tool.name));
  let mcp = activeTools.filter(isMcpTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
  let agents = activeTools.filter(isAgentTool).reduce((sum, tool) => sum + toolTokens(tool), 0);
  let systemTools = activeTools
    .filter((tool) => !isMcpTool(tool) && !isAgentTool(tool))
    .reduce((sum, tool) => sum + toolTokens(tool), 0);
  if (providerMetrics) {
    [systemTools, mcp, agents] = allocateTokens(
      [systemTools, mcp, agents],
      providerMetrics.toolsTokens,
    );
  }
  let skills = estimate(formatSkillsForPrompt(options.skills ?? []));
  let contextFiles = (options.contextFiles ?? []).reduce(
    (sum, file) => sum + estimate(file.content),
    0,
  );
  let prompt = providerMetrics
    ? Math.max(0, providerMetrics.systemTokens - skills - contextFiles)
    : estimate(ctx.getSystemPrompt());
  if (measuredTotal !== undefined) {
    [prompt, systemTools, mcp, agents, contextFiles, skills] = allocateTokens(
      [prompt, systemTools, mcp, agents, contextFiles, skills],
      Math.min(measuredTotal, prompt + systemTools + mcp + agents + contextFiles + skills),
    );
  }
  const known = prompt + systemTools + mcp + agents + contextFiles + skills;
  const messages =
    measuredTotal === undefined ? messagesEstimate : Math.max(0, measuredTotal - known);
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
  providerMetrics: ProviderPrefixMetrics | undefined = currentProviderPrefixMetrics(ctx),
): string {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const options = ctx.getSystemPromptOptions();
  const tools = pi.getAllTools();
  const activeNames = new Set(pi.getActiveTools());
  const entries = contextEntries(ctx);
  const messagesEstimate = messageTokens(entries);
  const matchingProviderMetrics =
    providerMetrics?.toolCount === activeNames.size ? providerMetrics : undefined;
  const measuredTotal =
    !measuredUsagePredatesCompaction(entries) && usage?.tokens && usage.tokens > 0
      ? usage.tokens
      : undefined;
  const reserve = Math.min(reserveTokens(ctx.cwd), window);
  const categories = categoryData(
    ctx,
    options,
    tools,
    activeNames,
    measuredTotal,
    messagesEstimate,
    matchingProviderMetrics,
  );
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0);
  const total = measuredTotal ?? categoryTotal;
  const free = Math.max(0, window - total - reserve);
  const deferred = tools.filter((tool) => !activeNames.has(tool.name));
  const deferredMcp = deferred.filter(isMcpTool);
  const activeAgents = tools.filter((tool) => activeNames.has(tool.name) && isAgentTool(tool));
  const catalog = mcpCatalog(ctx.cwd);
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  const sidebarWidth = MAX_REPORT_WIDTH - GRID_ROW_WIDTH - LEGEND_GAP;
  const legend = [
    truncateText(ctx.model?.id ?? "No model", sidebarWidth),
    `${formatTokens(total)}/${formatTokens(window)} tokens (${percent(total, window)}${measuredTotal === undefined ? "; estimated" : ""})`,
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
