/**
 * Tool calls in the review's side chat, drawn through the exact component
 * the main agent's transcript uses.
 */
import { isJsonRecord, isString } from "../../lib/runtime-values.ts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewChatToolCall } from "../core/ask.ts";
import { COLLAPSED_TOOL_RENDER_WIDTH, terminalSafeValue } from "./review-view-format.ts";
import type { ReviewContext, ToolExecutionDefinition } from "./review-view-state.ts";

function withBuiltInRenderers(
  name: string,
  definition: ToolExecutionDefinition,
  cwd: string,
  cache: Map<string, ToolExecutionDefinition>,
): ToolExecutionDefinition {
  let builtIn = cache.get(name);
  if (!cache.has(name)) {
    try {
      switch (name) {
        case "read":
          builtIn = createReadToolDefinition(cwd);
          break;
        case "bash":
          builtIn = createBashToolDefinition(cwd);
          break;
        case "powershell":
          builtIn = createPowerShellToolDefinition(cwd);
          break;
        case "edit":
          builtIn = createEditToolDefinition(cwd);
          break;
        case "write":
          builtIn = createWriteToolDefinition(cwd);
          break;
        case "grep":
          builtIn = createGrepToolDefinition(cwd);
          break;
        case "find":
          builtIn = createFindToolDefinition(cwd);
          break;
        case "ls":
          builtIn = createLsToolDefinition(cwd);
          break;
        default:
          builtIn = undefined;
      }
    } catch {
      builtIn = undefined;
    }
    cache.set(name, builtIn);
  }

  if (!definition) return builtIn;
  if (!builtIn) return definition;
  return {
    ...definition,
    renderCall: definition.renderCall ?? builtIn.renderCall,
    renderResult: definition.renderResult ?? builtIn.renderResult,
  };
}

export function renderToolEntry(
  ctx: ReviewContext,
  entry: ReviewChatToolCall,
  width: number,
): readonly string[] {
  let toolView = ctx.toolViews.get(entry.toolCallId);
  if (!toolView) {
    // The session's registered definition carries the tool's own
    // renderers — exactly what the main transcript passes — so
    // extension and MCP tools render their concise titles instead
    // of the raw argument/output fallback.
    let registeredDefinition: ToolExecutionDefinition;
    try {
      // SAFETY: ReviewChat exposes the host definition consumed by ToolExecutionComponent.
      registeredDefinition = ctx.chat?.toolDefinition(entry.toolName) as ToolExecutionDefinition;
    } catch {
      registeredDefinition = undefined;
    }
    const definition = withBuiltInRenderers(
      entry.toolName,
      registeredDefinition,
      ctx.options.reviewRoot,
      ctx.builtInToolDefinitions,
    );
    const component = new ToolExecutionComponent(
      entry.toolName,
      entry.toolCallId,
      terminalSafeValue(entry.args),
      undefined,
      definition,
      ctx.tui,
      ctx.options.reviewRoot,
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.setExpanded(ctx.toolsExpanded);
    toolView = { component };
    ctx.toolViews.set(entry.toolCallId, toolView);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const result = entry.result as { content?: unknown; details?: unknown } | undefined;
  if (
    result &&
    Array.isArray(result.content) &&
    (toolView.result !== entry.result || toolView.done !== entry.done)
  ) {
    toolView.component.updateResult(
      {
        content: result.content.map((item) =>
          isJsonRecord(item) && isString(item.text)
            ? { ...item, text: terminalSafeValue(item.text) }
            : item,
        ),
        // Pi's renderers draw details as given (an edit's diff, paths), so they are
        // made terminal-safe here too.
        details: terminalSafeValue(result.details),
        isError: entry.isError === true,
      },
      !entry.done,
    );
    toolView.result = entry.result;
    toolView.done = entry.done;
  }
  // Expanded keeps the component's own wrapping at the pane width,
  // where full content is the point.
  if (ctx.toolsExpanded) return toolView.component.render(width);
  const wide = toolView.component.render(Math.max(width, COLLAPSED_TOOL_RENDER_WIDTH));
  // A failed tool keeps its message visible even collapsed; hiding
  // an error behind Ctrl+O would read as a hang.
  if (entry.isError === true) {
    return wide.map((line) => truncateToWidth(line, width, "…"));
  }
  // Collapsed to the maximum: the one-line call title, like a folded
  // row, with Ctrl+O holding everything else.
  const title = wide.find((line) => stripTerminalSequences(line).trim().length > 0);
  return title === undefined ? [] : [truncateToWidth(title, width, "…")];
}

export function toggleToolExpansion(ctx: ReviewContext): void {
  ctx.toolsExpanded = !ctx.toolsExpanded;
  for (const toolView of ctx.toolViews.values()) toolView.component.setExpanded(ctx.toolsExpanded);
  ctx.tui.requestRender();
}
