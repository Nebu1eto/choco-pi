import { isNumber, isString, recordOf, type RuntimeValue } from "./lib/runtime-values.ts";
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

function legendMarker(marker: string, colorize: boolean): string {
  return colorize ? paint(marker, marker === "·" ? "·" : "█", colorize) : marker;
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
      Object.entries(projectConfig.mcpServers ?? {})
        .filter(([, definition]) => definition.disabled !== true)
        .map(([name]) => name),
    );
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const cache = JSON.parse(readFileSync(path.join(agentDir, "mcp-cache.json"), "utf8")) as {
      version?: number;
      servers?: Record<string, { tools?: unknown[]; resources?: unknown[] }>;
    };
    if (cache.version !== 1 || !cache.servers) return { total: 0, servers: [] };
    const servers = Object.entries(cache.servers)
      .filter(([name]) => enabledServers.has(name))
      .map(([name, entry]) => ({
        name,
        count: (entry.tools?.length ?? 0) + (entry.resources?.length ?? 0),
      }))
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

export function usageBar(
  categories: Category[],
  free: number,
  reserve: number,
  window: number,
  colorize: boolean,
): string {
  const segments = [
    ...categories,
    { label: "Free", tokens: free, marker: "·" },
    { label: "Buffer", tokens: reserve, marker: "B" },
  ];
  const win = Math.max(1, window);
  // Give every nonzero segment at least one cell so small categories stay
  // visible, then trim overflow from the largest segments.
  const widths = segments.map((segment) =>
    segment.tokens > 0 ? Math.max(1, Math.round((segment.tokens / win) * BAR_WIDTH)) : 0,
  );
  const overflow = () => widths.reduce((sum, width) => sum + width, 0) - BAR_WIDTH;
  while (overflow() > 0) {
    const largest = widths.indexOf(Math.max(...widths));
    if (widths[largest] <= 1) break;
    widths[largest] -= 1;
  }
  const parts = segments.map((segment, index) => {
    const cell = colorize ? (segment.marker === "·" ? "·" : "█") : segment.marker;
    return paint(segment.marker, cell.repeat(Math.max(0, widths[index])), colorize);
  });
  const drawn = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  if (drawn < BAR_WIDTH) parts.push(paint("·", "·".repeat(BAR_WIDTH - drawn), colorize));
  return parts.join("");
}

function sourceLabel(tool: ToolInfo): string {
  return tool.sourceInfo.source === "builtin" ? "Pi" : tool.sourceInfo.source.replace(/^npm:/, "");
}

function renderContext(
  pi: ExtensionAPI,
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
  const activeMcp = tools.filter((tool) => activeNames.has(tool.name) && isMcpTool(tool));
  const deferred = tools.filter((tool) => !activeNames.has(tool.name));
  const deferredMcp = deferred.filter(isMcpTool);
  const catalog = mcpCatalog(ctx.cwd);

  const lines = [
    "Context Usage",
    `${usageBar(categories, free, reserve, window, colorize)}  ${ctx.model?.id ?? "No model"}`,
    `${formatTokens(total)}/${formatTokens(window)} tokens (${percent(total, window)})`,
    "",
    "Estimated usage by category",
    ...categories.map(
      (category) =>
        `${legendMarker(category.marker, colorize)} ${category.label}: ${formatTokens(category.tokens)} tokens (${percent(category.tokens, window)})`,
    ),
    `${legendMarker("·", colorize)} Free space: ${formatTokens(free)} tokens (${percent(free, window)})`,
    `${legendMarker("B", colorize)} Autocompact buffer: ${formatTokens(reserve)} tokens (${percent(reserve, window)})`,
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
    ...(options.contextFiles?.map(
      (file) => `- ${file.path} (${formatTokens(estimate(file.content))} tokens)`,
    ) ?? ["- none"]),
  );
  lines.push("", "Skills", ...(options.skills?.map((skill) => `- ${skill.name}`) ?? ["- none"]));
  return lines.join("\n");
}

export default function contextStatus(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show context usage by prompt, tools, MCP, agents, files, skills, and messages",
    getArgumentCompletions: (prefix) =>
      "all".startsWith(prefix.trim().toLowerCase())
        ? [{ value: "all", label: "all", description: "Expand inventories" }]
        : null,
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode && mode !== "all") {
        ctx.ui.notify("Usage: /context [all]", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderContext(pi, ctx, mode === "all", false), "info");
        return;
      }
      const report = renderContext(pi, ctx, mode === "all", true);
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const title = theme.fg("accent", theme.bold("Context Usage"));
          const body = report.replace(/^Context Usage\n/, "");
          const component = new Box(1, 1, (text) => theme.fg("border", text));
          component.addChild(
            new Text(
              `${title}\n${body}\n\n${theme.fg("dim", "Press Enter or Esc to close")}`,
              0,
              0,
            ),
          );
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
        },
        {
          overlay: mode === "all",
          overlayOptions:
            mode === "all" ? { width: "90%", maxHeight: "85%", anchor: "center" } : undefined,
        },
      );
    },
  });
}
