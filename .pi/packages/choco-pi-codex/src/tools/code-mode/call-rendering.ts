import { isStringValue } from "../boundary.ts";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CodeModeRenderTracker } from "./render-tracker.ts";
import { codeModeToolDisplayName } from "./tool-identity.ts";
import type { CodeModeRenderContext, CodeModeRenderTheme } from "./types.ts";

const EXEC_SUMMARY = "Compose tools with JavaScript";

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
  text += theme.fg("muted", ` · ${EXEC_SUMMARY}`);
  const names = customToolNames(code);
  if (!context?.expanded && names.length > 0) {
    const labels = names.map((name) => codeModeToolDisplayName(name));
    text += `\n${theme.fg("dim", "  └ ")}${theme.fg("muted", "Calls ")}${theme.fg("accent", labels.join(" · "))}`;
  }
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
