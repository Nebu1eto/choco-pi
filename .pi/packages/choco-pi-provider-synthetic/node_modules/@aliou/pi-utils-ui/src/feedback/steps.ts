import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type StepItem = {
  title: string;
  description?: string;
  status: "pending" | "active" | "done" | "error";
};

export type StepsOptions = {
  items: StepItem[];
  compact?: boolean;
  activeStyle?: (text: string) => string;
  doneStyle?: (text: string) => string;
  errorStyle?: (text: string) => string;
  pendingStyle?: (text: string) => string;
};

export class Steps implements Component {
  private items: StepItem[];
  private _compact: boolean;
  private activeStyle: (text: string) => string;
  private doneStyle: (text: string) => string;
  private errorStyle: (text: string) => string;
  private pendingStyle: (text: string) => string;

  constructor(options: StepsOptions) {
    this.items = options.items;
    this._compact = options.compact ?? false;
    void this._compact;
    this.activeStyle =
      options.activeStyle ?? ((t: string) => `\x1b[1m${t}\x1b[0m`);
    this.doneStyle =
      options.doneStyle ?? ((t: string) => `\x1b[32m${t}\x1b[0m`);
    this.errorStyle =
      options.errorStyle ?? ((t: string) => `\x1b[31m${t}\x1b[0m`);
    this.pendingStyle =
      options.pendingStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
  }

  setItems(items: StepItem[]): void {
    this.items = items;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    for (let i = 0; i < this.items.length; i++) {
      const step = this.items[i]!;
      const isLast = i === this.items.length - 1;
      const styleFn = this.getStyle(step.status);

      // Step indicator + title
      const icon = this.getIcon(step.status);
      const title = styleFn(`${icon} ${step.title}`);
      lines.push(truncateToWidth(`  ${title}`, width, "", true));

      // Description
      if (step.description) {
        const desc = this.pendingStyle(step.description);
        lines.push(truncateToWidth(`    ${desc}`, width, "", true));
      }

      // Connector line between steps
      if (!isLast) {
        lines.push("  │");
      }
    }

    return lines;
  }

  invalidate(): void {}

  private getStyle(status: StepItem["status"]): (t: string) => string {
    switch (status) {
      case "active":
        return this.activeStyle;
      case "done":
        return this.doneStyle;
      case "error":
        return this.errorStyle;
      case "pending":
        return this.pendingStyle;
    }
  }

  private getIcon(status: StepItem["status"]): string {
    switch (status) {
      case "active":
        return ">";
      case "done":
        return "+";
      case "error":
        return "x";
      case "pending":
        return "o";
    }
  }
}
