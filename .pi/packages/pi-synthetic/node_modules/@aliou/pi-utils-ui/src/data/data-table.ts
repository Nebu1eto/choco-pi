import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { EmptyState } from "../feedback/empty-state";

export type TableColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => string;
  /** Fixed width. Omit = distribute remaining. */
  width?: number;
  minWidth?: number;
  /** Lower = hidden first on narrow terminals. */
  priority?: number;
  align?: "left" | "right";
  headerStyle?: (text: string) => string;
  cellStyle?: (text: string) => string;
};

export type DataTableOptions<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  headerStyle?: (text: string) => string;
  separatorStyle?: (text: string) => string;
  emptyState?: Component;
};

export class DataTable<T> implements Component {
  private columns: TableColumn<T>[];
  private rows: T[];
  private headerStyle: (text: string) => string;
  private separatorStyle: (text: string) => string;
  private emptyState: Component;

  constructor(options: DataTableOptions<T>) {
    this.columns = options.columns;
    this.rows = options.rows;
    this.headerStyle =
      options.headerStyle ?? ((t: string) => `\x1b[1m${t}\x1b[0m`);
    this.separatorStyle =
      options.separatorStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
    this.emptyState =
      options.emptyState ??
      new EmptyState({ title: "No data", description: "No rows to display" });
  }

  setRows(rows: T[]): void {
    this.rows = rows;
  }

  render(width: number): string[] {
    if (this.rows.length === 0) {
      return this.emptyState.render(width);
    }

    const visibleCols = this.computeVisibleColumns(width);
    if (visibleCols.length === 0) return [];

    const colWidths = this.computeWidths(visibleCols, width);
    const gap = 2;

    const lines: string[] = [];

    // Header row
    const headerParts: string[] = [];
    for (let i = 0; i < visibleCols.length; i++) {
      const col = visibleCols[i]!;
      const colW = colWidths[i]!;
      const styleFn = col.headerStyle ?? this.headerStyle;
      const header = styleFn(this.alignText(col.header, colW, col.align));
      headerParts.push(truncateToWidth(header, colW, "", true));
    }
    lines.push(
      truncateToWidth(headerParts.join(" ".repeat(gap)), width, "", true),
    );

    // Separator
    const sepParts: string[] = [];
    for (let i = 0; i < visibleCols.length; i++) {
      sepParts.push(this.separatorStyle("\u2500".repeat(colWidths[i]!)));
    }
    lines.push(
      truncateToWidth(sepParts.join(" ".repeat(gap)), width, "", true),
    );

    // Data rows
    for (const row of this.rows) {
      const rowParts: string[] = [];
      for (let i = 0; i < visibleCols.length; i++) {
        const col = visibleCols[i]!;
        const colW = colWidths[i]!;
        const styleFn = col.cellStyle ?? ((t: string) => t);
        const cellText = col.render(row);
        const cell = styleFn(this.alignText(cellText, colW, col.align));
        rowParts.push(truncateToWidth(cell, colW, "", true));
      }
      lines.push(
        truncateToWidth(rowParts.join(" ".repeat(gap)), width, "", true),
      );
    }

    return lines;
  }

  invalidate(): void {}

  private computeVisibleColumns(width: number): TableColumn<T>[] {
    // Sort by priority (higher = more important, shown first)
    const sorted = [...this.columns].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    // Add columns until we exceed width
    const visible: TableColumn<T>[] = [];
    let usedWidth = 0;
    const gap = 2;

    for (const col of sorted) {
      const colW = col.width ?? Math.max(col.minWidth ?? 8, 8);
      const needed = colW + (visible.length > 0 ? gap : 0);

      if (usedWidth + needed <= width) {
        visible.push(col);
        usedWidth += needed;
      }
    }

    // Restore original column order
    return visible.sort(
      (a, b) => this.columns.indexOf(a) - this.columns.indexOf(b),
    ) as TableColumn<T>[];
  }

  private computeWidths(cols: TableColumn<T>[], totalWidth: number): number[] {
    const gap = 2;
    const totalGaps = Math.max(0, cols.length - 1) * gap;
    let available = totalWidth - totalGaps;

    const widths: number[] = new Array(cols.length).fill(0);
    const flexible: number[] = [];

    // Assign fixed widths
    for (let i = 0; i < cols.length; i++) {
      const colWidth = cols[i]!.width;
      if (colWidth !== undefined) {
        widths[i] = colWidth;
        available -= colWidth;
      } else {
        flexible.push(i);
      }
    }

    if (available < 0) available = 0;

    // Distribute remaining equally
    if (flexible.length > 0) {
      const perCol = Math.floor(available / flexible.length);
      for (const idx of flexible) {
        widths[idx] = perCol;
      }
    }

    return widths;
  }

  private alignText(
    text: string,
    width: number,
    align?: "left" | "right",
  ): string {
    if (align === "right") {
      const visW = visibleWidth(text);
      const pad = Math.max(0, width - visW);
      return " ".repeat(pad) + text;
    }
    return text;
  }
}
