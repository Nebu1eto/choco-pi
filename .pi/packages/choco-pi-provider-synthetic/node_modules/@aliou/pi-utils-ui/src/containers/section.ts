import type { Component } from "@earendil-works/pi-tui";
import { Spacer, truncateToWidth } from "@earendil-works/pi-tui";

export type SectionOptions = {
  title: string | Component;
  description?: string | Component;
  body: Component;
  titleStyle?: (text: string) => string;
  descriptionStyle?: (text: string) => string;
  /** Gap between title/description and body (default: 1) */
  gap?: number;
};

export class Section implements Component {
  private title: string | Component;
  private description?: string | Component;
  private body: Component;
  private titleStyle: (text: string) => string;
  private descriptionStyle: (text: string) => string;
  private gap: number;

  constructor(options: SectionOptions) {
    this.title = options.title;
    this.description = options.description;
    this.body = options.body;
    this.titleStyle = options.titleStyle ?? ((t: string) => t);
    this.descriptionStyle = options.descriptionStyle ?? ((t: string) => t);
    this.gap = options.gap ?? 1;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Title
    if (typeof this.title === "string") {
      lines.push(truncateToWidth(this.titleStyle(this.title), width, "", true));
    } else {
      lines.push(...this.title.render(width));
    }

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

    // Gap between header and body
    if (this.gap > 0) {
      lines.push(...new Spacer(this.gap).render(width));
    }

    // Body
    lines.push(...this.body.render(width));

    return lines;
  }

  invalidate(): void {
    this.body.invalidate();
  }
}
