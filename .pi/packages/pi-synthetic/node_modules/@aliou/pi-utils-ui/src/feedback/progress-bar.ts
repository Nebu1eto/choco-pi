import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type ProgressBarOptions = {
  /** 0..1 */
  value: number;
  label?: string | Component;
  detail?: string | Component;
  showPercent?: boolean;
  filledStyle?: (text: string) => string;
  emptyStyle?: (text: string) => string;
  labelStyle?: (text: string) => string;
  /** Bar width. Omit = fill available. */
  width?: number;
};

export class ProgressBar implements Component {
  private value: number;
  private label?: string | Component;
  private detail?: string | Component;
  private showPercent: boolean;
  private filledStyle: (text: string) => string;
  private emptyStyle: (text: string) => string;
  private labelStyle: (text: string) => string;
  private barWidth?: number;

  constructor(options: ProgressBarOptions) {
    this.value = Math.max(0, Math.min(1, options.value));
    this.label = options.label;
    this.detail = options.detail;
    this.showPercent = options.showPercent ?? true;
    this.filledStyle =
      options.filledStyle ?? ((t: string) => `\x1b[42m${t}\x1b[0m`);
    this.emptyStyle =
      options.emptyStyle ?? ((t: string) => `\x1b[47m${t}\x1b[0m`);
    this.labelStyle = options.labelStyle ?? ((t: string) => t);
    this.barWidth = options.width;
  }

  setValue(value: number): void {
    this.value = Math.max(0, Math.min(1, value));
  }

  setLabel(label: string | Component): void {
    this.label = label;
  }

  setDetail(detail: string | Component): void {
    this.detail = detail;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Label row
    if (this.label) {
      const labelStr =
        typeof this.label === "string"
          ? this.labelStyle(this.label)
          : this.label.render(width).join(" ");
      const detailStr = this.detailStr(width);

      let labelLine = labelStr;
      if (detailStr) {
        labelLine += `  ${detailStr}`;
      }
      lines.push(truncateToWidth(labelLine, width, "", true));
    }

    // Bar
    const barWidth = this.barWidth ?? width;
    const filledLen = Math.round(this.value * barWidth);
    const emptyLen = Math.max(0, barWidth - filledLen);

    const filled = this.filledStyle("█".repeat(filledLen));
    const empty = this.emptyStyle("░".repeat(emptyLen));
    const bar = truncateToWidth(filled + empty, barWidth, "", true);
    lines.push(bar);

    // Percent row
    if (this.showPercent && !this.label) {
      const pct = `${Math.round(this.value * 100)}%`;
      lines.push(truncateToWidth(pct, width, "", true));
    }

    return lines;
  }

  invalidate(): void {}

  private detailStr(width: number): string {
    if (!this.detail) return "";
    return typeof this.detail === "string"
      ? this.detail
      : this.detail.render(width).join(" ");
  }
}
