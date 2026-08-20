import type { Component } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

export type TabItem = {
  id: string;
  label: string;
  badge?: string;
  content: Component;
};

export type TabsOptions = {
  items: TabItem[];
  activeId: string;
  activeStyle?: (text: string) => string;
  inactiveStyle?: (text: string) => string;
  badgeStyle?: (text: string) => string;
  separatorStyle?: (text: string) => string;
  onChange?: (id: string) => void;
};

export class Tabs implements Component {
  private items: TabItem[];
  private activeId: string;
  private activeStyle: (text: string) => string;
  private inactiveStyle: (text: string) => string;
  private badgeStyle: (text: string) => string;
  private separatorStyle: (text: string) => string;
  private onChange?: (id: string) => void;

  constructor(options: TabsOptions) {
    this.items = options.items;
    this.activeId = options.activeId;
    this.activeStyle =
      options.activeStyle ?? ((t: string) => `\x1b[1m${t}\x1b[0m`);
    this.inactiveStyle =
      options.inactiveStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
    this.badgeStyle =
      options.badgeStyle ?? ((t: string) => `\x1b[33m${t}\x1b[0m`);
    this.separatorStyle =
      options.separatorStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
    this.onChange = options.onChange;
  }

  setActiveId(id: string): void {
    this.activeId = id;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Tab bar
    const tabBar = this.renderTabBar(width);
    lines.push(tabBar);

    // Active tab content
    const activeTab = this.items.find((t) => t.id === this.activeId);
    if (activeTab) {
      lines.push(...activeTab.content.render(width));
    }

    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const activeIdx = this.items.findIndex((t) => t.id === this.activeId);

    if (kb.matches(data, "tui.editor.cursorLeft") || data === "h") {
      const prevIdx = (activeIdx - 1 + this.items.length) % this.items.length;
      this.activeId = this.items[prevIdx]!.id;
      this.onChange?.(this.activeId);
    } else if (kb.matches(data, "tui.editor.cursorRight") || data === "l") {
      const nextIdx = (activeIdx + 1) % this.items.length;
      this.activeId = this.items[nextIdx]!.id;
      this.onChange?.(this.activeId);
    }
  }

  invalidate(): void {
    for (const item of this.items) {
      item.content.invalidate();
    }
  }

  private renderTabBar(width: number): string {
    const parts: string[] = [];

    for (let i = 0; i < this.items.length; i++) {
      const tab = this.items[i]!;
      const isActive = tab.id === this.activeId;
      const styleFn = isActive ? this.activeStyle : this.inactiveStyle;

      let label = ` ${tab.label} `;
      if (tab.badge) {
        label += `${this.badgeStyle(`[${tab.badge}]`)} `;
      }

      parts.push(styleFn(label));

      if (i < this.items.length - 1) {
        parts.push(this.separatorStyle("|"));
      }
    }

    return truncateToWidth(parts.join(""), width, "", true);
  }
}
