import type { Component } from "@earendil-works/pi-tui";
import { TruncatedText } from "@earendil-works/pi-tui";
import type { ToolTheme } from "../theme";
import type { ToolCallFormatter } from "./tool-call-list";

export class ToolCallSummaryField<
  TCall extends { status: "running" | "done" | "error" },
> implements Component
{
  constructor(
    private toolCalls: TCall[],
    private formatter: ToolCallFormatter<TCall>,
    private theme: ToolTheme,
  ) {}

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.toolCalls || this.toolCalls.length === 0) return [];

    const th = this.theme;
    const names = this.toolCalls.map(
      (toolCall) => this.formatter(toolCall).label,
    );
    const counts: Record<string, number> = {};
    for (const name of names) {
      counts[name] = (counts[name] ?? 0) + 1;
    }

    const summary = Object.entries(counts)
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(", ");

    const prefix = `${this.toolCalls.length} ${pluralize(this.toolCalls.length, "tool call")}`;
    const line = new TruncatedText(th.fg("muted", `${prefix}: `) + summary);
    return line.render(width);
  }
}

function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
