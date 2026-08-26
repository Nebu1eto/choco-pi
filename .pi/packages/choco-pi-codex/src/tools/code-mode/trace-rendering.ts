import type { BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
import { parsePatchActions } from "../../patch/parser.ts";
import { formatPatchTarget } from "../apply-patch/rendering.ts";
import { shellSplit, splitOnConnectors } from "../../shell/tokenize.ts";
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
    return [
      orderedTraceCall(renderCollapsedTraceCall(trace, tool, theme, context), trace, order, theme),
    ];
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
  context: CodeModeRenderContext | undefined,
): Text {
  const verb = trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran";
  const label = codeModeToolDisplayName(trace.name, tool?.label);
  const summary = shortTraceSummary(trace, context?.cwd);
  const detail = summary ? theme.fg("muted", ` · ${summary}`) : "";
  return new Text(
    `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(`${verb} ${label}`))}${detail}`,
    0,
    0,
  );
}

function shortTraceSummary(trace: RuntimeToolTrace, cwd = process.cwd()): string | undefined {
  return shortExecCommandName(trace) ?? shortApplyPatchTarget(trace, cwd);
}

const SUBCOMMAND_TOOLS = new Set([
  "bun",
  "cargo",
  "docker",
  "gh",
  "git",
  "go",
  "kubectl",
  "nohup",
  "npm",
  "npx",
  "pnpm",
  "terraform",
  "yarn",
]);

const MISE_SIMPLE_SUBCOMMANDS = new Map([
  ["config", "config"],
  ["cfg", "config"],
  ["toml", "config"],
  ["install", "install"],
  ["i", "install"],
  ["lock", "lock"],
  ["settings", "settings"],
  ["tasks", "tasks"],
  ["t", "tasks"],
  ["task", "tasks"],
  ["use", "use"],
  ["u", "use"],
  ["ls", "ls"],
  ["list", "ls"],
  ["env", "env"],
  ["e", "env"],
  ["trust", "trust"],
  ["upgrade", "upgrade"],
  ["up", "upgrade"],
  ["watch", "watch"],
  ["w", "watch"],
  ["outdated", "outdated"],
  ["which", "which"],
  ["doctor", "doctor"],
  ["dr", "doctor"],
  ["generate", "generate"],
  ["gen", "generate"],
  ["g", "generate"],
]);

type ExplicitOptions = {
  booleans: ReadonlySet<string>;
  values: ReadonlySet<string>;
};

type ExplicitOptionResult =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "matched"; nextIndex: number; option: string; value?: string };

const MISE_GLOBAL_OPTIONS: ExplicitOptions = {
  values: new Set(["-C", "--cd", "-E", "--env", "-j", "--jobs", "--output"]),
  booleans: new Set([
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-y",
    "--yes",
    "--raw",
    "--silent",
    "--no-config",
    "--no-env",
    "--no-hooks",
    "--locked",
  ]),
};

const MISE_RUN_OPTIONS: ExplicitOptions = {
  values: new Set([
    ...MISE_GLOBAL_OPTIONS.values,
    "-o",
    "-s",
    "--shell",
    "-t",
    "--tool",
    "--affected-base",
    "--affected-head",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--task-cache",
    "--timeout",
  ]),
  booleans: new Set([
    ...[...MISE_GLOBAL_OPTIONS.booleans].filter(
      (option) => option !== "--no-env" && option !== "--no-hooks",
    ),
    "-f",
    "--force",
    "-n",
    "--dry-run",
    "-c",
    "--continue-on-error",
    "-r",
    "-S",
    "--all",
    "--affected",
    "--affected-explain",
    "--affected-json",
    "--deny-all",
    "--deny-env",
    "--deny-net",
    "--deny-read",
    "--deny-write",
    "--fresh-env",
    "--no-cache",
    "--no-deps",
    "--no-timings",
    "--skip-deps",
    "--skip-tools",
    "--task-cache-explain",
    "--task-cache-explain-json",
    "--task-cache-stats",
  ]),
};

const MISE_EXEC_OPTIONS: ExplicitOptions = {
  values: new Set([
    "-C",
    "--cd",
    "-E",
    "--env",
    "-c",
    "--command",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "--allow-write",
  ]),
  booleans: new Set([
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-y",
    "--yes",
    "--locked",
    "--silent",
    "--deny-all",
    "--deny-env",
    "--deny-net",
    "--deny-read",
    "--deny-write",
    "--fresh-env",
    "--no-deps",
  ]),
};

function shortExecCommandName(trace: RuntimeToolTrace): string | undefined {
  if (trace.name !== "exec_command" || !isObjectValue(trace.input)) return undefined;
  const command = trace.input["cmd"];
  if (!isStringValue(command)) return undefined;
  const inlineNode = inlineNodeCommandName(command);
  if (inlineNode) return inlineNode;
  const summaries = splitOnConnectors(shellSplit(command))
    .map(shortCommandName)
    .filter((summary): summary is string => summary !== undefined);
  return summaries.length > 0 ? summaries.join(", ") : undefined;
}

function inlineNodeCommandName(command: string): string | undefined {
  const firstLine = command.split(/\r?\n/, 1)[0];
  if (!firstLine) return undefined;
  const tokens = shellSplit(firstLine);
  const executable = safeCommandToken(tokens[0]);
  if (executable !== "node" || !tokens.some((token) => token.startsWith("<<"))) return undefined;
  return executable;
}

