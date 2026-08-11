import type { Component } from "@earendil-works/pi-tui";
import { Spacer } from "@earendil-works/pi-tui";

export type StackOptions = {
  /** Blank lines between children (default: 0) */
  gap?: number;
  /** Rendered between children instead of gap */
  separator?: Component;
};

export class Stack implements Component {
  private children: Component[] = [];
  private gap: number;
  private separator?: Component;

  constructor(options?: StackOptions) {
    this.gap = options?.gap ?? 0;
    this.separator = options?.separator;
  }

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const idx = this.children.indexOf(component);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  clear(): void {
    this.children = [];
  }

  render(width: number): string[] {
    if (this.children.length === 0) return [];

    const lines: string[] = [];

    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i]!;
      const childLines = child.render(width);
      lines.push(...childLines);

      // Add gap or separator between children (not after last)
      if (i < this.children.length - 1) {
        if (this.separator) {
          lines.push(...this.separator.render(width));
        } else if (this.gap > 0) {
          const spacer = new Spacer(this.gap);
          lines.push(...spacer.render(width));
        }
      }
    }

    return lines;
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate();
    }
    this.separator?.invalidate();
  }
}
