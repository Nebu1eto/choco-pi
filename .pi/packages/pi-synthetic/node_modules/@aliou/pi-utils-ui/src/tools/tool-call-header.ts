import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { ToolTheme, ToolThemeColor } from "./theme";

export interface ToolCallHeaderOptionArg {
  label: string;
  value: string;
  tone?: ToolThemeColor;
}

export interface ToolCallHeaderLongArg {
  label?: string;
  value: string;
}

export interface ToolCallHeaderConfig {
  toolName: string;
  action?: string;
  mainArg?: string;
  optionArgs?: ToolCallHeaderOptionArg[];
  longArgs?: ToolCallHeaderLongArg[];
  showColon?: boolean;
}

/**
 * Standard tool call header pattern:
 * [Tool Name]: [Action] [Main arg] [Option args]
 * [Long args]
 */
export class ToolCallHeader implements Component {
  constructor(
    private config: ToolCallHeaderConfig,
    private theme: ToolTheme,
  ) {}

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  update(config: ToolCallHeaderConfig): void {
    this.config = config;
  }

  render(width: number): string[] {
    const th = this.theme;
    const showColon = this.config.showColon ?? Boolean(this.config.action);
    const toolName = showColon
      ? `${this.config.toolName}:`
      : this.config.toolName;

    const parts: string[] = [th.fg("toolTitle", th.bold(toolName))];

    if (this.config.action) {
      parts.push(th.fg("accent", this.config.action));
    }

    if (this.config.mainArg) {
      parts.push(th.fg("accent", this.config.mainArg));
    }

    for (const option of this.config.optionArgs ?? []) {
      const tone = option.tone ?? "dim";
      const label = option.label.trim().toLowerCase();
      parts.push(`${th.fg("muted", `${label}=`)}${th.fg(tone, option.value)}`);
    }

    const lines: string[] = [parts.join(" ")];

    for (const longArg of this.config.longArgs ?? []) {
      if (!longArg.value) continue;
      const normalizedLabel = longArg.label?.trim().toLowerCase();
      const label = normalizedLabel
        ? `${th.fg("muted", `${normalizedLabel}:`)} `
        : "";
      lines.push(`${label}${th.fg("dim", longArg.value)}`);
    }

    return new Text(lines.join("\n"), 0, 0).render(width);
  }
}
