import type { MessageRenderer, MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "./deps/pi-tui.ts";
import { fitLines } from "./tui-fit.ts";
import {
  formatTurnSummaryLine,
  type TurnSummaryDetails,
  type TurnSummaryEvent,
} from "./turn-summary.ts";

type TurnSummaryMessage = Parameters<MessageRenderer<TurnSummaryDetails>>[0];

function severityColor(
  theme: Theme,
  severity: TurnSummaryEvent["severity"],
): (s: string) => string {
  if (severity === "error") return (s) => theme.fg("error", s);
  if (severity === "warning") return (s) => theme.fg("warning", s);
  return (s) => theme.fg("dim", s);
}

function eventLine(theme: Theme, event: TurnSummaryEvent): string {
  const loc = event.line !== undefined ? `:${event.line}` : "";
  if (event.kind === "diagnostic") {
    const color = severityColor(theme, event.severity);
    const rule = event.ruleId ? ` ${event.ruleId}` : "";
    const desc = event.description ? ` — ${event.description}` : "";
    return `    ${color(`[${event.tool}${rule}]`)}${loc}${desc}`;
  }
  if (event.kind === "autofix") {
    const desc = event.description ? ` — ${event.description}` : "";
    return `    ${theme.fg("success", `[autofix:${event.tool}]`)}${loc}${desc}`;
  }
  return `    ${theme.fg("accent", `[format:${event.tool}]`)}`;
}

function buildExpandedLines(details: TurnSummaryDetails, theme: Theme): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("choco-pi-lsp turn summary")));
  const sortedFiles = [...details.files].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  for (const file of sortedFiles) {
    lines.push(`  ${theme.bold(file.displayPath)}`);
    const formats = file.events.filter((e) => e.kind === "format");
    const autofixes = file.events.filter((e) => e.kind === "autofix");
    const diagnostics = file.events.filter((e) => e.kind === "diagnostic");
    for (const event of [...formats, ...autofixes, ...diagnostics]) {
      lines.push(eventLine(theme, event));
    }
  }
  return lines;
}

export function renderTurnSummaryMessage(
  message: TurnSummaryMessage,
  options: MessageRenderOptions,
  theme: Theme,
): Component | undefined {
  const details = message.details;
  if (!details) return undefined;

  if (!options.expanded) {
    const line = formatTurnSummaryLine(details);
    const text = theme.fg("accent", line);
    return {
      render: (width: number) => fitLines([text], width),
      invalidate: () => {},
    };
  }

  const lines = buildExpandedLines(details, theme);
  return {
    render: (width: number) => fitLines(lines, width),
    invalidate: () => {},
  };
}
