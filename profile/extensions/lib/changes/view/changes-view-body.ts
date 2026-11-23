import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DiffSnapshot, FileSummary } from "../git/model.ts";
import { createIntralineBudget, withRenderBudget } from "../render/diff-render.ts";
import { BODY_INDENT } from "./body-block.ts";
import { sanitizeTerminalText as safe } from "../terminal-text.ts";
import type { RecordedFinding } from "../findings.ts";
import {
  EMPTY_FILE_ITEMS,
  itemLines,
  placeItems,
  severityColor,
  type FileItems,
  type PaneComment,
  type ViewItem,
} from "./items.ts";
import { plural } from "./rows.ts";
import { emptyMessage } from "./source-text.ts";
import type { DiffNote } from "../notes.ts";
import {
  type Block,
  type FindingsIndex,
  MAX_FITTED_ROWS,
  findingRange,
  normalizeFindingPath,
} from "./changes-view-state.ts";
import { ChangesViewHeader } from "./changes-view-header.ts";

export abstract class ChangesViewBody extends ChangesViewHeader {
  renderBody(width: number, _focused: boolean): string[] {
    this.lastWidth = width;
    this.blockRows = [];
    if (this.state.kind !== "ready") return [];
    const columns = Math.max(0, width);
    const budget = createIntralineBudget();
    this.lastRenderBudget = budget;
    const snapshot = this.state.snapshot;
    const rows = withRenderBudget(budget, () => this.bodyRows(snapshot, width));
    return columns >= 2 ? rows : rows.map((row) => truncateToWidth(row, columns, "…"));
  }

  protected fit(row: string, width: number): string {
    if (width !== this.fittedWidth || this.fittedRows.size > MAX_FITTED_ROWS) {
      this.fittedRows.clear();
      this.fittedWidth = width;
    }
    let cut = this.fittedRows.get(row);
    if (cut === undefined) {
      cut = truncateToWidth(row, width, "…");
      this.fittedRows.set(row, cut);
    }
    return cut;
  }

  protected bodyRows(snapshot: DiffSnapshot, width: number): string[] {
    const styler = this.styler;
    const trailer = [...this.unlistedLines(width), ...(this.options.trailer?.(width) ?? [])].map(
      (line) => truncateToWidth(line, width, "…"),
    );
    if (snapshot.files.length === 0 && snapshot.omittedFiles === 0) {
      const columns = Math.max(1, width);
      return [
        ...wrapTextWithAnsi(styler.fg("dim", emptyMessage(snapshot)), columns).map((line) =>
          truncateToWidth(line, width, "…"),
        ),
        ...trailer,
      ];
    }
    const lines: string[] = [];
    const blockWidth = Math.max(1, width - 1);
    this.files().forEach((file, index) => {
      const block = this.fileBlock(file, snapshot.revision, blockWidth);
      const start = lines.length;
      const selected = index === this.selectedIndex;
      if (selected) this.selectedLine = start + (block.anchor ?? 0);
      const row = this.fit(block.lines[0] ?? "", blockWidth);
      const onRow =
        selected &&
        this.cursorMode === "line" &&
        this.selectedHunk === undefined &&
        this.selectedItem === undefined;
      const drawn =
        (selected ? styler.fg("accent", "❯") : " ") + (onRow ? styler.inverse(row) : row);
      this.blockRows.push({ start, block, row: drawn, path: file.path });
      lines.push(drawn);
      for (let at = 1; at < block.lines.length; at += 1) {
        lines.push(` ${this.fit(block.lines[at] ?? "", blockWidth)}`);
      }
    });
    if (snapshot.omittedFiles > 0) {
      lines.push(
        truncateToWidth(
          styler.fg("dim", `${plural(snapshot.omittedFiles, "more file")} not shown`),
          width,
          "…",
        ),
      );
    }
    lines.push(...trailer);
    return lines;
  }

  protected blockUnder(
    top: number,
  ): { start: number; block: Block; row: string; path: string } | undefined {
    return this.blockRows.find(
      (entry) => entry.start < top && top < entry.start + entry.block.lines.length,
    );
  }

  protected pins(
    top: number,
    limit: number,
  ): Array<{ text: string; path: string; hunkId?: string }> {
    if (limit <= 0) return [];
    const entry = this.blockUnder(top);
    if (!entry) return [];
    const pins: Array<{ text: string; path: string; hunkId?: string }> = [
      { text: entry.row, path: entry.path },
    ];
    const span = entry.block.hunks?.find(
      (hunk) => entry.start + hunk.start <= top && top + 1 < entry.start + hunk.end,
    );
    if (span && limit >= 2) {
      const header = entry.block.lines[span.start] ?? "";
      const text = ` ${this.fit(header, Math.max(1, this.lastWidth - 1))}`;
      pins.push({ text, path: entry.path, hunkId: span.hunkId });
    }
    return pins;
  }

  stickyRows(top: number, height: number): string[] {
    this.pinning = true;
    const pins = this.pins(top, height - 1);
    this.pinned = pins.map((pin, index) => ({ ...pin, row: top + index }));
    return pins.map((pin) => pin.text);
  }

  pinnedRowCount(top: number, height: number): number {
    return this.pins(top, height - 1).length;
  }

  topShowing(line: number, height: number): number {
    for (let top = line; top >= Math.max(0, line - height + 1); top -= 1) {
      if (line >= top + this.pinnedRowCount(top, height)) return top;
    }
    return line;
  }

