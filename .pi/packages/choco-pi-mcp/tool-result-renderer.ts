import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
  parseMcpValue,
  type McpObject,
  type McpValue,
} from "./protocol-values.ts";
import {
  formatMcpCallCompactTitle,
  formatMcpDisplayName,
  styleMcpCallLines,
} from "./tool-call-headline.ts";

type McpToolResultDetails = McpObject & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

const plainTheme: RenderTheme = { fg: (_name, text) => text };

export interface McpProxyToolCallInput {
  tool?: string;

  args?: string | McpObject;
  connect?: string;
  describe?: string;
  instructions?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderState {
  compactTitle?: string;
  compactInputPreview?: string;
}

interface McpToolRenderContext {
  isError: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  state?: McpToolRenderState;
}

export type McpToolResultRendering = "compact" | "boxed";

export interface McpToolRenderOptions {
  resultRendering: McpToolResultRendering;
  collapsedResultLines: 1 | 2 | 3;
}

export interface McpToolRenderSettings {
  toolResultRendering?: unknown;
  collapsedResultLines?: unknown;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
const DEFAULT_MAX_COMPACT_INPUT_CHARS = 240;
const DEFAULT_BOXED_COLLAPSED_LINES = 3;
const DEFAULT_COMPACT_COLLAPSED_LINES = 1;
const DEFAULT_MAX_COLLAPSED_CHARS = 8000;
const COLLAPSED_RENDER_CHAR_SLACK = 8;

class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

class CompactMcpToolResult implements Component {
  private readonly title: string;
  private readonly inputPreview: string;
  private readonly display: McpToolResultDisplay;
  private readonly theme: RenderTheme;
  private rendered: { width: number; lines: string[] } | null = null;

  constructor(
    title: string,
    inputPreview: string,
    display: McpToolResultDisplay,
    theme: RenderTheme,
  ) {
    this.title = title;
    this.inputPreview = inputPreview;
    this.display = display;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.rendered?.width === safeWidth) return this.rendered.lines;

    const resultLines = this.display.lines.filter((line, index, lines) => {
      return !(this.display.truncated && index === lines.length - 1 && line === "…");
    });
    const lines = resultLines.length > 0 ? resultLines : [""];
    const bodies = lines.map((line, index) => {
      const prefix = index === 0 ? this.renderPrefix(safeWidth) : "";
      return `${prefix}${this.theme.fg("toolOutput", line)}`;
    });
    const hiddenText =
      this.display.truncated || bodies.some((body) => visibleWidth(body) > safeWidth);
    const rendered = bodies.map((body, index) => {
      const suffix = hiddenText && index === bodies.length - 1 ? " … (Ctrl+O to expand)" : "";
      if (!suffix) return truncateToWidth(body, safeWidth, "…");
      if (safeWidth >= suffix.length + 20) {
        return `${truncateToWidth(body, safeWidth - suffix.length, "…")}${this.theme.fg("muted", suffix)}`;
      }
      const shortSuffix = " (Ctrl+O)";
      if (safeWidth >= shortSuffix.length + 5) {
        return `${truncateToWidth(body, safeWidth - shortSuffix.length, "…")}${this.theme.fg("muted", shortSuffix)}`;
      }
      return truncateToWidth(this.theme.fg("muted", shortSuffix.trim()), safeWidth, "…");
    });
    this.rendered = { width: safeWidth, lines: rendered };
    return rendered;
  }

  invalidate(): void {
    this.rendered = null;
  }

  private renderPrefix(width: number): string {
    if (!this.title) return "";
    const arrow = " → ";
    const title = this.theme.fg(
      "toolTitle",
      this.theme.bold ? this.theme.bold(this.title) : this.title,
    );
    if (!this.inputPreview) return `${this.theme.fg("dim", "•")} ${title}${arrow}`;

    const maxPrefixWidth = Math.max(12, Math.floor(width * 0.55));
    const titleWidth = visibleWidth(this.title);
    const inputWidth = Math.max(0, maxPrefixWidth - titleWidth - 1);
    if (inputWidth <= 3) {
      return `${this.theme.fg("dim", "•")} ${this.theme.fg("toolTitle", truncateToWidth(this.title, maxPrefixWidth, "…"))}${arrow}`;
    }

    const input = truncateToWidth(this.inputPreview, inputWidth, "…");
    return `${this.theme.fg("dim", "•")} ${title} ${this.theme.fg("muted", input)}${arrow}`;
  }
}

class CollapsibleText implements Component {
  private readonly text: string;
  private readonly expanded: boolean;
  private readonly maxCollapsedLines: number;
  private readonly preTruncated: boolean;
  private readonly fullText: Text;
  private readonly footerText: Text;
  private collapsedText: { charBudget: number; fullyIncluded: boolean; text: Text } | null = null;
  private collapsedRender: { width: number; charBudget: number; lines: string[] } | null = null;

