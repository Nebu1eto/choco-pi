import type { Component, SettingsListTheme } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { renderSettingsPanel } from "./render-settings-panel";

/**
 * A submenu component for selecting one item from a large list using fuzzy search.
 *
 * Features:
 * - Type to filter items via fuzzy search
 * - Navigate with up/down arrows
 * - Enter to select
 * - Esc to cancel
 * - Shows highlighted item clearly
 * - Scrolls when items exceed maxVisible
 */

export interface FuzzySelectorOptions {
  label: string;
  items: string[];
  currentValue?: string; // pre-select this item if present
  theme: SettingsListTheme;
  onSelect: (value: string) => void;
  onDone: () => void;
  maxVisible?: number; // default 10
  searchThreshold?: number; // default 7, switch to fuzzy search when item count is above this
}

export class FuzzySelector implements Component {
  private allItems: string[];
  private filteredItems: string[];
  private label: string;
  private theme: SettingsListTheme;
  private onSelect: (value: string) => void;
  private onDone: () => void;
  private selectedIndex = 0;
  private maxVisible: number;
  private input: Input;
  private query = "";
  private useSearch: boolean;

  constructor(options: FuzzySelectorOptions) {
    this.allItems = [...options.items];
    this.filteredItems = [...this.allItems];
    this.label = options.label;
    this.theme = options.theme;
    this.onSelect = options.onSelect;
    this.onDone = options.onDone;
    this.maxVisible = options.maxVisible ?? 10;
    const threshold = options.searchThreshold ?? 7;
    this.useSearch = this.allItems.length > threshold;
    this.input = new Input();

    // Pre-select currentValue if provided and exists in the list
    if (options.currentValue) {
      const index = this.allItems.indexOf(options.currentValue);
      if (index !== -1) {
        this.selectedIndex = index;
      }
    }

    this.input.onSubmit = () => {
      this.selectCurrent();
    };
    this.input.onEscape = () => {
      this.onDone();
    };
  }

  private selectCurrent() {
    if (this.filteredItems.length === 0) return;
    const selected = this.filteredItems[this.selectedIndex];
    if (selected) {
      this.onSelect(selected);
    }
  }

  private updateFilter() {
    this.query = this.input.getValue();
    if (this.query.trim() === "") {
      this.filteredItems = [...this.allItems];
    } else {
      this.filteredItems = fuzzyFilter(
        this.allItems,
        this.query,
        (item) => item,
      );
    }
    // Reset cursor to 0 when filtering
    this.selectedIndex = 0;
  }

  invalidate() {}

  render(width: number): string[] {
    return renderSettingsPanel(width, this.label, this.theme, (innerWidth) => {
      const lines: string[] = [];

      if (this.useSearch) {
        lines.push(this.theme.hint("Search:"));
        lines.push(this.input.render(innerWidth).join(""));
        lines.push("");
      }

      if (this.filteredItems.length === 0) {
        lines.push(this.theme.hint("(no matches)"));
      } else {
        const startIndex = Math.max(
          0,
          Math.min(
            this.selectedIndex - Math.floor(this.maxVisible / 2),
            this.filteredItems.length - this.maxVisible,
          ),
        );
        const endIndex = Math.min(
          startIndex + this.maxVisible,
          this.filteredItems.length,
        );

        for (let i = startIndex; i < endIndex; i++) {
          const item = this.filteredItems[i];
          if (!item) continue;
          const isSelected = i === this.selectedIndex;
          const prefix = isSelected ? this.theme.cursor : "  ";
          const prefixWidth = visibleWidth(prefix);
          const maxItemWidth = innerWidth - prefixWidth;
          const text = this.theme.value(
            truncateToWidth(item, maxItemWidth, ""),
            isSelected,
          );
          lines.push(prefix + text);
        }

        if (startIndex > 0 || endIndex < this.filteredItems.length) {
          lines.push(
            this.theme.hint(
              `(${this.selectedIndex + 1}/${this.filteredItems.length})`,
            ),
          );
        }
      }

      lines.push("");
      lines.push(
        this.theme.hint(
          this.useSearch
            ? "Type to search · Enter: select · Esc: back"
            : "↑/↓: move · Enter: select · Esc: back",
        ),
      );

      return lines;
    });
  }

  handleInput(data: string) {
    // Navigation and selection
    if (matchesKey(data, Key.up)) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down)) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
    } else if (matchesKey(data, Key.enter)) {
      this.selectCurrent();
    } else if (matchesKey(data, Key.escape)) {
      this.onDone();
    } else if (this.useSearch) {
      // Delegate to input handler
      this.input.handleInput(data);
      this.updateFilter();
    }
  }
}
