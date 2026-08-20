import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type ColumnDef = {
  child: Component;
  /** Fixed width in columns. Omit = split remaining equally. */
  width?: number;
  /** Collapse to vertical stack if this can't be met. */
  minWidth?: number;
};

export type ColumnsOptions = {
  /** Horizontal gap between columns (default: 1) */
  gap?: number;
  /** Width threshold to switch to vertical stack */
  collapseAt?: number;
  /** Vertical alignment when columns have different heights (default: "top") */
  align?: "top" | "bottom";
};

export class Columns implements Component {
  private columns: ColumnDef[];
  private gap: number;
  private collapseAt: number;
  private _align: "top" | "bottom";

  constructor(columns: ColumnDef[], options?: ColumnsOptions) {
    this.columns = columns;
    this.gap = options?.gap ?? 1;
    this.collapseAt = options?.collapseAt ?? 0;
    this._align = options?.align ?? "top";
    void this._align;
  }

  setColumns(columns: ColumnDef[]): void {
    this.columns = columns;
  }

  render(width: number): string[] {
    // Check if any column's minWidth can't be met, or if width < collapseAt
    if (this.shouldCollapse(width)) {
      return this.renderVertical(width);
    }
    return this.renderHorizontal(width);
  }

  invalidate(): void {
    for (const col of this.columns) {
      col.child.invalidate();
    }
  }

  private shouldCollapse(width: number): boolean {
    if (this.collapseAt > 0 && width < this.collapseAt) {
      return true;
    }
    // Check minWidth constraints
    const totalFixed = this.columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
    const totalGaps = Math.max(0, this.columns.length - 1) * this.gap;
    const flexibleCount = this.columns.filter((c) => !c.width).length;

    // Remaining width after fixed columns and gaps
    const remaining = width - totalFixed - totalGaps;
    const perFlexible = flexibleCount > 0 ? remaining / flexibleCount : 0;

    for (const col of this.columns) {
      if (col.minWidth) {
        const colWidth = col.width ?? perFlexible;
        if (colWidth < col.minWidth) {
          return true;
        }
      }
    }

    return false;
  }

  private renderHorizontal(width: number): string[] {
    const colWidths = this.computeWidths(width);
    if (!colWidths) {
      return this.renderVertical(width);
    }

    // Render each column
    const rendered = this.columns.map((col, i) => ({
      lines: col.child.render(colWidths[i]!),
      width: colWidths[i]!,
    }));

    // Pad each line to its column width and merge side-by-side
    const maxLines = Math.max(...rendered.map((r) => r.lines.length));
    const lines: string[] = [];

    for (let row = 0; row < maxLines; row++) {
      let line = "";
      for (let col = 0; col < rendered.length; col++) {
        const colLine = rendered[col]!.lines[row] ?? "";
        const colWidth = rendered[col]!.width;

        // Pad or truncate the line to fit the column width
        const padded = this.padLine(colLine, colWidth);

        if (col > 0) {
          line += " ".repeat(this.gap);
        }
        line += padded;
      }
      lines.push(truncateToWidth(line, width, "", true));
    }

    return lines;
  }

  private renderVertical(width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.columns.length; i++) {
      const childLines = this.columns[i]!.child.render(width);
      lines.push(...childLines);
      // Add blank line between stacked columns (not after last)
      if (i < this.columns.length - 1) {
        lines.push("");
      }
    }
    return lines;
  }

  private computeWidths(totalWidth: number): number[] | null {
    const n = this.columns.length;
    if (n === 0) return [];

    const totalGaps = Math.max(0, n - 1) * this.gap;
    let available = totalWidth - totalGaps;

    if (available < n) return null; // not enough space

    const widths: number[] = new Array(n).fill(0);
    const flexible: number[] = [];

    // Assign fixed widths first
    for (let i = 0; i < n; i++) {
      const colWidth = this.columns[i]!.width;
      if (colWidth !== undefined) {
        widths[i] = colWidth;
        available -= colWidth;
      } else {
        flexible.push(i);
      }
    }

    if (available < 0) return null;

    // Distribute remaining equally among flexible columns
    if (flexible.length > 0) {
      const perCol = Math.floor(available / flexible.length);
      let remainder = available - perCol * flexible.length;

      for (const idx of flexible) {
        widths[idx] = perCol + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
      }
    }

    return widths;
  }

  /** Pad a line to exactly `width` visible columns, handling ANSI codes. */
  private padLine(line: string, width: number): string {
    return truncateToWidth(line, width, "", true);
  }
}
