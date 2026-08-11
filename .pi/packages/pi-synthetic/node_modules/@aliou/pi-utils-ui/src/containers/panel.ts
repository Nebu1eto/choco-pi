import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type BorderStyle = "square" | "round";

export type PanelOptions = {
  title?: string | Component;
  body: Component;
  footer?: Component;
  borderStyle?: (text: string) => string;
  titleStyle?: (text: string) => string;
  /** "square" uses ┌┐└┘, "round" uses ╭╮╰╯ (default: "square") */
  border?: BorderStyle;
  /** Inner padding (default: 1) */
  padding?: number;
};

/** Border characters for each style */
const BORDERS: Record<
  BorderStyle,
  {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    left: string;
    right: string;
    footSep: string;
    h: string;
  }
> = {
  square: {
    tl: "┌",
    tr: "┐",
    bl: "└",
    br: "┘",
    left: "│",
    right: "│",
    footSep: "├",
    h: "─",
  },
  round: {
    tl: "╭",
    tr: "╮",
    bl: "╰",
    br: "╯",
    left: "│",
    right: "│",
    footSep: "├",
    h: "─",
  },
};

export class Panel implements Component {
  private title?: string | Component;
  private body: Component;
  private footer?: Component;
  private borderStyleFn: (text: string) => string;
  private titleStyle: (text: string) => string;
  private border: BorderStyle;
  private padding: number;

  constructor(options: PanelOptions) {
    this.title = options.title;
    this.body = options.body;
    this.footer = options.footer;
    this.borderStyleFn = options.borderStyle ?? ((t: string) => t);
    this.titleStyle = options.titleStyle ?? ((t: string) => t);
    this.border = options.border ?? "square";
    this.padding = options.padding ?? 1;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const s = this.borderStyleFn;
    const b = BORDERS[this.border];
    const pad = this.padding;
    const innerWidth = Math.max(0, width - 2);
    const contentWidth = Math.max(0, innerWidth - pad * 2);

    // Top border (with optional title)
    lines.push(this.renderTopBorder(s, b, width, innerWidth));

    // Top padding
    for (let i = 0; i < pad; i++) {
      lines.push(this.borderLine(s, b, innerWidth));
    }

    // Body
    const bodyLines = this.body.render(contentWidth);
    for (const line of bodyLines) {
      lines.push(this.contentLine(s, b, innerWidth, pad, line));
    }

    // Bottom padding
    for (let i = 0; i < pad; i++) {
      lines.push(this.borderLine(s, b, innerWidth));
    }

    // Footer separator + footer content
    if (this.footer) {
      lines.push(s(b.footSep) + s(b.h.repeat(innerWidth)) + s("┤"));
      const footerLines = this.footer.render(contentWidth);
      for (const line of footerLines) {
        lines.push(this.contentLine(s, b, innerWidth, pad, line));
      }
    }

    // Bottom border
    lines.push(s(b.bl) + s(b.h.repeat(innerWidth)) + s(b.br));

    return lines;
  }

  invalidate(): void {
    this.body.invalidate();
    this.footer?.invalidate();
  }

  private renderTopBorder(
    s: (t: string) => string,
    b: (typeof BORDERS)["square"],
    width: number,
    innerWidth: number,
  ): string {
    if (!this.title) {
      return s(b.tl) + s(b.h.repeat(innerWidth)) + s(b.tr);
    }

    const titleStr =
      typeof this.title === "string"
        ? this.title
        : this.title.render(innerWidth).join(" ");
    const styledTitle = this.titleStyle(` ${titleStr} `);
    const titleVisWidth = visibleWidth(styledTitle);

    const leftLen = 1;
    const rightLen = 1;
    const fillLen = Math.max(0, width - leftLen - titleVisWidth - rightLen);

    const rightFill = Math.ceil(fillLen / 2);
    const leftFill = fillLen - rightFill;

    return (
      s(b.tl) +
      s(b.h.repeat(leftFill)) +
      styledTitle +
      s(b.h.repeat(rightFill)) +
      s(b.tr)
    );
  }

  private borderLine(
    s: (t: string) => string,
    b: (typeof BORDERS)["square"],
    innerWidth: number,
  ): string {
    return s(b.left) + " ".repeat(innerWidth) + s(b.right);
  }

  private contentLine(
    s: (t: string) => string,
    b: (typeof BORDERS)["square"],
    innerWidth: number,
    pad: number,
    content: string,
  ): string {
    const padded =
      " ".repeat(pad) +
      truncateToWidth(content, Math.max(0, innerWidth - pad * 2), "", true) +
      " ".repeat(pad);
    const inner = truncateToWidth(padded, innerWidth, "", true);
    return s(b.left) + inner + s(b.right);
  }
}