function shortCommandName(tokens: string[]): string | undefined {
  const mise = shortMiseCommandName(tokens);
  if (mise) return mise;
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

function shortMiseCommandName(tokens: string[]): string | undefined {
  let executableIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[executableIndex] ?? "")) {
    executableIndex += 1;
  }
  if (safeCommandToken(tokens[executableIndex]) !== "mise") return undefined;

  const subcommandIndex = skipExplicitLeadingOptions(
    tokens,
    executableIndex + 1,
    MISE_GLOBAL_OPTIONS,
  );
  if (subcommandIndex === undefined) return "mise";
  const subcommand = tokens[subcommandIndex];
  if (subcommand === "run" || subcommand === "r") {
    return shortMiseRunName(tokens.slice(subcommandIndex + 1));
  }
  if (subcommand === "exec" || subcommand === "x") {
    return shortMiseExecName(tokens, subcommandIndex + 1);
  }
  const simpleSubcommand = subcommand && MISE_SIMPLE_SUBCOMMANDS.get(subcommand);
  return simpleSubcommand ? `mise ${simpleSubcommand}` : "mise";
}

function shortMiseRunName(tokens: string[]): string {
  const taskGroups: string[][] = [[]];
  for (const token of tokens) {
    if (token === ":::") taskGroups.push([]);
    else taskGroups.at(-1)?.push(token);
  }
  const tasks: string[] = [];
  for (const [groupIndex, group] of taskGroups.entries()) {
    const taskIndex = groupIndex === 0 ? skipExplicitLeadingOptions(group, 0, MISE_RUN_OPTIONS) : 0;
    if (taskIndex === undefined) return "mise";
    const task = safeMiseTaskName(group[taskIndex]);
    if (!task) return "mise";
    tasks.push(task);
  }
  return tasks.map((task) => `mise run ${task}`).join(", ");
}

function shortMiseExecName(tokens: string[], startIndex: number): string {
  for (let index = startIndex; index < tokens.length;) {
    if (tokens[index] === "--") {
      const command = firstExecutableName(tokens.slice(index + 1));
      return command ? `mise exec ${command}` : "mise";
    }

    const option = explicitOptionAt(tokens, index, MISE_EXEC_OPTIONS);
    if (option.kind === "invalid") return "mise";
    if (option.kind === "matched") {
      if (option.option === "-c" || option.option === "--command") {
        const commandTokens = splitOnConnectors(shellSplit(option.value ?? ""))[0] ?? [];
        const command = firstExecutableName(commandTokens);
        return command ? `mise exec ${command}` : "mise";
      }
      index = option.nextIndex;
      continue;
    }
    index += 1;
  }
  return "mise";
}

function skipExplicitLeadingOptions(
  tokens: string[],
  startIndex: number,
  options: ExplicitOptions,
): number | undefined {
  let index = startIndex;
  for (;;) {
    if (index >= tokens.length) return index;
    const option = explicitOptionAt(tokens, index, options);
    if (option.kind === "invalid") return undefined;
    if (option.kind === "none") return index;
    index = option.nextIndex;
  }
}

function explicitOptionAt(
  tokens: string[],
  index: number,
  options: ExplicitOptions,
): ExplicitOptionResult {
  const token = tokens[index];
  if (!token || token[0] !== "-") return { kind: "none" };
  if (options.booleans.has(token)) {
    return { kind: "matched", nextIndex: index + 1, option: token };
  }
  if (options.values.has(token)) {
    const value = tokens[index + 1];
    if (!value || value[0] === "-" || value === ":::") return { kind: "invalid" };
    return { kind: "matched", nextIndex: index + 2, option: token, value };
  }
  const attached = explicitAttachedOption(token, options.values);
  if (attached) {
    return { kind: "matched", nextIndex: index + 1, ...attached };
  }
  return { kind: "invalid" };
}

function explicitAttachedOption(
  token: string,
  valueOptions: ReadonlySet<string>,
): { option: string; value: string } | undefined {
  const shortOption = token.length > 2 && token[1] !== "-";
  const equalsIndex = token.indexOf("=");
  if (!shortOption && equalsIndex <= 2) return undefined;

  const option = shortOption ? token.slice(0, 2) : token.slice(0, equalsIndex);
  const attached = token.slice(shortOption ? 2 : equalsIndex + 1);
  const value = shortOption && attached[0] === "=" ? attached.slice(1) : attached;
  return valueOptions.has(option) && value ? { option, value } : undefined;
}

function firstExecutableName(tokens: string[]): string | undefined {
  let executableIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[executableIndex] ?? "")) {
    executableIndex += 1;
  }
  return safeCommandToken(tokens[executableIndex]);
}

function safeMiseTaskName(token: string | undefined): string | undefined {
  return token && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(token) ? token : undefined;
}

function safeCommandToken(token: string | undefined): string | undefined {
  const name = token?.split(/[\\/]/).at(-1);
  return name && /^[A-Za-z0-9._+-]+$/.test(name) ? name : undefined;
}

function shortApplyPatchTarget(trace: RuntimeToolTrace, cwd: string): string | undefined {
  if (trace.name !== "apply_patch") return undefined;
  const patch = isStringValue(trace.input)
    ? trace.input
    : isObjectValue(trace.input) && isStringValue(trace.input["patch"])
      ? trace.input["patch"]
      : undefined;
  if (!patch) return undefined;
  try {
    const targets = parsePatchActions({ text: patch }).map((action) =>
      formatPatchTarget(action.path, action.movePath, cwd),
    );
    if (targets.length === 1) return targets[0];
    if (targets.length > 1) return `${targets.length} files`;
  } catch {
    return undefined;
  }
  return undefined;
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
