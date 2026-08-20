import type { Component, SettingsListTheme } from "@earendil-works/pi-tui";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface SettingsDetailFieldBase {
  id: string;
  label: string;
  description?: string;
}

export interface SettingsDetailTextField extends SettingsDetailFieldBase {
  type: "text";
  getValue: () => string;
  setValue: (value: string) => void;
  validate?: (value: string) => string | null;
  displayValue?: (value: string) => string;
  emptyValueText?: string;
}

export interface SettingsDetailEnumField extends SettingsDetailFieldBase {
  type: "enum";
  getValue: () => string;
  setValue: (value: string) => void;
  options: string[] | (() => string[]);
  emptyValueText?: string;
}

export interface SettingsDetailBooleanField extends SettingsDetailFieldBase {
  type: "boolean";
  getValue: () => boolean;
  setValue: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
}

export interface SettingsDetailSubmenuField extends SettingsDetailFieldBase {
  type: "submenu";
  getValue: () => string;
  submenu: (done: (summary?: string) => void) => Component;
  onSubmenuDone?: (summary?: string) => void;
  emptyValueText?: string;
}

export interface SettingsDetailActionField extends SettingsDetailFieldBase {
  type: "action";
  getValue?: () => string;
  onConfirm: () => void;
  confirmMessage?: string;
  confirmHint?: string;
}

export type SettingsDetailField =
  | SettingsDetailTextField
  | SettingsDetailEnumField
  | SettingsDetailBooleanField
  | SettingsDetailSubmenuField
  | SettingsDetailActionField;

export interface SettingsDetailEditorOptions {
  title: string | (() => string);
  fields: SettingsDetailField[];
  theme: SettingsListTheme;
  onDone: (summary?: string) => void;
  getDoneSummary?: () => string | undefined;
  maxVisible?: number;
  emptyStateText?: string;
  hintSuffix?: string;
}

type EditorMode = "list" | "text" | "enum" | "confirm";

/**
 * A focused editor for one selected settings item.
 *
 * Designed to be used as a submenu from SectionedSettings.
 */
export class SettingsDetailEditor implements Component {
  private readonly fields: SettingsDetailField[];
  private readonly theme: SettingsListTheme;
  private readonly onDone: (summary?: string) => void;
  private readonly title: string | (() => string);
  private readonly getDoneSummary?: () => string | undefined;
  private readonly maxVisible: number;
  private readonly emptyStateText: string;
  private readonly hintSuffix: string;

  private selectedIndex = 0;
  private mode: EditorMode = "list";

  private input = new Input();
  private inputFieldIndex: number | null = null;
  private inputError: string | null = null;

  private enumFieldIndex: number | null = null;
  private enumOptionIndex = 0;

  private confirmFieldIndex: number | null = null;

  private submenuComponent: Component | null = null;
  private submenuFieldIndex: number | null = null;

  constructor(options: SettingsDetailEditorOptions) {
    this.fields = options.fields;
    this.theme = options.theme;
    this.onDone = options.onDone;
    this.title = options.title;
    this.getDoneSummary = options.getDoneSummary;
    this.maxVisible = options.maxVisible ?? 10;
    this.emptyStateText = options.emptyStateText ?? "No editable fields";
    this.hintSuffix = options.hintSuffix ?? "";

    this.input.onSubmit = (value) => this.submitInput(value);
    this.input.onEscape = () => {
      this.mode = "list";
      this.inputFieldIndex = null;
      this.inputError = null;
    };
  }

  invalidate(): void {
    this.submenuComponent?.invalidate?.();
  }

  render(width: number): string[] {
    if (this.submenuComponent) {
      return this.submenuComponent.render(width);
    }

    const lines: string[] = [];
    const title = typeof this.title === "function" ? this.title() : this.title;
    lines.push(this.theme.label(` ${title}`, true));
    lines.push("");

    if (this.mode === "text") {
      return [...lines, ...this.renderTextMode(width)];
    }
    if (this.mode === "enum") {
      return [...lines, ...this.renderEnumMode(width)];
    }
    if (this.mode === "confirm") {
      return [...lines, ...this.renderConfirmMode(width)];
    }

    return [...lines, ...this.renderListMode(width)];
  }

  private renderListMode(width: number): string[] {
    const lines: string[] = [];

    if (this.fields.length === 0) {
      lines.push(this.theme.hint(`  ${this.emptyStateText}`));
      lines.push("");
      lines.push(this.theme.hint("  Esc: back"));
      return lines;
    }

    const maxLabelWidth = Math.min(
      30,
      Math.max(...this.fields.map((field) => visibleWidth(field.label))),
    );

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.fields.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.fields.length);

