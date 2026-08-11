/**
 * A multi-select list with fuzzy search filtering.
 *
 * Features:
 * - Type to filter items via fuzzy search
 * - Navigate with up/down arrows
 * - Space to toggle selection
 * - Ctrl+A to select all visible, Ctrl+X to clear all visible
 * - Locked items shown greyed and non-toggleable
 * - Optional recommended marker (*)
 * - Scrolls when items exceed maxVisible
 */

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

export interface FuzzyMultiSelectorSubOption {
  label: string;
  checked: boolean;
  description?: string;
}

export interface FuzzyMultiSelectorItem {
  label: string;
  description?: string;
  /** Dim suffix shown after the label (e.g. skill count). */
  suffix?: string;
  checked: boolean;
  locked?: boolean;
  lockedBy?: string;
  recommended?: boolean;
  subOptions?: FuzzyMultiSelectorSubOption[];
}

export interface FuzzyMultiSelectorOptions {
  label: string;
  items: FuzzyMultiSelectorItem[];
  theme: SettingsListTheme;
  maxVisible?: number;
  /** Called after any toggle. */
  onToggle?: (item: FuzzyMultiSelectorItem) => void;
  showHints?: boolean;
  /** Show the "N selected" count line. Default true. */
  showCount?: boolean;
}

type NavigableEntry =
  | { type: "item"; item: FuzzyMultiSelectorItem }
  | {
      type: "subOption";
      subOption: FuzzyMultiSelectorSubOption;
      parent: FuzzyMultiSelectorItem;
    };

export class FuzzyMultiSelector implements Component {
  private allItems: FuzzyMultiSelectorItem[];
  private filteredItems: FuzzyMultiSelectorItem[];
  private label: string;
  private theme: SettingsListTheme;
  private onToggle?: (item: FuzzyMultiSelectorItem) => void;
  private selectedIndex = 0;
  private maxVisible: number;
  private input: Input;
  private showHints: boolean;
  private showCount: boolean;

  constructor(options: FuzzyMultiSelectorOptions) {
    this.allItems = options.items;
    this.filteredItems = [...this.allItems];
    this.label = options.label;
    this.theme = options.theme;
    this.onToggle = options.onToggle;
    this.maxVisible = options.maxVisible ?? 12;
    this.input = new Input();
    this.showHints = options.showHints ?? true;
    this.showCount = options.showCount ?? true;
  }

  /** Get all items (including non-visible due to filtering). */
  getItems(): FuzzyMultiSelectorItem[] {
    return this.allItems;
  }

  /** Get only checked items. */
  getCheckedItems(): FuzzyMultiSelectorItem[] {
    return this.allItems.filter((i) => i.checked);
  }

  /** Recompute the filtered list and clamp the cursor. Call after external item mutations. */
  refresh(): void {
    this.updateFilter();
  }