  constructor(
    text: string,
    expanded: boolean,
    maxCollapsedLines: number,
    ellipsis: string,
    expandHint: string,
    preTruncated = false,
  ) {
    this.text = text;
    this.expanded = expanded;
    this.maxCollapsedLines = maxCollapsedLines;
    this.preTruncated = preTruncated;
    this.fullText = new Text(text, 0, 0);
    this.footerText = new Text(`${ellipsis}\n${expandHint}`, 0, 0);
  }

  render(width: number): string[] {
    if (this.expanded) {
      return this.fullText.render(width);
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const charBudget = safeWidth * (this.maxCollapsedLines + 1) * COLLAPSED_RENDER_CHAR_SLACK;
    if (!this.collapsedText || this.collapsedText.charBudget !== charBudget) {
      const prefix = this.text.length > charBudget ? this.text.slice(0, charBudget) : this.text;
      this.collapsedText = {
        charBudget,
        fullyIncluded: prefix === this.text,
        text: new Text(prefix, 0, 0),
      };
      this.collapsedRender = null;
    }

    const lines = this.collapsedText.text.render(width);
    if (
      !this.preTruncated &&
      this.collapsedText.fullyIncluded &&
      lines.length <= this.maxCollapsedLines
    )
      return lines;
    if (this.collapsedRender?.width === width && this.collapsedRender.charBudget === charBudget) {
      return this.collapsedRender.lines;
    }

    const rendered = [...lines.slice(0, this.maxCollapsedLines), ...this.footerText.render(width)];
    this.collapsedRender = { width, charBudget, lines: rendered };
    return rendered;
  }

  invalidate(): void {
    this.fullText.invalidate();
    this.footerText.invalidate();
    this.collapsedText?.text.invalidate();
    this.collapsedRender = null;
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

const SENSITIVE_INPUT_KEY =
  /^(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|id[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?id|token)$/i;

function redactMcpInput(value: McpValue, key?: string, depth = 0): McpValue {
  if (key && SENSITIVE_INPUT_KEY.test(key)) return "[redacted]";
  if (depth >= 8) return "[nested value]";
  if (Array.isArray(value)) return value.map((item) => redactMcpInput(item, undefined, depth + 1));
  if (!isObjectValue(value)) return value;
  const output: McpObject = {};
  for (const [entryKey, item] of Object.entries(value)) {
    output[entryKey] = redactMcpInput(item, entryKey, depth + 1);
  }
  return output;
}

function formatJsonish(value: McpValue, maxChars: number): string {
  if (isStringValue(value)) {
    try {
      const parsed = parseMcpValue(JSON.parse(value));
      return truncateText(JSON.stringify(redactMcpInput(parsed), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(redactMcpInput(value), null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function hasUsefulObjectContent<BoundaryValue>(value: BoundaryValue): boolean {
  return (
    isObjectValue(value) && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
  );
}

function semanticValue(value: McpValue, key?: string): string {
  if (key && SENSITIVE_INPUT_KEY.test(key)) return "[redacted]";
  if (isStringValue(value)) return truncateText(value.replace(/\s+/g, " ").trim(), 64);
  if (isNumberValue(value) || isBooleanValue(value) || value === null) return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isObjectValue(value)) {
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  return "";
}

function semanticObjectPreview(value: McpObject, maxChars: number): string {
  const entries = Object.entries(value)
    .slice(0, 4)
    .map(([key, item]) => `${formatMcpDisplayName(key, false)}=${semanticValue(item, key)}`);
  const omitted = Math.max(0, Object.keys(value).length - entries.length);
  if (omitted > 0) entries.push(`+${omitted} more`);
  return truncateText(entries.join(" · "), maxChars);
}

export function formatMcpInputPreview(
  value: McpValue,
  maxChars = DEFAULT_MAX_COMPACT_INPUT_CHARS,
): string {
  let parsed = value;
  if (isStringValue(value)) {
    try {
      parsed = parseMcpValue(JSON.parse(value));
    } catch {
      return truncateText(value.replace(/\s+/g, " ").trim(), maxChars);
    }
  }
  if (Array.isArray(parsed)) return truncateText(`${parsed.length} items`, maxChars);
  if (isObjectValue(parsed)) return semanticObjectPreview(parsed, maxChars);
  return truncateText(semanticValue(parsed), maxChars);
}

function jsonResultPreview(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
): string | undefined {
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return undefined;
  try {
    return formatMcpInputPreview(parseMcpValue(JSON.parse(result.content[0].text)));
  } catch {
    return undefined;
  }
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.action === "ui-messages") return [`mcp ${args.action}`];

  if (args.tool) {
    const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
    return lines;
  }

  if (args.connect) return [`mcp connect ${args.connect}`];
  if (args.describe) return [`mcp describe ${args.describe}`];
  if (args.instructions) return [`mcp instructions ${args.instructions}`];

  if (args.search) {
    let line = `mcp search ${args.search}`;
    if (args.server) line += ` @ ${args.server}`;
    if (args.regex === true) line += " (regex)";
    if (args.includeSchemas === false) line += " (schemas hidden)";
    return [line];
  }

  if (args.action)
    return [args.server ? `mcp ${args.action} ${args.server}` : `mcp ${args.action}`];
  if (args.server) return [`mcp list ${args.server}`];

  return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
  displayName: string,

  args: McpObject,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (!hasUsefulObjectContent(args)) return [displayName];
  return [displayName, formatJsonish(args, maxInputChars)];
}

/**
 * Renders a call in the same shape as the other choco-pi tools: a dim bullet
 * with a bold header, then detail rows under a `└` branch.
 */
function renderToolCallLines(lines: string[], theme?: RenderTheme) {
  return new Text(styleMcpCallLines(lines, theme ?? plainTheme).join("\n"), 0, 0);
}

function formatCompactInputPreview(
  lines: string[],
  maxChars = DEFAULT_MAX_COMPACT_INPUT_CHARS,
): string {
  return truncateText(lines.slice(1).join(" ").replace(/\s+/g, " ").trim(), maxChars);
}

export function resolveMcpToolRenderOptions(
  settings?: McpToolRenderSettings,
): McpToolRenderOptions {
  const resultRendering = settings?.toolResultRendering === "boxed" ? "boxed" : "compact";
  const collapsedLines = settings?.collapsedResultLines;
  const defaultLines =
    resultRendering === "boxed" ? DEFAULT_BOXED_COLLAPSED_LINES : DEFAULT_COMPACT_COLLAPSED_LINES;
  return {
    resultRendering,
    collapsedResultLines:
      collapsedLines === 1 || collapsedLines === 2 || collapsedLines === 3
        ? collapsedLines
        : defaultLines,
  };
}

function shouldUseCompactFinalRender(
  options: McpToolRenderOptions,
  context?: McpToolRenderContext,
): boolean {
  return (
    options.resultRendering === "compact" &&
    context !== undefined &&
    context.isPartial === false &&
    context.expanded !== true &&
    context.isError !== true
  );
}

function renderToolCall(
  lines: string[],
  theme: RenderTheme | undefined,
  context: McpToolRenderContext | undefined,
  options: McpToolRenderOptions,
  compactInputPreview = formatCompactInputPreview(lines),
) {
  if (context?.state) {
    context.state.compactTitle = formatMcpCallCompactTitle(lines[0] ?? "mcp");
    context.state.compactInputPreview = compactInputPreview;
  }
  if (shouldUseCompactFinalRender(options, context)) return new EmptyComponent();
  const visibleLines =
    context?.expanded === true || !compactInputPreview
      ? lines
      : [lines[0] ?? "mcp", compactInputPreview];
  return renderToolCallLines(visibleLines, theme);
}

export function renderMcpProxyToolCall(
  args: McpProxyToolCallInput,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
) {
  return renderToolCall(
    formatMcpProxyToolCallLines(args),
    theme,
    context,
    resolveMcpToolRenderOptions(),
    args.args === undefined ? "" : formatMcpInputPreview(args.args),
  );
}

export function createMcpProxyToolCallRenderer(options: McpToolRenderOptions) {
  return (args: McpProxyToolCallInput, theme?: RenderTheme, context?: McpToolRenderContext) => {
    return renderToolCall(
      formatMcpProxyToolCallLines(args),
      theme,
      context,
      options,
      args.args === undefined ? "" : formatMcpInputPreview(args.args),
    );
  };
}

export function createMcpDirectToolCallRenderer(
  displayName: string,
  options = resolveMcpToolRenderOptions(),
) {
  return (args: McpObject, theme?: RenderTheme, context?: McpToolRenderContext) => {
    return renderToolCall(
      formatMcpDirectToolCallLines(displayName, args),
      theme,
      context,
      options,
      formatMcpInputPreview(args),
    );
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

function collectCollapsedResultLines(
  content: AgentToolResult<McpToolResultDetails>["content"],
  maxLines: number,
  maxChars: number,
): McpToolResultDisplay {
  if (content.length === 0) return { lines: ["(empty result)"], truncated: false };

  const lines: string[] = [];
  let remainingChars = maxChars;
  let truncated = false;

  const appendLine = (line: string) => {
    if (lines.length === 0) {
      const previewWidth = Math.min(line.length, remainingChars);
      if (line.slice(0, previewWidth).trim() === "") {
        if (line.length >= remainingChars) {
          truncated = true;
          remainingChars = 0;
          return false;
        }
        remainingChars -= line.length + 1;
        return true;
      }
    }

    if (lines.length >= maxLines || remainingChars <= 0) {
      truncated = true;
      return false;
    }

    if (line.length > remainingChars) {
      lines.push(line.slice(0, remainingChars));
      truncated = true;
      remainingChars = 0;
      return false;
    }

    lines.push(line);
    remainingChars -= line.length + 1;
    return true;
  };

  for (const block of content) {
    if (block.type !== "text") {
      if (!appendLine(`[image: ${block.mimeType}]`)) break;
      continue;
    }

    let start = 0;
    while (start <= block.text.length) {
      const newline = block.text.indexOf("\n", start);
      const line = newline === -1 ? block.text.slice(start) : block.text.slice(start, newline);
      if (!appendLine(line)) break;
      if (newline === -1) break;
      start = newline + 1;
    }

    if (truncated) break;
  }

  if (lines.length === 0) lines.push(truncated ? "(leading blank output omitted)" : "");
  if (truncated && lines.length >= maxLines) lines.push("…");
  return { lines, truncated };
}

export function formatMcpToolResultIdentity(
  details: McpToolResultDetails | undefined,
): string | null {
  if (details?.mode !== "call") return null;
  const server = isStringValue(details.server)
    ? details.server
    : isStringValue(details.hintServer)
      ? details.hintServer
      : null;
  if (!server) return null;

  if (isStringValue(details.tool))
    return `MCP: ${formatMcpDisplayName(server, false)} · ${formatMcpDisplayName(details.tool)}`;

  if (isStringValue(details.resourceUri))
    return `MCP: ${formatMcpDisplayName(server, false)} · Resource ${details.resourceUri}`;

  if (isStringValue(details.requestedTool))
    return `MCP: ${formatMcpDisplayName(server, false)} · ${formatMcpDisplayName(details.requestedTool)}`;
  return null;
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = DEFAULT_BOXED_COLLAPSED_LINES,
  maxCollapsedChars = DEFAULT_MAX_COLLAPSED_CHARS,
): McpToolResultDisplay {
  if (!expanded) {
    const semantic = jsonResultPreview(result);
    if (semantic) return { lines: [semantic], truncated: true };
    return collectCollapsedResultLines(result.content, maxCollapsedLines, maxCollapsedChars);
  }

  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];
  return { lines, truncated: false };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
  renderOptions = resolveMcpToolRenderOptions(),
) {
  const activeTheme = theme ?? plainTheme;
  if (options.isPartial) {
    return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const hasErrorDetails = Boolean(result.details.error);
  const expanded = options.expanded || context?.isError === true || hasErrorDetails;
  if (!expanded && renderOptions.resultRendering === "compact") {
    const display = formatMcpToolResultLines(result, false, renderOptions.collapsedResultLines);
    const title = context?.state?.compactTitle ?? formatMcpToolResultIdentity(result.details) ?? "";
    const inputPreview = context?.state?.compactInputPreview ?? "";
    return new CompactMcpToolResult(title, inputPreview, display, activeTheme);
  }

  const display = formatMcpToolResultLines(result, expanded, renderOptions.collapsedResultLines);
  const identity = formatMcpToolResultIdentity(result.details);
  const output = [
    ...(identity ? [activeTheme.fg("muted", identity)] : []),
    ...display.lines.map((line) => activeTheme.fg("toolOutput", line)),
  ].join("\n");

  return new CollapsibleText(
    output,
    expanded,
    renderOptions.collapsedResultLines + (identity ? 1 : 0),
    activeTheme.fg("muted", "…"),
    activeTheme.fg("muted", "(Ctrl+O to expand)"),
    display.truncated,
  );
}

export function createMcpToolResultRenderer(renderOptions: McpToolRenderOptions) {
  return (
    result: AgentToolResult<McpToolResultDetails>,
    options: ToolRenderResultOptions,
    theme?: RenderTheme,
    context?: McpToolRenderContext,
  ) => renderMcpToolResult(result, options, theme, context, renderOptions);
}
