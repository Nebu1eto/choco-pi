import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type AlertOptions = {
  title?: string | Component;
  message: string | Component;
  borderStyle?: (text: string) => string;
  titleStyle?: (text: string) => string;
  iconStyle?: (text: string) => string;
  /** Prefix character, e.g. "!" or "i" */
  icon?: string;
  padding?: number;
};

export class Alert implements Component {
  private title?: string | Component;
  private message: string | Component;
  private borderStyle: (text: string) => string;
  private titleStyle: (text: string) => string;
  private iconStyle: (text: string) => string;
  private icon: string;
  private padding: number;

  constructor(options: AlertOptions) {
    this.title = options.title;
    this.message = options.message;
    this.borderStyle = options.borderStyle ?? ((t: string) => t);
    this.titleStyle = options.titleStyle ?? ((t: string) => t);
    this.iconStyle = options.iconStyle ?? ((t: string) => t);
    this.icon = options.icon ?? "!";
    this.padding = options.padding ?? 1;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const s = this.borderStyle;
    const pad = this.padding;
    const innerWidth = Math.max(0, width - 2);
    const contentWidth = Math.max(0, innerWidth - pad * 2);

    // Top border
    lines.push(s("┌") + s("─".repeat(innerWidth)) + s("┐"));

    // Title row
    if (this.title) {
      const titleStr =
        typeof this.title === "string"
          ? this.title
          : this.title.render(contentWidth).join(" ");
      const iconPart = this.iconStyle(` ${this.icon} `);
      const titlePart = this.titleStyle(` ${titleStr} `);
      const titleLine = iconPart + titlePart;
      lines.push(this.contentLine(s, innerWidth, pad, titleLine));

      // Separator
      lines.push(s("├") + s("─".repeat(innerWidth)) + s("┤"));
    }

    // Top padding
    for (let i = 0; i < pad; i++) {
      lines.push(s("│") + " ".repeat(innerWidth) + s("│"));
    }

    // Message
    if (typeof this.message === "string") {
      const wrapped = wrapTextWithAnsi(this.message, contentWidth);
      for (const line of wrapped) {
        lines.push(this.contentLine(s, innerWidth, pad, line));
      }
    } else {
      const msgLines = this.message.render(contentWidth);
      for (const line of msgLines) {
        lines.push(this.contentLine(s, innerWidth, pad, line));
      }
    }

    // Bottom padding
    for (let i = 0; i < pad; i++) {
      lines.push(s("│") + " ".repeat(innerWidth) + s("│"));
    }

    // Bottom border
    lines.push(s("└") + s("─".repeat(innerWidth)) + s("┘"));

    return lines;
  }

  invalidate(): void {}

  private contentLine(
    s: (t: string) => string,
    innerWidth: number,
    pad: number,
    content: string,
  ): string {
    const padded =
      " ".repeat(pad) +
      truncateToWidth(content, Math.max(0, innerWidth - pad * 2), "", true) +
      " ".repeat(pad);
    const inner = truncateToWidth(padded, innerWidth, "", true);
    return s("│") + inner + s("│");
  }
}