  protected findings(): FindingsIndex {
    const snapshot = this.state.kind === "ready" ? this.state.snapshot : undefined;
    const key = `${this.recordedVersion}\u0000${this.commentsVersion}\u0000${snapshot?.revision ?? -1}`;
    if (this.findingsCache?.key === key) return this.findingsCache.index;
    const listed = new Map(this.files().map((file, index) => [file.path, index]));
    const byPath = new Map<string, RecordedFinding[]>();
    const unlisted: RecordedFinding[] = [];
    for (const finding of this.recorded.findings) {
      const path = normalizeFindingPath(finding.path, snapshot?.repoRoot ?? "");
      if (!listed.has(path)) {
        unlisted.push(finding);
        continue;
      }
      byPath.set(path, [...(byPath.get(path) ?? []), finding]);
    }
    const lineOf = (finding: RecordedFinding) => finding.startLine ?? 0;
    for (const list of byPath.values()) list.sort((a, b) => lineOf(a) - lineOf(b));
    const commentsByPath = new Map<string, PaneComment[]>();
    const unlistedComments: PaneComment[] = [];
    for (const comment of this.comments) {
      if (!listed.has(comment.path)) {
        unlistedComments.push(comment);
        continue;
      }
      commentsByPath.set(comment.path, [...(commentsByPath.get(comment.path) ?? []), comment]);
    }
    for (const list of commentsByPath.values()) list.sort((a, b) => a.line - b.line);
    const index = { byPath, unlisted, commentsByPath, unlistedComments };
    this.findingsCache = { key, index };
    return index;
  }

  protected itemIds(path: string | undefined): string[] {
    if (path === undefined) return [];
    const file = this.files().find((entry) => entry.path === path);
    return file ? this.fileItems(file).items.map((entry) => entry.item.id) : [];
  }

  protected fileItems(file: FileSummary): FileItems {
    const index = this.findings();
    const findings = index.byPath.get(file.path) ?? [];
    const comments = index.commentsByPath.get(file.path) ?? [];
    if (findings.length === 0 && comments.length === 0) return EMPTY_FILE_ITEMS;
    const loaded = this.bodies.get(file.path);
    const raw =
      this.canShowContents(file) && loaded?.body.kind === "text" ? loaded.body.file : undefined;
    const known = this.layouts.get(file.path);
    if (known && known.raw === raw) return known.items;
    const hunks = raw ? this.displayHunks(file) : undefined;
    const items = placeItems(
      findings,
      comments,
      raw && hunks ? { ...raw, hunks: [...hunks] } : undefined,
    );
    this.layouts.set(file.path, { raw, items });
    return items;
  }

  isItemOpen(itemId: string): boolean {
    return this.itemOpen.get(itemId) ?? true;
  }

  protected itemRows(item: ViewItem, path: string, width: number, textColumn?: number): string[] {
    const selected = this.selectedItem === item.id && this.selectedPath === path;
    const open = this.isItemOpen(item.id);
    const at = textColumn === undefined ? {} : { textColumn };
    if (item.kind === "comment") {
      return itemLines(item, { open, selected, width, styler: this.styler, ...at });
    }
    const review = this.recorded.tasks.find(
      (task) => task.workTask === item.finding.workTask,
    )?.review;
    const drawing = {
      open,
      selected,
      width,
      styler: this.styler,
      mayBeOutdated: this.mayBeOutdated(item.finding, path),
      ...at,
    };
    return itemLines(
      item,
      review?.kind === "parsed" ? { ...drawing, verdict: review.verdict } : drawing,
    );
  }

  mayBeOutdated(finding: RecordedFinding, path: string): boolean {
    if (Number.isNaN(finding.completedAt)) return true;
    const changed = this.changeTimes.get(path);
    if (changed === undefined) return false;
    if (changed === null) return true;
    return finding.completedAt < changed;
  }

  protected noteLine(note: DiffNote, outdated: boolean, width: number): string {
    const text = safe(outdated ? `✎ (outdated, was ${note.range}) ${note.text}` : `✎ ${note.text}`);
    return truncateToWidth(
      `${BODY_INDENT}  ${this.styler.fg(outdated ? "dim" : "accent", text)}`,
      width,
      "…",
    );
  }

  protected unlistedLines(width: number): string[] {
    const listed = new Set(this.files().map((file) => file.path));
    const { unlisted: findings, unlistedComments: comments } = this.findings();
    const notes = (this.notes?.notes ?? []).filter((note) => !listed.has(note.path));
    if (findings.length === 0 && comments.length === 0 && notes.length === 0) return [];
    const styler = this.styler;
    const lines = ["", styler.fg("dim", "Not in this diff:")];
    for (const finding of findings) {
      const range = findingRange(finding);
      const outcome = finding.outcome ? ` [${finding.outcome}]` : "";
      const text = safe(
        `⚑ ${finding.severity} ${finding.class} ${finding.id} ${finding.path}${range ? ` ${range}` : ""}: ${finding.invariant}${outcome}`,
      );
      lines.push(`  ${styler.fg(severityColor(finding), text)}`);
    }
    for (const comment of comments) {
      const range =
        comment.startLine !== undefined && comment.startLine !== comment.line
          ? `L${comment.startLine}-${comment.line}`
          : `L${comment.line}`;
      const text = safe(`● ${comment.path} ${range}: ${comment.body.split("\n")[0] ?? ""}`);
      lines.push(`  ${styler.fg("dim", text)}`);
    }
    for (const note of notes) {
      lines.push(
        `  ${styler.fg("dim", safe(`✎ ${note.path} (outdated, was ${note.range}) ${note.text}`))}`,
      );
    }
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }
}