    for (let i = startIndex; i < endIndex; i++) {
      const field = this.fields[i];
      if (!field) continue;

      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.cursor : "  ";
      const prefixWidth = visibleWidth(prefix);
      const labelPadded =
        field.label +
        " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(field.label)));
      const labelText = this.theme.label(labelPadded, isSelected);

      const separator = "  ";
      const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
      const maxValueWidth = Math.max(1, width - usedWidth - 1);
      const valueText = this.theme.value(
        truncateToWidth(this.getFieldListValueText(field), maxValueWidth, ""),
        isSelected,
      );

      lines.push(prefix + labelText + separator + valueText);
    }

    if (startIndex > 0 || endIndex < this.fields.length) {
      lines.push(
        this.theme.hint(`  (${this.selectedIndex + 1}/${this.fields.length})`),
      );
    }

    const selected = this.fields[this.selectedIndex];
    if (selected?.description) {
      lines.push("");
      const wrapped = wrapTextWithAnsi(
        selected.description,
        Math.max(1, width - 4),
      );
      for (const line of wrapped) {
        lines.push(this.theme.description(`  ${line}`));
      }
    }

    lines.push("");
    const suffix = this.hintSuffix ? ` · ${this.hintSuffix}` : "";
    lines.push(
      this.theme.hint(
        `  ↑/↓ or j/k navigate · Enter edit/open · Esc back${suffix}`,
      ),
    );

