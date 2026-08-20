import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type BreadcrumbItem = {
  id: string;
  label: string;
};

export type BreadcrumbsOptions = {
  items: BreadcrumbItem[];
  /** Default: " > " */
  separator?: string;
  activeStyle?: (text: string) => string;
  inactiveStyle?: (text: string) => string;
  onSelect?: (id: string) => void;
};

export class Breadcrumbs implements Component {
  private items: BreadcrumbItem[];
  private separator: string;
  private activeStyle: (text: string) => string;
  private inactiveStyle: (text: string) => string;
  private _onSelect?: (id: string) => void;

  constructor(options: BreadcrumbsOptions) {
    this.items = options.items;
    this.separator = options.separator ?? " > ";
    this.activeStyle =
      options.activeStyle ?? ((t: string) => `\x1b[1m${t}\x1b[0m`);
    this.inactiveStyle = options.inactiveStyle ?? ((t: string) => t);
    this._onSelect = options.onSelect;
    void this._onSelect;
  }

  setItems(items: BreadcrumbItem[]): void {
    this.items = items;
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [];

    const parts: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const isLast = i === this.items.length - 1;
      const styleFn = isLast ? this.activeStyle : this.inactiveStyle;

      parts.push(styleFn(item.label));
      if (!isLast) {
        parts.push(this.separator);
      }
    }

    const full = parts.join("");

    // If it fits, return as-is
    if (visibleWidth(full) <= width) {
      return [truncateToWidth(full, width, "", true)];
    }

    // Truncate from left: keep last item + "... > " prefix for each preceding
    const lastItem = this.items[this.items.length - 1]!;
    const lastStyled = this.activeStyle(lastItem.label);
    const prefix = this.inactiveStyle("...") + this.separator;

    let result = prefix + lastStyled;
    // Add items from right to left as space allows
    for (let i = this.items.length - 2; i >= 0; i--) {
      const candidate =
        this.inactiveStyle(this.items[i]!.label) + this.separator + result;
      if (visibleWidth(candidate) <= width) {
        result = candidate;
      } else {
        result = prefix + result.slice(prefix.length);
        break;
      }
    }

    return [truncateToWidth(result, width, "", true)];
  }

  handleInput?(_data: string): void {}

  invalidate(): void {}
}
