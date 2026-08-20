import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type EmptyStateOptions = {
  title: string;
  description?: string;
  titleStyle?: (text: string) => string;
  descriptionStyle?: (text: string) => string;
  padding?: number;
};

export class EmptyState implements Component {
  private title: string;
  private description?: string;
  private titleStyle: (text: string) => string;
  private descriptionStyle: (text: string) => string;
  private padding: number;

  constructor(options: EmptyStateOptions) {
    this.title = options.title;
    this.description = options.description;
    this.titleStyle = options.titleStyle ?? ((t: string) => t);
    this.descriptionStyle =
      options.descriptionStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
    this.padding = options.padding ?? 2;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Top padding
    for (let i = 0; i < this.padding; i++) {
      lines.push("");
    }

    // Title centered
    const styledTitle = this.titleStyle(this.title);
    const titlePad = Math.max(0, width - styledTitle.length);
    const leftPad = Math.floor(titlePad / 2);
    lines.push(
      truncateToWidth(" ".repeat(leftPad) + styledTitle, width, "", true),
    );

    // Description centered
    if (this.description) {
      lines.push("");
      const styledDesc = this.descriptionStyle(this.description);
      const descPad = Math.max(0, width - styledDesc.length);
      const descLeftPad = Math.floor(descPad / 2);
      lines.push(
        truncateToWidth(" ".repeat(descLeftPad) + styledDesc, width, "", true),
      );
    }

    // Bottom padding
    for (let i = 0; i < this.padding; i++) {
      lines.push("");
    }

    return lines;
  }

  invalidate(): void {}
}
