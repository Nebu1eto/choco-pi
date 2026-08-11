import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type StatusLineOptions = {
  left?: (string | Component)[];
  right?: (string | Component)[];
  /** Between items on same side (default: " ") */
  separator?: string;
  style?: (text: string) => string;
};

export class StatusLine implements Component {
  private left: (string | Component)[];
  private right: (string | Component)[];
  private separator: string;
  private style: (text: string) => string;

  constructor(options?: StatusLineOptions) {
    this.left = options?.left ?? [];
    this.right = options?.right ?? [];
    this.separator = options?.separator ?? " ";
    this.style = options?.style ?? ((t: string) => t);
  }

  setLeft(items: (string | Component)[]): void {
    this.left = items;
  }

  setRight(items: (string | Component)[]): void {
    this.right = items;
  }

  render(width: number): string[] {
    const leftStr = this.renderItems(this.left, width);
    const rightStr = this.renderItems(this.right, width);

    if (!leftStr && !rightStr) {
      return [this.style(" ".repeat(width))];
    }

    if (!rightStr) {
      return [truncateToWidth(this.style(leftStr), width, "", true)];
    }

    if (!leftStr) {
      const rightVis = visibleWidth(rightStr);
      const pad = Math.max(0, width - rightVis);
      return [
        truncateToWidth(
          this.style(" ".repeat(pad) + rightStr),
          width,
          "",
          true,
        ),
      ];
    }

    // Both sides: left-pad-right
    const leftVis = visibleWidth(leftStr);
    const rightVis = visibleWidth(rightStr);
    const gap = Math.max(1, width - leftVis - rightVis);

    const line = leftStr + " ".repeat(gap) + rightStr;
    return [truncateToWidth(this.style(line), width, "", true)];
  }

  invalidate(): void {}

  private renderItems(items: (string | Component)[], width: number): string {
    const parts: string[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        parts.push(item);
      } else {
        const rendered = item.render(width);
        parts.push(rendered.join(" "));
      }
    }
    return parts.join(this.separator);
  }
}
