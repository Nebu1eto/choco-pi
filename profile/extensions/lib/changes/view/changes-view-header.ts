/** The changes view's header: title, totals, recorded findings, the message line and key help. */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DiffSnapshot } from "../git/model.ts";
import { sanitizeTerminalText as safe } from "../terminal-text.ts";
import { reviewLabels, reviewLine } from "../findings.ts";
import { HEADER_BOX_CHROME, HEADER_BOX_MIN_WIDTH, themedHeaderBox } from "./header-box.ts";
import { plural } from "./rows.ts";
import { baselineText, sourceLabel } from "./source-text.ts";
import { TONE_COLORS, ChangesViewState } from "./changes-view-state.ts";

export abstract class ChangesViewHeader extends ChangesViewState {
  /* ------------------------------------------------------------ header */

  renderHeader(width: number, focused: boolean): string[] {
    if (!this.options.boxedHeader || width < HEADER_BOX_MIN_WIDTH) {
      return this.plainHeader(width, focused);
    }
    return this.boxedHeader(width, focused);
  }

  /**
   * The header as a box laid out like zentui's prompt frame, its facts as
   * cells on the borders: title and source top left, totals top right,
   * review verdicts bottom left, the branch (and `? help` while focused)
   * bottom right. Inside: the baseline, the message, a note being written and
   * the key list. Focus changes the border's color, never the number of rows.
   */
  protected boxedHeader(width: number, focused: boolean): string[] {
    const styler = this.styler;
    const inner = Math.max(1, width - HEADER_BOX_CHROME);
    const source = this.state.kind === "ready" ? this.state.snapshot.source : this.source;
    const branch = this.state.kind === "ready" ? this.state.snapshot.branch : null;
    const rows: string[] = [];
    const cut = (line: string) => truncateToWidth(line, inner, "…");
    const wrap = (line: string) => wrapTextWithAnsi(line, inner).map(cut);
    const dot = styler.fg("muted", " · ");
    const topLeft = [styler.bold(this.title), styler.fg("muted", sourceLabel(source))];
    let totals: string[] = [];
    switch (this.state.kind) {
      case "idle":
        rows.push(cut(styler.fg("dim", "Loading…")));
        break;
      case "not-a-repository":
        rows.push(cut(styler.fg("warning", "Not a git repository")));
        break;
      case "error":
        rows.push(...wrap(styler.fg("error", `Error: ${safe(this.state.message)}`)));
        break;
      case "ready": {
        const snapshot = this.state.snapshot;
        totals = this.totalCells(snapshot);
        if (this.state.refreshing) topLeft.push(styler.fg("dim", "refreshing…"));
        const baseline = baselineText(snapshot);
        if (baseline !== undefined) rows.push(cut(styler.fg("dim", baseline)));
        break;
      }
    }
    const review = reviewLabels(this.recorded).map((label) =>
      styler.fg(TONE_COLORS[label.tone], safe(label.text)),
    );
    if (this.message) rows.push(...wrap(styler.fg(this.message.color, this.message.text)));
    if (this.noteInput) {
      const target = this.noteInput;
      rows.push(
        cut(
          styler.fg(
            "accent",
            `Note on ${safe(target.path)} ${safe(target.range)} (⏎ save, esc cancel):`,
          ),
        ),
      );
      rows.push(...target.input.render(inner).map(cut));
    }
    if (this.helpOpen)
      for (const line of this.helpLines) rows.push(...wrap(styler.fg("muted", line)));
    const box = {
      width,
      lines: rows,
      topLeft: topLeft.join(dot),
      topRight: totals,
      bottomLeft: review.join(dot),
      bottomRight: [
        focused && !this.helpOpen ? styler.fg("dim", "? help") : "",
        branch ? styler.fg("accent", safe(branch)) : "",
      ],
      focused,
    };
    let drawn: string[] | undefined;
    try {
      drawn = this.headerBox?.(box);
    } catch {
      drawn = undefined;
    }
    return (drawn ?? themedHeaderBox(box, styler)).map((line) => truncateToWidth(line, width, ""));
  }

