import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, SettingsListTheme } from "@earendil-works/pi-tui";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { renderSettingsPanel } from "./render-settings-panel";

export interface PathArrayEditorOptions {
  label: string;
  items: string[];
  theme: SettingsListTheme;
  onSave: (items: string[]) => void;
  onDone: () => void;
  /** Max visible items before scrolling */
  maxVisible?: number;
  /** Base directory for resolving relative paths. Default: process.cwd() */
  baseDir?: string;
  /** Optional validation hook. Return error message to reject submit. */
  validatePath?: (value: string) => string | null;
}

/**
 * Array editor specialized for filesystem paths.
 *
 * Same UX as ArrayEditor, plus Tab completion in add/edit mode.
 */
export class PathArrayEditor implements Component {
  private items: string[];
  private label: string;
  private theme: SettingsListTheme;
  private onSave: (items: string[]) => void;
  private onDone: () => void;
  private selectedIndex = 0;
  private maxVisible: number;
  private mode: "list" | "add" | "edit" = "list";
  private input: Input;
  private editIndex = -1;
  private baseDir: string;
  private completions: string[] = [];
  private completionIndex = 0;
  private readonly validatePath?: (value: string) => string | null;
  private inputError: string | null = null;

  constructor(options: PathArrayEditorOptions) {
    this.items = [...options.items];
    this.label = options.label;
    this.theme = options.theme;
    this.onSave = options.onSave;
    this.onDone = options.onDone;
    this.maxVisible = options.maxVisible ?? 10;
    this.baseDir = options.baseDir ?? process.cwd();
    this.validatePath = options.validatePath;
    this.input = new Input();
    this.input.onSubmit = (value: string) => {
      if (this.mode === "edit") {
        this.submitEdit(value);
      } else {
        this.submitAdd(value);
      }
    };
    this.input.onEscape = () => {
      this.mode = "list";
      this.editIndex = -1;
      this.completions = [];
      this.completionIndex = 0;
      this.inputError = null;
    };
  }

  private submitAdd(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      this.mode = "list";
      return;
    }

    const validationError = this.validatePath?.(trimmed) ?? null;
    if (validationError) {
      this.inputError = validationError;
      return;
    }

