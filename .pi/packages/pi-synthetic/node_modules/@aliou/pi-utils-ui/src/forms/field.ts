import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type FieldOptions = {
  label: string | Component;
  input: Component;
  description?: string | Component;
  error?: string | Component;
  required?: boolean;
  labelStyle?: (text: string) => string;
  errorStyle?: (text: string) => string;
  descriptionStyle?: (text: string) => string;
  requiredStyle?: (text: string) => string;
};

export class Field implements Component {
  private label: string | Component;
  private input: Component;
  private description?: string | Component;
  private error?: string | Component;
  private required: boolean;
  private labelStyle: (text: string) => string;
  private errorStyle: (text: string) => string;
  private descriptionStyle: (text: string) => string;
  private requiredStyle: (text: string) => string;

  constructor(options: FieldOptions) {
    this.label = options.label;
    this.input = options.input;
    this.description = options.description;
    this.error = options.error;
    this.required = options.required ?? false;
    this.labelStyle = options.labelStyle ?? ((t: string) => t);
    this.descriptionStyle = options.descriptionStyle ?? ((t: string) => t);
    this.errorStyle =
      options.errorStyle ?? ((t: string) => `\x1b[31m${t}\x1b[0m`);
    this.requiredStyle =
      options.requiredStyle ?? ((t: string) => `\x1b[31m${t}\x1b[0m`);
  }

  setError(error?: string | Component): void {
    this.error = error;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Label line
    const requiredMarker = this.required ? this.requiredStyle(" *") : "";
    if (typeof this.label === "string") {
      lines.push(
        truncateToWidth(
          this.labelStyle(this.label) + requiredMarker,
          width,
          "",
          true,
        ),
      );
    } else {
      lines.push(...this.label.render(width));
    }

    // Input
    lines.push(...this.input.render(width));

    // Description
    if (this.description) {
      if (typeof this.description === "string") {
        lines.push(
          truncateToWidth(
            this.descriptionStyle(this.description),
            width,
            "",
            true,
          ),
        );
      } else {
        lines.push(...this.description.render(width));
      }
    }

    // Error
    if (this.error) {
      if (typeof this.error === "string") {
        lines.push(
          truncateToWidth(this.errorStyle(this.error), width, "", true),
        );
      } else {
        lines.push(...this.error.render(width));
      }
    }

    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
