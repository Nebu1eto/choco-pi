import type { Component } from "@earendil-works/pi-tui";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import type { ToolTheme } from "./theme";

export interface ToolHeaderField {
  label: string;
  value: string;
}

export interface ToolHeaderConfig {
  title: string;
  fields?: ToolHeaderField[];
}

export class ToolHeader implements Component {
  constructor(
    private config: ToolHeaderConfig,
    private theme: ToolTheme,
  ) {}

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  update(config: ToolHeaderConfig): void {
    this.config = config;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const th = this.theme;

    const title = new TruncatedText(
      th.fg("toolTitle", th.bold(this.config.title)),
    );
    lines.push(...title.render(width));

    for (const field of this.config.fields ?? []) {
      const prefix = th.fg("muted", `${field.label}: `);
      const text = new Text(prefix + field.value, 0, 0);
      lines.push(...text.render(width));
    }

    return lines;
  }
}