  /** The totals as border cells: `3 files`, `+12 -4`, `1 note`, `2 comments`. */
  protected totalCells(snapshot: DiffSnapshot): string[] {
    const styler = this.styler;
    const { files, additions, deletions } = snapshot.totals;
    const noteCount = this.notes?.notes.length ?? 0;
    const commentCount = this.comments.length;
    return [
      plural(files, "file"),
      `${styler.fg("toolDiffAdded", `+${additions}`)} ${styler.fg("toolDiffRemoved", `-${deletions}`)}`,
      noteCount > 0 ? styler.fg("accent", plural(noteCount, "note")) : "",
      commentCount > 0 ? styler.fg("accent", plural(commentCount, "comment")) : "",
    ].filter((cell) => cell.length > 0);
  }

  /** The header as stacked lines (the review, and the pane when too narrow for a box). */
  protected plainHeader(width: number, focused: boolean): string[] {
    const styler = this.styler;
    const source = this.state.kind === "ready" ? this.state.snapshot.source : this.source;
    const branch =
      this.state.kind === "ready" && this.state.snapshot.branch
        ? styler.fg("dim", ` on ${safe(this.state.snapshot.branch)}`)
        : "";
    const lines = [
      `${styler.bold(this.title)} ${styler.fg("muted", sourceLabel(source))}${branch}`,
    ];
    // Lines that must be read in full wrap; the rest truncate.
    const wrapped = new Set<number>();
    const pushWrapped = (line: string) => {
      wrapped.add(lines.length);
      lines.push(line);
    };
    switch (this.state.kind) {
      case "idle":
        lines.push(styler.fg("dim", "Loading…"));
        break;
      case "not-a-repository":
        lines.push(styler.fg("warning", "Not a git repository"));
        break;
      case "error":
        pushWrapped(styler.fg("error", `Error: ${safe(this.state.message)}`));
        break;
      case "ready": {
        const snapshot = this.state.snapshot;
        const baseline = baselineText(snapshot);
        if (baseline !== undefined) lines.push(styler.fg("dim", baseline));
        const refreshing = this.state.refreshing ? styler.fg("dim", " · refreshing…") : "";
        const { files, additions, deletions } = snapshot.totals;
        const noteCount = this.notes?.notes.length ?? 0;
        const notes = noteCount > 0 ? styler.fg("accent", ` · ${plural(noteCount, "note")}`) : "";
        lines.push(
          `${plural(files, "file")} ${styler.fg("toolDiffAdded", `+${additions}`)} ${styler.fg("toolDiffRemoved", `-${deletions}`)}${notes}${refreshing}`,
        );
        break;
      }
    }
    const reviewText = reviewLine(this.recorded);
    const review = reviewText === undefined ? undefined : safe(reviewText);
    if (review !== undefined) {
      const troubled =
        this.recorded.malformed > 0 ||
        this.recorded.errors.length > 0 ||
        this.recorded.tasks.some((task) => task.review?.kind === "unrecorded");
      pushWrapped(styler.fg(troubled ? "warning" : "muted", review));
    }
    if (this.message) pushWrapped(styler.fg(this.message.color, this.message.text));
    if (this.noteInput) {
      const target = this.noteInput;
      lines.push(
        styler.fg(
          "accent",
          `Note on ${safe(target.path)} ${safe(target.range)} (⏎ save, esc cancel):`,
        ),
      );
      lines.push(...target.input.render(Math.max(1, width)));
    }
    if (this.helpOpen) for (const line of this.helpLines) pushWrapped(styler.fg("muted", line));
    else if (focused) lines.push(styler.fg("dim", this.keyHint));
    lines.push(styler.fg("borderMuted", "─".repeat(Math.max(0, width))));
    const columns = Math.max(1, width);
    return lines.flatMap((line, index) =>
      wrapped.has(index)
        ? wrapTextWithAnsi(line, columns).map((part) => truncateToWidth(part, width, "…"))
        : [truncateToWidth(line, width, "…")],
    );
  }
}
