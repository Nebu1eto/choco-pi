import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Columns } from "../layout/columns";
import { Stack } from "../layout/stack";

export type DescriptionItem = {
  label: string | Component;
  value: string | Component;
};

export type DescriptionListOptions = {
  items: DescriptionItem[];
  /** Fixed label column width. Omit = auto. */
  labelWidth?: number;
  labelStyle?: (text: string) => string;
  valueStyle?: (text: string) => string;
  /** Vertical gap between items (default: 0) */
  gap?: number;
  /** No blank line between items even when stacked */
  compact?: boolean;
};

export class DescriptionList implements Component {
  private items: DescriptionItem[];
  private labelWidth?: number;
  private labelStyle: (text: string) => string;
  private valueStyle: (text: string) => string;
  private gap: number;
  private compact: boolean;

  constructor(options: DescriptionListOptions) {
    this.items = options.items;
    this.labelWidth = options.labelWidth;
    this.labelStyle = options.labelStyle ?? ((t: string) => t);
    this.valueStyle = options.valueStyle ?? ((t: string) => t);
    this.gap = options.gap ?? 0;
    this.compact = options.compact ?? false;
  }

  setItems(items: DescriptionItem[]): void {
    this.items = items;
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [];

    const stackGap = this.compact ? 0 : this.gap;
    const stack = new Stack({ gap: stackGap });

    for (const item of this.items) {
      const labelComp = this.wrapStyled(item.label, this.labelStyle);
      const valueComp = this.wrapStyled(item.value, this.valueStyle);

      const labelW = this.labelWidth ?? this.computeAutoLabelWidth(width);

      // If labelWidth is set or auto is wide enough, use Columns; else stack
      if (labelW > 0 && width - labelW - 1 >= 10) {
        stack.addChild(
          new Columns(
            [{ child: labelComp, width: labelW }, { child: valueComp }],
            { gap: 1 },
          ),
        );
      } else {
        // Stacked: label above value
        const pair = new Stack({ gap: 0 });
        pair.addChild(labelComp);
        pair.addChild(valueComp);
        if (!this.compact) {
          // Add blank line between stacked pairs
          pair.addChild({ render: () => [""], invalidate: () => {} });
        }
        stack.addChild(pair);
      }
    }

    return stack.render(width);
  }

  invalidate(): void {}

  private computeAutoLabelWidth(width: number): number {
    // Auto: measure longest label string
    let maxLen = 0;
    for (const item of this.items) {
      if (typeof item.label === "string") {
        maxLen = Math.max(maxLen, item.label.length);
      }
    }
    // Cap at 40% of width
    return Math.min(maxLen, Math.floor(width * 0.4));
  }

  private wrapStyled(
    input: string | Component,
    styleFn: (t: string) => string,
  ): Component {
    if (typeof input === "string") {
      return {
        render: (width: number) => [
          truncateToWidth(styleFn(input), width, "", true),
        ],
        invalidate: () => {},
      };
    }
    return input;
  }
}