  private updateFilter(): void {
    const query = this.input.getValue();
    if (query.trim() === "") {
      this.filteredItems = [...this.allItems];
    } else {
      this.filteredItems = fuzzyFilter(
        this.allItems,
        query,
        (item) => `${item.label} ${item.description ?? ""}`,
      );
    }
    const navigableList = this.buildNavigableList();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, navigableList.length - 1),
    );
  }

  private buildNavigableList(): NavigableEntry[] {
    const list: NavigableEntry[] = [];

    // Add checked items and their sub-options from allItems (in order)
    for (const item of this.allItems) {
      if (item.checked) {
        list.push({ type: "item", item });
        for (const subOption of item.subOptions ?? []) {
          list.push({ type: "subOption", subOption, parent: item });
        }
      }
    }

    // Add unchecked items from filteredItems
    for (const item of this.filteredItems) {
      if (!item.checked) {
        list.push({ type: "item", item });
      }
    }

    return list;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderSettingsPanel(width, this.label, this.theme, (width) => {
      const lines: string[] = [];
      const navigableList = this.buildNavigableList();

      // Search input
      lines.push(this.theme.hint("Search:"));
      lines.push(this.input.render(width).join(""));
      lines.push("");

      // Count
      if (this.showCount) {
        const checkedCount = this.allItems.filter((i) => i.checked).length;
        const lockedCount = this.allItems.filter(
          (i) => i.checked && i.locked,
        ).length;
        let countText = `${checkedCount} selected`;
        if (lockedCount > 0) countText += ` (${lockedCount} locked)`;
        lines.push(this.theme.hint(`  ${countText}`));
        lines.push("");
      }

      if (navigableList.length === 0) {
        lines.push(this.theme.hint("  (no matches)"));
      } else {
        // Split into selected section (checked items + subOptions) and unchecked section
        const selectedEntries: { entry: NavigableEntry; navIndex: number }[] =
          [];
        const uncheckedEntries: { entry: NavigableEntry; navIndex: number }[] =
          [];

        for (let i = 0; i < navigableList.length; i++) {
          const entry = navigableList[i];
          if (!entry) continue;
          if (entry.type === "item" && entry.item.checked) {
            selectedEntries.push({ entry, navIndex: i });
          } else if (entry.type === "subOption") {
            selectedEntries.push({ entry, navIndex: i });
          } else {
            uncheckedEntries.push({ entry, navIndex: i });
          }
        }

        // Render Selected section
        if (selectedEntries.length > 0) {
          lines.push(this.theme.hint("  Selected:"));
          for (const { entry, navIndex } of selectedEntries) {
            const isSelected = navIndex === this.selectedIndex;
            const prefix = isSelected ? this.theme.cursor : "  ";
            const prefixWidth = visibleWidth(prefix);

            if (entry.type === "item") {
              const item = entry.item;
              const checkbox = item.checked ? "[x]" : "[ ]";
              const rec = item.recommended ? " *" : "";
              const lockText =
                item.locked && item.lockedBy ? ` (via ${item.lockedBy})` : "";
              const suffixText = item.suffix
                ? ` ${this.theme.hint(item.suffix)}`
                : "";

              const maxItemWidth = width - prefixWidth - 2;
              const itemText = `${checkbox} ${item.label}${rec}${lockText}`;
              const text = item.locked
                ? this.theme.hint(truncateToWidth(itemText, maxItemWidth, ""))
                : this.theme.value(
                    truncateToWidth(itemText, maxItemWidth, ""),
                    isSelected,
                  );
              lines.push(prefix + text + suffixText);
            } else {
              // subOption
              const subOption = entry.subOption;
              const checkbox = subOption.checked ? "[x]" : "[ ]";
              const itemText = `    ${checkbox} ${subOption.label}`;
              const maxItemWidth = width - prefixWidth - 2;
              const text = this.theme.value(
                truncateToWidth(itemText, maxItemWidth, ""),
                isSelected,
              );
              lines.push(prefix + text);
            }
          }
        }

        // Separator between sections
        if (selectedEntries.length > 0 && uncheckedEntries.length > 0) {
          lines.push("");
        }

        // Compute scroll window for unchecked section
        let startIndex = 0;
        let endIndex = uncheckedEntries.length;

        if (uncheckedEntries.length > this.maxVisible) {
          // Find cursor position within unchecked section
          let cursorInUnchecked = -1;
          for (let i = 0; i < uncheckedEntries.length; i++) {
            const e = uncheckedEntries[i];
            if (e && e.navIndex === this.selectedIndex) {
              cursorInUnchecked = i;
              break;
            }
          }

          if (cursorInUnchecked >= 0) {
            // Cursor is in unchecked section, center it
            startIndex = Math.max(
              0,
              Math.min(
                cursorInUnchecked - Math.floor(this.maxVisible / 2),
                uncheckedEntries.length - this.maxVisible,
              ),
            );
            endIndex = startIndex + this.maxVisible;
          } else {
            // Cursor is in selected section, show from top
            endIndex = this.maxVisible;
          }
        }

        // Render unchecked section (with scrolling)
        for (
          let i = startIndex;
          i < endIndex && i < uncheckedEntries.length;
          i++
        ) {
          const e = uncheckedEntries[i];
          if (!e) continue;
          const { entry, navIndex } = e;
          const isSelected = navIndex === this.selectedIndex;
          const prefix = isSelected ? this.theme.cursor : "  ";
          const prefixWidth = visibleWidth(prefix);

          // uncheckedEntries only contains type 'item' entries
          const item = (entry as { type: "item"; item: FuzzyMultiSelectorItem })
            .item;
          const checkbox = item.checked ? "[x]" : "[ ]";
          const rec = item.recommended ? " *" : "";
          const lockText =
            item.locked && item.lockedBy ? ` (via ${item.lockedBy})` : "";
          const suffixText = item.suffix
            ? ` ${this.theme.hint(item.suffix)}`
            : "";

          const maxItemWidth = width - prefixWidth - 2;
          const itemText = `${checkbox} ${item.label}${rec}${lockText}`;
          const text = item.locked
            ? this.theme.hint(truncateToWidth(itemText, maxItemWidth, ""))
            : this.theme.value(
                truncateToWidth(itemText, maxItemWidth, ""),
                isSelected,
              );
          lines.push(prefix + text + suffixText);
        }

        // Scroll indicator for unchecked section
        if (uncheckedEntries.length > this.maxVisible) {
          // Find cursor position within unchecked section for the indicator
          let cursorInUnchecked = -1;
          for (let i = 0; i < uncheckedEntries.length; i++) {
            const e = uncheckedEntries[i];
            if (e && e.navIndex === this.selectedIndex) {
              cursorInUnchecked = i;
              break;
            }
          }
          const displayIndex =
            cursorInUnchecked >= 0 ? cursorInUnchecked + 1 : 1;
          lines.push(
            this.theme.hint(`  (${displayIndex}/${uncheckedEntries.length})`),
          );
        }

        // Description of current entry
        const currentEntry = navigableList[this.selectedIndex];
        if (currentEntry?.type === "item" && currentEntry.item.description) {
          lines.push("");
          lines.push(this.theme.hint(`  ${currentEntry.item.description}`));
        }
      }

      if (this.showHints) {
        lines.push("");
        lines.push(
          this.theme.hint("  Space toggle · ^A all · ^X clear · Enter confirm"),
        );
      }

      return lines;
    });
  }

  handleInput(data: string): void {
    const navigableList = this.buildNavigableList();

    // Navigation
    if (matchesKey(data, Key.up)) {
      if (navigableList.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? navigableList.length - 1
          : this.selectedIndex - 1;
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (navigableList.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === navigableList.length - 1
          ? 0
          : this.selectedIndex + 1;
      return;
    }

    // Toggle on Space
    if (data === " ") {
      const entry = navigableList[this.selectedIndex];
      if (!entry) return;

      if (entry.type === "item") {
        const item = entry.item;
        if (!item.locked) {
          item.checked = !item.checked;
          this.onToggle?.(item);
        }
        // Rebuild list and clamp cursor after toggling top-level item
        const newList = this.buildNavigableList();
        this.selectedIndex = Math.min(
          this.selectedIndex,
          Math.max(0, newList.length - 1),
        );
      } else {
        // subOption - toggle without locked check or onToggle
        entry.subOption.checked = !entry.subOption.checked;
      }
      return;
    }

    // Ctrl+A - Select all visible (top-level items only)
    if (matchesKey(data, Key.ctrl("a"))) {
      const targets = this.input.getValue()
        ? this.filteredItems
        : this.allItems;
      for (const item of targets) {
        if (!item.locked) item.checked = true;
      }
      return;
    }

    // Ctrl+X - Clear all visible (top-level items only)
    if (matchesKey(data, Key.ctrl("x"))) {
      const targets = this.input.getValue()
        ? this.filteredItems
        : this.allItems;
      for (const item of targets) {
        if (!item.locked) item.checked = false;
      }
      return;
    }

    // Pass everything else to search input
    this.input.handleInput(data);
    this.updateFilter();
  }
}
