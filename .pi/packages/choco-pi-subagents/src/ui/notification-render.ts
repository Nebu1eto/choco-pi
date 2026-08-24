import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderAgentName } from "../agent-color.ts";
import type { NotificationDetails } from "../types.ts";
import { fgPreservingNestedStyles, formatMs, formatTokens, formatTurns } from "./agent-widget.ts";

const MAX_DETAIL_CELLS = 120;
const MAX_RESULT_CELLS = 116;
const MAX_TRANSCRIPT_PATH_CELLS = 96;
const MAX_EXPANDED_LINES = 30;

interface StatusPresentation {
  icon: string;
  iconColor: "dim" | "error" | "success" | "warning";
  outputColor: "error" | "toolOutput" | "warning";
  title: string;
}

function compact(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 3))}...`;
}

function statusPresentation(status: string): StatusPresentation {
  switch (status) {
    case "completed":
      return { icon: "✓", iconColor: "success", outputColor: "toolOutput", title: "completed" };
    case "steered":
      return { icon: "✓", iconColor: "warning", outputColor: "toolOutput", title: "wrapped up" };
    case "stopped":
      return { icon: "■", iconColor: "dim", outputColor: "toolOutput", title: "stopped" };
    case "aborted":
      return { icon: "✗", iconColor: "error", outputColor: "warning", title: "aborted" };
    case "error":
      return { icon: "✗", iconColor: "error", outputColor: "error", title: "failed" };
    default:
      return {
        icon: "•",
        iconColor: "dim",
        outputColor: "toolOutput",
        title: compact(status || "finished", 32),
      };
  }
}

function statsParts(details: NotificationDetails): string[] {
  const parts: string[] = [];
  if (details.turnCount > 0) parts.push(formatTurns(details.turnCount, details.maxTurns));
  if (details.toolUses > 0) {
    parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
  }
  if (details.totalTokens > 0) parts.push(formatTokens(details.totalTokens));
  if (details.durationMs > 0) parts.push(formatMs(details.durationMs));
  return parts;
}

function renderDetail(details: NotificationDetails, theme: Theme): string {
  const stats = statsParts(details);
  const statsText = stats.join(" · ");
  const statsWidth = statsText ? statsText.length + 3 : 0;
  const descriptionWidth = Math.max(24, MAX_DETAIL_CELLS - statsWidth);
  const description = theme.fg("accent", compact(details.description, descriptionWidth));
  const separator = ` ${theme.fg("dim", "·")} `;
  const renderedStats = stats.map((part) => fgPreservingNestedStyles(theme, "dim", part));
  return theme.fg("dim", "  └ ") + [description, ...renderedStats].join(separator);
}

function transcriptPath(outputFile: string): string {
  const normalized = outputFile.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  let display = normalized;
  if (parts.length > 2) display = `…/${parts.slice(-2).join("/")}`;
  return compact(display, MAX_TRANSCRIPT_PATH_CELLS);
}

function resultLines(details: NotificationDetails, expanded: boolean): string[] {
  const sourceLines = details.resultPreview.split("\n");
  if (!expanded) return [compact(sourceLines[0] ?? "", MAX_RESULT_CELLS)];

  const rendered = sourceLines
    .slice(0, MAX_EXPANDED_LINES)
    .map((line) => compact(line, MAX_RESULT_CELLS));
  if (sourceLines.length > MAX_EXPANDED_LINES) rendered.push("... (truncated)");
  return rendered;
}

function renderOne(details: NotificationDetails, expanded: boolean, theme: Theme): string {
  const status = statusPresentation(details.status);
  const icon = theme.fg(status.iconColor, status.icon);
  // The role badge matches the launch row (`▸ implementer  …`), so a completion
  // notice is attributable to its agent at a glance instead of reading "Agent".
  const agent = renderAgentName(details.type, theme, { fallbackColor: "toolTitle", bold: true });
  const title = theme.fg("toolTitle", theme.bold(status.title));
  const lines = [`${icon} ${agent} ${title}`, renderDetail(details, theme)];

  if (details.status === "error") {
    lines.push(
      theme.fg("error", `    Error: ${compact(details.error ?? "unknown", MAX_RESULT_CELLS)}`),
    );
  }
  for (const line of resultLines(details, expanded)) {
    lines.push(theme.fg(status.outputColor, `    ${line}`));
  }

  if (details.outputFile) {
    lines.push(
      `    ${theme.fg("muted", "Transcript")}${theme.fg("dim", " · ")}${theme.fg(
        "accent",
        transcriptPath(details.outputFile),
      )}`,
    );
  }
  return lines.join("\n");
}

/** Render one notification and any grouped completions without host or TUI side effects. */
export function renderSubagentNotification(
  details: NotificationDetails,
  options: { expanded: boolean },
  theme: Theme,
): string {
  return [details, ...(details.others ?? [])]
    .map((item) => renderOne(item, options.expanded, theme))
    .join("\n");
}