    return lines;
  }

  private renderTextMode(width: number): string[] {
    const lines: string[] = [];
    const field = this.getActiveTextField();

    if (!field) {
      this.mode = "list";
      this.inputFieldIndex = null;
      return this.renderListMode(width);
    }

    lines.push(this.theme.hint(`  ${field.label}`));
    lines.push(`  ${this.input.render(Math.max(1, width - 4)).join("")}`);

    if (this.inputError) {
      lines.push("");
      lines.push(this.theme.value(`  ${this.inputError}`, true));
    }

    lines.push("");
    lines.push(this.theme.hint("  Enter: confirm · Esc: cancel"));
    return lines;
  }

  private renderEnumMode(width: number): string[] {
    const lines: string[] = [];
    const field = this.getActiveEnumField();

    if (!field) {
      this.mode = "list";
      this.enumFieldIndex = null;
      return this.renderListMode(width);
    }

    const options = this.resolveEnumOptions(field);
    if (options.length === 0) {
      lines.push(this.theme.hint("  (no choices)"));
      lines.push("");
      lines.push(this.theme.hint("  Esc: back"));
      return lines;
    }

    lines.push(this.theme.hint(`  ${field.label}`));
    lines.push("");

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (!option) continue;
      const isSelected = i === this.enumOptionIndex;
      const prefix = isSelected ? this.theme.cursor : "  ";
      const prefixWidth = visibleWidth(prefix);
      const maxTextWidth = Math.max(1, width - prefixWidth - 1);
      const text = this.theme.value(
        truncateToWidth(option, maxTextWidth, ""),
        isSelected,
      );
      lines.push(prefix + text);
    }

    lines.push("");
    lines.push(
      this.theme.hint("  ↑/↓ or j/k navigate · Enter: choose · Esc: cancel"),
    );

    return lines;
  }

  private renderConfirmMode(width: number): string[] {
    const lines: string[] = [];
    const field = this.getActiveActionField();

    if (!field) {
      this.mode = "list";
      this.confirmFieldIndex = null;
      return this.renderListMode(width);
    }

    const message = field.confirmMessage ?? `Confirm: ${field.label}?`;
    const wrapped = wrapTextWithAnsi(message, Math.max(1, width - 4));
    for (const line of wrapped) {
      lines.push(this.theme.value(`  ${line}`, true));
    }

    lines.push("");
    lines.push(
      this.theme.hint(
        field.confirmHint ?? "  Enter/y: confirm · Esc/n: cancel",
      ),
    );

    return lines;
  }

  handleInput(data: string): void {
    if (this.submenuComponent) {
      this.submenuComponent.handleInput?.(data);
      return;
    }

    if (this.mode === "text") {
      this.input.handleInput(data);
      return;
    }

    if (this.mode === "enum") {
      this.handleEnumInput(data);
      return;
    }

    if (this.mode === "confirm") {
      this.handleConfirmInput(data);
      return;
    }

    this.handleListInput(data);
  }

  private handleListInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.fields.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.fields.length - 1
          : this.selectedIndex - 1;
      return;
    }

    if (matchesKey(data, Key.down) || data === "j") {
      if (this.fields.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.fields.length - 1
          ? 0
          : this.selectedIndex + 1;
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.activateSelectedField();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onDone(this.getDoneSummary?.());
    }
  }

  private activateSelectedField(): void {
    const field = this.fields[this.selectedIndex];
    if (!field) return;

    if (field.type === "boolean") {
      field.setValue(!field.getValue());
      return;
    }

    if (field.type === "text") {
      this.mode = "text";
      this.inputFieldIndex = this.selectedIndex;
      this.inputError = null;
      this.input.setValue(field.getValue());
      return;
    }

    if (field.type === "enum") {
      this.mode = "enum";
      this.enumFieldIndex = this.selectedIndex;
      const options = this.resolveEnumOptions(field);
      const current = field.getValue();
      const idx = options.indexOf(current);
      this.enumOptionIndex = idx >= 0 ? idx : 0;
      return;
    }

    if (field.type === "submenu") {
      this.submenuFieldIndex = this.selectedIndex;
      this.submenuComponent = field.submenu((summary) => {
        field.onSubmenuDone?.(summary);
        this.closeSubmenu();
      });
      return;
    }

    this.mode = "confirm";
    this.confirmFieldIndex = this.selectedIndex;
  }

  private handleEnumInput(data: string): void {
    const field = this.getActiveEnumField();
    if (!field) {
      this.mode = "list";
      this.enumFieldIndex = null;
      return;
    }

    const options = this.resolveEnumOptions(field);
    if (options.length === 0) {
      if (matchesKey(data, Key.escape)) {
        this.mode = "list";
        this.enumFieldIndex = null;
      }
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      this.enumOptionIndex =
        this.enumOptionIndex === 0
          ? options.length - 1
          : this.enumOptionIndex - 1;
      return;
    }

    if (matchesKey(data, Key.down) || data === "j") {
      this.enumOptionIndex =
        this.enumOptionIndex === options.length - 1
          ? 0
          : this.enumOptionIndex + 1;
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = options[this.enumOptionIndex];
      if (selected !== undefined) {
        field.setValue(selected);
      }
      this.mode = "list";
      this.enumFieldIndex = null;
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.mode = "list";
      this.enumFieldIndex = null;
    }
  }

  private handleConfirmInput(data: string): void {
    const field = this.getActiveActionField();

    if (!field) {
      this.mode = "list";
      this.confirmFieldIndex = null;
      return;
    }

    if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
      field.onConfirm();
      this.mode = "list";
      this.confirmFieldIndex = null;
      return;
    }

    if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
      this.mode = "list";
      this.confirmFieldIndex = null;
    }
  }

  private submitInput(value: string): void {
    const field = this.getActiveTextField();
    if (!field) {
      this.mode = "list";
      this.inputFieldIndex = null;
      this.inputError = null;
      return;
    }

    const error = field.validate?.(value) ?? null;
    if (error) {
      this.inputError = error;
      return;
    }

    field.setValue(value);
    this.mode = "list";
    this.inputFieldIndex = null;
    this.inputError = null;
  }

  private closeSubmenu(): void {
    this.submenuComponent = null;
    if (this.submenuFieldIndex !== null) {
      this.selectedIndex = this.submenuFieldIndex;
      this.submenuFieldIndex = null;
    }
  }

  private resolveEnumOptions(field: SettingsDetailEnumField): string[] {
    return typeof field.options === "function"
      ? field.options()
      : field.options;
  }

  private getFieldValueText(field: SettingsDetailField): string {
    if (field.type === "text") {
      const raw = field.getValue();
      const display = field.displayValue?.(raw) ?? raw;
      return display || field.emptyValueText || "(empty)";
    }

    if (field.type === "enum") {
      return field.getValue() || field.emptyValueText || "(none)";
    }

    if (field.type === "boolean") {
      return field.getValue()
        ? (field.trueLabel ?? "on")
        : (field.falseLabel ?? "off");
    }

    if (field.type === "submenu") {
      return field.getValue() || field.emptyValueText || "(empty)";
    }

    return field.getValue?.() ?? "run";
  }

  private getFieldListValueText(field: SettingsDetailField): string {
    if (field.type === "submenu") {
      return `› ${this.getFieldValueText(field)}`;
    }

    if (field.type === "action") {
      return `! ${this.getFieldValueText(field)}`;
    }

    return this.getFieldValueText(field);
  }

  private getActiveTextField(): SettingsDetailTextField | null {
    if (this.inputFieldIndex === null) return null;
    const field = this.fields[this.inputFieldIndex];
    return field?.type === "text" ? field : null;
  }

  private getActiveEnumField(): SettingsDetailEnumField | null {
    if (this.enumFieldIndex === null) return null;
    const field = this.fields[this.enumFieldIndex];
    return field?.type === "enum" ? field : null;
  }

  private getActiveActionField(): SettingsDetailActionField | null {
    if (this.confirmFieldIndex === null) return null;
    const field = this.fields[this.confirmFieldIndex];
    return field?.type === "action" ? field : null;
  }
}
