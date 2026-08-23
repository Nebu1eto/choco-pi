import type { BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
import { shellSplit } from "../../shell/tokenize.ts";
import { type Component, Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { previewText, renderTextAndImages } from "./render-content.ts";
import { codeModeToolDisplayName } from "./tool-identity.ts";
import type {
  CodeModeRenderContext,
  CodeModeRenderTheme,
  CodeModeToolDefinition,
  ProgrammaticCodeModeToolDefinition,
  RuntimeToolTrace,
} from "./types.ts";

export function renderTraceAndOutput(
  traces: RuntimeToolTrace[],
  droppedTraceCount: number,
  tools: CodeModeToolDefinition[],
  output: Component,
  hasOutput: boolean,
  options: { expanded: boolean; isPartial: boolean },
  theme: CodeModeRenderTheme,
  context: CodeModeRenderContext | undefined,
  emittedImages: Map<string, Set<string>>,
): Component {
  if (traces.length === 0 && droppedTraceCount === 0) return output;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const container = new Container();
  if (droppedTraceCount > 0) {
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          `… ${droppedTraceCount} earlier nested call${droppedTraceCount === 1 ? "" : "s"} omitted`,
        ),
        0,
        0,
      ),
    );
  }
  for (const [index, trace] of traces.entries()) {
    const rendered = renderTrace(
      trace,
      droppedTraceCount + index + 1,
      byName.get(trace.name),
      options,
      theme,
      context,
      emittedImages,
    );
    for (const component of rendered) container.addChild(component);
  }
  if (hasOutput) {
    container.addChild(new Spacer(1));
    container.addChild(output);
  }
  return container;
}

function renderTrace(
  trace: RuntimeToolTrace,
  order: number,
  tool: CodeModeToolDefinition | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: CodeModeRenderTheme,
  context: CodeModeRenderContext | undefined,
  emittedImages: Map<string, Set<string>>,
): Component[] {
  if (!options.expanded) {
    return [orderedTraceCall(renderCollapsedTraceCall(trace, tool, theme), trace, order, theme)];
  }
  const renderedTrace = withoutEmittedImages(trace, emittedImages);
  const renderContext = {
    toolCallId: trace.id,
    cwd: context?.cwd,
    expanded: options.expanded,
    isError: trace.status === "error",
    args: trace.input,
    invalidate: context?.invalidate,
  };
  const programmatic = isProgrammaticTool(tool) ? tool : undefined;
  let call: Component;
  try {
    call = programmatic?.renderCall
      ? programmatic.renderCall(trace.input, theme, renderContext)
      : renderGenericTraceCall(trace, theme, options.expanded);
  } catch {
    call = renderGenericTraceCall(trace, theme, options.expanded);
  }
  const components = [orderedTraceCall(call, trace, order, theme)];
  if (renderedTrace.result && programmatic?.renderResult) {
    try {
      components.push(
        programmatic.renderResult(
          renderedTrace.result,
          { expanded: options.expanded, isPartial: trace.status === "running" },
          theme,
          renderContext,
        ),
      );
    } catch {
      // A stale persisted trace must not break the whole transcript.
    }
  }
  if (trace.status === "error" && trace.error) {
    components.push(new Text(theme.fg("error", trace.error), 4, 0));
  } else if (renderedTrace.result && !programmatic?.renderResult) {
    components.push(
      renderGenericTraceResult(renderedTrace, theme, options.expanded || options.isPartial),
    );
  }
  return components;
}

function renderCollapsedTraceCall(
  trace: RuntimeToolTrace,
  tool: CodeModeToolDefinition | undefined,
  theme: CodeModeRenderTheme,
): Text {
  const verb = trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran";
  const label = codeModeToolDisplayName(trace.name, tool?.label);
  const command = shortExecCommandName(trace);
  const detail = command ? theme.fg("muted", ` · ${command}`) : "";
  return new Text(
    `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(`${verb} ${label}`))}${detail}`,
    0,
    0,
  );
}

const SUBCOMMAND_TOOLS = new Set([
  "bun",
  "cargo",
  "docker",
  "gh",
  "git",
  "go",
  "kubectl",
  "npm",
  "npx",
  "pnpm",
  "terraform",
  "yarn",
]);

