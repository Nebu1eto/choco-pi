import type { Component } from "@earendil-works/pi-tui";
import { TruncatedText } from "@earendil-works/pi-tui";
import type { ToolTheme } from "../theme";

export type ToolCallFormatter<TCall> = (toolCall: TCall) => {
  label: string;
  detail?: string;
};

export class FailedToolCallsField<
  TCall extends { status: "running" | "done" | "error"; error?: string },
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
    if (!this.toolCalls) return [];
    const failed = this.toolCalls.filter(
      (toolCall) => toolCall.status === "error",
    );
    if (failed.length === 0) return [];

    const th = this.theme;
    const lines: string[] = [];

    for (const toolCall of failed) {
      const { label, detail } = this.formatter(toolCall);
      const text = detail ? `${th.bold(label)} ${detail}` : th.bold(label);
      const line = new TruncatedText(`${th.fg("error", "✗")} ${text}`);
      lines.push(...line.render(width));

      if (toolCall.error) {
        let errorText = toolCall.error;

        try {
          const parsed = JSON.parse(toolCall.error);
          if (parsed.content?.[0]?.text) {
            errorText = parsed.content[0].text;
            const apiErrorMatch = errorText.match(/API error \(\d+\): ({.+})$/);
            if (apiErrorMatch?.[1]) {
              try {
                const apiError = JSON.parse(apiErrorMatch[1]);
                if (apiError.error) {
                  errorText = apiError.error;
                }
              } catch {
                // keep original error text
              }
            }
          }
        } catch {
          // keep original error text
        }

        if (errorText.length > 150) {
          errorText = `${errorText.slice(0, 147)}...`;
        }

        const errorLine = new TruncatedText(`  ${th.fg("dim", errorText)}`);
        lines.push(...errorLine.render(width));
      }
    }

    return lines;
  }
}
