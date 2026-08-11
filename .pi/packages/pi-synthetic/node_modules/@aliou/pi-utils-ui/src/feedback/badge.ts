import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export class Badge implements Component {
  private text: string;
  private style?: (text: string) => string;

  constructor(text: string, style?: (text: string) => string) {
    this.text = text;
    this.style = style;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const content = ` ${this.text} `;
    const styled = this.style ? this.style(content) : content;
    return [truncateToWidth(styled, width, "", false)];
  }

  invalidate(): void {}
}