function shortExecCommandName(trace: RuntimeToolTrace): string | undefined {
  if (trace.name !== "exec_command" || !isObjectValue(trace.input)) return undefined;
  const command = trace.input["cmd"];
  if (!isStringValue(command)) return undefined;
  const tokens = shellSplit(command);
  const executable = safeCommandToken(tokens[0]);
  if (!executable) return undefined;
  if (!SUBCOMMAND_TOOLS.has(executable)) return executable;
  const subcommandIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
  const subcommand = safeCommandToken(tokens[subcommandIndex]);
  if (!subcommand) return executable;
  const parts = [executable, subcommand];
  if (
    (executable === "npm" ||
      executable === "pnpm" ||
      executable === "yarn" ||
      executable === "bun") &&
    subcommand === "run"
  ) {
    const script = safeCommandToken(tokens[subcommandIndex + 1]);
    if (script) parts.push(script);
  }
  return parts.join(" ");
}

function safeCommandToken(token: string | undefined): string | undefined {
  const name = token?.split(/[\\/]/).at(-1);
  return name && /^[A-Za-z0-9._+-]+$/.test(name) ? name : undefined;
}

function orderedTraceCall(
  component: Component,
  trace: RuntimeToolTrace,
  order: number,
  theme: CodeModeRenderTheme,
): Component {
  const label = `${order}.`;
  const prefix = `${theme.fg("muted", label)} `;
  const prefixWidth = visibleWidth(label) + 1;
  return {
    render(width: number): string[] {
      const lines = component.render(Math.max(1, width - prefixWidth));
      if (lines.length === 0) return [`${prefix}${theme.fg("toolTitle", theme.bold(trace.name))}`];
      const continuation = " ".repeat(prefixWidth);
      return lines.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
    },
    invalidate(): void {
      component.invalidate();
    },
  };
}

function withoutEmittedImages(
  trace: RuntimeToolTrace,
  emittedImages: Map<string, Set<string>>,
): RuntimeToolTrace {
  const normalized = normalizeTraceResult(trace);
  if (!normalized.result) return normalized;
  const content = normalized.result.content.filter(
    (item) => item.type !== "image" || !emittedImages.get(item.mimeType)?.has(item.data),
  );
  if (content.length === normalized.result.content.length) return normalized;
  return { ...normalized, result: { ...normalized.result, content } };
}

function normalizeTraceResult(trace: RuntimeToolTrace): RuntimeToolTrace {
  if (!trace.result) return trace;
  const rawContent: unknown = trace.result.content;
  if (Array.isArray(rawContent)) return trace;
  const content = isStringValue(rawContent) ? [{ type: "text" as const, text: rawContent }] : [];
  return { ...trace, result: { ...trace.result, content } };
}

function renderGenericTraceCall(
  trace: RuntimeToolTrace,
  theme: CodeModeRenderTheme,
  expanded: boolean,
): Text {
  const verb = trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran";
  let text = `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(`${verb} ${trace.name}`))}`;
  const input = traceInputText(trace.input, expanded);
  if (input) text += `\n${theme.fg("dim", "  └ ")}${theme.fg("accent", input)}`;
  return new Text(text, 0, 0);
}

function traceInputText(input: BoundaryValue, expanded: boolean): string {
  const command = isObjectValue(input) && isStringValue(input["cmd"]) ? input["cmd"] : undefined;
  const text = command ?? (isStringValue(input) ? input : safeRenderString(input));
  if (expanded) return text;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 100 ? compact : `${compact.slice(0, 97)}...`;
}

function renderGenericTraceResult(
  trace: RuntimeToolTrace,
  theme: CodeModeRenderTheme,
  full: boolean,
): Component {
  const result = trace.result;
  if (!result) return new Container();
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const images = result.content.filter(
    (item): item is typeof item & { data: string; mimeType: string } =>
      item.type === "image" && isStringValue(item.data) && isStringValue(item.mimeType),
  );
  const renderedText = theme.fg("toolOutput", text);
  return renderTextAndImages(full ? renderedText : previewText(renderedText, theme), images, theme);
}

function isProgrammaticTool(
  tool: CodeModeToolDefinition | undefined,
): tool is ProgrammaticCodeModeToolDefinition {
  return Boolean(tool && "invoke" in tool);
}

function safeRenderString(value: BoundaryValue): string {
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return "[unavailable input]";
  }
}