    this.items.push(trimmed);
    this.selectedIndex = this.items.length - 1;
    this.save();
    this.mode = "list";
    this.input.setValue("");
    this.completions = [];
    this.completionIndex = 0;
    this.inputError = null;
  }

  private submitEdit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      this.mode = "list";
      this.editIndex = -1;
      return;
    }

    const validationError = this.validatePath?.(trimmed) ?? null;
    if (validationError) {
      this.inputError = validationError;
      return;
    }

    this.items[this.editIndex] = trimmed;
    this.save();
    this.mode = "list";
    this.editIndex = -1;
    this.input.setValue("");
    this.completions = [];
    this.completionIndex = 0;
    this.inputError = null;
  }

  private deleteSelected() {
    if (this.items.length === 0) return;
    this.items.splice(this.selectedIndex, 1);
    if (this.selectedIndex >= this.items.length) {
      this.selectedIndex = Math.max(0, this.items.length - 1);
    }
    this.save();
  }

  private startEdit() {
    if (this.items.length === 0) return;
    this.editIndex = this.selectedIndex;
    this.mode = "edit";
    this.setInputValueAtEnd(this.items[this.selectedIndex] as string);
    this.completions = [];
    this.completionIndex = 0;
  }

  private save() {
    this.onSave([...this.items]);
  }

  invalidate() {}

  render(width: number): string[] {
    return renderSettingsPanel(width, this.label, this.theme, (innerWidth) => {
      if (this.mode === "add" || this.mode === "edit") {
        return this.renderInputMode(innerWidth);
      }

      return this.renderListMode(innerWidth);
    });
  }

  private renderListMode(width: number): string[] {
    const lines: string[] = [];

    if (this.items.length === 0) {
      lines.push(this.theme.hint("  (empty)"));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.maxVisible / 2),
          this.items.length - this.maxVisible,
        ),
      );
      const endIndex = Math.min(
        startIndex + this.maxVisible,
        this.items.length,
      );

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.items[i];
        if (!item) continue;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? this.theme.cursor : "  ";
        const prefixWidth = visibleWidth(prefix);
        const maxItemWidth = width - prefixWidth - 2;
        const text = this.theme.value(
          truncateToWidth(item, maxItemWidth, ""),
          isSelected,
        );
        lines.push(prefix + text);
      }

      if (startIndex > 0 || endIndex < this.items.length) {
        lines.push(
          this.theme.hint(`  (${this.selectedIndex + 1}/${this.items.length})`),
        );
      }
    }

    lines.push("");
    lines.push(
      this.theme.hint("  a: add · e/Enter: edit · d: delete · Esc: back"),
    );

    return lines;
  }

  private renderInputMode(width: number): string[] {
    const lines: string[] = [];
    const label = this.mode === "edit" ? "  Edit path:" : "  New path:";
    lines.push(this.theme.hint(label));
    lines.push(`  ${this.input.render(width - 4).join("")}`);

    if (this.completions.length > 0) {
      lines.push("");
      lines.push(this.theme.hint("  Suggestions:"));
      const start = Math.max(
        0,
        Math.min(this.completionIndex - 2, this.completions.length - 5),
      );
      const end = Math.min(this.completions.length, start + 5);
      for (let i = start; i < end; i++) {
        const completion = this.completions[i];
        if (!completion) continue;
        const isSelected = i === this.completionIndex;
        const prefix = isSelected ? this.theme.cursor : "    ";
        const text = isSelected
          ? this.theme.value(completion, true)
          : this.theme.hint(completion);
        lines.push(`${prefix}${text}`);
      }
      if (this.completions.length > 5) {
        lines.push(
          this.theme.hint(
            `    (${this.completionIndex + 1}/${this.completions.length})`,
          ),
        );
      }
    }

    if (this.inputError) {
      lines.push("");
      lines.push(this.theme.value(`  ${this.inputError}`, true));
    }

    lines.push("");
    lines.push(
      this.theme.hint(
        "  Tab: complete/apply · ↑/↓: select suggestion · Enter: confirm · Esc: cancel",
      ),
    );
    return lines;
  }

  handleInput(data: string) {
    if (this.mode === "add" || this.mode === "edit") {
      if (matchesKey(data, Key.up) && this.completions.length > 0) {
        this.completionIndex =
          this.completionIndex === 0
            ? this.completions.length - 1
            : this.completionIndex - 1;
        return;
      }
      if (matchesKey(data, Key.down) && this.completions.length > 0) {
        this.completionIndex =
          this.completionIndex === this.completions.length - 1
            ? 0
            : this.completionIndex + 1;
        return;
      }
      if (matchesKey(data, Key.tab)) {
        if (this.completions.length > 0) {
          this.applySelectedCompletion();
        } else {
          this.completeInputPath();
        }
        return;
      }
      if (matchesKey(data, Key.enter)) {
        // Keep Enter for submit/confirm. Use Tab to apply suggestions.
        this.input.handleInput(data);
        return;
      }
      this.input.handleInput(data);
      this.completions = [];
      this.completionIndex = 0;
      this.inputError = null;
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      if (this.items.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.items.length - 1
          : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.items.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1
          ? 0
          : this.selectedIndex + 1;
    } else if (data === "a" || data === "A") {
      this.mode = "add";
      this.input.setValue("");
      this.completions = [];
      this.completionIndex = 0;
    } else if (data === "e" || data === "E" || matchesKey(data, Key.enter)) {
      this.startEdit();
    } else if (data === "d" || data === "D") {
      this.deleteSelected();
    } else if (matchesKey(data, Key.escape)) {
      this.onDone();
    }
  }

  private completeInputPath(): void {
    const raw = this.input.getValue();
    const completed = this.getCompletion(raw);
    if (!completed) return;
    this.setInputValueAtEnd(completed.nextValue);
    this.completions = completed.suggestions;
    this.completionIndex = 0;
  }

  private applySelectedCompletion(): void {
    const selected = this.completions[this.completionIndex];
    if (!selected) return;

    const raw = this.input.getValue().trim();
    const rawEndsWithSep = raw.endsWith("/") || raw.endsWith(path.sep);
    const rawDirPart = rawEndsWithSep ? raw : path.dirname(raw);
    const separator = rawDirPart === "." ? "" : rawDirPart;
    const joiner = separator && !separator.endsWith("/") ? "/" : "";

    const nextValue = `${separator}${joiner}${selected}`;

    // Prevent duplicate appends when user tabs repeatedly on same completion.
    if (nextValue === raw || raw.endsWith(selected)) {
      this.completions = [];
      this.completionIndex = 0;
      return;
    }

    this.setInputValueAtEnd(nextValue);
    this.completions = [];
    this.completionIndex = 0;
  }

  private setInputValueAtEnd(value: string): void {
    this.input.setValue(value);
    // Input has no public setCursor API. Emulate End (Ctrl+E) so follow-up
    // typing/tab completion continues from end of line.
    this.input.handleInput("\u0005");
  }

  private getCompletion(inputValue: string): {
    nextValue: string;
    suggestions: string[];
  } | null {
    const raw = inputValue.trim();
    if (!raw) return null;

    const rawEndsWithSep = raw.endsWith("/") || raw.endsWith(path.sep);
    const rawDirPart = rawEndsWithSep ? raw : path.dirname(raw);
    const rawPrefix = rawEndsWithSep ? "" : path.basename(raw);

    const absDir = this.resolveAbsolutePath(
      rawDirPart === "." ? "" : rawDirPart,
      this.baseDir,
    );

    let names: string[];
    try {
      names = fs.readdirSync(absDir);
    } catch {
      return null;
    }

    const matched = names
      .filter((name) => name.startsWith(rawPrefix))
      .sort((a, b) => a.localeCompare(b));

    if (matched.length === 0) return null;

    const suggestions = matched.map((name) => {
      const candidateAbs = path.join(absDir, name);
      const isDir = this.isDirectory(candidateAbs);
      return `${name}${isDir ? "/" : ""}`;
    });

    const nextName =
      matched.length === 1
        ? matched[0]
        : this.commonPrefix(matched) || rawPrefix;

    if (!nextName || nextName === rawPrefix) {
      return { nextValue: raw, suggestions };
    }

    const nextAbs = path.join(absDir, nextName);
    const nextIsDir = this.isDirectory(nextAbs);
    const separator = rawDirPart === "." ? "" : rawDirPart;
    const joiner = separator && !separator.endsWith("/") ? "/" : "";
    const nextValue = `${separator}${joiner}${nextName}${nextIsDir ? "/" : ""}`;

    return { nextValue, suggestions };
  }

  private resolveAbsolutePath(rawPath: string, baseDir: string): string {
    if (rawPath.startsWith("~/")) {
      return path.resolve(os.homedir(), rawPath.slice(2));
    }
    if (rawPath === "~") {
      return os.homedir();
    }
    if (path.isAbsolute(rawPath)) {
      return path.normalize(rawPath);
    }
    return path.resolve(baseDir, rawPath || ".");
  }

  private isDirectory(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  private commonPrefix(values: string[]): string {
    if (values.length === 0) return "";
    let prefix = values[0] as string;
    for (let i = 1; i < values.length; i++) {
      const current = values[i] as string;
      let j = 0;
      while (
        j < prefix.length &&
        j < current.length &&
        prefix[j] === current[j]
      ) {
        j++;
      }
      prefix = prefix.slice(0, j);
      if (!prefix) break;
    }
    return prefix;
  }
}
