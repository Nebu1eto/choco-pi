import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolTheme } from "../theme";

export type ToolCallFormatter<TCall> = (toolCall: TCall) => {
  label: string;
  detail?: string;
};

export class ToolCallListField<
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
    const lines: string[] = [];

    lines.push(th.fg("muted", `Tool calls (${this.toolCalls.length}):`));

    for (const toolCall of this.toolCalls) {
      const indicator =
        toolCall.status === "running"
          ? " "
          : toolCall.status === "done"
            ? th.fg("success", "✓")
            : th.fg("error", "✗");

      const { label, detail } = this.formatter(toolCall);
      const text = detail ? `${th.bold(label)} ${detail}` : th.bold(label);

      const prefix = `  ${indicator} `;
      const prefixWidth = visibleWidth(prefix);
      const textWidth = Math.max(1, width - prefixWidth);
      const wrapped = wrapTextWithAnsi(text, textWidth);
      const indent = " ".repeat(prefixWidth);

      for (let i = 0; i < wrapped.length; i++) {
        lines.push(i === 0 ? prefix + wrapped[i] : indent + wrapped[i]);
      }
    }

    return lines;
  }
}
