import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderAgentName } from "../agent-color.ts";
import type { NotificationDetails } from "../types.ts";
import {
  fgPreservingNestedStyles,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
} from "./agent-widget.ts";

const MAX_DETAIL_CELLS = 118;
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
      return { icon: "✓", iconColor: "success", outputColor: "toolOutput", title: "Completed" };
    case "steered":
      return { icon: "✓", iconColor: "warning", outputColor: "toolOutput", title: "Wrapped up" };
    case "stopped":
      return { icon: "■", iconColor: "dim", outputColor: "toolOutput", title: "Stopped" };
    case "aborted":
      return { icon: "✗", iconColor: "error", outputColor: "warning", title: "Aborted" };
    case "error":
      return { icon: "✗", iconColor: "error", outputColor: "error", title: "Failed" };
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

function renderDetail(
  details: NotificationDetails,
  agent: string,
  agentWidth: number,
  theme: Theme,
): string {
  const stats = statsParts(details);
  const statsText = stats.join(" · ");
  const statsWidth = statsText ? statsText.length + 3 : 0;
  const descriptionWidth = Math.max(24, MAX_DETAIL_CELLS - statsWidth - agentWidth - 3);
  const description = theme.fg("accent", compact(details.description, descriptionWidth));
  const separator = ` ${theme.fg("dim", "·")} `;
  const renderedStats = stats.map((part) => fgPreservingNestedStyles(theme, "dim", part));
  return theme.fg("dim", "    └ ") + [agent, description, ...renderedStats].join(separator);
}

function transcriptPath(outputFile: string): string {
  const normalized = outputFile.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  let display = normalized;
  if (parts.length > 2) display = `…/${parts.slice(-2).join("/")}`;
  return compact(display, MAX_TRANSCRIPT_PATH_CELLS);
}

function normalizeResultLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("```") || /^#{1,6}(?:\s+|$)/.test(trimmed)) return "";
  if (/^[-*_]{3,}$/.test(trimmed)) return "";

  return (
    trimmed
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      // Inline emphasis survives the block-level strip above and still reads as
      // raw markup in a one-line summary; backticks stay, since an identifier
      // like `subagent_type` reads better quoted.
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, "$1$2")
      .trim()
  );
}

function resultLines(details: NotificationDetails, expanded: boolean): string[] {
  const sourceLines = details.resultPreview
    .split("\n")
    .map(normalizeResultLine)
    .filter((line) => line.length > 0);
  if (!expanded) return [compact(sourceLines[0] ?? "Completed", MAX_RESULT_CELLS)];

  const rendered = sourceLines
    .slice(0, MAX_EXPANDED_LINES)
    .map((line) => compact(line, MAX_RESULT_CELLS));
  if (sourceLines.length > MAX_EXPANDED_LINES) rendered.push("... (truncated)");
  return rendered.length > 0 ? rendered : ["Completed"];
}

function notificationBackground(status: string, theme: Theme): string {
  const color = status === "error" || status === "aborted" ? "toolErrorBg" : "toolSuccessBg";
  // Lightweight host themes may provide only foreground styling.
  return theme.getBgAnsi?.(color) ?? "";
}

function renderOne(details: NotificationDetails, expanded: boolean, theme: Theme): string {
  const status = statusPresentation(details.status);
  const background = notificationBackground(details.status, theme);
  const icon = theme.fg(status.iconColor, status.icon);
  const toolLabel = theme.fg("toolTitle", theme.bold(`Delegation: ${status.title}`));
  const agentLabel = details.type ? getDisplayName(details.type) : "Agent";
  const agent = renderAgentName(details.type, theme, {
    fallbackColor: "toolTitle",
    restoreBackground: background,
    bold: true,
  });
  const lines = [
    ` ${theme.fg("dim", "•")} ${icon} ${toolLabel}`,
    renderDetail(details, agent, agentLabel.length, theme),
  ];

  if (details.status === "error") {
    lines.push(
      theme.fg("error", `      Error: ${compact(details.error ?? "unknown", MAX_RESULT_CELLS)}`),
    );
  }
  for (const line of resultLines(details, expanded)) {
    lines.push(theme.fg(status.outputColor, `      ${line}`));
  }

  if (details.outputFile) {
    lines.push(
      `      ${theme.fg("muted", "Transcript")}${theme.fg("dim", " · ")}${theme.fg(
        "accent",
        transcriptPath(details.outputFile),
      )}`,
    );
  }
  // Match settled tool cells with one empty band row above and below the content.
  // Leave each row open so the host Text component pads it to its render width.
  return ["", ...lines, ""].map((line) => background + line).join("\n");
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
