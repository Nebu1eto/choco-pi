import { isStringValue } from "../boundary.ts";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { expandHint } from "./render-content.ts";
import type { CodeModeRenderTracker } from "./render-tracker.ts";
import type { CodeModeRenderContext, CodeModeRenderTheme } from "./types.ts";

const BACKGROUND_SAFE_RESET = "\x1b[22;23;24;25;27;28;29;39m";

export function renderExecCall(
  args: { code?: unknown },
  theme: CodeModeRenderTheme,
  context: CodeModeRenderContext | undefined,
  tracker: CodeModeRenderTracker,
): Text {
  tracker.register(context?.toolCallId, context?.invalidate);
  const code = isStringValue(args.code) ? args.code : "";
  const status = tracker.status(context?.toolCallId);
  const verb = status === "running" ? "Running" : status === "yielded" ? "Started" : "Ran";
  let text = `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(`${verb} code`))}`;
  if (!context?.expanded && code.trim()) text += `\n${previewCode(code, theme)}`;
  const names = customToolNames(code);
  if (names.length > 0)
    text += `\n${theme.fg("dim", "  └ ")}${theme.fg("accent", names.join(" · "))}`;
  if (context?.expanded && code.trim())
    text += `\n\n${highlightCode(code, "javascript").join("\n")}`;
  return new Text(text, 0, 0);
}

export function renderWaitCall(
  args: { cell_id?: unknown; terminate?: unknown },
  theme: CodeModeRenderTheme,
  context: CodeModeRenderContext | undefined,
  tracker: CodeModeRenderTracker,
): Text {
  tracker.register(context?.toolCallId, context?.invalidate);
  const done = tracker.status(context?.toolCallId) !== "running";
  const terminate = args.terminate === true;
  const title = terminate
    ? done
      ? "Terminated code cell"
      : "Terminating code cell"
    : done
      ? "Waited for code cell"
      : "Waiting for code cell";
  const cell = isStringValue(args.cell_id) ? ` #${args.cell_id}` : "";
  return new Text(
    `${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(title))}${theme.fg("muted", cell)}`,
    0,
    0,
  );
}

function customToolNames(code: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of code.matchAll(/\btools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function previewCode(code: string, theme: CodeModeRenderTheme): string {
  const highlighted = highlightCode(code.trim(), "javascript");
  const lines = highlighted
    .slice(0, 3)
    .map((line) =>
      truncateToWidth(`  ${line}`, 100, "...").replaceAll("\x1b[0m", BACKGROUND_SAFE_RESET),
    );
  const skippedCount = highlighted.length - lines.length;
  if (skippedCount > 0)
    lines.push(theme.fg("muted", `  ... (${skippedCount} more lines, ${expandHint()})`));
  return lines.join("\n");
}
